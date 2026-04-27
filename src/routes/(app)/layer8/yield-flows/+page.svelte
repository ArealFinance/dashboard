<script lang="ts">
  import { onMount } from 'svelte';
  import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
  import {
    Coins,
    Building2,
    Repeat2,
    RefreshCw,
    AlertTriangle,
    Download,
  } from 'lucide-svelte';
  import { connection, network } from '$lib/stores/network';
  import { ydStore, ydProgramId } from '$lib/stores/yd';
  import { rwtProgramId } from '$lib/stores/rwt';
  import { dexProgramId, dexStore } from '$lib/stores/dex';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { wallet } from '$lib/stores/wallet';
  import {
    fetchYieldDistributedEvents,
    fetchCompoundYieldEvents,
    fetchTreasuryYieldEvents,
    fetchMerkleProof,
    readRwtVault,
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
  import {
    buildRwtClaimYieldIx,
    buildDexCompoundIx,
    buildOtTreasuryClaimIx,
    buildComputeBudgetIxs,
    decodeProof,
    CU_BUDGETS,
  } from '$lib/utils/layer8-builders';
  import {
    resolveRwtClaimAccounts,
    resolveDexCompoundAccounts,
    resolveTreasuryClaimAccounts,
    readClaimStatusCumulative,
  } from '$lib/utils/layer8-resolvers';
  import { findRwtVaultPda } from '$lib/utils/pda';
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

  // Per-event quick-claim modal (SD-23): each event row carries (otMint,
  // distributor, pool?) and we resolve the full account-set on submit.
  let claimModalOpen = false;
  let claimModalTitle = '';
  let claimModalDescription = '';
  type SelectedClaim =
    | { kind: 'rwt-vault'; otMint: string }
    | { kind: 'pool'; otMint: string; pool: string }
    | { kind: 'treasury'; otMint: string; ydOtMint: string };
  let selectedClaim: SelectedClaim | null = null;

  // Vesting / already-claimed state surfaced in the modal.
  let vestingProgress: {
    lockedVested: bigint;
    maxTotalClaim: bigint;
    totalFunded: bigint;
    totalClaimed: bigint;
  } | null = null;
  let alreadyClaimedAmount: bigint = 0n;
  let proofForClaim: MerkleProof | null = null;
  let claimResolveError: string | null = null;
  // Sec M-2 — proof staleness gate: distributor's current epoch read at
  // resolve time. If proof.epoch < distributorEpoch, the on-chain handler
  // reverts (proof signed against stale merkle root); refuse submit
  // client-side to save the user a TX fee.
  let distributorEpoch: bigint = 0n;

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

  /**
   * Open the claim modal for a specific event row, pre-resolve vesting state
   * and the claim_status cumulative so the modal renders accurate progress.
   */
  async function openClaimForRwtVault(otMint: string): Promise<void> {
    selectedClaim = { kind: 'rwt-vault', otMint };
    claimModalTitle = `Claim yield · RWT Vault`;
    claimModalDescription =
      'RWT Vault claims vested RWT from the YD distributor and splits 70/15/15 ' +
      '(book value / liquidity / protocol revenue). CU pinned at 200K.';
    await preloadClaimContext();
    claimModalOpen = true;
  }

  async function openClaimForPool(ev: CompoundYieldExecutedEvent): Promise<void> {
    selectedClaim = { kind: 'pool', otMint: ev.otMint, pool: ev.pool };
    claimModalTitle = `Compound yield · DEX pool`;
    claimModalDescription =
      'Pool PDA claims vested RWT from the YD distributor and folds it into the ' +
      'pool reserve on the RWT side (auto-compound). CU pinned at 200K.';
    await preloadClaimContext();
    claimModalOpen = true;
  }

  async function openClaimForTreasury(ev: TreasuryYieldClaimedEvent): Promise<void> {
    selectedClaim = {
      kind: 'treasury',
      otMint: ev.otMint,
      ydOtMint: ev.ydOtMint,
    };
    claimModalTitle = `Claim yield · OT Treasury`;
    claimModalDescription =
      'OT Treasury claims vested RWT from the YD distributor (per-OT). ' +
      'CU pinned at 200K.';
    await preloadClaimContext();
    claimModalOpen = true;
  }

  /**
   * Resolve vesting + already-claimed for the currently selected claim.
   * Best-effort: errors are surfaced as `claimResolveError`; the modal still
   * opens so the user can see the diagnostic.
   */
  async function preloadClaimContext(): Promise<void> {
    vestingProgress = null;
    alreadyClaimedAmount = 0n;
    proofForClaim = null;
    claimResolveError = null;
    if (!selectedClaim) return;
    const conn = $connection;
    try {
      const programs = {
        ydProgramId,
        rwtEngineProgramId: rwtProgramId,
        dexProgramId,
        otProgramId,
      };
      let claimStatusPda: PublicKey;
      let distributorPda: PublicKey;
      let claimantPda: PublicKey;

      if (selectedClaim.kind === 'rwt-vault') {
        const otMintPk = new PublicKey(selectedClaim.otMint);
        const accounts = await resolveRwtClaimAccounts(conn, programs, otMintPk);
        vestingProgress = accounts.vesting;
        distributorEpoch = accounts.distributorEpoch;
        claimStatusPda = accounts.ydClaimStatus;
        distributorPda = accounts.ydDistributor;
        claimantPda = accounts.rwtVault;
      } else if (selectedClaim.kind === 'pool') {
        // Need pool data + RWT mint.
        const [vaultPda] = findRwtVaultPda(rwtProgramId);
        const vault = await readRwtVault(conn, vaultPda);
        if (!vault) throw new Error('RwtVault not initialized');
        const rwtMint = new PublicKey(vault.rwtMint);
        const poolData = $dexStore.pools.find((p) => p.pda === (selectedClaim as { kind: 'pool'; pool: string; otMint: string }).pool);
        if (!poolData) {
          throw new Error(
            `Pool ${(selectedClaim as { kind: 'pool'; pool: string; otMint: string }).pool} not in DEX store — refresh DEX first.`,
          );
        }
        const otMintPk = new PublicKey(selectedClaim.otMint);
        const accounts = await resolveDexCompoundAccounts(
          conn,
          programs,
          otMintPk,
          poolData,
          rwtMint,
        );
        vestingProgress = accounts.vesting;
        distributorEpoch = accounts.distributorEpoch;
        claimStatusPda = accounts.ydClaimStatus;
        distributorPda = accounts.ydDistributor;
        claimantPda = accounts.poolState;
      } else {
        const [vaultPda] = findRwtVaultPda(rwtProgramId);
        const vault = await readRwtVault(conn, vaultPda);
        if (!vault) throw new Error('RwtVault not initialized');
        const rwtMint = new PublicKey(vault.rwtMint);
        const otMintPk = new PublicKey(selectedClaim.otMint);
        const ydOtMintPk = new PublicKey(selectedClaim.ydOtMint);
        const accounts = await resolveTreasuryClaimAccounts(
          conn,
          programs,
          otMintPk,
          ydOtMintPk,
          rwtMint,
        );
        vestingProgress = accounts.vesting;
        distributorEpoch = accounts.distributorEpoch;
        claimStatusPda = accounts.ydClaimStatus;
        distributorPda = accounts.ydDistributor;
        claimantPda = accounts.otTreasury;
      }

      // Already-claimed gate: read ClaimStatus.cumulative.
      alreadyClaimedAmount = await readClaimStatusCumulative(conn, claimStatusPda);

      // Pre-fetch proof from publisher.
      const url = resolveProofStoreUrl();
      if (!url) {
        claimResolveError =
          'PUBLIC_PROOF_STORE_URL is not configured — cannot fetch Merkle proof. Submit will fail.';
        return;
      }
      proofForClaim = await fetchMerkleProof(url, distributorPda, claimantPda);
      if (!proofForClaim) {
        claimResolveError = `No proof published for distributor ${distributorPda.toBase58()} / claimant ${claimantPda.toBase58()}.`;
      }
    } catch (err) {
      claimResolveError = err instanceof Error ? err.message : String(err);
    }
  }

  function validateClaim(): void {
    if (!selectedClaim) throw new Error('No claim selected');
    if (!walletState.publicKey) throw new Error('Wallet not connected');
    if (!proofForClaim) throw new Error('Merkle proof not loaded');
    const cumulative = BigInt(proofForClaim.cumulativeAmount);
    if (alreadyClaimedAmount >= cumulative) {
      throw new Error(
        `Nothing to claim — already claimed ${formatAmount(alreadyClaimedAmount, RWT_DECIMALS)} >= cumulative ${formatAmount(cumulative, RWT_DECIMALS)}.`,
      );
    }
    // Sec M-1 — over-claim guard. The on-chain handler caps cumulative at
    // `distributor.maxTotalClaim`; a user-signed proof with a larger value
    // reverts. Catch client-side to save fees.
    if (vestingProgress && cumulative > vestingProgress.maxTotalClaim) {
      throw new Error(
        `Proof cumulative ${formatAmount(cumulative, RWT_DECIMALS)} exceeds distributor max ${formatAmount(vestingProgress.maxTotalClaim, RWT_DECIMALS)} — proof is invalid for this distributor.`,
      );
    }
    // Sec M-2 — proof staleness gate. The publisher signs each proof against
    // a specific merkle root (one per epoch); when the distributor advances
    // its epoch the prior root is invalidated. Reject stale proofs upfront.
    if (BigInt(proofForClaim.epoch) < distributorEpoch) {
      throw new Error(
        `Proof is stale: proof.epoch=${proofForClaim.epoch} < distributor.epoch=${distributorEpoch.toString()}. Refresh the proof publisher.`,
      );
    }
  }

  async function buildClaimIx(): Promise<TransactionInstruction[]> {
    if (!selectedClaim) throw new Error('No claim selected');
    if (!walletState.publicKey) throw new Error('Wallet not connected');
    if (!proofForClaim) throw new Error('Merkle proof not loaded');

    const conn = $connection;
    const programs = {
      ydProgramId,
      rwtEngineProgramId: rwtProgramId,
      dexProgramId,
      otProgramId,
    };
    const cumulative = BigInt(proofForClaim.cumulativeAmount);
    const proofBytes = decodeProof(proofForClaim.proof);

    if (selectedClaim.kind === 'rwt-vault') {
      const otMintPk = new PublicKey(selectedClaim.otMint);
      const accounts = await resolveRwtClaimAccounts(conn, programs, otMintPk);
      const ix = await buildRwtClaimYieldIx({
        rwtEngineProgramId: rwtProgramId,
        ydProgramId,
        signer: walletState.publicKey,
        rwtVault: accounts.rwtVault,
        distConfig: accounts.distConfig,
        rwtClaimAta: accounts.rwtClaimAta,
        liquidityDest: accounts.liquidityDest,
        protocolRevenueDest: accounts.protocolRevenueDest,
        ydConfig: accounts.ydConfig,
        otMint: otMintPk,
        ydDistributor: accounts.ydDistributor,
        ydClaimStatus: accounts.ydClaimStatus,
        ydRewardVault: accounts.ydRewardVault,
        cumulativeAmount: cumulative,
        proof: proofBytes,
      });
      return [...buildComputeBudgetIxs(CU_BUDGETS.claim, 1000), ix];
    }

    if (selectedClaim.kind === 'pool') {
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const vault = await readRwtVault(conn, vaultPda);
      if (!vault) throw new Error('RwtVault not initialized');
      const rwtMint = new PublicKey(vault.rwtMint);
      const poolData = $dexStore.pools.find(
        (p) => p.pda === (selectedClaim as { kind: 'pool'; pool: string }).pool,
      );
      if (!poolData) throw new Error('Pool not in DEX store — refresh DEX first.');
      const otMintPk = new PublicKey(selectedClaim.otMint);
      const accounts = await resolveDexCompoundAccounts(
        conn,
        programs,
        otMintPk,
        poolData,
        rwtMint,
      );
      const ix = await buildDexCompoundIx({
        dexProgramId,
        ydProgramId,
        signer: walletState.publicKey,
        poolState: accounts.poolState,
        targetVault: accounts.targetVault,
        ydConfig: accounts.ydConfig,
        otMint: otMintPk,
        ydDistributor: accounts.ydDistributor,
        ydClaimStatus: accounts.ydClaimStatus,
        ydRewardVault: accounts.ydRewardVault,
        cumulativeAmount: cumulative,
        proof: proofBytes,
      });
      return [...buildComputeBudgetIxs(CU_BUDGETS.claim, 1000), ix];
    }

    // treasury
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const vault = await readRwtVault(conn, vaultPda);
    if (!vault) throw new Error('RwtVault not initialized');
    const rwtMint = new PublicKey(vault.rwtMint);
    const otMintPk = new PublicKey(selectedClaim.otMint);
    const ydOtMintPk = new PublicKey(selectedClaim.ydOtMint);
    const accounts = await resolveTreasuryClaimAccounts(
      conn,
      programs,
      otMintPk,
      ydOtMintPk,
      rwtMint,
    );
    const ix = await buildOtTreasuryClaimIx({
      otProgramId,
      ydProgramId,
      signer: walletState.publicKey,
      otMint: otMintPk,
      otTreasury: accounts.otTreasury,
      treasuryRwtAta: accounts.treasuryRwtAta,
      ydConfig: accounts.ydConfig,
      ydOtMint: ydOtMintPk,
      ydDistributor: accounts.ydDistributor,
      ydClaimStatus: accounts.ydClaimStatus,
      ydRewardVault: accounts.ydRewardVault,
      cumulativeAmount: cumulative,
      proof: proofBytes,
    });
    return [...buildComputeBudgetIxs(CU_BUDGETS.claim, 1000), ix];
  }

  /**
   * SD-24: vesting progress (lockedVested / maxTotalClaim).
   */
  function vestingPercent(): number {
    if (!vestingProgress || vestingProgress.maxTotalClaim === 0n) return 0;
    const num = Number(vestingProgress.lockedVested);
    const den = Number(vestingProgress.maxTotalClaim);
    if (den === 0) return 0;
    return Math.min(100, (num / den) * 100);
  }

  function claimableNow(): bigint {
    if (!proofForClaim) return 0n;
    const cumulative = BigInt(proofForClaim.cumulativeAmount);
    return cumulative > alreadyClaimedAmount
      ? cumulative - alreadyClaimedAmount
      : 0n;
  }

  onMount(() => {
    proofStoreUrl = resolveProofStoreUrl();
    void refresh();
    void ydStore.refresh();
    // DEX store needed for compound_yield resolver (looks up pool target_vault).
    void dexStore.refresh();
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
              <button
                class="btn btn-quick"
                disabled={!walletState.connected}
                on:click={() => openClaimForRwtVault(ev.otMint)}
                title="Manual RWT::claim_yield for this OT mint"
              >
                <Download size={12} />
                Quick-claim
              </button>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  {:else if activeClaimant === 'pool'}
    <h2 class="section-title">DEX Pools — compound_yield events</h2>
    {#if dexEvents.length === 0}
      <div class="empty">No pool compound events yet.</div>
    {:else}
      <div class="events-list">
        {#each dexEvents as ev (ev.signature)}
          <article class="event-card">
            <header class="event-head">
              <span class="ot mono" title={ev.otMint}>OT {formatAddress(ev.otMint, 6)}</span>
              <span class="event-amount mono">+{formatAmount(ev.rwtClaimed, RWT_DECIMALS)} RWT</span>
            </header>
            <div class="splits">
              <div class="split">
                <span class="split-label">Pool</span>
                <span class="split-value mono">{formatAddress(ev.pool, 6)}</span>
              </div>
              <div class="split">
                <span class="split-label">RWT side</span>
                <span class="split-value mono">{ev.rwtSide === 0 ? 'A' : 'B'}</span>
              </div>
              <div class="split">
                <span class="split-label">Reserve after</span>
                <span class="split-value mono">{formatAmount(ev.reserveAfter, RWT_DECIMALS)}</span>
              </div>
            </div>
            <footer class="event-foot">
              {#if ev.blockTime}
                <span class="muted">{formatTimestamp(BigInt(ev.blockTime))}</span>
              {/if}
              <a class="muted" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
                tx {formatAddress(ev.signature, 4)}
              </a>
              <button
                class="btn btn-quick"
                disabled={!walletState.connected}
                on:click={() => openClaimForPool(ev)}
                title="Manual DEX::compound_yield for this pool"
              >
                <Download size={12} />
                Quick-claim
              </button>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  {:else}
    <h2 class="section-title">OT Treasuries — claim_yd_for_treasury events</h2>
    {#if otEvents.length === 0}
      <div class="empty">No treasury claims yet.</div>
    {:else}
      <div class="events-list">
        {#each otEvents as ev (ev.signature)}
          <article class="event-card">
            <header class="event-head">
              <span class="ot mono" title={ev.otMint}>OT {formatAddress(ev.otMint, 6)}</span>
              <span class="event-amount mono">+{formatAmount(ev.amount, RWT_DECIMALS)} RWT</span>
            </header>
            <div class="splits">
              <div class="split">
                <span class="split-label">YD distributor mint</span>
                <span class="split-value mono">{formatAddress(ev.ydOtMint, 6)}</span>
              </div>
            </div>
            <footer class="event-foot">
              {#if ev.blockTime}
                <span class="muted">{formatTimestamp(BigInt(ev.blockTime))}</span>
              {/if}
              <a class="muted" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
                tx {formatAddress(ev.signature, 4)}
              </a>
              <button
                class="btn btn-quick"
                disabled={!walletState.connected}
                on:click={() => openClaimForTreasury(ev)}
                title="Manual OT::claim_yd_for_treasury for this OT mint"
              >
                <Download size={12} />
                Quick-claim
              </button>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  {/if}

  {#if !walletState.connected}
    <span class="muted-note">Connect a wallet to use quick-claim buttons on event rows.</span>
  {/if}
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
  description={claimModalDescription}
  buildIx={buildClaimIx}
  validate={validateClaim}
  on:close={() => {
    claimModalOpen = false;
    selectedClaim = null;
    vestingProgress = null;
    proofForClaim = null;
  }}
>
  <div class="claim-modal-body">
    {#if selectedClaim}
      <div class="kpis">
        <div class="kpi">
          <span class="kpi-label">OT mint</span>
          <span class="kpi-value mono">{formatAddress(selectedClaim.otMint, 6)}</span>
        </div>
        {#if selectedClaim.kind === 'pool'}
          <div class="kpi">
            <span class="kpi-label">Pool</span>
            <span class="kpi-value mono">{formatAddress(selectedClaim.pool, 6)}</span>
          </div>
        {/if}
        {#if selectedClaim.kind === 'treasury'}
          <div class="kpi">
            <span class="kpi-label">YD distributor mint</span>
            <span class="kpi-value mono">{formatAddress(selectedClaim.ydOtMint, 6)}</span>
          </div>
        {/if}
      </div>
    {/if}

    {#if vestingProgress}
      <div class="vesting-card">
        <div class="vesting-head">
          <span class="vesting-label">Vesting progress (SD-24)</span>
          <span class="vesting-pct mono">{vestingPercent().toFixed(1)}%</span>
        </div>
        <div class="vesting-bar">
          <div class="vesting-fill" style="width: {vestingPercent()}%"></div>
        </div>
        <div class="vesting-detail mono">
          {formatAmount(vestingProgress.lockedVested, RWT_DECIMALS)} /
          {formatAmount(vestingProgress.maxTotalClaim, RWT_DECIMALS)} RWT vested ·
          claimed {formatAmount(vestingProgress.totalClaimed, RWT_DECIMALS)} RWT
        </div>
      </div>
    {/if}

    {#if proofForClaim}
      <div class="claim-pre">
        <div class="kpis">
          <div class="kpi">
            <span class="kpi-label">Cumulative</span>
            <span class="kpi-value mono">{formatAmount(BigInt(proofForClaim.cumulativeAmount), RWT_DECIMALS)} RWT</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Already claimed</span>
            <span class="kpi-value mono">{formatAmount(alreadyClaimedAmount, RWT_DECIMALS)} RWT</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Claimable now</span>
            <span class="kpi-value mono">{formatAmount(claimableNow(), RWT_DECIMALS)} RWT</span>
          </div>
        </div>
        {#if claimableNow() === 0n}
          <div class="alert alert-warning">
            <AlertTriangle size={14} />
            Nothing to claim — already-claimed cumulative ≥ proof cumulative.
          </div>
        {/if}
      </div>
    {/if}

    {#if claimResolveError}
      <div class="alert alert-error">
        <strong>Pre-flight error:</strong> {claimResolveError}
      </div>
    {/if}
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

  .btn-quick {
    background: var(--color-bg);
    color: var(--color-primary);
    border: 1px solid var(--color-border);
    font-size: var(--text-xs);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    margin-left: auto;
  }
  .btn-quick:hover:not(:disabled) {
    background: var(--color-primary-muted);
    border-color: var(--color-primary);
  }

  .claim-modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-2);
  }
  .kpi {
    background: var(--color-bg);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kpi-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kpi-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    font-weight: 500;
  }

  .vesting-card {
    background: var(--color-bg);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vesting-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .vesting-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .vesting-pct {
    font-size: var(--text-md);
    color: var(--color-primary);
    font-weight: 600;
  }
  .vesting-bar {
    height: 6px;
    background: var(--color-border);
    border-radius: var(--radius-xs);
    overflow: hidden;
  }
  .vesting-fill {
    height: 100%;
    background: var(--color-primary);
    transition: width 0.3s ease;
  }
  .vesting-detail {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .claim-pre { display: flex; flex-direction: column; gap: var(--space-2); }

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
