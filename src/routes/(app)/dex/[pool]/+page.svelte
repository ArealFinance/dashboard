<script lang="ts">
  import { page } from '$app/stores';
  import { dexStore } from '$lib/stores/dex';
  import { formatAddress } from '$lib/utils/format';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: poolAddr = ($page.params as { pool?: string }).pool ?? '';
  $: pool = $dexStore.pools.find(p => p.pda === poolAddr);

  // H-6: BigInt-safe price + TVL. Scale before Number cast so reserves above
  // 2^53 don't silently lose precision.
  function microToNumber(v: bigint | undefined, fallback = 0): number {
    if (v === undefined) return fallback;
    const whole = v / 1_000_000n;
    const frac = v % 1_000_000n;
    return Number(whole) + Number(frac) / 1_000_000;
  }
  $: priceDisplay = pool && pool.reserveA > 0n
    ? (Number((pool.reserveB * 1_000_000n) / pool.reserveA) / 1_000_000).toFixed(6)
    : '—';
  $: tvlA = pool ? microToNumber(pool.reserveA) : 0;
  $: tvlB = pool ? microToNumber(pool.reserveB) : 0;
  $: feesAccum = pool ? microToNumber(pool.totalFeesAccumulated) : 0;
</script>

<div class="page">
  {#if !pool}
    <p class="muted">Pool not found: {formatAddress(poolAddr, 8)}</p>
    <p class="muted">Navigate from the DEX page to load pool data first.</p>
  {:else}
    <h1>Pool Detail</h1>
    <p class="subtitle">
      {formatAddress(pool.tokenAMint, 6)} / {formatAddress(pool.tokenBMint, 6)}
      {#if pool.poolType === 1}
        <span class="badge concentrated">Concentrated</span>
      {:else}
        <span class="badge standard">Standard</span>
      {/if}
      {#if pool.hasOtTreasury}
        <span class="badge ot">OT Pair</span>
      {/if}
    </p>

    {#if pool.poolType === 1}
      <div class="stats-grid" style="margin-bottom: var(--space-2);">
        <div class="stat-card">
          <span class="stat-label">Bin Step</span>
          <span class="stat-value">{pool.binStepBps / 100}%</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Active Bin</span>
          <span class="stat-value">{pool.activeBinId}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Bin Price</span>
          <span class="stat-value">{Math.pow(1 + pool.binStepBps / 10000, pool.activeBinId).toFixed(6)}</span>
        </div>
      </div>
    {/if}

    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Price (B/A)</span>
        <span class="stat-value">{priceDisplay}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Reserve A</span>
        <span class="stat-value">{tvlA.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Reserve B</span>
        <span class="stat-value">{tvlB.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Total LP Shares</span>
        <span class="stat-value">{pool.totalLpShares.toString()}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Fees Accumulated</span>
        <span class="stat-value">{feesAccum.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Fee</span>
        <span class="stat-value">{pool.feeBps / 100}%{pool.hasOtTreasury ? ' + 0.5% OT' : ''}</span>
      </div>
    </div>

    <div class="card">
      <h2>Pool Info</h2>
      <div class="details">
        <div class="row"><span class="label">PDA</span><CopyAddress address={pool.pda} /></div>
        <div class="row"><span class="label">Token A</span><CopyAddress address={pool.tokenAMint} /></div>
        <div class="row"><span class="label">Token B</span><CopyAddress address={pool.tokenBMint} /></div>
        <div class="row"><span class="label">Vault A</span><CopyAddress address={pool.vaultA} /></div>
        <div class="row"><span class="label">Vault B</span><CopyAddress address={pool.vaultB} /></div>
        <div class="row"><span class="label">Status</span>
          <span class="badge" class:active={pool.isActive} class:paused={!pool.isActive}>
            {pool.isActive ? 'Active' : 'Paused'}
          </span>
        </div>
        {#if pool.hasOtTreasury}
          <div class="row"><span class="label">OT Treasury Fee Dest</span><CopyAddress address={pool.otTreasuryFeeDestination} /></div>
        {/if}
      </div>
    </div>

    <div class="nav-buttons">
      <a href="/dex/{pool.pda}/swap" class="nav-btn">Swap</a>
      <a href="/dex/{pool.pda}/liquidity" class="nav-btn">Liquidity</a>
      {#if pool.poolType === 1}
        <a href="/dex/{pool.pda}/bins" class="nav-btn bins">Bins</a>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 900px; }
  .subtitle { color: var(--color-text-muted); margin-bottom: var(--space-4); }
  .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); margin-bottom: var(--space-4); }
  .stat-card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); padding: var(--space-3);
    display: flex; flex-direction: column; gap: 4px;
  }
  .stat-label { font-size: 0.75rem; color: var(--color-text-muted); text-transform: uppercase; }
  .stat-value { font-family: var(--font-mono); font-size: 1.1rem; font-weight: 600; }
  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-3) 0; font-size: 1.1rem; }
  .details { display: flex; flex-direction: column; gap: var(--space-2); }
  .row { display: flex; align-items: center; gap: var(--space-2); }
  .label { font-size: 0.8rem; color: var(--color-text-muted); min-width: 120px; }
  .badge { padding: 2px 8px; border-radius: var(--radius-sm); font-size: 0.8rem; }
  .badge.active { background: var(--color-success); color: white; }
  .badge.paused { background: var(--color-danger); color: white; }
  .badge.ot { background: var(--color-primary); color: white; margin-left: 8px; }
  .badge.concentrated { background: #f59e0b; color: #1a1a2e; margin-left: 8px; }
  .badge.standard { background: var(--color-border); color: var(--color-text-muted); margin-left: 8px; }
  .nav-btn.bins { background: #f59e0b; color: #1a1a2e; }
  .nav-buttons { display: flex; gap: var(--space-3); }
  .nav-btn {
    padding: 12px 24px; background: var(--color-primary); color: white;
    border-radius: var(--radius-md); text-decoration: none; font-weight: 600;
  }
  .nav-btn:hover { opacity: 0.9; }
  .muted { color: var(--color-text-muted); }
</style>
