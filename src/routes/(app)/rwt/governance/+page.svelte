<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { rwtStore, rwtClient, rwtProgramId } from '$lib/stores/rwt';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findRwtVaultPda } from '$lib/utils/pda';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: vault = $rwtStore.vault;

  let newAuthority = '';
  let proposeTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let proposeTxSig = '';
  let proposeTxError = '';

  let acceptTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let acceptTxSig = '';
  let acceptTxError = '';

  async function handlePropose() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { proposeTxError = 'No active dev keypair'; proposeTxStatus = 'error'; return; }

    proposeTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const authPk = new PublicKey(newAuthority);

      const tx = client.buildTransaction('propose_authority_transfer', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: { new_authority: Array.from(authPk.toBytes()) }
      });

      proposeTxStatus = 'sending';
      proposeTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      proposeTxStatus = 'success';
      newAuthority = '';
      await rwtStore.refresh();
    } catch (err: any) {
      proposeTxError = err.message;
      proposeTxStatus = 'error';
    }
  }

  async function handleAccept() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { acceptTxError = 'No active dev keypair'; acceptTxStatus = 'error'; return; }

    acceptTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);

      const tx = client.buildTransaction('accept_authority_transfer', {
        accounts: {
          new_authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: {}
      });

      acceptTxStatus = 'sending';
      acceptTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      acceptTxStatus = 'success';
      await rwtStore.refresh();
    } catch (err: any) {
      acceptTxError = err.message;
      acceptTxStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <h1>Authority Transfer</h1>
  <a href="/rwt" class="back-link">Back to Overview</a>
</div>

{#if !vault}
  <p class="text-muted">Vault not initialized.</p>
{:else}
  <div class="card">
    <div class="card-header">
      <h3>Current Authority</h3>
    </div>
    <div class="card-body">
      <div class="info-row">
        <span class="info-label">Authority</span>
        <CopyAddress address={vault.authority} />
      </div>
      {#if vault.hasPending}
        <div class="info-row pending">
          <span class="info-label">Pending Transfer To</span>
          <CopyAddress address={vault.pendingAuthority} />
        </div>
      {/if}
    </div>
  </div>

  <div class="grid grid-2">
    <!-- Propose -->
    <div class="card">
      <div class="card-header"><h3>Step 1: Propose</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">New Authority Pubkey</label>
          <input class="form-input" type="text" bind:value={newAuthority} placeholder="Pubkey..." />
        </div>
        <button class="btn btn-primary" on:click={handlePropose}>Propose Transfer</button>
        <TxStatus status={proposeTxStatus} signature={proposeTxSig} error={proposeTxError} />
      </div>
    </div>

    <!-- Accept -->
    <div class="card">
      <div class="card-header">
        <h3>Step 2: Accept</h3>
        {#if vault.hasPending}
          <span class="badge badge-warning">Pending</span>
        {/if}
      </div>
      <div class="card-body">
        {#if vault.hasPending}
          <p class="info-text">The pending authority must sign to accept.</p>
          <button class="btn btn-success" on:click={handleAccept}>Accept Transfer</button>
        {:else}
          <p class="text-muted">No pending transfer.</p>
        {/if}
        <TxStatus status={acceptTxStatus} signature={acceptTxSig} error={acceptTxError} />
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header { margin-bottom: var(--space-6); display: flex; justify-content: space-between; align-items: center; }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
  .back-link { color: var(--color-primary); text-decoration: none; font-size: var(--text-sm); }

  .grid { display: grid; gap: var(--space-4); margin-top: var(--space-4); }
  .grid-2 { grid-template-columns: 1fr 1fr; }

  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .info-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) 0; }
  .info-row.pending { background: rgba(245, 158, 11, 0.1); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); margin-top: var(--space-2); }
  .info-label { color: var(--color-text-secondary); font-size: var(--text-sm); }

  .form-group { margin-bottom: var(--space-3); }
  .form-label { display: block; font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .form-input { width: 100%; padding: var(--space-2) var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }

  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-success { background: var(--color-success); color: white; }

  .badge { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-sm); }
  .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--color-warning); }

  .info-text { color: var(--color-text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-3); }
  .text-muted { color: var(--color-text-muted); }
</style>
