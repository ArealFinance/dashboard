<script lang="ts">
  import { onMount } from 'svelte';
  import { PublicKey } from '@solana/web3.js';
  import {
    Coins,
    GitBranch,
    Building2,
    Repeat2,
    RefreshCw,
    AlertTriangle,
  } from 'lucide-svelte';
  import { connection, network } from '$lib/stores/network';
  import { ydStore, ydProgramId } from '$lib/stores/yd';
  import { rwtProgramId } from '$lib/stores/rwt';
  import { dexProgramId } from '$lib/stores/dex';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { wallet } from '$lib/stores/wallet';
  import {
    fetchYieldDistributedEvents,
    fetchCompoundYieldEvents,
    fetchTreasuryYieldEvents,
    fetchMerkleProof,
    type YieldDistributedEvent,
    type CompoundYieldExecutedEvent,
    type TreasuryYieldClaimedEvent,
    type MerkleProof,
  } from '$lib/api/layer8';
  import { resolveProofStoreUrl } from '$lib/stores/layer8';
  import {
    formatAddress,
    formatAmount,
    formatTimestamp,
    explorerUrl,
    isValidAddress,
  } from '$lib/utils/format';
  import EventFeed from '$lib/components/layer8/EventFeed.svelte';
  import MerkleProofDisplay from '$lib/components/layer8/MerkleProofDisplay.svelte';
  import ManualTriggerModal from '$lib/components/layer8/ManualTriggerModal.svelte';

  type ClaimantKind = 'rwt-vault' | 'pool' | 'treasury';

  const RWT_DECIMALS = 6;

  let rwtEvents: YieldDistributedEvent[] = [];
  let dexEvents: CompoundYieldExecutedEvent[] = [];
  let otEvents: TreasuryYieldClaimedEvent[] = [];
  let loading = false;
  let error: string | null = null;

  let activeClaimant: ClaimantKind = 'rwt-vault';

  // Merkle-proof inspector
  let proofDistributor = '';
  let proofHolder = '';
  let proofLoading = false;
  let proofError: string | null = null;
  let proofResult: MerkleProof | null = null;
  let proofStoreUrl: string | undefined;

  // Modal state — shared shell, not yet wired to ix builder for full-claim
  // flows (requires aux pubkeys per ix). Kept ready for Step 10 polish.
  let claimModalOpen = false;
  let claimModalTitle = '';

  $: walletState = $wallet;
  $: clusterTag = $network;

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    proofStoreUrl = resolveProofStoreUrl();
    try {
      const conn = $connection;
      const [rwt, dex, ot] = await Promise.all([
        fetchYieldDistributedEvents(conn, rwtProgramId, undefined, { limit: 30 }),
        fetchCompoundYieldEvents(conn, dexProgramId, { limit: 30 }),
        fetchTreasuryYieldEvents(conn, otProgramId, { limit: 30 }),
      ]);
      rwtEvents = rwt;
      dexEvents = dex;
      otEvents = ot;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadProof(): Promise<void> {
    proofError = null;
    proofResult = null;
    if (!proofDistributor.trim() || !proofHolder.trim()) {
      proofError = 'Both distributor and holder addresses are required';
      return;
    }
    if (!isValidAddress(proofDistributor.trim())) {
      proofError = 'Invalid distributor address';
      return;
    }
    if (!isValidAddress(proofHolder.trim())) {
      proofError = 'Invalid holder address';
      return;
    }
    if (!proofStoreUrl) {
      proofError =
        'No proof-store URL configured (PUBLIC_PROOF_STORE_URL). Set the env var to fetch published proofs.';
      return;
    }
    proofLoading = true;
    try {
      const dist = new PublicKey(proofDistributor.trim());
      const holder = new PublicKey(proofHolder.trim());
      const result = await fetchMerkleProof(proofStoreUrl, dist, holder);
      if (!result) {
        proofError = 'No proof published for this distributor/holder pair.';
      } else {
        proofResult = result;
      }
    } catch (err) {
      proofError = err instanceof Error ? err.message : String(err);
    } finally {
      proofLoading = false;
    }
  }

  function onChainRootForResult(): string | null {
    if (!proofResult) return null;
    const dist = $ydStore.distributors.find(
      (d) => d.address === proofResult!.distributor,
    );
    if (!dist) return null;
    let s = '';
    for (const b of dist.merkleRoot) s += b.toString(16).padStart(2, '0');
    return s;
  }

  $: onChainRoot = proofResult ? onChainRootForResult() : null;

  function buildModalIxStub(): never {
    throw new Error(
      'Full claim TX builder requires aux pubkeys (RWT vault claim ATA, ' +
        'pool target vault, OT treasury) not yet wired into per-OT context. ' +
        'Use the yield-claim-crank or extend layer8-builders.ts.',
    );
  }

  onMount(() => {
    proofStoreUrl = resolveProofStoreUrl();
    void refresh();
    void ydStore.refresh();
  });
</script>

<div class="page-header">
  <div>
    <h1>Yield Flows</h1>
    <p class="page-description">
      Per-claimant view of the yield-claim wrappers: RWT Engine vault (70/15/15
      split), Native DEX pools (compound), and OT treasuries. Inspect events,
      open Merkle proofs, and trigger manual claims.
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

<div class="claimant-tabs" role="tablist">
  <button
    role="tab"
    class="claimant-tab"
    class:active={activeClaimant === 'rwt-vault'}
    on:click={() => (activeClaimant = 'rwt-vault')}
  >
    <Coins size={14} />
    RWT Vault
    <span class="count">{rwtEvents.length}</span>
  </button>
  <button
    role="tab"
    class="claimant-tab"
    class:active={activeClaimant === 'pool'}
    on:click={() => (activeClaimant = 'pool')}
  >
    <Repeat2 size={14} />
    DEX Pools
    <span class="count">{dexEvents.length}</span>
  </button>
  <button
    role="tab"
    class="claimant-tab"
    class:active={activeClaimant === 'treasury'}
    on:click={() => (activeClaimant = 'treasury')}
  >
    <Building2 size={14} />
    OT Treasuries
    <span class="count">{otEvents.length}</span>
  </button>
</div>

<section class="section">
  {#if activeClaimant === 'rwt-vault'}
    <h2 class="section-title">RWT Vault — claim_yield events</h2>
    {#if rwtEvents.length === 0}
      <div class="empty">No yield distributions yet on this cluster.</div>
    {:else}
      <div class="events-list">
        {#each rwtEvents as ev (ev.signature)}
          <article class="event-card">
            <header class="event-head">
              <span class="ot mono" title={ev.otMint}>OT {formatAddress(ev.otMint, 6)}</span>
              <span class="event-amount mono">{formatAmount(ev.totalYield, RWT_DECIMALS)} RWT</span>
            </header>
            <div class="splits">
              <div class="split">
                <span class="split-label">Book value (70%)</span>
                <span class="split-value mono">{formatAmount(ev.bookValueShare, RWT_DECIMALS)}</span>
              </div>
              <div class="split">
                <span class="split-label">Liquidity (15%)</span>
                <span class="split-value mono">{formatAmount(ev.liquidityShare, RWT_DECIMALS)}</span>
              </div>
              <div class="split">
                <span class="split-label">Protocol revenue (15%)</span>
                <span class="split-value mono">{formatAmount(ev.protocolRevenueShare, RWT_DECIMALS)}</span>
              </div>
            </div>
            <footer class="event-foot">
              <span class="muted mono">NAV {formatAmount(ev.navBefore, RWT_DECIMALS)} → {formatAmount(ev.navAfter, RWT_DECIMALS)}</span>
              {#if ev.blockTime}
                <span class="muted">{formatTimestamp(BigInt(ev.blockTime))}</span>
              {/if}
              <a class="muted" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
                tx {formatAddress(ev.signature, 4)}
              </a>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  {:else if activeClaimant === 'pool'}
    <h2 class="section-title">DEX Pools — compound_yield events</h2>
    <EventFeed events={dexEvents} title="" showHeader={false} emptyMessage="No pool compound events yet." />
  {:else}
    <h2 class="section-title">OT Treasuries — claim_yd_for_treasury events</h2>
    <EventFeed events={otEvents} title="" showHeader={false} emptyMessage="No treasury claims yet." />
  {/if}

  <div class="claim-actions">
    <button
      class="btn btn-primary"
      disabled={!walletState.connected}
      on:click={() => {
        claimModalTitle = activeClaimant === 'rwt-vault'
          ? 'Manual claim_yield'
          : activeClaimant === 'pool'
          ? 'Manual compound_yield'
          : 'Manual claim_yd_for_treasury';
        claimModalOpen = true;
      }}
    >
      <GitBranch size={14} />
      Manual claim
    </button>
    {#if !walletState.connected}
      <span class="muted-note">Connect a wallet to manually claim.</span>
    {/if}
  </div>
</section>

<section class="section">
  <h2 class="section-title">Merkle proof inspector</h2>
  {#if !proofStoreUrl}
    <div class="alert alert-warning">
      <AlertTriangle size={14} />
      <span>
        <strong>PUBLIC_PROOF_STORE_URL</strong> not configured. Proof lookups
        require the merkle-publisher proof-store HTTP endpoint.
      </span>
    </div>
  {/if}
  <div class="proof-inputs">
    <div class="form-row">
      <label for="dist-input">Distributor</label>
      <input id="dist-input" type="text" bind:value={proofDistributor} placeholder="Distributor PDA address" />
    </div>
    <div class="form-row">
      <label for="holder-input">Holder</label>
      <input id="holder-input" type="text" bind:value={proofHolder} placeholder="Holder pubkey" />
    </div>
    <button class="btn btn-primary" on:click={loadProof} disabled={proofLoading}>
      {proofLoading ? 'Fetching…' : 'Fetch proof'}
    </button>
  </div>

  {#if proofError}
    <div class="alert alert-error">
      <strong>Proof error:</strong> {proofError}
    </div>
  {/if}

  <MerkleProofDisplay proof={proofResult} {onChainRoot} decimals={RWT_DECIMALS} />
</section>

<ManualTriggerModal
  bind:open={claimModalOpen}
  title={claimModalTitle}
  description="Manual claim builders are stubbed in v0.1 — they require auxiliary pubkeys per claimant kind. Use the yield-claim-crank for now."
  buildIx={buildModalIxStub}
  on:close={() => (claimModalOpen = false)}
>
  <p class="modal-stub">
    The full claim flow needs cluster-specific aux pubkeys (vault claim ATA,
    pool target vault, OT treasury). The dashboard ships a stub that surfaces
    a clear error to prevent invalid TX submissions.
  </p>
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
  }

  .claimant-tabs {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: var(--space-4) 0 var(--space-3);
  }
  .claimant-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .claimant-tab.active {
    background: var(--color-primary-muted);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .claimant-tab:hover:not(.active) {
    color: var(--color-text);
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    margin-left: 4px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-4);
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
    gap: var(--space-3);
  }
  .event-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ot { color: var(--color-text); }
  .event-amount {
    color: var(--color-success);
    font-weight: 600;
  }
  .splits {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--space-2);
  }
  .split {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-bg);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }
  .split-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .split-value {
    font-size: var(--text-sm);
    color: var(--color-text);
  }
  .event-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-size: var(--text-xs);
  }
  .muted { color: var(--color-text-muted); }
  .mono { font-family: var(--font-mono); }

  .empty {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .claim-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .muted-note { color: var(--color-text-muted); font-size: var(--text-sm); }

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
  }
  .alert-warning {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: var(--color-warning);
  }

  .proof-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: var(--space-2);
    align-items: end;
  }
  .form-row { display: flex; flex-direction: column; gap: 4px; }
  .form-row label { font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

  .modal-stub {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    line-height: 1.5;
    margin: 0;
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
