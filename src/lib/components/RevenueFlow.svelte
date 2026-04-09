<script lang="ts">
  import { PublicKey } from '@solana/web3.js';
  import { Clock, AlertTriangle, ExternalLink } from 'lucide-svelte';
  import CopyAddress from './CopyAddress.svelte';
  import { resolveAddress } from '$lib/utils/resolver';
  import { formatUsdc, formatCooldown, bytesToBase58, trimNullBytes } from '$lib/utils/format';
  import { network } from '$lib/stores/network';
  import { programId } from '$lib/stores/ot';
  import type { OtState } from '$lib/stores/ot';
  import type { Cluster } from '$lib/stores/network';

  export let otState: OtState;

  // Revenue flow constants
  const PROTOCOL_FEE_BPS = 25; // 0.25%
  const COOLDOWN_SECONDS = 604_800; // 7 days

  // Reactive data from OT state
  $: revenueConfig = otState.revenueConfig;
  $: revenueAccount = otState.revenueAccount;
  $: revenueAtaBalance = otState.revenueAtaBalance;

  // Cooldown calculation
  $: cooldownRemaining = (() => {
    if (!revenueAccount) return 0;
    const lastTs = Number(revenueAccount.last_distribution_ts ?? 0n);
    if (lastTs === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastTs;
    return Math.max(0, COOLDOWN_SECONDS - elapsed);
  })();

  $: isDistributing = revenueAccount?.is_distributing ?? false;

  // Build destination entries for display
  interface FlowDestination {
    address: string;
    label: string;
    resolvedLabel: string;
    bps: number;
    pct: string;
    type: 'fee' | 'yd' | 'treasury' | 'crank' | 'custom';
    status: 'active' | 'pending' | 'unconfigured';
    module?: string;
  }

  $: destinations = buildDestinations($network);

  function buildDestinations(cluster: Cluster): FlowDestination[] {
    const results: FlowDestination[] = [];

    // Protocol fee (always first)
    if (revenueConfig) {
      const feeAddr = bytesToBase58(revenueConfig.areal_fee_destination);
      const feeResolved = resolveAddress(feeAddr, cluster, {
        otState,
        otProgramId: programId
      });
      results.push({
        address: feeAddr,
        label: 'Protocol Fee',
        resolvedLabel: feeResolved.label,
        bps: PROTOCOL_FEE_BPS,
        pct: (PROTOCOL_FEE_BPS / 100).toFixed(2),
        type: 'fee',
        status: 'active',
        module: feeResolved.module
      });
    }

    // Active destinations
    if (revenueConfig && revenueConfig.active_count > 0) {
      for (let i = 0; i < revenueConfig.active_count; i++) {
        const dest = revenueConfig.destinations[i];
        const addr = bytesToBase58(dest.address);
        const rawLabel = trimNullBytes(dest.label);
        const resolved = resolveAddress(addr, cluster, {
          otState,
          otProgramId: programId
        });

        // Heuristic type detection from label
        let destType: FlowDestination['type'] = 'custom';
        const lowerLabel = rawLabel.toLowerCase();
        if (lowerLabel.includes('yd') || lowerLabel.includes('yield') || lowerLabel.includes('accumulator')) {
          destType = 'yd';
        } else if (lowerLabel.includes('treasury')) {
          destType = 'treasury';
        } else if (lowerLabel.includes('crank') || lowerLabel.includes('nexus') || lowerLabel.includes('liquidity')) {
          destType = 'crank';
        }

        results.push({
          address: addr,
          label: rawLabel || `Destination #${i + 1}`,
          resolvedLabel: resolved.type !== 'unknown' ? resolved.label : rawLabel || resolved.label,
          bps: dest.allocation_bps,
          pct: (dest.allocation_bps / 100).toFixed(2),
          type: destType,
          status: resolved.status ?? 'active',
          module: resolved.module
        });
      }
    }

    return results;
  }

  // Status color helper
  function statusClass(status: string): string {
    if (status === 'active') return 'status-active';
    if (status === 'pending') return 'status-pending';
    return 'status-unconfigured';
  }

  // Type icon/color helper
  function typeClass(type: string): string {
    if (type === 'fee') return 'flow-fee';
    if (type === 'yd') return 'flow-yd';
    if (type === 'treasury') return 'flow-treasury';
    if (type === 'crank') return 'flow-crank';
    return 'flow-custom';
  }
</script>

<div class="revenue-flow">
  <!-- Revenue ATA header -->
  <div class="flow-source">
    <div class="source-header">
      <span class="source-label">Revenue ATA</span>
      <span class="source-balance">{formatUsdc(BigInt(revenueAtaBalance.toString()))}</span>
    </div>
    <div class="source-meta">
      <span class="cooldown-badge" class:ready={cooldownRemaining === 0} class:distributing={isDistributing}>
        <Clock size={12} />
        {#if isDistributing}
          Distribution in progress
        {:else if cooldownRemaining === 0}
          Ready
        {:else}
          {formatCooldown(cooldownRemaining)}
        {/if}
      </span>
      {#if revenueAccount}
        <span class="dist-count">{BigInt(revenueAccount.distribution_count?.toString() ?? '0').toString()} distributions</span>
      {/if}
    </div>
  </div>

  <!-- Flow trunk line -->
  <div class="flow-trunk"></div>

  <!-- Destinations -->
  {#if destinations.length > 0}
    <div class="flow-destinations">
      {#each destinations as dest, i}
        <div class="flow-branch">
          <div class="branch-connector">
            <div class="connector-line"></div>
            <div class="connector-dot {typeClass(dest.type)}"></div>
          </div>
          <div class="branch-card {typeClass(dest.type)}" class:pending-dest={dest.status === 'pending'}>
            <div class="branch-header">
              <span class="branch-pct">{dest.pct}%</span>
              <span class="branch-label">{dest.label}</span>
              <span class="branch-status {statusClass(dest.status)}">
                {#if dest.status === 'pending'}
                  pending
                {/if}
              </span>
            </div>
            <div class="branch-detail">
              <CopyAddress address={dest.address} chars={4} />
              {#if dest.resolvedLabel !== dest.label && dest.resolvedLabel !== formatAddressShort(dest.address)}
                <span class="resolved-tag">{dest.resolvedLabel}</span>
              {/if}
              {#if dest.module && dest.module !== 'ot'}
                <span class="module-tag">{dest.module}</span>
              {/if}
            </div>
            <!-- BPS bar -->
            <div class="bps-bar-container">
              <div class="bps-bar-fill {typeClass(dest.type)}" style="width: {Math.min(100, dest.bps / 100)}%"></div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="flow-empty">
      <AlertTriangle size={16} />
      <span>No destinations configured</span>
    </div>
  {/if}
</div>

<script context="module" lang="ts">
  function formatAddressShort(addr: string): string {
    if (addr.length <= 11) return addr;
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }
</script>

<style>
  .revenue-flow {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Source (Revenue ATA) */
  .flow-source {
    background: var(--color-surface-active);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .source-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .source-label {
    font-weight: 600;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .source-balance {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--color-success);
  }

  .source-meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
  }

  .cooldown-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-warning);
  }

  .cooldown-badge.ready {
    color: var(--color-success);
  }

  .cooldown-badge.distributing {
    color: var(--color-info);
  }

  .dist-count {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  /* Trunk line */
  .flow-trunk {
    width: 2px;
    height: var(--space-4);
    background: var(--color-border);
    margin-left: var(--space-8);
  }

  /* Destinations list */
  .flow-destinations {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .flow-branch {
    display: flex;
    gap: 0;
    align-items: stretch;
  }

  .branch-connector {
    display: flex;
    align-items: center;
    width: var(--space-8);
    flex-shrink: 0;
    position: relative;
  }

  .connector-line {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--color-border);
    margin-left: calc(var(--space-8) - 2px);
  }

  .flow-branch:last-child .connector-line {
    bottom: 50%;
  }

  .connector-dot {
    position: absolute;
    right: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-border);
    z-index: 1;
  }

  .connector-dot.flow-fee { background: var(--color-text-muted); }
  .connector-dot.flow-yd { background: var(--color-primary); }
  .connector-dot.flow-treasury { background: var(--color-success); }
  .connector-dot.flow-crank { background: var(--color-info); }
  .connector-dot.flow-custom { background: var(--color-warning); }

  /* Branch card */
  .branch-card {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-left: var(--space-2);
  }

  .branch-card.pending-dest {
    opacity: 0.6;
    border-style: dashed;
  }

  .branch-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .branch-pct {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: var(--text-sm);
    min-width: 48px;
  }

  .flow-fee .branch-pct,
  .branch-card.flow-fee .branch-pct { color: var(--color-text-muted); }
  .flow-yd .branch-pct,
  .branch-card.flow-yd .branch-pct { color: var(--color-primary); }
  .flow-treasury .branch-pct,
  .branch-card.flow-treasury .branch-pct { color: var(--color-success); }
  .flow-crank .branch-pct,
  .branch-card.flow-crank .branch-pct { color: var(--color-info); }
  .flow-custom .branch-pct,
  .branch-card.flow-custom .branch-pct { color: var(--color-warning); }

  .branch-label {
    font-size: var(--text-sm);
    font-weight: 500;
    flex: 1;
  }

  .branch-status {
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .status-active { color: var(--color-success); }
  .status-pending {
    background: var(--color-warning-muted);
    color: var(--color-warning);
  }
  .status-unconfigured {
    background: var(--color-surface-active);
    color: var(--color-text-muted);
  }

  .branch-detail {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }

  .resolved-tag {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    padding: 1px var(--space-1);
    background: var(--color-surface-active);
    border-radius: var(--radius-xs);
  }

  .module-tag {
    color: var(--color-primary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    padding: 1px var(--space-1);
    background: var(--color-primary-muted);
    border-radius: var(--radius-xs);
  }

  /* BPS bar */
  .bps-bar-container {
    height: 3px;
    background: var(--color-surface-active);
    border-radius: 2px;
    overflow: hidden;
  }

  .bps-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width var(--transition-base);
  }

  .bps-bar-fill.flow-fee { background: var(--color-text-muted); }
  .bps-bar-fill.flow-yd { background: var(--color-primary); }
  .bps-bar-fill.flow-treasury { background: var(--color-success); }
  .bps-bar-fill.flow-crank { background: var(--color-info); }
  .bps-bar-fill.flow-custom { background: var(--color-warning); }

  /* Empty state */
  .flow-empty {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-6);
    color: var(--color-text-muted);
    justify-content: center;
    font-size: var(--text-sm);
  }
</style>
