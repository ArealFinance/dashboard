<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { dexStore, dexClient, type BinArrayState } from '$lib/stores/dex';
  import { findBinArrayPda } from '$lib/utils/pda';
  import { formatAddress } from '$lib/utils/format';
  import { connection } from '$lib/stores/network';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { devKeys } from '$lib/stores/devkeys';
  import TxStatus from '$lib/components/TxStatus.svelte';

  $: poolAddr = ($page.params as any).pool ?? '';
  $: pool = $dexStore.pools.find(p => p.pda === poolAddr);

  let binArray: BinArrayState | null = null;
  let loading = true;
  let error = '';

  // Manual shift form
  let shiftNavBin = 0;
  let shiftBinCount = 40;
  let txStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let txSig = '';

  onMount(async () => {
    if (!poolAddr) return;
    await loadBins();
  });

  async function loadBins() {
    loading = true;
    error = '';
    try {
      const poolPda = new PublicKey(poolAddr);
      binArray = await dexStore.fetchBinArray(poolPda);
      if (!binArray) error = 'BinArray not found (pool may be StandardCurve)';
    } catch (e: any) {
      error = e.message;
    }
    loading = false;
  }

  // Computed bin visualization data
  $: maxLiquidity = binArray ? Math.max(
    ...binArray.bins.map(b => Number(b.liquidityA) + Number(b.liquidityB)),
    1 // prevent division by zero
  ) : 1;

  $: activeBinIndex = binArray ? binArray.activeBinId - binArray.lowerBinId : -1;

  // NAV bin calculation (client-side from pool price)
  $: navBinId = pool && pool.binStepBps > 0
    ? Math.round(Math.log(pool.price || 1) / Math.log(1 + pool.binStepBps / 10000))
    : 0;
  $: navBinIndex = binArray ? navBinId - binArray.lowerBinId : -1;

  async function handleShift() {
    if (!pool || !binArray) return;
    txStatus = 'signing';
    txSig = '';
    try {
      const client = get(dexClient);
      const conn = get(connection);
      const deployer = devKeys.getActiveKeypair();
      if (!deployer) { txStatus = 'error'; error = 'No active keypair'; return; }

      const poolPda = new PublicKey(poolAddr);
      const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('dex_config')], client.programId);
      const [binPda] = findBinArrayPda(poolPda, client.programId);

      const tx = client.buildTransaction('shift_liquidity', {
        accounts: {
          rebalancer: deployer.publicKey,
          dex_config: configPda,
          pool_state: poolPda,
          bin_array: binPda,
        },
        args: {
          nav_bin: shiftNavBin,
          target_bin_count: shiftBinCount,
        },
      });

      txStatus = 'sending';
      txSig = await signAndSendTransaction(conn, tx, [deployer]);
      txStatus = 'success';
      await loadBins();
    } catch (e: any) {
      txStatus = 'error';
      error = e.message;
    }
  }
</script>

