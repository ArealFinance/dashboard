<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { dexStore, dexClient, dexProgramId } from '$lib/stores/dex';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findDexConfigPda, findPoolCreatorsPda } from '$lib/utils/pda';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: config = $dexStore.config;
  $: creators = $dexStore.creators;

  // Update config form
  let newFeeBps = '';
  let newLpShareBps = '';
  let newRebalancer = '';
  let newIsActive = true;
  let configTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let configTxSig = '';
  let configTxError = '';

  // Creator management
  let creatorWallet = '';
  let creatorAction: 'add' | 'remove' = 'add';
  let creatorTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let creatorTxSig = '';
  let creatorTxError = '';

  $: if (config && !newFeeBps) {
    newFeeBps = config.baseFeeBps.toString();
    newLpShareBps = config.lpFeeShareBps.toString();
    newRebalancer = config.rebalancer;
    newIsActive = config.isActive;
  }

  async function handleUpdateConfig() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { configTxError = 'No active dev keypair'; configTxStatus = 'error'; return; }

    configTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const [configPda] = findDexConfigPda(dexProgramId);

      const rebalancerKey = new PublicKey(newRebalancer);
      const tx = client.buildTransaction('update_dex_config', {
        accounts: {
          authority: deployer.publicKey,
          dex_config: configPda,
        },
        args: {
          base_fee_bps: parseInt(newFeeBps),
          lp_fee_share_bps: parseInt(newLpShareBps),
          rebalancer: Array.from(rebalancerKey.toBytes()),
          is_active: newIsActive,
        }
      });

      configTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      configTxSig = sig;
      configTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      configTxStatus = 'success';
      await dexStore.refresh();
    } catch (e: any) {
      configTxError = e.message;
      configTxStatus = 'error';
    }
  }

  async function handleCreatorUpdate() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { creatorTxError = 'No active dev keypair'; creatorTxStatus = 'error'; return; }

    creatorTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const [configPda] = findDexConfigPda(dexProgramId);
      const [creatorsPda] = findPoolCreatorsPda(dexProgramId);

      const wallet = new PublicKey(creatorWallet);
      const tx = client.buildTransaction('update_pool_creators', {
        accounts: {
          authority: deployer.publicKey,
          dex_config: configPda,
          pool_creators: creatorsPda,
        },
        args: {
          wallet: Array.from(wallet.toBytes()),
          action: creatorAction === 'add' ? 0 : 1,
        }
      });

      creatorTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      creatorTxSig = sig;
      creatorTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      creatorTxStatus = 'success';
      creatorWallet = '';
      await dexStore.refresh();
    } catch (e: any) {
      creatorTxError = e.message;
      creatorTxStatus = 'error';
    }
  }
</script>

<div class="page">
  <h1>DEX Config Management</h1>

  {#if !config}
    <p class="muted">DEX not initialized.</p>
  {:else}
    <div class="card">
      <h2>Update Config</h2>
      <div class="form">
        <label>
          Base Fee (bps)
          <input type="number" bind:value={newFeeBps} min="0" max="1000" />
          <span class="hint">Max: 1000 (10%)</span>
        </label>
        <label>
          LP Fee Share (bps)
          <input type="number" bind:value={newLpShareBps} min="0" max="10000" />
          <span class="hint">Max: 10000 (100%)</span>
        </label>
        <label>
          Rebalancer
          <input type="text" bind:value={newRebalancer} />
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={newIsActive} />
          DEX Active
        </label>
        <button on:click={handleUpdateConfig}>Update Config</button>
        <TxStatus status={configTxStatus} signature={configTxSig} error={configTxError} />
      </div>
    </div>

    <div class="card">
      <h2>Pool Creators</h2>
      {#if creators}
        <div class="creators-list">
          {#each creators.creators as c, i}
            <div class="creator-row">
              <span class="idx">{i + 1}.</span>
              <CopyAddress address={c} />
            </div>
          {/each}
        </div>
      {/if}
      <div class="form" style="margin-top: var(--space-3)">
        <label>
          Wallet Address
          <input type="text" bind:value={creatorWallet} placeholder="Base58 address" />
        </label>
        <div class="actions">
          <button on:click={() => { creatorAction = 'add'; handleCreatorUpdate(); }}>Add Creator</button>
          <button class="danger" on:click={() => { creatorAction = 'remove'; handleCreatorUpdate(); }}>Remove Creator</button>
        </div>
        <TxStatus status={creatorTxStatus} signature={creatorTxSig} error={creatorTxError} />
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 700px; }
  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-3) 0; font-size: 1.1rem; }
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
  .form input[type="text"], .form input[type="number"] {
    padding: 8px 12px; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); font-family: var(--font-mono); background: var(--color-bg);
  }
  .hint { font-size: 0.75rem; color: var(--color-text-muted); }
  .checkbox { flex-direction: row; align-items: center; gap: 8px; }
  button {
    padding: 10px 20px; background: var(--color-primary); color: white;
    border: none; border-radius: var(--radius-md); cursor: pointer; font-weight: 600;
  }
  button.danger { background: var(--color-danger); }
  .actions { display: flex; gap: var(--space-2); }
  .creators-list { display: flex; flex-direction: column; gap: 4px; }
  .creator-row { display: flex; align-items: center; gap: 8px; }
  .idx { font-size: 0.8rem; color: var(--color-text-muted); min-width: 20px; }
  .muted { color: var(--color-text-muted); }
</style>
