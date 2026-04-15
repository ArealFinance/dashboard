<script lang="ts">
  import { get } from 'svelte/store';
  import { Keypair, PublicKey } from '@solana/web3.js';
  import { dexStore, dexClient, dexProgramId } from '$lib/stores/dex';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import {
    findDexConfigPda, findPoolCreatorsPda, findPoolStatePda,
    TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID
  } from '$lib/utils/pda';
  import { formatAddress } from '$lib/utils/format';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: config = $dexStore.config;
  $: creators = $dexStore.creators;
  $: pools = $dexStore.pools;
  $: loading = $dexStore.loading;

  // Initialize DEX form
  let initTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let initTxSig = '';
  let initTxError = '';

  // Create pool form
  let tokenAMint = '';
  let tokenBMint = '';
  let createTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let createTxSig = '';
  let createTxError = '';

  async function handleInitializeDex() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { initTxError = 'No active dev keypair'; initTxStatus = 'error'; return; }

    initTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);

      const [configPda] = findDexConfigPda(dexProgramId);
      const [creatorsPda] = findPoolCreatorsPda(dexProgramId);

      const tx = client.buildTransaction('initialize_dex', {
        accounts: {
          deployer: deployer.publicKey,
          dex_config: configPda,
          pool_creators: creatorsPda,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {
          areal_fee_destination: Array.from(deployer.publicKey.toBytes()),
          pause_authority: Array.from(deployer.publicKey.toBytes()),
          rebalancer: Array.from(deployer.publicKey.toBytes()),
        }
      });

      initTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      initTxSig = sig;
      initTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      initTxStatus = 'success';
      await dexStore.refresh();
    } catch (e: any) {
      initTxError = e.message;
      initTxStatus = 'error';
    }
  }

  async function handleCreatePool() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { createTxError = 'No active dev keypair'; createTxStatus = 'error'; return; }
    if (!tokenAMint || !tokenBMint) { createTxError = 'Both mint addresses required'; createTxStatus = 'error'; return; }

    createTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);

      const mintA = new PublicKey(tokenAMint);
      const mintB = new PublicKey(tokenBMint);
      const [configPda] = findDexConfigPda(dexProgramId);
      const [creatorsPda] = findPoolCreatorsPda(dexProgramId);
      const [poolPda] = findPoolStatePda(mintA, mintB, dexProgramId);

      const vaultAKeypair = Keypair.generate();
      const vaultBKeypair = Keypair.generate();

      const tx = client.buildTransaction('create_pool', {
        accounts: {
          creator: deployer.publicKey,
          dex_config: configPda,
          pool_creators: creatorsPda,
          pool_state: poolPda,
          token_a_mint: mintA,
          token_b_mint: mintB,
          vault_a: vaultAKeypair.publicKey,
          vault_b: vaultBKeypair.publicKey,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {}
      });

      createTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer, vaultAKeypair, vaultBKeypair]);
      createTxSig = sig;
      createTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      createTxStatus = 'success';
      await dexStore.refreshPool(mintA, mintB);
    } catch (e: any) {
      createTxError = e.message;
      createTxStatus = 'error';
    }
  }
</script>

