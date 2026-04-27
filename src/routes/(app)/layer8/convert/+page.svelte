<script lang="ts">
  import { onMount } from 'svelte';
  import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
  import { Repeat, RefreshCw, AlertTriangle } from 'lucide-svelte';
  import {
    ydStore,
    ydProgramId,
    getAccumulatorPda,
  } from '$lib/stores/yd';
  import { rwtProgramId } from '$lib/stores/rwt';
  import { dexStore, dexProgramId } from '$lib/stores/dex';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { connection } from '$lib/stores/network';
  import { wallet } from '$lib/stores/wallet';
  import { fetchStreamConvertedEvents, type StreamConvertedEvent } from '$lib/api/layer8';
  import { findAta, USDC_MINTS } from '$lib/utils/pda';
  import { network } from '$lib/stores/network';
  import { formatAmount, formatAddress, parseDecimal } from '$lib/utils/format';
  import {
    buildConvertToRwtIx,
    buildComputeBudgetIxs,
    CU_BUDGETS,
  } from '$lib/utils/layer8-builders';
  import {
    resolveConvertAccounts,
    resolveRwtUsdcMasterPool,
  } from '$lib/utils/layer8-resolvers';
  import ConvertMetadataCard from '$lib/components/layer8/ConvertMetadataCard.svelte';
  import ManualTriggerModal from '$lib/components/layer8/ManualTriggerModal.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  const USDC_DECIMALS = 6;
  const RWT_DECIMALS = 6;

  interface AccumRow {
    otMint: string;
    distributor: string;
    accumulator: string;
    accumulatorUsdcAta: string;
    usdcBalance: bigint;
  }

  let rows: AccumRow[] = [];
  let events: StreamConvertedEvent[] = [];
  let loading = false;
  let error: string | null = null;

  let modalOpen = false;
  let selectedRow: AccumRow | null = null;
  let usdcAmountInput = '';
  let minRwtOutInput = '';
  let swapFirst = true;

  $: walletState = $wallet;
  $: usdcMint = USDC_MINTS[$network] ?? null;

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      await ydStore.refresh();
      const conn = $connection;
      if (!usdcMint) {
        error = `No USDC mint configured for cluster "${$network}"`;
        loading = false;
        return;
      }
      const distState = $ydStore;
      const newRows: AccumRow[] = [];
      for (const d of distState.distributors) {
        const otMintPk = new PublicKey(d.otMint);
        const [accumulatorPk] = getAccumulatorPda(otMintPk);
        const usdcAta = findAta(accumulatorPk, usdcMint);
        let balance = 0n;
        try {
          const info = await conn.getAccountInfo(usdcAta, 'confirmed');
          if (info && info.data.length >= 72) {
            const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
            balance = view.getBigUint64(64, true);
          }
        } catch {
          balance = 0n;
        }
        newRows.push({
          otMint: d.otMint,
          distributor: d.address,
          accumulator: accumulatorPk.toBase58(),
          accumulatorUsdcAta: usdcAta.toBase58(),
          usdcBalance: balance,
        });
      }
      rows = newRows;

      events = await fetchStreamConvertedEvents(conn, ydProgramId, undefined, {
        limit: 25,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    // Ensure DEX config + master pool are loaded for the convert resolver.
    void dexStore.refresh();
  });

  function openModal(row: AccumRow): void {
    selectedRow = row;
    usdcAmountInput = formatAmount(row.usdcBalance, USDC_DECIMALS).replace(/,/g, '');
    minRwtOutInput = '0';
    swapFirst = true;
    modalOpen = true;
  }

  function validateModal(): void {
    if (!selectedRow) throw new Error('No accumulator selected');
    const usdc = parseDecimal(usdcAmountInput, USDC_DECIMALS);
    if (usdc <= 0n) throw new Error('USDC amount must be greater than zero');
    if (usdc > selectedRow.usdcBalance) {
      throw new Error(
        `USDC amount (${formatAmount(usdc, USDC_DECIMALS)}) exceeds accumulator balance (${formatAmount(selectedRow.usdcBalance, USDC_DECIMALS)})`,
      );
    }
    // D1: outer slippage protection. Inner CPIs use min=1; outer must be > 0
    // so the contract's `rwt_acquired < min_rwt_out` revert path catches a
    // bad swap.
    const minRwt = parseDecimal(minRwtOutInput, RWT_DECIMALS);
    if (minRwt <= 0n) {
      throw new Error('Min RWT out must be > 0 (slippage protection — D1).');
    }
  }

  async function buildModalIx(): Promise<TransactionInstruction[]> {
    if (!selectedRow) throw new Error('No accumulator selected');
    if (!walletState.publicKey) throw new Error('Wallet not connected');
    if (!usdcMint) throw new Error('No USDC mint for current cluster');

    const conn = $connection;
    const dex = $dexStore;
    if (!dex.config || !dex.configPda) {
      throw new Error('DEX state not loaded — refresh DEX first.');
    }

    // Resolve the master RWT/USDC pool. SD-21: env-override or canonical-derive.
    // We need the RWT mint first to derive the canonical seed pair — the
    // resolveConvertAccounts call also reads RwtVault, so we'd double-fetch
    // if we read it here too. Pull RWT mint from the resolved RwtVault state
    // by doing a single bottleneck read.
    const env = (typeof import.meta !== 'undefined' && import.meta.env)
      ? import.meta.env
      : ({} as ImportMetaEnv);
    const envOverride = (env as any).PUBLIC_RWT_USDC_POOL as string | undefined;

    // Read RwtVault once so we know the RWT mint for the master pool derivation.
    // (resolveConvertAccounts will read it again; the small redundancy is
    // worth keeping the resolver pure / single-purpose.)
    const { readRwtVault } = await import('$lib/api/layer8');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [rwtVaultPda] = findRwtVaultPda(rwtProgramId);
    const rwtVault = await readRwtVault(conn, rwtVaultPda);
    if (!rwtVault) {
      throw new Error('RwtVault not initialized — run RWT Engine setup first.');
    }
    const rwtMint = new PublicKey(rwtVault.rwtMint);

    const masterPoolPda = resolveRwtUsdcMasterPool(
      envOverride,
      rwtMint,
      usdcMint,
      dexProgramId,
      $network,
    );

    // Refresh the master pool state into dex store so we can read vault
    // assignments for the swap direction.
    let pool = dex.pools.find((p) => p.pda === masterPoolPda.toBase58());
    if (!pool) {
      // Try to load it via the canonical-order helper.
      const a = rwtMint.toBuffer();
      const b = usdcMint.toBuffer();
      const cmp = Buffer.compare(a, b);
      const [tokenA, tokenB] = cmp <= 0 ? [rwtMint, usdcMint] : [usdcMint, rwtMint];
      pool = await dexStore.refreshPool(tokenA, tokenB) ?? undefined;
    }
    if (!pool) {
      throw new Error(
        `Master RWT/USDC pool not found at ${masterPoolPda.toBase58()}. ` +
          'Ensure the pool has been created on the active cluster, or set PUBLIC_RWT_USDC_POOL.',
      );
    }

    // Resolver pulls the rest.
    const otMintPk = new PublicKey(selectedRow.otMint);
    const accounts = await resolveConvertAccounts(
      conn,
      {
        ydProgramId,
        rwtEngineProgramId: rwtProgramId,
        dexProgramId,
        otProgramId,
      },
      otMintPk,
      usdcMint,
      masterPoolPda,
      dex.configPda,
      new PublicKey(dex.config.arealFeeDestination),
      pool,
    );

    const usdcAmount = parseDecimal(usdcAmountInput, USDC_DECIMALS);
    const minRwtOut = parseDecimal(minRwtOutInput, RWT_DECIMALS);

    // Architecture min-distribution gate (D1 spec hint): warn when the
    // requested USDC amount is below the configured floor — the on-chain
    // handler does NOT enforce a per-call min on convert_to_rwt itself,
    // but ops convention treats `DistributionConfig.minDistributionAmount`
    // as a "don't run if below this" signal for the crank.
    if (usdcAmount < accounts.minDistributionAmount) {
      throw new Error(
        `USDC amount (${formatAmount(usdcAmount, USDC_DECIMALS)}) is below ` +
          `DistributionConfig.minDistributionAmount ` +
          `(${formatAmount(accounts.minDistributionAmount, USDC_DECIMALS)}). ` +
          'Wait for the accumulator to fill before converting.',
      );
    }

    const ix = await buildConvertToRwtIx({
      ydProgramId,
      dexProgramId,
      rwtEngineProgramId: rwtProgramId,
      signer: walletState.publicKey,

      config: accounts.config,
      distributor: accounts.distributor,
      otMint: accounts.otMint,
      accumulator: accounts.accumulator,
      accumulatorUsdcAta: accounts.accumulatorUsdcAta,
      accumulatorRwtAta: accounts.accumulatorRwtAta,
      feeAccount: accounts.feeAccount,
      rewardVault: accounts.rewardVault,
      rwtMint: accounts.rwtMint,
      dexConfig: accounts.dexConfig,
      poolState: accounts.poolState,
      dexPoolVaultIn: accounts.dexPoolVaultIn,
      dexPoolVaultOut: accounts.dexPoolVaultOut,
      dexArealFeeAccount: accounts.dexArealFeeAccount,
      rwtVault: accounts.rwtVault,
      rwtCapitalAcc: accounts.rwtCapitalAcc,
      rwtDaoFeeAccount: accounts.rwtDaoFeeAccount,

      usdcAmount,
      minRwtOut,
      swapFirst,
    });

    // D5 hard requirement: convert_to_rwt MUST run with ComputeBudget(300_000).
    return [...buildComputeBudgetIxs(CU_BUDGETS.convertToRwt, 1000), ix];
  }

  function closeModal(): void {
    modalOpen = false;
    selectedRow = null;
  }
