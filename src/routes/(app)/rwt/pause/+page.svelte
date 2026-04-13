<script lang="ts">
  import { get } from 'svelte/store';
  import { rwtStore, rwtClient, rwtProgramId } from '$lib/stores/rwt';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findRwtVaultPda } from '$lib/utils/pda';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';

  $: vault = $rwtStore.vault;

  let txStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let txSig = '';
  let txError = '';

  async function handlePause() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { txError = 'No active dev keypair'; txStatus = 'error'; return; }

    txStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);

      const tx = client.buildTransaction('pause_mint', {
        accounts: {
          pause_authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: {}
      });

      txStatus = 'sending';
      txSig = await signAndSendTransaction(conn, tx, [deployer]);
      txStatus = 'success';
      await rwtStore.refresh();
    } catch (err: any) {
      txError = err.message;
      txStatus = 'error';
    }
  }

  async function handleUnpause() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { txError = 'No active dev keypair'; txStatus = 'error'; return; }

    txStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);

      const tx = client.buildTransaction('unpause_mint', {
        accounts: {
          pause_authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: {}
      });

      txStatus = 'sending';
      txSig = await signAndSendTransaction(conn, tx, [deployer]);
      txStatus = 'success';
      await rwtStore.refresh();
    } catch (err: any) {
      txError = err.message;
      txStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <h1>Pause Controls</h1>
  <a href="/rwt" class="back-link">Back to Overview</a>
</div>

{#if !vault}
  <p class="text-muted">Vault not initialized.</p>
{:else}
  <div class="card">
    <div class="card-header">
      <h3>Mint Status</h3>
      <span class="badge" class:badge-success={!vault.mintPaused} class:badge-danger={vault.mintPaused}>
        {vault.mintPaused ? 'PAUSED' : 'ACTIVE'}
      </span>
    </div>
    <div class="card-body">
      <p class="info-text">
        Pause stops user minting (mint_rwt). Admin mint, manager swaps, and authority operations are NOT affected.
      </p>
      <p class="info-text">
        Only the pause authority can pause/unpause. This is immutable after initialization.
      </p>

      <div class="button-group">
        {#if vault.mintPaused}
          <button class="btn btn-success" on:click={handleUnpause}>Unpause Minting</button>
        {:else}
          <button class="btn btn-danger" on:click={handlePause}>Pause Minting</button>
        {/if}
      </div>
      <TxStatus status={txStatus} signature={txSig} error={txError} />
    </div>
  </div>
{/if}

<style>
  .page-header { margin-bottom: var(--space-6); display: flex; justify-content: space-between; align-items: center; }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
  .back-link { color: var(--color-primary); text-decoration: none; font-size: var(--text-sm); }

  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .badge { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-sm); font-weight: 500; }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }

  .info-text { color: var(--color-text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-3); }
  .button-group { margin-top: var(--space-4); }

  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-success { background: var(--color-success); color: white; }
  .btn-danger { background: var(--color-danger); color: white; }

  .text-muted { color: var(--color-text-muted); }
</style>
