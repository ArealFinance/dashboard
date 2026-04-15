<script lang="ts">
  import { page } from '$app/stores';
  import { dexStore } from '$lib/stores/dex';
  import { formatAddress } from '$lib/utils/format';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: poolAddr = ($page.params as any).pool ?? '';
  $: pool = $dexStore.pools.find(p => p.pda === poolAddr);

  $: priceDisplay = pool ? (Number(pool.reserveB) / Number(pool.reserveA)).toFixed(6) : '—';
  $: tvlA = pool ? Number(pool.reserveA) / 1_000_000 : 0;
  $: tvlB = pool ? Number(pool.reserveB) / 1_000_000 : 0;
  $: feesAccum = pool ? Number(pool.totalFeesAccumulated) / 1_000_000 : 0;
</script>

<div class="page">
  {#if !pool}
    <p class="muted">Pool not found: {formatAddress(poolAddr, 8)}</p>
    <p class="muted">Navigate from the DEX page to load pool data first.</p>
  {:else}
    <h1>Pool Detail</h1>
    <p class="subtitle">
      {formatAddress(pool.tokenAMint, 6)} / {formatAddress(pool.tokenBMint, 6)}
      {#if pool.hasOtTreasury}
        <span class="badge ot">OT Pair</span>
      {/if}
    </p>

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
  .nav-buttons { display: flex; gap: var(--space-3); }
  .nav-btn {
    padding: 12px 24px; background: var(--color-primary); color: white;
    border-radius: var(--radius-md); text-decoration: none; font-weight: 600;
  }
  .nav-btn:hover { opacity: 0.9; }
  .muted { color: var(--color-text-muted); }
</style>