<div class="page">
  <h1>Native DEX</h1>
  <p class="subtitle">StandardCurve AMM — Layer 4</p>

  {#if loading}
    <div class="loader">Loading DEX state...</div>
  {:else if !config}
    <div class="card">
      <h2>Initialize DEX</h2>
      <p>DEX not yet initialized. Creates DexConfig + PoolCreators PDAs.</p>
      <button on:click={handleInitializeDex} disabled={initTxStatus === 'signing' || initTxStatus === 'sending'}>
        Initialize DEX
      </button>
      <TxStatus status={initTxStatus} signature={initTxSig} error={initTxError} />
    </div>
  {:else}
    <div class="card">
      <h2>DEX Config</h2>
      <div class="grid">
        <div class="field">
          <span class="label">Authority</span>
          <CopyAddress address={config.authority} />
        </div>
        <div class="field">
          <span class="label">Pause Authority</span>
          <CopyAddress address={config.pauseAuthority} />
        </div>
        <div class="field">
          <span class="label">Rebalancer</span>
          <CopyAddress address={config.rebalancer} />
        </div>
        <div class="field">
          <span class="label">Base Fee</span>
          <span class="value">{config.baseFeeBps / 100}%</span>
        </div>
        <div class="field">
          <span class="label">LP Fee Share</span>
          <span class="value">{config.lpFeeShareBps / 100}%</span>
        </div>
        <div class="field">
          <span class="label">Status</span>
          <span class="value badge" class:active={config.isActive} class:paused={!config.isActive}>
            {config.isActive ? 'Active' : 'Paused'}
          </span>
        </div>
      </div>
    </div>

    {#if creators}
      <div class="card">
        <h2>Pool Creators ({creators.activeCount})</h2>
        <div class="creators-list">
          {#each creators.creators as creator}
            <CopyAddress address={creator} />
          {/each}
        </div>
      </div>
    {/if}

    <div class="card">
      <h2>Pools ({pools.length})</h2>
      {#if pools.length === 0}
        <p class="muted">No pools created yet.</p>
      {:else}
        <div class="pools-grid">
          {#each pools as pool}
            <a href="/dex/{pool.pda}" class="pool-card">
              <div class="pool-pair">
                {formatAddress(pool.tokenAMint, 4)} / {formatAddress(pool.tokenBMint, 4)}
              </div>
              <div class="pool-stats">
                <span>Reserve A: {Number(pool.reserveA).toLocaleString()}</span>
                <span>Reserve B: {Number(pool.reserveB).toLocaleString()}</span>
                <span>LP Shares: {pool.totalLpShares.toString()}</span>
                <span>Fee: {pool.feeBps / 100}%</span>
                <span class="badge" class:active={pool.isActive} class:paused={!pool.isActive}>
                  {pool.isActive ? 'Active' : 'Paused'}
                </span>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </div>

    <div class="card">
      <h2>Create Pool</h2>
      <p class="muted">One mint must be RWT. Canonical order: token_a &lt; token_b.</p>
      <div class="form">
        <label>
          Token A Mint
          <input type="text" bind:value={tokenAMint} placeholder="Base58 address" />
        </label>
        <label>
          Token B Mint
          <input type="text" bind:value={tokenBMint} placeholder="Base58 address" />
        </label>
        <button on:click={handleCreatePool} disabled={createTxStatus === 'signing' || createTxStatus === 'sending'}>
          Create Pool
        </button>
        <TxStatus status={createTxStatus} signature={createTxSig} error={createTxError} />
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 900px; }
  .subtitle { color: var(--color-text-muted); margin-bottom: var(--space-4); }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-3) 0; font-size: 1.1rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .label { font-size: 0.75rem; color: var(--color-text-muted); text-transform: uppercase; }
  .value { font-family: var(--font-mono); font-size: 0.9rem; }
  .badge { padding: 2px 8px; border-radius: var(--radius-sm); font-size: 0.8rem; display: inline-block; }
  .badge.active { background: var(--color-success); color: white; }
  .badge.paused { background: var(--color-danger); color: white; }
  .creators-list { display: flex; flex-direction: column; gap: 4px; }
  .pool-card {
    display: block; padding: var(--space-3);
    border: 1px solid var(--color-border); border-radius: var(--radius-md);
    text-decoration: none; color: inherit;
  }
  .pool-card:hover { border-color: var(--color-primary); }
  .pool-pair { font-weight: 600; margin-bottom: var(--space-2); font-family: var(--font-mono); }
  .pool-stats { display: flex; flex-wrap: wrap; gap: var(--space-2); font-size: 0.8rem; color: var(--color-text-muted); }
  .pools-grid { display: flex; flex-direction: column; gap: var(--space-2); }
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
  .form input {
    padding: 8px 12px; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); font-family: var(--font-mono);
    font-size: 0.85rem; background: var(--color-bg);
  }
  button {
    padding: 10px 20px; background: var(--color-primary); color: white;
    border: none; border-radius: var(--radius-md); cursor: pointer; font-weight: 600;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--color-text-muted); font-size: 0.85rem; }
  .loader { padding: var(--space-4); color: var(--color-text-muted); }
</style>
