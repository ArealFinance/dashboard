<script lang="ts">
  import { getContext, onMount, onDestroy } from 'svelte';
  import { Coins, BarChart3, Shield, Wallet, Clock, AlertTriangle, GitBranch, Link } from 'lucide-svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import RevenueFlow from '$lib/components/RevenueFlow.svelte';
  import { formatAmount, formatUsdc, formatTimestamp, formatCooldown, bytesToBase58, trimNullBytes, isZeroAddress } from '$lib/utils/format';
  import { resolveAuthorityType } from '$lib/utils/resolver';
  import { protocolRegistry } from '$lib/stores/protocol';
  import type { OtState } from '$lib/stores/ot';
  import type { Writable } from 'svelte/store';

  const otStore = getContext<{ subscribe: Writable<OtState>['subscribe'] }>('otStore');

  // Helper to safely read bigint fields
  function bigint(val: any): bigint {
    if (typeof val === 'bigint') return val;
    return BigInt(val?.toString() ?? '0');
  }

  // Resolve authority type
  $: authorityInfo = (() => {
    if (!$otStore.governance) return null;
    const authAddr = bytesToBase58($otStore.governance.authority);
    return resolveAuthorityType(authAddr, $otStore.mint);
  })();

  // CPI integrations for this OT
  $: cpiIntegrations = $protocolRegistry.getLinksFor('ot');
  $: inboundLinks = $protocolRegistry.getLinksTo('ot');
  $: outboundLinks = $protocolRegistry.getLinksFrom('ot');
</script>

