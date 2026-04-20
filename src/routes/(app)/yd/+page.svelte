<script lang="ts">
  import { ydStore, ydProgramId } from '$lib/stores/yd';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { formatAddress } from '$lib/utils/format';
  import { Shield, RefreshCw } from 'lucide-svelte';

  const RWT_DECIMALS = 6;

  $: config = $ydStore.config;
  $: distributors = $ydStore.distributors;
  $: loading = $ydStore.loading;
  $: error = $ydStore.error;

  function formatRwt(amount: bigint): string {
    const divisor = BigInt(10 ** RWT_DECIMALS);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(RWT_DECIMALS, '0').replace(/0+$/, '');
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  function vestedPct(d: { totalFunded: bigint; lockedVested: bigint }): number {
    if (d.totalFunded === 0n) return 0;
    const n = Number(d.lockedVested) / Number(d.totalFunded);
    return Math.max(0, Math.min(100, n * 100));
  }

  function claimedPct(d: { totalFunded: bigint; totalClaimed: bigint }): number {
    if (d.totalFunded === 0n) return 0;
    const n = Number(d.totalClaimed) / Number(d.totalFunded);
    return Math.max(0, Math.min(100, n * 100));
  }

  function handleRefresh() {
    ydStore.refresh();
  }
</script>

<div class="page-header">
  <div>
    <h1>Yield Distribution</h1>
    <p class="page-description">
      Merkle-based RWT rewards distribution with per-deposit vesting for OT holders
    </p>
  </div>
  <div class="header-actions">
    <button class="btn btn-ghost" on:click={handleRefresh} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'spin' : ''} />
      Refresh
    </button>
    <a href="/yd/admin" class="btn btn-primary">
      <Shield size={14} />
      Admin
    </a>
  </div>
</div>

