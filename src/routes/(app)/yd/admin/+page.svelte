<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import {
    ydStore,
    ydClient,
    ydProgramId,
    getYdConfigPda,
    getAccumulatorPda,
    type YdDistributorState
  } from '$lib/stores/yd';
  import { devKeys, activeKeypairInfo } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { getAtaAddress } from '$lib/utils/spl';
  import {
    findYdConfigPda,
    findMerkleDistributorPda,
    findYdAccumulatorPda,
    TOKEN_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  } from '$lib/utils/pda';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { ArrowLeft } from 'lucide-svelte';

  $: config = $ydStore.config;
  $: distributors = $ydStore.distributors;

  // UX: warn if the active dev keypair is not the config authority — on-chain
  // `has_one = authority` is the real gate; this banner just saves a failed tx.
  $: activePk = $activeKeypairInfo?.publicKey ?? null;
  $: isAuthority = !!(config && activePk && config.authority === activePk);
  $: isPublishAuthority = !!(config && activePk && config.publishAuthority === activePk);

  type TxS = 'idle'|'signing'|'sending'|'confirming'|'success'|'error';

  // ---- initialize_config ----
  let initPublishAuth = '';
  let initFeeBps = '25';
  let initMinDist = '100';
  let initFeeDest = ''; // RWT ATA address (pubkey)
  let initStatus: TxS = 'idle';
  let initSig = '';
  let initError = '';

  async function handleInit() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { initError = 'No active dev keypair'; initStatus = 'error'; return; }
    initStatus = 'signing'; initError = ''; initSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);

      const pubAuth = initPublishAuth.trim() || deployer.publicKey.toBase58();
      const feeDest = initFeeDest.trim();
      if (!feeDest) throw new Error('Fee destination (RWT ATA) is required');

      const pubAuthPk = new PublicKey(pubAuth);
      const feeDestPk = new PublicKey(feeDest);

      const minDist = BigInt(Math.floor((Number(initMinDist) || 0) * 1_000_000));
      const feeBps = Number(initFeeBps) || 0;

      const tx = client.buildTransaction('initialize_config', {
        accounts: {
          deployer: deployer.publicKey,
          config: configPda,
          areal_fee_destination_account: feeDestPk,
          system_program: SYSTEM_PROGRAM_ID
        },
        args: {
          publish_authority: Array.from(pubAuthPk.toBytes()),
          protocol_fee_bps: feeBps,
          min_distribution_amount: minDist
        }
      });

      initStatus = 'sending';
      initSig = await signAndSendTransaction(conn, tx, [deployer]);
      initStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      initError = err?.message ?? String(err);
      initStatus = 'error';
    }
  }

  // ---- create_distributor ----
  let createOtMint = '';
  let createRwtMint = '';
  let createUsdcMint = '';
  let createVesting = '31536000';
  let createStatus: TxS = 'idle';
  let createSig = '';
  let createError = '';

  async function handleCreateDistributor() {
    const authority = devKeys.getActiveKeypair();
    if (!authority) { createError = 'No active dev keypair'; createStatus = 'error'; return; }
    createStatus = 'signing'; createError = ''; createSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);

      const otMint = new PublicKey(createOtMint.trim());
      const rwtMint = new PublicKey(createRwtMint.trim());
      const usdcMint = new PublicKey(createUsdcMint.trim());

      const [distributorPda] = findMerkleDistributorPda(ydProgramId, otMint);
      const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, otMint);
      const rewardVault = getAtaAddress(distributorPda, rwtMint);
      const accUsdcAta = getAtaAddress(accumulatorPda, usdcMint);

      const vestingSecs = BigInt(Math.floor(Number(createVesting) || 0));

      const tx = client.buildTransaction('create_distributor', {
        accounts: {
          authority: authority.publicKey,
          config: configPda,
          ot_mint: otMint,
          distributor: distributorPda,
          accumulator: accumulatorPda,
          rwt_mint: rwtMint,
          usdc_mint: usdcMint,
          reward_vault: rewardVault,
          accumulator_usdc_ata: accUsdcAta,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
        },
        args: { vesting_period_secs: vestingSecs }
      });

      createStatus = 'sending';
      createSig = await signAndSendTransaction(conn, tx, [authority]);
      createStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      createError = err?.message ?? String(err);
      createStatus = 'error';
    }
  }

  // ---- update_config ----
  let updFeeBps = '';
  let updMin = '';
  let updActive = true;
  let updStatus: TxS = 'idle';
  let updSig = '';
  let updError = '';

  $: if (config) {
    if (updFeeBps === '') updFeeBps = String(config.protocolFeeBps);
    if (updMin === '') updMin = (Number(config.minDistributionAmount) / 1_000_000).toString();
    updActive = config.isActive;
  }

  async function handleUpdateConfig() {
    const authority = devKeys.getActiveKeypair();
    if (!authority) { updError = 'No active dev keypair'; updStatus = 'error'; return; }
    updStatus = 'signing'; updError = ''; updSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);

      const tx = client.buildTransaction('update_config', {
        accounts: {
          authority: authority.publicKey,
          config: configPda
        },
        args: {
          protocol_fee_bps: Number(updFeeBps) || 0,
          min_distribution_amount: BigInt(Math.floor((Number(updMin) || 0) * 1_000_000)),
          is_active: updActive
        }
      });

      updStatus = 'sending';
      updSig = await signAndSendTransaction(conn, tx, [authority]);
      updStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      updError = err?.message ?? String(err);
      updStatus = 'error';
    }
  }

  // ---- update_publish_authority ----
  let newPublishAuth = '';
  let pubAuthStatus: TxS = 'idle';
  let pubAuthSig = '';
  let pubAuthError = '';

  async function handleUpdatePublishAuth() {
    const authority = devKeys.getActiveKeypair();
    if (!authority) { pubAuthError = 'No active dev keypair'; pubAuthStatus = 'error'; return; }
    pubAuthStatus = 'signing'; pubAuthError = ''; pubAuthSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);
      const newAuth = new PublicKey(newPublishAuth.trim());
      const tx = client.buildTransaction('update_publish_authority', {
        accounts: {
          authority: authority.publicKey,
          config: configPda
        },
        args: { new_publish_authority: Array.from(newAuth.toBytes()) }
      });
      pubAuthStatus = 'sending';
      pubAuthSig = await signAndSendTransaction(conn, tx, [authority]);
      pubAuthStatus = 'success';
      newPublishAuth = '';
      await ydStore.refresh();
    } catch (err: any) {
      pubAuthError = err?.message ?? String(err);
      pubAuthStatus = 'error';
    }
  }

  // ---- authority transfer ----
  let proposeAuth = '';
  let propStatus: TxS = 'idle';
  let propSig = '';
  let propError = '';

  async function handlePropose() {
    const authority = devKeys.getActiveKeypair();
    if (!authority) { propError = 'No active dev keypair'; propStatus = 'error'; return; }
    propStatus = 'signing'; propError = ''; propSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);
      const newAuth = new PublicKey(proposeAuth.trim());
      const tx = client.buildTransaction('propose_authority_transfer', {
        accounts: { authority: authority.publicKey, config: configPda },
        args: { new_authority: Array.from(newAuth.toBytes()) }
      });
      propStatus = 'sending';
      propSig = await signAndSendTransaction(conn, tx, [authority]);
      propStatus = 'success';
      proposeAuth = '';
      await ydStore.refresh();
    } catch (err: any) {
      propError = err?.message ?? String(err);
      propStatus = 'error';
    }
  }

  let acceptStatus: TxS = 'idle';
  let acceptSig = '';
  let acceptError = '';

  async function handleAccept() {
    const newAuth = devKeys.getActiveKeypair();
    if (!newAuth) { acceptError = 'No active dev keypair'; acceptStatus = 'error'; return; }
    acceptStatus = 'signing'; acceptError = ''; acceptSig = '';
    try {
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);
      const tx = client.buildTransaction('accept_authority_transfer', {
        accounts: { new_authority: newAuth.publicKey, config: configPda },
        args: {}
      });
      acceptStatus = 'sending';
      acceptSig = await signAndSendTransaction(conn, tx, [newAuth]);
      acceptStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      acceptError = err?.message ?? String(err);
      acceptStatus = 'error';
    }
  }

  // ---- close_distributor ----
  let closeOtMintAddress = '';
  let closeUnclaimedDest = '';
  let closeStatus: TxS = 'idle';
  let closeSig = '';
  let closeError = '';

  async function handleClose(dist: YdDistributorState) {
    const authority = devKeys.getActiveKeypair();
    if (!authority) { closeError = 'No active dev keypair'; closeStatus = 'error'; return; }
    closeStatus = 'signing'; closeError = ''; closeSig = '';
    try {
      const unclaimedStr = closeUnclaimedDest.trim();
      if (!unclaimedStr) throw new Error('Unclaimed destination required');

      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);
      const distributorPda = new PublicKey(dist.address);
      const otMint = new PublicKey(dist.otMint);
      const rewardVault = new PublicKey(dist.rewardVault);
      const unclaimedDest = new PublicKey(unclaimedStr);

      const tx = client.buildTransaction('close_distributor', {
        accounts: {
          authority: authority.publicKey,
          config: configPda,
          distributor: distributorPda,
          ot_mint: otMint,
          reward_vault: rewardVault,
          unclaimed_destination: unclaimedDest,
          token_program: TOKEN_PROGRAM_ID
        },
        args: {}
      });
      closeStatus = 'sending';
      closeSig = await signAndSendTransaction(conn, tx, [authority]);
      closeStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      closeError = err?.message ?? String(err);
      closeStatus = 'error';
    }
  }

  // ---- publish_root (admin convenience; normally bot) ----
  let pubOtMint = '';
  let pubRootHex = '';
  let pubMaxClaim = '';
  let pubStatus: TxS = 'idle';
  let pubSig = '';
  let pubError = '';

  async function handlePublishRoot() {
    const signer = devKeys.getActiveKeypair();
    if (!signer) { pubError = 'No active dev keypair'; pubStatus = 'error'; return; }
    pubStatus = 'signing'; pubError = ''; pubSig = '';
    try {
      const { hexToBytes } = await import('$lib/utils/merkle');
      const conn = get(connection);
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(ydProgramId);
      const otMint = new PublicKey(pubOtMint.trim());
      const [distributorPda] = findMerkleDistributorPda(ydProgramId, otMint);

      const root = hexToBytes(pubRootHex.trim());
      if (root.length !== 32) throw new Error('Root must be 32 bytes');

      const maxClaim = BigInt(Math.floor((Number(pubMaxClaim) || 0) * 1_000_000));

      const tx = client.buildTransaction('publish_root', {
        accounts: {
          publish_authority: signer.publicKey,
          config: configPda,
          distributor: distributorPda,
          ot_mint: otMint
        },
        args: {
          merkle_root: Array.from(root),
          max_total_claim: maxClaim
        }
      });

      pubStatus = 'sending';
      pubSig = await signAndSendTransaction(conn, tx, [signer]);
      pubStatus = 'success';
      await ydStore.refresh();
    } catch (err: any) {
      pubError = err?.message ?? String(err);
      pubStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <a href="/yd" class="back-link"><ArrowLeft size={14} /> Back</a>
  <h1>YD Admin</h1>
</div>

{#if config && !isAuthority}
  <div class="warning-banner" role="alert">
    <strong>⚠ Not authority.</strong>
    Your active keypair
    {#if activePk}(<span class="mono">{activePk.slice(0, 8)}...{activePk.slice(-4)}</span>){/if}
    is not the YD authority. Authority-gated actions (update config, create distributor,
    transfer, close) will fail on-chain with <span class="mono">Unauthorized</span>.
    {#if !isPublishAuthority}
      Manual <span class="mono">publish_root</span> will also fail
      (<span class="mono">UnauthorizedPublisher</span>).
    {/if}
  </div>
{/if}

<!-- Initialize -->
{#if !config}
  <div class="card">
    <div class="card-header"><h3>Initialize Distribution Config</h3></div>
    <div class="card-body">
      <p class="text-muted">Create the global singleton config. Deployer becomes initial authority.</p>
      <div class="form-group">
        <label class="form-label" for="init-pubauth">Publish Authority (pubkey)</label>
        <input id="init-pubauth" class="form-input" bind:value={initPublishAuth} placeholder="defaults to active dev keypair" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="init-feebps">Protocol Fee BPS</label>
          <input id="init-feebps" class="form-input" type="number" bind:value={initFeeBps} />
        </div>
        <div class="form-group">
          <label class="form-label" for="init-min">Min Distribution (RWT)</label>
          <input id="init-min" class="form-input" type="number" bind:value={initMinDist} />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="init-feedest">Areal Fee Destination (RWT ATA pubkey — immutable)</label>
        <input id="init-feedest" class="form-input" bind:value={initFeeDest} placeholder="Pubkey of RWT ATA" />
      </div>
      <button class="btn btn-primary" on:click={handleInit} disabled={initStatus !== 'idle' && initStatus !== 'success' && initStatus !== 'error'}>
        Initialize Config
      </button>
      <TxStatus status={initStatus} signature={initSig} error={initError} />
    </div>
  </div>
{:else}
  <div class="grid-2">
    <!-- Update config -->
    <div class="card">
      <div class="card-header"><h3>Update Config</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="upd-fee">Protocol Fee BPS</label>
            <input id="upd-fee" class="form-input" type="number" bind:value={updFeeBps} />
          </div>
          <div class="form-group">
            <label class="form-label" for="upd-min">Min Distribution (RWT)</label>
            <input id="upd-min" class="form-input" type="number" bind:value={updMin} />
          </div>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={updActive} />
          <span>is_active</span>
        </label>
        <button class="btn btn-primary" on:click={handleUpdateConfig}>Update Config</button>
        <TxStatus status={updStatus} signature={updSig} error={updError} />
      </div>
    </div>

    <!-- Update publish authority -->
    <div class="card">
      <div class="card-header"><h3>Update Publish Authority</h3></div>
      <div class="card-body">
        <p class="info-row"><span class="info-label">Current</span><CopyAddress address={config.publishAuthority} /></p>
        <div class="form-group">
          <label class="form-label" for="pub-new">New Publish Authority</label>
          <input id="pub-new" class="form-input" bind:value={newPublishAuth} placeholder="Pubkey..." />
        </div>
        <button class="btn btn-primary" on:click={handleUpdatePublishAuth}>Update</button>
        <TxStatus status={pubAuthStatus} signature={pubAuthSig} error={pubAuthError} />
      </div>
    </div>

    <!-- Create distributor -->
    <div class="card">
      <div class="card-header"><h3>Create Distributor</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label" for="cd-ot">OT Mint</label>
          <input id="cd-ot" class="form-input" bind:value={createOtMint} placeholder="OT mint pubkey" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cd-rwt">RWT Mint</label>
          <input id="cd-rwt" class="form-input" bind:value={createRwtMint} placeholder="RWT mint pubkey" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cd-usdc">USDC Mint</label>
          <input id="cd-usdc" class="form-input" bind:value={createUsdcMint} placeholder="USDC mint pubkey" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cd-vest">Vesting Period (seconds)</label>
          <input id="cd-vest" class="form-input" type="number" bind:value={createVesting} />
        </div>
        <button class="btn btn-primary" on:click={handleCreateDistributor}>Create</button>
        <TxStatus status={createStatus} signature={createSig} error={createError} />
      </div>
    </div>

    <!-- Authority transfer -->
    <div class="card">
      <div class="card-header"><h3>Authority Transfer</h3></div>
      <div class="card-body">
        <div class="info-row"><span class="info-label">Current Authority</span><CopyAddress address={config.authority} /></div>
        {#if config.hasPending}
          <div class="info-row"><span class="info-label">Pending Authority</span><CopyAddress address={config.pendingAuthority} /></div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="prop-auth">Propose New Authority</label>
          <input id="prop-auth" class="form-input" bind:value={proposeAuth} placeholder="Pubkey..." />
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" on:click={handlePropose}>Propose</button>
          <button class="btn btn-secondary" on:click={handleAccept} disabled={!config.hasPending}>Accept (as pending)</button>
        </div>
        <TxStatus status={propStatus} signature={propSig} error={propError} />
        <TxStatus status={acceptStatus} signature={acceptSig} error={acceptError} />
      </div>
    </div>
  </div>

  <!-- Publish root (admin manual) -->
  <div class="card">
    <div class="card-header"><h3>Publish Root (manual / admin)</h3></div>
    <div class="card-body">
      <p class="text-muted">Use only for testing. In production the off-chain publisher bot calls this.</p>
      <div class="form-group">
        <label class="form-label" for="pr-ot">OT Mint</label>
        <input id="pr-ot" class="form-input" bind:value={pubOtMint} />
      </div>
      <div class="form-group">
        <label class="form-label" for="pr-root">Merkle Root (hex, 32 bytes)</label>
        <input id="pr-root" class="form-input" bind:value={pubRootHex} placeholder="aabbcc...(64 hex chars)" />
      </div>
      <div class="form-group">
        <label class="form-label" for="pr-max">max_total_claim (RWT, must equal total_funded)</label>
        <input id="pr-max" class="form-input" type="number" bind:value={pubMaxClaim} />
      </div>
      <button class="btn btn-primary" on:click={handlePublishRoot}>Publish</button>
      <TxStatus status={pubStatus} signature={pubSig} error={pubError} />
    </div>
  </div>

  <!-- Close distributor -->
  <div class="card">
    <div class="card-header"><h3>Close Distributor</h3></div>
    <div class="card-body">
      <p class="text-muted">Sweeps remaining RWT to a destination ATA, deactivates distributor.</p>
      <div class="form-group">
        <label class="form-label" for="cl-dest">Unclaimed Destination (RWT ATA pubkey)</label>
        <input id="cl-dest" class="form-input" bind:value={closeUnclaimedDest} placeholder="RWT ATA..." />
      </div>
      {#if distributors.length === 0}
        <p class="text-muted">No distributors to close.</p>
      {:else}
        <div class="dist-rows">
          {#each distributors as d}
            <div class="dist-row">
              <div class="dist-meta">
                <div class="mono">{d.address.slice(0, 8)}...{d.address.slice(-4)}</div>
                <div class="text-muted">
                  OT: {d.otMint.slice(0, 6)}... · Funded {Number(d.totalFunded) / 1e6} / Claimed {Number(d.totalClaimed) / 1e6}
                </div>
              </div>
              <button class="btn btn-danger" on:click={() => handleClose(d)} disabled={!d.isActive || !closeUnclaimedDest.trim()}>
                {d.isActive ? 'Close' : 'Closed'}
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <TxStatus status={closeStatus} signature={closeSig} error={closeError} />
    </div>
  </div>
{/if}

<style>
  .page-header { display: flex; gap: var(--space-3); align-items: center; margin-bottom: var(--space-4); }
  .page-header h1 { margin: 0; font-size: var(--text-2xl); font-weight: 700; }
  .back-link { color: var(--color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-sm); }

  .warning-banner {
    background: var(--color-warning, #FCD34D);
    color: var(--color-text);
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .warning-banner strong { margin-right: 4px; }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-4); }

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

  .form-group { margin-bottom: var(--space-3); }
  .form-row { display: flex; gap: var(--space-2); }
  .form-row .form-group { flex: 1; }
  .form-label { display: block; font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .form-input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    box-sizing: border-box;
  }
  .form-input:focus { outline: none; border-color: var(--color-primary); }

  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: var(--space-3); font-size: var(--text-sm); color: var(--color-text-secondary); cursor: pointer; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    text-decoration: none;
  }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border); }
  .btn-danger { background: var(--color-danger); color: white; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-row { display: flex; gap: var(--space-2); margin-top: var(--space-2); }

  .dist-rows { display: flex; flex-direction: column; gap: var(--space-2); }
  .dist-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) var(--space-3); background: var(--color-bg); border-radius: var(--radius-md); }
  .dist-meta { display: flex; flex-direction: column; gap: 2px; font-size: var(--text-sm); }

  .mono { font-family: var(--font-mono); }
  .text-muted { color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
