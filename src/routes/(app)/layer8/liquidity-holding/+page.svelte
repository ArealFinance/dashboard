<script lang="ts">
  import { onMount } from 'svelte';
  import { Droplet, RefreshCw, AlertTriangle, Power, Lock } from 'lucide-svelte';
  import { connection, network } from '$lib/stores/network';
  import { liquidityHolding } from '$lib/stores/layer8';
  import { wallet } from '$lib/stores/wallet';
  import { ydProgramId } from '$lib/stores/yd';
  import { rwtProgramId } from '$lib/stores/rwt';
  import {
    fetchEvents,
    type LiquidityHoldingFundedEvent,
    type LiquidityHoldingInitializedEvent,
  } from '$lib/api/layer8';
  import {
    formatAmount,
    formatTimestamp,
    explorerUrl,
    formatAddress,
  } from '$lib/utils/format';
  import {
    buildInitializeLiquidityHoldingIx,
    buildComputeBudgetIxs,
  } from '$lib/utils/layer8-builders';
  import { findAta, ASSOCIATED_TOKEN_PROGRAM_ID, findRwtVaultPda } from '$lib/utils/pda';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import ManualTriggerModal from '$lib/components/layer8/ManualTriggerModal.svelte';

  const RWT_DECIMALS = 6;

  let fundedEvents: LiquidityHoldingFundedEvent[] = [];
  let initEvents: LiquidityHoldingInitializedEvent[] = [];
  let loading = false;
  let error: string | null = null;

  let initModalOpen = false;
  let withdrawModalOpen = false;

  $: walletState = $wallet;
  $: clusterTag = $network;
  $: state = $liquidityHolding.state;
  $: pda = $liquidityHolding.pda;

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      await liquidityHolding.refresh();
      const conn = $connection;

      // RWT::claim_yield emits LiquidityHoldingFunded; YD program emits init.
      const [rwtRaw, ydRaw] = await Promise.all([
        fetchEvents(conn, rwtProgramId, { limit: 60, kind: 'LiquidityHoldingFunded' }),
        fetchEvents(conn, ydProgramId, { limit: 30, kind: 'LiquidityHoldingInitialized' }),
      ]);
      fundedEvents = rwtRaw.filter(
        (e): e is LiquidityHoldingFundedEvent => e.kind === 'LiquidityHoldingFunded',
      );
      initEvents = ydRaw.filter(
        (e): e is LiquidityHoldingInitializedEvent =>
          e.kind === 'LiquidityHoldingInitialized',
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function buildInitIx() {
    if (!walletState.publicKey) throw new Error('Wallet not connected');
    if (!pda) throw new Error('PDA not derived');

    // We need RWT mint to derive the holding ATA. Read it from the RwtVault
    // account which is the canonical source. (We avoid hardcoding mint addr
    // — different per cluster.)
    const conn = $connection;
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const info = await conn.getAccountInfo(vaultPda, 'confirmed');
    if (!info) {
      throw new Error('RwtVault not initialized; init RWT Engine first.');
    }
    // RwtVault layout: discriminator (8) + ... + rwt_mint at known offset.
    // We delegate parsing to the rwt store loader; here we read directly to
    // avoid pulling the full IDL. Mint is at offset 8 + 16 (after two u64
    // capital fields = 32 bytes total) — pinned by Layer 3 §state.rs.
    // For safety, read the canonical 32 bytes at offset 8 + 16 = 24.
    if (info.data.length < 24 + 32) throw new Error('RwtVault data too short');
    const rwtMintBytes = info.data.subarray(24, 24 + 32);
    const { PublicKey } = await import('@solana/web3.js');
    const rwtMint = new PublicKey(rwtMintBytes);
    const liquidityHoldingAta = findAta(pda, rwtMint);

    const ix = await buildInitializeLiquidityHoldingIx({
      ydProgramId,
      payer: walletState.publicKey,
      liquidityHolding: pda,
      liquidityHoldingAta,
      rwtMint,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    });
    // Wrap with CU budget — init is light (~50k CU), but we set a sane ceiling.
    return [...buildComputeBudgetIxs(80_000, 1000), ix];
  }

  function buildWithdrawIxStub(): never {
    // Per D14, the placeholder ix unconditionally reverts. We surface an
    // explicit error here so users don't waste a TX fee.
    throw new Error(
      'withdraw_liquidity_holding is a Layer 9 placeholder — it always reverts ' +
        'with NexusNotInitialized until the Nexus contract ships.',
    );
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="page-header">
  <div>
    <h1>Liquidity Holding</h1>
    <p class="page-description">
      Singleton PDA receiving the 15% liquidity-share splitted by
      <code>RWT::claim_yield</code>. Funds park here until Layer 9 Nexus
      drains them. Per D11.1, the seed is global (<code>["liq_holding"]</code>) —
      one shared pot across all OT projects.
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

<section class="state-card">
  <div class="state-head">
    <div class="state-icon"><Droplet size={20} /></div>
    <div class="state-title">
      <h2>Singleton state</h2>
      {#if state}
        <span class="badge badge-success">Initialized</span>
      {:else}
        <span class="badge badge-warning">Not initialized</span>
      {/if}
    </div>
  </div>

  {#if state}
    <div class="state-grid">
      <div class="kpi">
        <span class="kpi-label">Total received</span>
        <span class="kpi-value mono">{formatAmount(state.totalReceived, RWT_DECIMALS)} RWT</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">Total withdrawn</span>
        <span class="kpi-value mono">{formatAmount(state.totalWithdrawn, RWT_DECIMALS)} RWT</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">Last funded slot</span>
        <span class="kpi-value mono">{state.lastFundedSlot.toString()}</span>
      </div>
    </div>
    <div class="addr-row">
      <span class="addr-label">PDA</span>
      <CopyAddress address={state.pda} />
    </div>
  {:else}
    <p class="muted-note">
      The LiquidityHolding singleton has not been initialized yet on this cluster.
      Anyone can run the one-time <code>initialize_liquidity_holding</code> ix.
    </p>
    <div class="addr-row">
      <span class="addr-label">PDA (derived)</span>
      <CopyAddress address={pda?.toBase58() ?? ''} />
    </div>
  {/if}

  <div class="state-actions">
    {#if !state}
      <button
        class="btn btn-primary"
        on:click={() => (initModalOpen = true)}
        disabled={!walletState.connected}
      >
        <Power size={14} />
        Initialize
      </button>
    {/if}
    <button
      class="btn btn-ghost"
      on:click={() => (withdrawModalOpen = true)}
      disabled={!walletState.connected}
      title="Disabled until Layer 9 Nexus ships"
    >
      <Lock size={14} />
      Withdraw (Layer 9)
    </button>
    {#if !walletState.connected}
      <span class="muted-note">Connect a wallet to perform admin actions.</span>
    {/if}
  </div>
</section>

<section class="section">
  <h2 class="section-title">Funding history</h2>
  {#if fundedEvents.length === 0}
    <div class="empty">
      No <code>LiquidityHoldingFunded</code> events on this cluster yet. Run a
      <code>claim_yield</code> with a non-zero liquidity share to populate.
    </div>
  {:else}
    <div class="events-list">
      {#each fundedEvents as ev (ev.signature)}
        <article class="event-card">
          <header class="event-head">
            <span class="ot mono" title={ev.otMint}>OT {formatAddress(ev.otMint, 6)}</span>
            <span class="event-amount mono">+{formatAmount(ev.amount, RWT_DECIMALS)} RWT</span>
          </header>
          <footer class="event-foot">
            {#if ev.blockTime}
              <span class="muted">{formatTimestamp(BigInt(ev.blockTime))}</span>
            {/if}
            <span class="muted mono">slot {ev.slot}</span>
            <a class="muted" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
              tx {formatAddress(ev.signature, 4)}
            </a>
          </footer>
        </article>
      {/each}
    </div>
  {/if}
</section>

{#if initEvents.length > 0}
  <section class="section">
    <h2 class="section-title">Init history</h2>
    <div class="events-list">
      {#each initEvents as ev (ev.signature)}
        <article class="event-card">
          <header class="event-head">
            <span class="muted mono">payer {formatAddress(ev.payer, 6)}</span>
            <span class="muted mono">{formatTimestamp(ev.timestamp)}</span>
          </header>
          <footer class="event-foot">
            <CopyAddress address={ev.liquidityHolding} />
            <CopyAddress address={ev.liquidityHoldingAta} />
            <a class="muted" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
              tx {formatAddress(ev.signature, 4)}
            </a>
          </footer>
        </article>
      {/each}
    </div>
  </section>
{/if}

<ManualTriggerModal
  bind:open={initModalOpen}
  title="Initialize Liquidity Holding"
  description="One-time, permissionless init of the singleton LiquidityHolding PDA + its RWT ATA. Per D14, this is a small fixed-cost TX (~80k CU)."
  buildIx={buildInitIx}
  on:close={() => {
    initModalOpen = false;
    void refresh();
  }}
>
  <div class="init-info">
    <p>This will create:</p>
    <ul>
      <li>The singleton <code>LiquidityHolding</code> account (66 bytes).</li>
      <li>The associated <code>LiquidityHolding RWT ATA</code> (165 bytes).</li>
    </ul>
    <p>Rent is paid by the connected wallet.</p>
  </div>
</ManualTriggerModal>

<ManualTriggerModal
  bind:open={withdrawModalOpen}
  title="Withdraw Liquidity Holding"
  description="Layer 9 Nexus required — the on-chain instruction unconditionally reverts with NexusNotInitialized until then."
  buildIx={buildWithdrawIxStub}
  permissionless={false}
  on:close={() => (withdrawModalOpen = false)}
>
  <div class="alert alert-warning withdrawal-warn">
    <AlertTriangle size={14} />
    <span>This action cannot succeed until the Layer 9 Nexus contract is
      deployed and the LiquidityHolding allocator strategy is configured. The
      <code>withdraw_liquidity_holding</code> ix is a one-way no-op
      placeholder per D14 (anti-honeypot guardrail).</span>
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
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
  .page-description {
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    max-width: 64ch;
    line-height: 1.5;
  }
  .page-description code, .alert code, .empty code, .init-info code, .withdrawal-warn code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    background: var(--color-bg);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
  }

  .state-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-top: var(--space-4);
  }
  .state-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .state-icon {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    background: var(--color-info-muted);
    color: var(--color-info);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .state-title { display: flex; gap: var(--space-2); align-items: center; }
  .state-title h2 { margin: 0; font-size: var(--text-md); }

  .badge {
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-weight: 500;
  }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--color-warning); }

  .state-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
  }
  .kpi {
    background: var(--color-bg);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kpi-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .kpi-value {
    font-size: var(--text-md);
    color: var(--color-text);
    font-weight: 600;
  }
  .mono { font-family: var(--font-mono); }

  .addr-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .addr-label {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .state-actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-4);
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

  .events-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .event-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .event-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ot { color: var(--color-text); font-size: var(--text-sm); }
  .event-amount { color: var(--color-success); font-weight: 600; }
  .event-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-size: var(--text-xs);
  }
  .muted { color: var(--color-text-muted); }

  .empty {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
    line-height: 1.5;
  }

  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .alert-error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
    margin-bottom: var(--space-3);
  }
  .alert-warning {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: var(--color-warning);
  }
  .withdrawal-warn { line-height: 1.5; }

  .muted-note { color: var(--color-text-muted); font-size: var(--text-sm); }

  .init-info { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .init-info ul { padding-left: var(--space-4); margin: var(--space-1) 0; }
  .init-info li { margin: 2px 0; }

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
