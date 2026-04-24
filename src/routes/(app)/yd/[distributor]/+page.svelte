<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getDistributorContext } from './context';
  import {
    ydStore,
    calculateTotalVested,
    calculateClaimable,
    type YdDistributorState
  } from '$lib/stores/yd';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { formatAddress, formatTimestamp } from '$lib/utils/format';
  import { bytesToHex } from '$lib/utils/merkle';
  import { ArrowLeft, Wallet2, DollarSign, RefreshCw } from 'lucide-svelte';

  const RWT_DECIMALS = 6;
  const MIN_VESTED = 1_000_000n;

  const { distributor, claimStatus, loading, refresh } = getDistributorContext();

  $: d = $distributor;
  $: cs = $claimStatus;
  $: config = $ydStore.config;

  let nowSecs = BigInt(Math.floor(Date.now() / 1000));
  let timer: any = null;
  onMount(() => {
    timer = setInterval(() => { nowSecs = BigInt(Math.floor(Date.now() / 1000)); }, 1000);
  });
  onDestroy(() => { if (timer) clearInterval(timer); });

  function formatRwt(amount: bigint): string {
    const divisor = BigInt(10 ** RWT_DECIMALS);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(RWT_DECIMALS, '0').replace(/0+$/, '');
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  $: totalVested = d ? calculateTotalVested(d, nowSecs, MIN_VESTED) : 0n;
  $: vestedPct = d && d.totalFunded > 0n
    ? Math.max(0, Math.min(100, Number(totalVested) / Number(d.totalFunded) * 100))
    : 0;
  $: claimedPct = d && d.totalFunded > 0n
    ? Math.max(0, Math.min(100, Number(d.totalClaimed) / Number(d.totalFunded) * 100))
    : 0;

  $: vestingElapsed = d ? nowSecs - d.lastFundTs : 0n;
  $: vestingFraction = d && d.vestingPeriodSecs > 0n
    ? Number(vestingElapsed < d.vestingPeriodSecs ? vestingElapsed : d.vestingPeriodSecs)
      / Number(d.vestingPeriodSecs)
    : 0;

  function rootDisplay(d: YdDistributorState): string {
    const hex = bytesToHex(d.merkleRoot);
    if (hex === '0'.repeat(64)) return '— (not published)';
    return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
  }
</script>

<div class="page-header">
  <a href="/yd" class="back-link"><ArrowLeft size={14} /> Back</a>
  <div class="header-actions">
    <button class="btn btn-ghost" on:click={refresh} disabled={$loading}>
      <RefreshCw size={14} class={$loading ? 'spin' : ''} />
      Refresh
    </button>
  </div>
</div>

{#if !d}
  {#if $loading}
    <p class="text-muted">Loading distributor...</p>
  {:else}
    <div class="card"><div class="card-body">
      <p class="text-muted">Distributor not found at this address.</p>
    </div></div>
  {/if}
{:else}
  <h1 class="title">Distributor</h1>
  <div class="subtitle">
    <CopyAddress address={d.address} />
    <span class="badge" class:badge-success={d.isActive} class:badge-danger={!d.isActive}>
      {d.isActive ? 'Active' : 'Closed'}
    </span>
  </div>

  <!-- Top stats row -->
  <div class="grid-3">
    <div class="stat-card">
      <div class="stat-label">Total Funded</div>
      <div class="stat-value mono">{formatRwt(d.totalFunded)}</div>
      <div class="stat-sub">RWT</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Claimed</div>
      <div class="stat-value mono">{formatRwt(d.totalClaimed)}</div>
      <div class="stat-sub">RWT ({claimedPct.toFixed(1)}%)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Vested (now)</div>
      <div class="stat-value mono">{formatRwt(totalVested)}</div>
      <div class="stat-sub">RWT ({vestedPct.toFixed(1)}%)</div>
    </div>
  </div>

  <!-- Vesting visualization -->
  <div class="card">
    <div class="card-header"><h3>Vesting Progress</h3></div>
    <div class="card-body">
      <div class="progress-wrap">
        <div class="progress-label">
          <span>Total vested</span>
          <span class="mono">{formatRwt(totalVested)} / {formatRwt(d.totalFunded)}</span>
        </div>
        <div class="progress">
          <div class="progress-bar progress-vested" style={`width:${vestedPct}%`}></div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-label">
          <span>Claimed</span>
          <span class="mono">{formatRwt(d.totalClaimed)} / {formatRwt(d.maxTotalClaim)}</span>
        </div>
        <div class="progress">
          <div class="progress-bar progress-claimed" style={`width:${claimedPct}%`}></div>
        </div>
      </div>
      <div class="info-row">
        <span class="info-label">Locked Vested (on-chain)</span>
        <span class="info-value mono">{formatRwt(d.lockedVested)} RWT</span>
      </div>
      <div class="info-row">
        <span class="info-label">Vesting Period</span>
        <span class="info-value mono">{d.vestingPeriodSecs.toString()} sec</span>
      </div>
      <div class="info-row">
        <span class="info-label">Last Fund</span>
        <span class="info-value mono">{formatTimestamp(d.lastFundTs)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Current Vesting Fraction</span>
        <span class="info-value mono">{(vestingFraction * 100).toFixed(2)}%</span>
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-header"><h3>State</h3></div>
      <div class="card-body">
        <div class="info-row"><span class="info-label">Epoch</span><span class="info-value mono">{d.epoch.toString()}</span></div>
        <div class="info-row"><span class="info-label">Merkle Root</span><span class="info-value mono" title={bytesToHex(d.merkleRoot)}>{rootDisplay(d)}</span></div>
        <div class="info-row"><span class="info-label">Max Total Claim</span><span class="info-value mono">{formatRwt(d.maxTotalClaim)}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>Addresses</h3></div>
      <div class="card-body">
        <div class="info-row"><span class="info-label">OT Mint</span><CopyAddress address={d.otMint} /></div>
        <div class="info-row"><span class="info-label">Reward Vault</span><CopyAddress address={d.rewardVault} /></div>
        <div class="info-row"><span class="info-label">Accumulator</span><CopyAddress address={d.accumulator} /></div>
      </div>
    </div>
  </div>

  <!-- User position -->
  {#if cs}
    <div class="card">
      <div class="card-header"><h3>Your Claim Status</h3></div>
      <div class="card-body">
        <div class="info-row">
          <span class="info-label">Claimant</span>
          <CopyAddress address={cs.claimant} />
        </div>
        <div class="info-row">
          <span class="info-label">Total Claimed</span>
          <span class="info-value mono">{formatRwt(cs.claimedAmount)} RWT</span>
        </div>
      </div>
    </div>
  {/if}

  <div class="actions">
    <a href={`/yd/${d.address}/fund`} class="action-card">
      <DollarSign size={18} />
      <div>
        <div class="a-title">Fund</div>
        <div class="a-sub">Deposit RWT into this distributor</div>
      </div>
    </a>
    <a href={`/yd/${d.address}/claim`} class="action-card">
      <Wallet2 size={18} />
      <div>
        <div class="a-title">Claim</div>
        <div class="a-sub">Claim your vested RWT rewards</div>
      </div>
    </a>
  </div>
{/if}

<style>
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }
  .back-link { color: var(--color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-sm); }
  .header-actions { display: flex; gap: var(--space-2); }

  .title { font-size: var(--text-2xl); font-weight: 700; margin: 0 0 var(--space-1); }
  .subtitle { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-5); }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-4); }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-4); }

  .stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }
  .stat-label { font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: var(--text-xl); font-weight: 700; margin-top: var(--space-1); }
  .stat-sub { font-size: var(--text-xs); color: var(--color-text-secondary); margin-top: 2px; }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: var(--space-4);
  }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .info-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .info-value { font-family: var(--font-mono); font-size: var(--text-sm); }

  .progress-wrap { margin-bottom: var(--space-3); }
  .progress-label { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: 4px; }
  .progress { height: 8px; background: var(--color-bg); border-radius: 999px; overflow: hidden; }
  .progress-bar { height: 100%; border-radius: 999px; transition: width 0.3s; }
  .progress-vested { background: linear-gradient(90deg, var(--color-primary) 0%, var(--color-success) 100%); }
  .progress-claimed { background: var(--color-text-muted); }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .action-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    text-decoration: none;
    color: inherit;
    transition: all 0.15s;
  }
  .action-card:hover { border-color: var(--color-primary); background: var(--color-surface-hover); text-decoration: none; }
  .a-title { font-size: var(--text-md); font-weight: 600; color: var(--color-text); }
  .a-sub { font-size: var(--text-xs); color: var(--color-text-secondary); }

  .badge { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-sm); font-weight: 500; }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }

  .btn { display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: 1px solid transparent; text-decoration: none; }
  .btn-ghost { background: transparent; color: var(--color-text-secondary); border-color: var(--color-border); }
  .btn-ghost:hover:not(:disabled) { color: var(--color-text); background: var(--color-surface-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .mono { font-family: var(--font-mono); }
  .text-muted { color: var(--color-text-muted); }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