{#if error}
  <div class="alert alert-error">
    <strong>Load error:</strong> {error}
    <p class="text-muted">
      This may mean YD program is not yet deployed. Deploy the contract and reload.
    </p>
  </div>
{/if}

<div class="section-title">Program</div>
<div class="card compact">
  <div class="info-row">
    <span class="info-label">Program ID</span>
    <CopyAddress address={ydProgramId.toBase58()} />
  </div>
</div>

<div class="section-title">Distribution Config</div>
{#if !config}
  <div class="card">
    <div class="card-body">
      <p class="text-muted">Config not initialized.</p>
      <a href="/yd/admin" class="btn btn-primary">Initialize Config</a>
    </div>
  </div>
{:else}
  <div class="card">
    <div class="card-body">
      <div class="info-grid">
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="badge" class:badge-success={config.isActive} class:badge-danger={!config.isActive}>
            {config.isActive ? 'Active' : 'Paused'}
          </span>
        </div>
        <div class="info-row">
          <span class="info-label">Protocol Fee</span>
          <span class="info-value">{(config.protocolFeeBps / 100).toFixed(2)}%</span>
        </div>
        <div class="info-row">
          <span class="info-label">Min Distribution</span>
          <span class="info-value">{formatRwt(config.minDistributionAmount)} RWT</span>
        </div>
        <div class="info-row">
          <span class="info-label">Authority</span>
          <CopyAddress address={config.authority} />
        </div>
        <div class="info-row">
          <span class="info-label">Publish Authority</span>
          <CopyAddress address={config.publishAuthority} />
        </div>
        <div class="info-row">
          <span class="info-label">Fee Destination</span>
          <CopyAddress address={config.arealFeeDestination} />
        </div>
        {#if config.hasPending}
          <div class="info-row">
            <span class="info-label">Pending Authority</span>
            <CopyAddress address={config.pendingAuthority} />
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<div class="section-title">
  Distributors
  <span class="count">{distributors.length}</span>
</div>

{#if !config}
  <p class="text-muted">Initialize config first to create distributors.</p>
{:else if distributors.length === 0}
  <div class="card">
    <div class="card-body">
      <p class="text-muted">No distributors created yet. Use Admin → Create Distributor.</p>
    </div>
  </div>
{:else}
  <div class="distributor-grid">
    {#each distributors as d}
      <a class="distributor-card" href={`/yd/${d.address}`}>
        <div class="d-header">
          <div>
            <div class="d-title">OT Distributor</div>
            <div class="d-subtitle mono">{formatAddress(d.otMint, 6)}</div>
          </div>
          <span class="badge" class:badge-success={d.isActive} class:badge-danger={!d.isActive}>
            {d.isActive ? 'Active' : 'Closed'}
          </span>
        </div>
        <div class="d-stats">
          <div class="stat">
            <div class="stat-label">Funded</div>
            <div class="stat-value mono">{formatRwt(d.totalFunded)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Claimed</div>
            <div class="stat-value mono">{formatRwt(d.totalClaimed)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Epoch</div>
            <div class="stat-value mono">{d.epoch.toString()}</div>
          </div>
        </div>
        <div class="progress-wrap">
          <div class="progress-label">
            <span>Vested</span>
            <span class="mono">{vestedPct(d).toFixed(1)}%</span>
          </div>
          <div class="progress">
            <div class="progress-bar progress-vested" style={`width:${vestedPct(d)}%`}></div>
          </div>
        </div>
        <div class="progress-wrap">
          <div class="progress-label">
            <span>Claimed</span>
            <span class="mono">{claimedPct(d).toFixed(1)}%</span>
          </div>
          <div class="progress">
            <div class="progress-bar progress-claimed" style={`width:${claimedPct(d)}%`}></div>
          </div>
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; color: var(--color-text); margin: 0; }
  .page-description { color: var(--color-text-secondary); margin-top: var(--space-1); font-size: var(--text-sm); max-width: 56ch; }
  .header-actions { display: flex; gap: var(--space-2); align-items: center; }

  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: var(--space-6) 0 var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .count {
    background: var(--color-primary-muted, rgba(139, 92, 246, 0.15));
    color: var(--color-primary);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .card.compact { padding: var(--space-3) var(--space-4); }
  .card-body { padding: var(--space-4); }

  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2) var(--space-6); }
  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-1) 0;
    min-width: 0;
  }
  .info-label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .info-value { font-family: var(--font-mono); font-size: var(--text-sm); }

  .badge { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-sm); font-weight: 500; }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }

  .distributor-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-4);
  }
  .distributor-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    text-decoration: none;
    color: inherit;
    transition: all 0.15s;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .distributor-card:hover {
    border-color: var(--color-primary);
    background: var(--color-surface-hover);
    text-decoration: none;
  }
  .d-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .d-title { font-size: var(--text-md); font-weight: 600; color: var(--color-text); }
  .d-subtitle { color: var(--color-text-muted); font-size: var(--text-xs); margin-top: 2px; font-family: var(--font-mono); }

  .d-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-2); padding: var(--space-3) 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); }
  .stat-label { font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: var(--text-sm); font-weight: 600; margin-top: 2px; }
  .mono { font-family: var(--font-mono); }

  .progress-wrap { display: flex; flex-direction: column; gap: 4px; }
  .progress-label { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .progress { height: 6px; background: var(--color-bg); border-radius: 999px; overflow: hidden; }
  .progress-bar { height: 100%; border-radius: 999px; transition: width 0.3s; }
  .progress-vested { background: linear-gradient(90deg, var(--color-primary) 0%, var(--color-success) 100%); }
  .progress-claimed { background: var(--color-text-muted); }

  .btn { display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: 1px solid transparent; text-decoration: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; text-decoration: none; }
  .btn-ghost { background: transparent; color: var(--color-text-secondary); border-color: var(--color-border); }
  .btn-ghost:hover:not(:disabled) { color: var(--color-text); background: var(--color-surface-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
  .alert-error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: var(--color-danger); }
  .alert p { margin: var(--space-1) 0 0; }

  .text-muted { color: var(--color-text-muted); }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