<div class="overview">
  <!-- Config Section -->
  {#if $otStore.otConfig}
    {@const cfg = $otStore.otConfig}
    <section class="card">
      <div class="card-header">
        <Coins size={16} />
        <h3>Config</h3>
      </div>
      <div class="data-grid">
        <div class="data-row">
          <span class="data-label">Name</span>
          <span>{trimNullBytes(cfg.name)}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Symbol</span>
          <span class="bold">{trimNullBytes(cfg.symbol)}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Decimals</span>
          <span>{cfg.decimals}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Total Minted</span>
          <span class="mono">{formatAmount(bigint(cfg.total_minted), cfg.decimals)}</span>
        </div>
        <div class="data-row">
          <span class="data-label">URI</span>
          <span class="mono uri">{trimNullBytes(cfg.uri)}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Mint</span>
          <CopyAddress address={bytesToBase58(cfg.ot_mint)} chars={6} />
        </div>
      </div>
    </section>
  {/if}

  <!-- Revenue Flow Section (replaces raw destinations table) -->
  <section class="card">
    <div class="card-header">
      <BarChart3 size={16} />
      <h3>Revenue Flow</h3>
      {#if $otStore.revenueConfig}
        <span class="badge-sm">{$otStore.revenueConfig.active_count} destinations</span>
        <span class="secondary">v{bigint($otStore.revenueConfig.config_version).toString()}</span>
      {/if}
    </div>

    {#if $otStore.revenueAccount || $otStore.revenueConfig}
      <RevenueFlow otState={$otStore} />
    {:else}
      <p class="empty-text">Revenue not configured for this OT.</p>
    {/if}

    {#if $otStore.revenueAccount}
      <div class="revenue-stats">
        <div class="data-row">
          <span class="data-label">Total Distributed</span>
          <span class="mono">{formatUsdc(bigint($otStore.revenueAccount.total_distributed))}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Distribution Count</span>
          <span>{bigint($otStore.revenueAccount.distribution_count).toString()}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Min Distribution</span>
          <span class="mono">{formatUsdc(bigint($otStore.revenueAccount.min_distribution_amount))}</span>
        </div>
      </div>
    {/if}
  </section>

  <!-- Governance Section -->
  {#if $otStore.governance}
    {@const gov = $otStore.governance}
    <section class="card">
      <div class="card-header">
        <Shield size={16} />
        <h3>Governance</h3>
        <span class="badge-sm" class:active-badge={gov.is_active} class:inactive-badge={!gov.is_active}>
          {gov.is_active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div class="data-grid">
        <div class="data-row">
          <span class="data-label">Authority</span>
          <div class="authority-row">
            <CopyAddress address={bytesToBase58(gov.authority)} chars={6} />
            {#if authorityInfo}
              <span class="authority-type-badge" class:authority-wallet={authorityInfo.type === 'wallet'} class:authority-futarchy={authorityInfo.type === 'futarchy'}>
                {authorityInfo.label}
              </span>
            {/if}
          </div>
        </div>
        {#if gov.has_pending}
          <div class="data-row">
            <span class="data-label">Pending Authority</span>
            <span class="badge warning">
              <CopyAddress address={bytesToBase58(gov.pending_authority)} chars={6} />
            </span>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Treasury Section -->
  <section class="card">
    <div class="card-header">
      <Wallet size={16} />
      <h3>Treasury</h3>
    </div>
    {#if $otStore.treasuryTokenAccounts.length > 0}
      <table class="dest-table">
        <thead>
          <tr>
            <th>Token Mint</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {#each $otStore.treasuryTokenAccounts as ta}
            <tr>
              <td><CopyAddress address={ta.mint.toBase58()} chars={6} /></td>
              <!-- N-4: format consistently with other BigInt amounts in app.
                   Assumes 6 decimals (USDC-style) — the common case for
                   treasury balances. -->
              <td class="mono">{formatUsdc(ta.balance)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="empty-text">No token accounts in treasury.</p>
    {/if}
  </section>

  <!-- Integrations Section -->
  <section class="card">
    <div class="card-header">
      <Link size={16} />
      <h3>Protocol Integrations</h3>
      <span class="badge-sm">{cpiIntegrations.length} CPI links</span>
    </div>

    {#if inboundLinks.length > 0}
      <div class="integration-group">
        <span class="integration-group-label">Inbound CPI (other contracts call OT)</span>
        {#each inboundLinks as link}
          <div class="integration-row" class:integration-pending={link.status === 'pending'}>
            <span class="integration-from">{$protocolRegistry.getProgram(link.from)?.name ?? link.from}</span>
            <span class="integration-arrow">-></span>
            <span class="integration-ix mono">{link.instruction}</span>
            <span class="integration-status" class:pending={link.status === 'pending'} class:active={link.status === 'active'}>
              {link.status}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    {#if outboundLinks.length > 0}
      <div class="integration-group">
        <span class="integration-group-label">Outbound CPI (OT calls other contracts)</span>
        {#each outboundLinks as link}
          <div class="integration-row" class:integration-pending={link.status === 'pending'}>
            <span class="integration-ix mono">{link.instruction}</span>
            <span class="integration-arrow">-></span>
            <span class="integration-to">{$protocolRegistry.getProgram(link.to)?.name ?? link.to}</span>
            <span class="integration-status" class:pending={link.status === 'pending'} class:active={link.status === 'active'}>
              {link.status}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    {#if cpiIntegrations.length === 0}
      <p class="empty-text">No CPI integrations configured.</p>
    {/if}
  </section>
</div>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    color: var(--color-text-secondary);
  }

  .card-header h3 {
    font-size: var(--text-md);
    color: var(--color-text);
    margin-right: auto;
  }

  .data-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .data-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
  }

  .data-label {
    color: var(--color-text-muted);
    flex-shrink: 0;
    min-width: 140px;
  }

  .bold {
    font-weight: 600;
  }

  .uri {
    word-break: break-all;
    font-size: var(--text-xs);
    text-align: right;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .badge.warning {
    background: var(--color-warning-muted);
    color: var(--color-warning);
  }

  .badge-sm {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-surface-active);
    color: var(--color-text-secondary);
  }

  .active-badge {
    background: var(--color-success-muted) !important;
    color: var(--color-success) !important;
  }

  .inactive-badge {
    background: var(--color-danger-muted) !important;
    color: var(--color-danger) !important;
  }

  .revenue-stats {
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Authority type badge */
  .authority-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .authority-type-badge {
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .authority-wallet {
    background: var(--color-surface-active);
    color: var(--color-text-muted);
  }

  .authority-futarchy {
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }

  .dest-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .dest-table th {
    text-align: left;
    padding: var(--space-2);
    color: var(--color-text-muted);
    font-weight: 500;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--color-border);
  }

  .dest-table td {
    padding: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }

  .dest-table tr:last-child td {
    border-bottom: none;
  }

  .empty-text {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    padding: var(--space-4) 0;
    text-align: center;
  }

  /* Integrations */
  .integration-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .integration-group-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-bottom: var(--space-1);
    border-bottom: 1px solid var(--color-border);
  }

  .integration-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
  }

  .integration-row.integration-pending {
    opacity: 0.5;
  }

  .integration-from,
  .integration-to {
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .integration-arrow {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .integration-ix {
    color: var(--color-text-secondary);
    flex: 1;
  }

  .integration-status {
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .integration-status.pending {
    background: var(--color-surface-active);
    color: var(--color-text-muted);
  }

  .integration-status.active {
    background: var(--color-success-muted);
    color: var(--color-success);
  }
</style>
