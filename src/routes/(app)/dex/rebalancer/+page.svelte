<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { dexStore, dexClient } from '$lib/stores/dex';
  import { connection } from '$lib/stores/network';
  import { formatAddress } from '$lib/utils/format';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: config = $dexStore.config;
  $: concentratedPools = $dexStore.pools.filter(p => p.poolType === 1);

  interface ShiftEvent {
    pool: string;
    rebalancer: string;
    oldLower: number;
    oldUpper: number;
    newLower: number;
    newUpper: number;
    timestamp: number;
    signature: string;
  }

  let recentShifts: ShiftEvent[] = [];
  let loading = true;
  let botHealthy = false;
  let lastShiftAge = '—';

  onMount(async () => {
    await loadRecentShifts();
  });

  async function loadRecentShifts() {
    loading = true;
    try {
      const conn = get(connection);
      const client = get(dexClient);
      // Fetch recent transactions for the program to find LiquidityShifted events
      const sigs = await conn.getSignaturesForAddress(client.programId, { limit: 50 });

      // Parse shift events from transaction logs
      const shifts: ShiftEvent[] = [];
      for (const sig of sigs) {
        if (!sig.memo && sig.err === null) {
          // Check transaction logs for "Liquidity shifted" marker
          try {
            const tx = await conn.getTransaction(sig.signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            });
            if (tx?.meta?.logMessages?.some(l => l.includes('Liquidity shifted'))) {
              shifts.push({
                pool: '—',
                rebalancer: config?.rebalancer ?? '—',
                oldLower: 0, oldUpper: 0, newLower: 0, newUpper: 0,
                timestamp: sig.blockTime ?? 0,
                signature: sig.signature,
              });
            }
          } catch { /* skip failed fetches */ }
        }
        if (shifts.length >= 10) break;
      }

      recentShifts = shifts;

      // Bot health: if last shift < 5 min ago, consider healthy
      if (shifts.length > 0 && shifts[0].timestamp > 0) {
        const ageMs = Date.now() - shifts[0].timestamp * 1000;
        const ageMins = Math.floor(ageMs / 60000);
        lastShiftAge = ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ago`;
        botHealthy = ageMins < 10;
      }
    } catch (e: any) {
      console.error('Failed to load shifts:', e);
    }
    loading = false;
  }
</script>

<div class="page">
  <div class="header">
    <a href="/dex" class="back">&larr; DEX</a>
    <h1>Pool Rebalancer</h1>
  </div>

  <div class="status-cards">
    <div class="status-card">
      <span class="status-label">Bot Status</span>
      <span class="status-value">
        <span class="dot" class:healthy={botHealthy} class:unhealthy={!botHealthy}></span>
        {botHealthy ? 'Healthy' : 'Unknown'}
      </span>
    </div>
    <div class="status-card">
      <span class="status-label">Last Shift</span>
      <span class="status-value mono">{lastShiftAge}</span>
    </div>
    <div class="status-card">
      <span class="status-label">Concentrated Pools</span>
      <span class="status-value mono">{concentratedPools.length}</span>
    </div>
    <div class="status-card">
      <span class="status-label">Rebalancer Wallet</span>
      <span class="status-value mono">
        {#if config}
          <CopyAddress address={config.rebalancer} />
        {:else}
          —
        {/if}
      </span>
    </div>
  </div>

  <div class="card">
    <h2>Configuration</h2>
    <div class="config-grid">
      <div class="config-item">
        <span class="config-label">Rebalance Threshold</span>
        <span class="config-value">1%</span>
      </div>
      <div class="config-item">
        <span class="config-label">Target Bin Count</span>
        <span class="config-value">40</span>
      </div>
      <div class="config-item">
        <span class="config-label">Check Interval</span>
        <span class="config-value">60s</span>
      </div>
      <div class="config-item">
        <span class="config-label">Debounce</span>
        <span class="config-value">30s</span>
      </div>
      <div class="config-item">
        <span class="config-label">Max Shift Distance</span>
        <span class="config-value">35 bins</span>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Recent Shifts</h2>
    {#if loading}
      <p class="muted">Loading...</p>
    {:else if recentShifts.length === 0}
      <p class="muted">No recent shift events found</p>
    {:else}
      <div class="shifts-list">
        {#each recentShifts as shift}
          <div class="shift-item">
            <span class="shift-time">
              {new Date(shift.timestamp * 1000).toLocaleString()}
            </span>
            <a
              href="https://explorer.solana.com/tx/{shift.signature}?cluster=devnet"
              target="_blank"
              class="shift-sig"
            >
              {formatAddress(shift.signature, 8)}
            </a>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if concentratedPools.length > 0}
    <div class="card">
      <h2>Concentrated Pools</h2>
      <div class="pool-list">
        {#each concentratedPools as pool}
          <a href="/dex/{pool.pda}/bins" class="pool-item">
            <span class="pool-pair">
              {formatAddress(pool.tokenAMint, 4)} / {formatAddress(pool.tokenBMint, 4)}
            </span>
            <span class="pool-stat">
              Bin: {pool.activeBinId} | Step: {pool.binStepBps / 100}%
            </span>
            <span class="pool-badge" class:active={pool.isActive} class:paused={!pool.isActive}>
              {pool.isActive ? 'Active' : 'Paused'}
            </span>
          </a>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 900px; }
  .header { margin-bottom: var(--space-4); }
  .back { color: var(--color-primary); text-decoration: none; font-size: 0.85rem; }
  .muted { color: var(--color-text-muted); }

  .status-cards {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3); margin-bottom: var(--space-4);
  }
  .status-card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); padding: var(--space-3);
    display: flex; flex-direction: column; gap: 4px;
  }
  .status-label { font-size: 0.7rem; color: var(--color-text-muted); text-transform: uppercase; }
  .status-value { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .mono { font-family: var(--font-mono); font-size: 0.9rem; }

  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.healthy { background: var(--color-success); box-shadow: 0 0 6px var(--color-success); }
  .dot.unhealthy { background: var(--color-text-muted); }

  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-3) 0; font-size: 1.1rem; }

  .config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-2); }
  .config-item { display: flex; flex-direction: column; gap: 2px; }
  .config-label { font-size: 0.75rem; color: var(--color-text-muted); }
  .config-value { font-family: var(--font-mono); font-weight: 600; }

  .shifts-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .shift-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: var(--space-2); border-radius: var(--radius-sm);
    background: var(--color-bg);
  }
  .shift-time { font-size: 0.85rem; color: var(--color-text-muted); }
  .shift-sig {
    font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-primary);
    text-decoration: none;
  }
  .shift-sig:hover { text-decoration: underline; }

  .pool-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .pool-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
    background: var(--color-bg); text-decoration: none; color: var(--color-text);
  }
  .pool-item:hover { border-color: var(--color-primary); }
  .pool-pair { font-family: var(--font-mono); font-weight: 600; }
  .pool-stat { font-size: 0.8rem; color: var(--color-text-muted); font-family: var(--font-mono); }
  .pool-badge { padding: 2px 8px; border-radius: var(--radius-sm); font-size: 0.75rem; }
  .pool-badge.active { background: var(--color-success); color: white; }
  .pool-badge.paused { background: var(--color-danger); color: white; }
</style>
