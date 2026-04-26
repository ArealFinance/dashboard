<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { X, AlertTriangle, Loader2, ExternalLink } from 'lucide-svelte';
  import { Transaction, type TransactionInstruction } from '@solana/web3.js';
  import { connection } from '$lib/stores/network';
  import { wallet } from '$lib/stores/wallet';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { explorerUrl } from '$lib/utils/format';
  import { network } from '$lib/stores/network';

  /**
   * Reusable manual-trigger modal for Layer 8 admin actions.
   *
   * The modal is intentionally agnostic about the underlying instruction:
   * the caller passes a `buildIx()` callback that returns one or more
   * `TransactionInstruction`s (CU budget + the action). The modal handles
   * wallet signing, broadcasting, and confirmation UI.
   *
   * Permissionless ix means *any* connected wallet can sign — so we surface
   * a clear notice to the user.
   */

  export let open = false;
  export let title = 'Manual trigger';
  export let description = '';
  /** Should return the instructions to bundle into the transaction. */
  export let buildIx: (() => Promise<TransactionInstruction[]> | TransactionInstruction[]) | null = null;
  /** Optional pre-flight validation; throw to abort. */
  export let validate: (() => void) | null = null;
  /** Permissionless flag — when true, shows the disclosure banner. */
  export let permissionless = true;

  const dispatch = createEventDispatcher<{
    close: void;
    success: { signature: string };
    error: { error: string };
  }>();

  type State = 'idle' | 'building' | 'signing' | 'confirming' | 'success' | 'error';
  let state: State = 'idle';
  let signature: string | null = null;
  let error: string | null = null;

  $: clusterTag = $network;
  $: walletState = $wallet;

  function handleClose(): void {
    if (state === 'signing' || state === 'confirming' || state === 'building') return;
    open = false;
    resetState();
    dispatch('close');
  }

  function resetState(): void {
    state = 'idle';
    signature = null;
    error = null;
  }

  function onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) handleClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') handleClose();
  }

  async function handleSubmit(): Promise<void> {
    if (!buildIx) {
      error = 'No builder configured';
      state = 'error';
      return;
    }
    if (!walletState.connected || !walletState.provider || !walletState.publicKey) {
      error = 'Wallet not connected';
      state = 'error';
      return;
    }

    error = null;
    signature = null;

    try {
      if (validate) validate();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      state = 'error';
      return;
    }

    state = 'building';
    let ixs: TransactionInstruction[];
    try {
      ixs = await buildIx();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      state = 'error';
      return;
    }
    if (ixs.length === 0) {
      error = 'No instructions produced';
      state = 'error';
      return;
    }

    state = 'signing';
    try {
      const tx = new Transaction();
      ixs.forEach((ix) => tx.add(ix));
      const conn = $connection;
      // sendWalletTransaction handles blockhash / signing / confirmation.
      const sig = await sendWalletTransaction(conn, tx, {
        publicKey: walletState.publicKey,
        signTransaction: walletState.provider.signTransaction.bind(walletState.provider),
      });
      signature = sig;
      state = 'success';
      dispatch('success', { signature: sig });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      state = 'error';
      dispatch('error', { error });
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <div
    class="backdrop"
    on:click={onBackdropClick}
    on:keydown={onKeydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby="manual-trigger-title"
    tabindex="-1"
  >
    <div class="modal" role="document">
      <header class="head">
        <h3 id="manual-trigger-title">{title}</h3>
        <button class="close" on:click={handleClose} aria-label="Close" disabled={state === 'signing' || state === 'building' || state === 'confirming'}>
          <X size={16} />
        </button>
      </header>

      {#if description}
        <p class="description">{description}</p>
      {/if}

      <div class="content">
        <slot {state} />
      </div>

      {#if permissionless}
        <div class="permissionless-note">
          <AlertTriangle size={14} />
          <span>This action is permissionless: any connected wallet can submit it. The crank will retry automatically if you don't.</span>
        </div>
      {/if}

      {#if error}
        <div class="alert alert-error">
          <strong>Failed:</strong> {error}
        </div>
      {/if}

      {#if state === 'success' && signature}
        <div class="alert alert-success">
          <strong>Submitted.</strong>
          <a href={explorerUrl(signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener" class="explorer-link">
            View transaction <ExternalLink size={12} />
          </a>
        </div>
      {/if}

      <footer class="actions">
        <button class="btn btn-ghost" on:click={handleClose} disabled={state === 'signing' || state === 'building' || state === 'confirming'}>
          {state === 'success' ? 'Close' : 'Cancel'}
        </button>
        {#if state !== 'success'}
          <button
            class="btn btn-primary"
            on:click={handleSubmit}
            disabled={!walletState.connected || state === 'signing' || state === 'building' || state === 'confirming'}
          >
            {#if state === 'building'}
              <Loader2 size={14} class="spin" />
              Building…
            {:else if state === 'signing'}
              <Loader2 size={14} class="spin" />
              Signing…
            {:else if state === 'confirming'}
              <Loader2 size={14} class="spin" />
              Confirming…
            {:else if !walletState.connected}
              Connect wallet to submit
            {:else}
              Submit transaction
            {/if}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-elevated);
    width: 100%;
    max-width: 540px;
    max-height: calc(100vh - var(--space-8));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }
  .head h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-text);
  }

  .close {
    background: transparent;
    color: var(--color-text-secondary);
    border: 0;
    padding: 6px;
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
  }
  .close:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .description {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .permissionless-note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.25);
    color: var(--color-warning);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
  }
  .permissionless-note span {
    color: var(--color-text-secondary);
  }

  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .alert-error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
  }
  .alert-success {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    color: var(--color-success);
  }
  .explorer-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--color-success);
  }
  .explorer-link:hover {
    text-decoration: none;
    opacity: 0.8;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
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
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .btn-primary {
    background: var(--color-primary);
    color: white;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }
  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(0);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
