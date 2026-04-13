<script lang="ts">
  import { onMount } from 'svelte';
  import { Vote, Plus, RefreshCw, Loader2, ExternalLink } from 'lucide-svelte';
  import { futarchyList, futarchyClient, futarchyProgramId } from '$lib/stores/futarchy';
  import { wallet } from '$lib/stores/wallet';
  import { findFutarchyConfigPda, findOtGovernancePda } from '$lib/utils/pda';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { isValidAddress } from '$lib/utils/format';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { connection } from '$lib/stores/network';
  import { PublicKey, SystemProgram } from '@solana/web3.js';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  let otMintInput = '';
  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSignature = '';
  let txError = '';

  $: mintValid = isValidAddress(otMintInput);

  async function handleInitialize() {
    if (!$wallet.publicKey || !mintValid) return;
    txStatus = 'signing';
    txError = '';

    try {
      const client = $futarchyClient;
      const otMint = new PublicKey(otMintInput);
      const [configPda] = findFutarchyConfigPda(otMint, futarchyProgramId);
      const [otGovPda] = findOtGovernancePda(otMint, otProgramId);

      const tx = client.buildTransaction('initialize_futarchy', {
        accounts: {
          deployer: $wallet.publicKey,
          ot_mint: otMint,
          ot_governance: otGovPda,
          config: configPda,
          system_program: SystemProgram.programId
        },
        args: {}
      });

      txStatus = 'sending';
      const sig = await signAndSendTransaction($connection, tx, []);
      txSignature = sig;
      txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      otMintInput = '';
      await futarchyList.refresh();
    } catch (e: any) {
      txError = e.message || 'Unknown error';
      txStatus = 'error';
    }
  }

  onMount(() => { futarchyList.refresh(); });
</script>

<div class="page">
  <div class="page-header">
    <div class="header-left">
      <Vote size={24} />
      <h1>Futarchy Governance</h1>
    </div>
    <button class="btn-icon" on:click={() => futarchyList.refresh()} title="Refresh">
      <RefreshCw size={14} />
    </button>
  </div>

  {#if $wallet.publicKey}
    <div class="card">
      <div class="card-header">
        <h3>Initialize Futarchy</h3>
        <span class="badge badge-info">New</span>
      </div>
      <div class="card-body">
        <p class="hint">Create governance for an Ownership Token. You must be the current OT authority.</p>
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label class="form-label">OT Mint Address</label>
            <input class="form-input" type="text" bind:value={otMintInput} placeholder="Base58 OT mint address" />
          </div>
          <button class="btn btn-primary" disabled={!mintValid || txStatus === 'signing' || txStatus === 'sending'} on:click={handleInitialize}>
            <Plus size={14} /> Initialize
          </button>
        </div>
        <TxStatus status={txStatus} signature={txSignature} error={txError} />
      </div>
    </div>
  {/if}

  <div class="card">
    <div class="card-header">
      <h3>Governance Instances</h3>
      <span class="badge">{$futarchyList.items.length}</span>
    </div>
    <div class="card-body">
      {#if $futarchyList.loading}
        <div class="center-msg"><Loader2 size={20} class="spin" /> Loading...</div>
      {:else if $futarchyList.error}
        <div class="center-msg error">{$futarchyList.error}</div>
      {:else if $futarchyList.items.length === 0}
        <div class="center-msg">No Futarchy instances found. Initialize one above.</div>
      {:else}
        <div class="config-grid">
          {#each $futarchyList.items as item}
            <a href="/futarchy/{item.address.toBase58()}" class="config-card">
              <div class="config-card-top">
                <span class="badge" class:badge-success={item.isActive} class:badge-danger={!item.isActive}>
                  {item.isActive ? 'Active' : 'Paused'}
                </span>
                <span class="meta">{item.nextProposalId.toString()} proposals</span>
              </div>
              <div class="info-rows">
                <div class="info-row"><span class="lbl">OT Mint</span> <CopyAddress address={item.otMint} chars={6} /></div>
                <div class="info-row"><span class="lbl">Authority</span> <CopyAddress address={item.authority} chars={6} /></div>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: var(--space-4); }
  .page-header { display: flex; justify-content: space-between; align-items: center; }
  .header-left { display: flex; align-items: center; gap: var(--space-3); }
  h1 { font-size: var(--text-xl); font-weight: 600; margin: 0; }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .card-header h3 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .card-body { padding: var(--space-4); }
  .hint { color: var(--color-text-secondary); font-size: var(--text-sm); margin: 0 0 var(--space-3); }
  .form-row { display: flex; gap: var(--space-3); align-items: flex-end; }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-label { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-input { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }
  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; border: none; cursor: pointer; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-icon { background: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2); color: var(--color-text-secondary); cursor: pointer; }
  .badge { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: var(--text-xs); font-weight: 500; background: var(--color-surface-raised); color: var(--color-text-secondary); }
  .badge-success { background: rgba(16,185,129,0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239,68,68,0.15); color: var(--color-danger); }
  .badge-info { background: rgba(59,130,246,0.15); color: var(--color-info); }
  .center-msg { padding: var(--space-6); text-align: center; color: var(--color-text-muted); font-size: var(--text-sm); }
  .center-msg.error { color: var(--color-danger); }
  .config-grid { display: grid; gap: var(--space-3); }
  .config-card { display: block; background: var(--color-surface-hover); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-4); text-decoration: none; color: var(--color-text); transition: border-color 0.15s; }
  .config-card:hover { border-color: var(--color-primary); }
  .config-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }
  .meta { font-size: var(--text-xs); color: var(--color-text-muted); }
  .info-rows { display: flex; flex-direction: column; gap: var(--space-2); }
  .info-row { display: flex; justify-content: space-between; align-items: center; }
  .lbl { font-size: var(--text-xs); color: var(--color-text-secondary); }
</style>