</script>

<div class="page-header">
  <div>
    <h1>Convert · Stream → RWT</h1>
    <p class="page-description">
      Per-OT accumulator USDC balances and recent <code>StreamConverted</code> events.
      Click any row to inspect or manually trigger the convert path.
    </p>
  </div>
  <button class="btn btn-ghost" on:click={refresh} disabled={loading}>
    <RefreshCw size={14} class={loading ? 'spin' : ''} />
    Refresh
  </button>
</div>

{#if error}
  <div class="alert alert-error">
    <strong>Load failed:</strong> {error}
  </div>
{/if}

<section class="section">
  <h2 class="section-title">Accumulator USDC balances</h2>

  {#if rows.length === 0}
    <div class="empty">
      {loading ? 'Loading…' : 'No distributors found. Initialize Yield Distribution first.'}
    </div>
  {:else}
    <div class="accum-list">
      {#each rows as row (row.distributor)}
        <article class="accum-row">
          <div class="accum-main">
            <div class="accum-title">
              <span class="ot mono" title={row.otMint}>OT {formatAddress(row.otMint, 6)}</span>
              <span class="balance mono">{formatAmount(row.usdcBalance, USDC_DECIMALS)} USDC</span>
            </div>
            <div class="accum-meta">
              <span class="meta-key">accum</span>
              <CopyAddress address={row.accumulator} />
              <span class="meta-key">usdc ata</span>
              <CopyAddress address={row.accumulatorUsdcAta} />
            </div>
          </div>
          <button
            class="btn btn-primary"
            on:click={() => openModal(row)}
            disabled={row.usdcBalance === 0n || !walletState.connected}
          >
            <Repeat size={14} />
            Manual trigger
          </button>
        </article>
      {/each}
    </div>
  {/if}

  {#if !walletState.connected}
    <p class="muted-note">Connect a wallet to manually trigger conversions.</p>
  {/if}
</section>

<section class="section">
  <h2 class="section-title">Recent StreamConverted events</h2>
  {#if events.length === 0}
    <div class="empty">No conversions yet on this cluster.</div>
  {:else}
    <div class="events-grid">
      {#each events as ev (ev.signature)}
        <ConvertMetadataCard event={ev} />
      {/each}
    </div>
  {/if}
</section>

<ManualTriggerModal
  bind:open={modalOpen}
  title="Manual convert_to_rwt"
  description="Submit a permissionless YD::convert_to_rwt transaction. The crank will retry automatically — manual trigger is for testing or emergency operations only."
  buildIx={buildModalIx}
  validate={validateModal}
  on:close={closeModal}
>
  <div class="modal-form">
    <div class="form-row">
      <label for="usdc-input">USDC amount</label>
      <input
        id="usdc-input"
        type="text"
        inputmode="decimal"
        bind:value={usdcAmountInput}
        placeholder="0.0"
      />
      {#if selectedRow}
        <span class="hint mono">
          balance: {formatAmount(selectedRow.usdcBalance, USDC_DECIMALS)} USDC
        </span>
      {/if}
    </div>

    <div class="form-row">
      <label for="min-rwt-input">Min RWT out</label>
      <input
        id="min-rwt-input"
        type="text"
        inputmode="decimal"
        bind:value={minRwtOutInput}
        placeholder="0.0"
      />
      <span class="hint">Slippage protection — set conservatively.</span>
    </div>

    <div class="form-row checkbox-row">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={swapFirst} />
        Try DEX swap first (recommended)
      </label>
      <span class="hint">If unchecked, mint-only path is used.</span>
    </div>

    <div class="aux-warn">
      <AlertTriangle size={14} />
      <span>Aux pubkeys (DEX master pool, RWT vault, capital ATA, fee
        destinations) are resolved automatically from on-chain state. The
        master pool defaults to the canonical RWT/USDC PDA — set
        <code>PUBLIC_RWT_USDC_POOL</code> to override. CU budget is pinned
        at 300K (D5).</span>
    </div>
  </div>
</ManualTriggerModal>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }
  .page-header h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    margin: 0;
  }
  .page-description {
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    max-width: 64ch;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-5);
  }
  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .accum-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .accum-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }

  .accum-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .accum-title {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-wrap: wrap;
  }
  .ot {
    font-size: var(--text-sm);
    color: var(--color-text);
  }
  .balance {
    font-size: var(--text-md);
    color: var(--color-primary);
    font-weight: 600;
  }
  .accum-meta {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    align-items: center;
  }
  .meta-key {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--text-xs);
  }

  .empty {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .muted-note {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .events-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: var(--space-3);
  }

  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .alert-error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
    margin-bottom: var(--space-3);
  }

  .modal-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .form-row label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .checkbox-row {
    flex-direction: column;
  }
  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .mono {
    font-family: var(--font-mono);
  }

  .aux-warn {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: var(--color-warning);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  .aux-warn code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { cursor: not-allowed; opacity: 0.6; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }
  .btn-ghost { background: transparent; color: var(--color-text-secondary); border-color: var(--color-border); }
  .btn-ghost:hover:not(:disabled) { color: var(--color-text); background: var(--color-surface-hover); }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
