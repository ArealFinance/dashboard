<script lang="ts">
  import { getContext } from 'svelte';
  import { PublicKey } from '@solana/web3.js';
  import { Shield, ArrowRightLeft, Check } from 'lucide-svelte';
  import { wallet } from '$lib/stores/wallet';
  import { futarchyClient, futarchyProgramId } from '$lib/stores/futarchy';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { findOtGovernancePda } from '$lib/utils/pda';
  import { isValidAddress, bytesToBase58 } from '$lib/utils/format';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { connection } from '$lib/stores/network';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import TxStatus from '$lib/components/TxStatus.svelte';

  const store: any = getContext('futarchyStore');

  $: config = $store.config;
  $: authority = config ? bytesToBase58(config.authority) : '';
  $: pendingAuth = config?.has_pending ? bytesToBase58(config.pending_authority) : null;
  $: otMint = config ? bytesToBase58(config.ot_mint) : '';

  $: isAuthority = config && $wallet.publicKey
    ? authority === $wallet.publicKey.toBase58()
    : false;
  $: isPendingAuth = config && $wallet.publicKey && pendingAuth
    ? pendingAuth === $wallet.publicKey.toBase58()
    : false;

  // Propose transfer form
  let newAuthInput = '';
  $: newAuthValid = isValidAddress(newAuthInput);

  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSignature = '';
  let txError = '';

  async function handlePropose() {
    if (!$wallet.publicKey || !newAuthValid) return;
    txStatus = 'signing'; txError = '';
    try {
      const client = $futarchyClient;
      const tx = client.buildTransaction('propose_authority_transfer', {
        accounts: { authority: $wallet.publicKey, config: $store.configAddress },
        args: { new_authority: Array.from(new PublicKey(newAuthInput).toBytes()) }
      });
      txStatus = 'sending';
      const sig = await signAndSendTransaction($connection, tx, []);
      txSignature = sig; txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success'; newAuthInput = '';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }

  async function handleAccept() {
    if (!$wallet.publicKey) return;
    txStatus = 'signing'; txError = '';
    try {
      const client = $futarchyClient;
      const tx = client.buildTransaction('accept_authority_transfer', {
        accounts: { new_authority: $wallet.publicKey, config: $store.configAddress },
        args: {}
      });
      txStatus = 'sending';
      const sig = await signAndSendTransaction($connection, tx, []);
      txSignature = sig; txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }

  async function handleClaimGovernance() {
    if (!$wallet.publicKey || !config) return;
    txStatus = 'signing'; txError = '';
    try {
      const client = $futarchyClient;
      const otMintPk = new PublicKey(otMint);
      const [otGovPda] = findOtGovernancePda(otMintPk, otProgramId);

      const tx = client.buildTransaction('claim_ot_governance', {
        accounts: {
          executor: $wallet.publicKey,
          config: $store.configAddress,
          ot_governance: otGovPda,
          ot_mint: otMintPk,
          ot_program: otProgramId
        },
        args: {}
      });
      txStatus = 'sending';
      const sig = await signAndSendTransaction($connection, tx, []);
      txSignature = sig; txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }
</script>

<div class="governance-page">
  <!-- Current governance info -->
  <div class="card">
    <div class="card-header">
      <h3><Shield size={16} /> Governance Authority</h3>
    </div>
    <div class="card-body">
      <div class="field-grid">
        <div class="field">
          <span class="fl">Current Authority</span>
          <CopyAddress address={authority} chars={10} />
          {#if isAuthority}<span class="you-badge">You</span>{/if}
        </div>
        <div class="field">
          <span class="fl">OT Mint</span>
          <CopyAddress address={otMint} chars={10} />
        </div>
        {#if pendingAuth}
          <div class="field">
            <span class="fl">Pending Authority</span>
            <CopyAddress address={pendingAuth} chars={10} />
            {#if isPendingAuth}<span class="you-badge">You</span>{/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Claim OT Governance -->
  <div class="card">
    <div class="card-header">
      <h3>Claim OT Governance</h3>
    </div>
    <div class="card-body">
      <p class="hint">Accept OT governance authority. The OT contract must have proposed this Futarchy config PDA as the new authority.</p>
      <button class="btn btn-primary" on:click={handleClaimGovernance}
        disabled={!$wallet.publicKey || txStatus === 'signing' || txStatus === 'sending'}>
        <Check size={14} /> Claim OT Governance
      </button>
    </div>
  </div>

  <!-- Authority Transfer -->
  {#if isAuthority}
    <div class="card">
      <div class="card-header">
        <h3><ArrowRightLeft size={16} /> Transfer Authority</h3>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">New Authority Address</label>
          <input class="form-input" type="text" bind:value={newAuthInput} placeholder="Base58 address (e.g. multisig)" />
        </div>
        <button class="btn btn-warning" on:click={handlePropose}
          disabled={!newAuthValid || txStatus === 'signing' || txStatus === 'sending'}>
          Propose Transfer
        </button>
      </div>
    </div>
  {/if}

  <!-- Accept Transfer -->
  {#if isPendingAuth}
    <div class="card">
      <div class="card-header">
        <h3>Accept Authority Transfer</h3>
      </div>
      <div class="card-body">
        <p class="hint">You are the pending authority. Click to accept.</p>
        <button class="btn btn-success" on:click={handleAccept}
          disabled={txStatus === 'signing' || txStatus === 'sending'}>
          <Check size={14} /> Accept Authority
        </button>
      </div>
    </div>
  {/if}

  <TxStatus status={txStatus} signature={txSignature} error={txError} />
</div>

<style>
  .governance-page { display: flex; flex-direction: column; gap: var(--space-4); }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; align-items: center; gap: var(--space-2); }
  .card-header h3 { margin: 0; font-size: var(--text-base); font-weight: 600; display: flex; align-items: center; gap: var(--space-2); }
  .card-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .fl { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; }
  .you-badge { display: inline-flex; padding: 1px 6px; border-radius: 999px; font-size: 10px; background: rgba(139,92,246,0.2); color: var(--color-primary); font-weight: 600; }
  .hint { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-label { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; }
  .form-input { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }
  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; border: none; cursor: pointer; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-success { background: var(--color-success); color: white; }
  .btn-warning { background: var(--color-warning); color: white; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
