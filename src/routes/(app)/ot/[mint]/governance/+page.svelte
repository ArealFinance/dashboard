<script lang="ts">
  import { getContext } from 'svelte';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { Shield, ArrowRight, Check, AlertTriangle } from 'lucide-svelte';
  import { arlexClient, programId } from '$lib/stores/ot';
  import { wallet, connected, publicKey } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import { bytesToBase58, isValidAddress, isZeroAddress } from '$lib/utils/format';
  import { findOtGovernancePda, TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import type { OtState } from '$lib/stores/ot';
  import type { Writable } from 'svelte/store';

  const otStore = getContext<{ subscribe: Writable<OtState>['subscribe']; refresh: () => Promise<void> }>('otStore');

  $: mintAddress = $page.params.mint ?? '';
  $: otMint = mintAddress ? new PublicKey(mintAddress) : PublicKey.default;
  $: gov = $otStore.governance;

  $: currentAuthority = gov ? bytesToBase58(gov.authority) : '';
  $: pendingAuthority = gov?.has_pending ? bytesToBase58(gov.pending_authority) : '';
  $: isAuthority = $publicKey && currentAuthority === $publicKey.toBase58();
  $: isPendingAuthority = $publicKey && pendingAuthority === $publicKey.toBase58();

  // Propose form
  let newAuthorityInput = '';
  let proposeTxStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let proposeTxSig = '';
  let proposeTxError = '';

  $: newAuthValid = isValidAddress(newAuthorityInput) && newAuthorityInput !== currentAuthority;

  // Accept
  let acceptTxStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let acceptTxSig = '';
  let acceptTxError = '';

  async function handlePropose() {
    if (!$publicKey || !newAuthValid) return;

    proposeTxStatus = 'signing';
    proposeTxSig = '';
    proposeTxError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);

      const [governancePda] = findOtGovernancePda(otMint, programId);

      const tx = client.buildTransaction('propose_authority_transfer', {
        accounts: {
          authority: $publicKey,
          ot_mint: otMint,
          ot_governance: governancePda
        },
        args: {
          new_authority: Array.from(new PublicKey(newAuthorityInput).toBytes())
        }
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      proposeTxStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      proposeTxSig = sig;
      proposeTxStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      proposeTxStatus = 'success';
      newAuthorityInput = '';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      proposeTxStatus = 'error';
      proposeTxError = err.message || 'Proposal failed';
    }
  }

  async function handleAccept() {
    if (!$publicKey || !isPendingAuthority) return;

    acceptTxStatus = 'signing';
    acceptTxSig = '';
    acceptTxError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);

      const [governancePda] = findOtGovernancePda(otMint, programId);

      const tx = client.buildTransaction('accept_authority_transfer', {
        accounts: {
          new_authority: $publicKey,
          ot_mint: otMint,
          ot_governance: governancePda
        }
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      acceptTxStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      acceptTxSig = sig;
      acceptTxStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      acceptTxStatus = 'success';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      acceptTxStatus = 'error';
      acceptTxError = err.message || 'Accept failed';
    }
  }
</script>

<div class="gov-page">
  <!-- Current State -->
  {#if gov}
    <section class="card">
      <div class="card-header">
        <Shield size={16} />
        <h3>Governance Status</h3>
        <span class="badge" class:active={gov.is_active} class:inactive={!gov.is_active}>
          {gov.is_active ? 'Active' : 'Inactive'}
        </span>
      </div>

      <div class="data-grid">
        <div class="data-row">
          <span class="data-label">Current Authority</span>
          <div class="authority-display">
            <CopyAddress address={currentAuthority} chars={6} />
            {#if isAuthority}
              <span class="you-badge">You</span>
            {/if}
          </div>
        </div>

        {#if gov.has_pending}
          <div class="data-row pending">
            <span class="data-label">Pending Authority</span>
            <div class="authority-display">
              <CopyAddress address={pendingAuthority} chars={6} />
              {#if isPendingAuthority}
                <span class="you-badge">You</span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </section>

    <!-- Propose Transfer -->
    <section class="card">
      <div class="card-header">
        <ArrowRight size={16} />
        <h3>Propose Authority Transfer</h3>
        {#if !isAuthority}
          <span class="badge-restricted">Authority only</span>
        {/if}
      </div>

      <div class="warning-box">
        <AlertTriangle size={14} />
        <span>This will transfer full governance control to a new address. The new authority must accept the transfer.</span>
      </div>

      <label class="form-field">
        <span class="label">New Authority Address</span>
        <input type="text" bind:value={newAuthorityInput} placeholder="New authority wallet address"
          class:invalid={newAuthorityInput && !newAuthValid} />
        {#if newAuthorityInput === currentAuthority}
          <span class="field-error">Cannot transfer to yourself</span>
        {/if}
      </label>

      <div class="form-actions">
        <button class="btn-primary warning" disabled={!isAuthority || !newAuthValid || !$connected ||
          proposeTxStatus === 'signing' || proposeTxStatus === 'sending' || proposeTxStatus === 'confirming'}
          on:click={handlePropose}>
          <ArrowRight size={14} />
          Propose Transfer
        </button>
      </div>
      <TxStatus status={proposeTxStatus} signature={proposeTxSig} error={proposeTxError} />
    </section>

    <!-- Accept Transfer -->
    {#if gov.has_pending}
      <section class="card accept-card">
        <div class="card-header">
          <Check size={16} />
          <h3>Accept Authority Transfer</h3>
        </div>

        <p class="secondary">
          A transfer has been proposed from
          <strong class="mono">{currentAuthority.slice(0, 8)}...</strong>
          to
          <strong class="mono">{pendingAuthority.slice(0, 8)}...</strong>
        </p>

        {#if isPendingAuthority}
          <div class="form-actions">
            <button class="btn-primary" disabled={!$connected ||
              acceptTxStatus === 'signing' || acceptTxStatus === 'sending' || acceptTxStatus === 'confirming'}
              on:click={handleAccept}>
              <Check size={14} />
              Accept Transfer
            </button>
          </div>
        {:else}
          <p class="muted-text">Only the pending authority can accept this transfer.</p>
        {/if}
        <TxStatus status={acceptTxStatus} signature={acceptTxSig} error={acceptTxError} />
      </section>
    {/if}
  {/if}
</div>

<style>
  .gov-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .accept-card {
    border-color: var(--color-warning);
    background: var(--color-warning-muted);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
  }

  .card-header h3 {
    font-size: var(--text-md);
    color: var(--color-text);
    margin-right: auto;
  }

  .badge {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .badge.active {
    background: var(--color-success-muted);
    color: var(--color-success);
  }

  .badge.inactive {
    background: var(--color-danger-muted);
    color: var(--color-danger);
  }

  .badge-restricted {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-warning-muted);
    color: var(--color-warning);
  }

  .data-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .data-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) 0;
    font-size: var(--text-sm);
  }

  .data-row.pending {
    padding: var(--space-2) var(--space-3);
    background: var(--color-warning-muted);
    border-radius: var(--radius-md);
  }

  .data-label {
    color: var(--color-text-muted);
    min-width: 140px;
  }

  .authority-display {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .you-badge {
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-primary-muted);
    color: var(--color-primary);
    font-weight: 500;
  }

  .warning-box {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--color-warning-muted);
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-warning);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .form-field input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .form-field input.invalid {
    border-color: var(--color-danger);
  }

  .field-error {
    font-size: var(--text-xs);
    color: var(--color-danger);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-5);
    background: var(--color-primary);
    color: white;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: all var(--transition-fast);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-primary.warning {
    background: var(--color-warning);
    color: var(--color-text-inverse);
  }

  .btn-primary.warning:hover:not(:disabled) {
    background: #D97706;
  }

  .muted-text {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    text-align: center;
  }
</style>