<div class="page">
  <div class="header">
    <a href="/dex/{poolAddr}" class="back">&larr; Pool</a>
    <h1>Bin Visualization</h1>
    {#if pool}
      <p class="subtitle">{formatAddress(pool.tokenAMint, 6)} / {formatAddress(pool.tokenBMint, 6)}</p>
    {/if}
  </div>

  {#if loading}
    <p class="muted">Loading bins...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if binArray}
    <div class="info-row">
      <div class="info-item">
        <span class="info-label">Lower Bin ID</span>
        <span class="info-value">{binArray.lowerBinId}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Active Bin</span>
        <span class="info-value highlight">{binArray.activeBinId}</span>
      </div>
      <div class="info-item">
        <span class="info-label">NAV Bin (est.)</span>
        <span class="info-value nav">{navBinId}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Bin Step</span>
        <span class="info-value">{binArray.binStepBps / 100}%</span>
      </div>
      <div class="info-item">
        <span class="info-label">Pool Price</span>
        <span class="info-value">{pool ? pool.price.toFixed(6) : '—'}</span>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart">
        {#each binArray.bins as bin, i}
          {@const binId = binArray.lowerBinId + i}
          {@const totalLiq = Number(bin.liquidityA) + Number(bin.liquidityB)}
          {@const heightPct = (totalLiq / maxLiquidity) * 100}
          {@const aShare = totalLiq > 0 ? Number(bin.liquidityA) / totalLiq : 0}
          {@const bShare = totalLiq > 0 ? Number(bin.liquidityB) / totalLiq : 0}
          {@const isActive = i === activeBinIndex}
          {@const isNav = i === navBinIndex}
          <div
            class="bin-bar"
            class:active-bin={isActive}
            class:nav-bin={isNav}
            title="Bin {binId}: A={Number(bin.liquidityA)} B={Number(bin.liquidityB)}"
          >
            <div class="bar-fill" style="height: {heightPct}%;">
              <div class="bar-ask" style="height: {aShare * 100}%;"></div>
              <div class="bar-bid" style="height: {bShare * 100}%;"></div>
            </div>
            {#if isActive}
              <div class="marker active-marker" title="Active Bin">A</div>
            {/if}
            {#if isNav}
              <div class="marker nav-marker" title="NAV Bin">N</div>
            {/if}
          </div>
        {/each}
      </div>
      <div class="legend">
        <span class="legend-item"><span class="legend-color ask"></span> RWT (Ask)</span>
        <span class="legend-item"><span class="legend-color bid"></span> USDC (Bid)</span>
        <span class="legend-item"><span class="legend-color active-legend"></span> Active Bin</span>
        <span class="legend-item"><span class="legend-color nav-legend"></span> NAV Bin</span>
      </div>
    </div>

    <div class="card">
      <h2>Manual Shift (Testing)</h2>
      <div class="form-row">
        <label>
          <span>NAV Bin</span>
          <input type="number" bind:value={shiftNavBin} />
        </label>
        <label>
          <span>Target Bin Count</span>
          <input type="number" bind:value={shiftBinCount} min="1" max="70" />
        </label>
        <button on:click={handleShift} disabled={txStatus === 'sending'}>
          Shift Liquidity
        </button>
      </div>
      {#if txStatus}
        <TxStatus status={txStatus} signature={txSig} {error} />
      {/if}
    </div>
  {:else}
    <p class="muted">No bin data available</p>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 1100px; }
  .header { margin-bottom: var(--space-4); }
  .back { color: var(--color-primary); text-decoration: none; font-size: 0.85rem; }
  .back:hover { text-decoration: underline; }
  .subtitle { color: var(--color-text-muted); margin: 0; }
  .muted { color: var(--color-text-muted); }
  .error { color: var(--color-danger); }

  .info-row {
    display: flex; gap: var(--space-3); flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .info-item {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); padding: var(--space-2) var(--space-3);
    display: flex; flex-direction: column; gap: 2px;
  }
  .info-label { font-size: 0.7rem; color: var(--color-text-muted); text-transform: uppercase; }
  .info-value { font-family: var(--font-mono); font-weight: 600; }
  .info-value.highlight { color: var(--color-success); }
  .info-value.nav { color: #f59e0b; }

  .chart-container {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .chart {
    display: flex; align-items: flex-end; gap: 1px;
    height: 300px; position: relative;
  }
  .bin-bar {
    flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
    position: relative; min-width: 0; height: 100%;
  }
  .bar-fill {
    display: flex; flex-direction: column; width: 100%;
    border-radius: 2px 2px 0 0; overflow: hidden;
  }
  .bar-ask { background: var(--color-primary); opacity: 0.85; }
  .bar-bid { background: #3b82f6; opacity: 0.85; }

  .bin-bar.active-bin { outline: 2px solid var(--color-success); outline-offset: -1px; border-radius: 2px; }
  .bin-bar.nav-bin { outline: 2px dashed #f59e0b; outline-offset: -1px; border-radius: 2px; }

  .marker {
    position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%);
    font-size: 0.6rem; font-weight: 700; width: 14px; height: 14px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
  }
  .active-marker { background: var(--color-success); color: white; }
  .nav-marker { background: #f59e0b; color: #1a1a2e; }

  .legend {
    display: flex; gap: var(--space-4); margin-top: var(--space-4);
    padding-top: var(--space-3); border-top: 1px solid var(--color-border);
  }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--color-text-muted); }
  .legend-color { width: 12px; height: 12px; border-radius: 2px; }
  .legend-color.ask { background: var(--color-primary); }
  .legend-color.bid { background: #3b82f6; }
  .legend-color.active-legend { background: var(--color-success); }
  .legend-color.nav-legend { background: #f59e0b; }

  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-3) 0; font-size: 1.1rem; }
  .form-row { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
  .form-row label { display: flex; flex-direction: column; gap: 4px; }
  .form-row label span { font-size: 0.8rem; color: var(--color-text-muted); }
  .form-row input {
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); padding: 8px 12px;
    color: var(--color-text); font-family: var(--font-mono);
    width: 140px;
  }
  .form-row button {
    padding: 8px 20px; background: #f59e0b; color: #1a1a2e;
    border: none; border-radius: var(--radius-sm); font-weight: 600;
    cursor: pointer;
  }
  .form-row button:disabled { opacity: 0.5; cursor: not-allowed; }
  .form-row button:hover:not(:disabled) { opacity: 0.9; }
</style>
