<script lang="ts">
  import { Coins, Loader2 } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import { dexProgramId, dexStore } from '$lib/stores/dex';
  import { buildClaimLpFeesIx } from '$lib/api/layer9';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { findAta, findLpPositionPda } from '$lib/utils/pda';
  import { isValidAddress } from '$lib/utils/format';

  type ToastType = 'success' | 'error' | 'info';
  let toasts: { id: number; type: ToastType; text: string }[] = [];
  function pushToast(type: ToastType, text: string): void {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    toasts = [...toasts, { id, type, text }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 3500);
  }

  let poolPdaStr = '';
  let submitting = false;

  async function submit(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const trimmed = poolPdaStr.trim();
    if (!isValidAddress(trimmed)) {
      pushToast('error', 'Invalid pool PDA.');
      return;
    }
    const pool = $dexStore.pools.find((p) => p.pda === trimmed);
    if (!pool) {
      pushToast('error', 'Pool not in dex store — refresh DEX first.');
      return;
    }

    submitting = true;
    try {
      const tokenAMint = new PublicKey(pool.tokenAMint);
      const tokenBMint = new PublicKey(pool.tokenBMint);
      const poolPda = new PublicKey(pool.pda);
      const [lpPda] = findLpPositionPda(poolPda, w.publicKey, dexProgramId);
      const ix = await buildClaimLpFeesIx({
        dexProgramId,
        recipient: w.publicKey,
        poolState: poolPda,
        lpPosition: lpPda,
        poolVaultA: new PublicKey(pool.vaultA),
        poolVaultB: new PublicKey(pool.vaultB),
        recipientTokenAAta: findAta(w.publicKey, tokenAMint),
        recipientTokenBAta: findAta(w.publicKey, tokenBMint),
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `claim_lp_fees submitted: ${sig.slice(0, 12)}…`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      submitting = false;
    }
  }
</script>

<article class="panel">
  <header class="panel-head">
    <h3>
      <Coins size={16} />
      Claim LP Fees
    </h3>
    <span class="role">Permissionless</span>
  </header>
  <p class="hint">
    Realise accumulator-tracked LP fees on your own LpPosition. Any wallet
    with an open position on a pool can claim. Layer 9 D28.
  </p>
  <div class="form-row">
    <label for="lp-pool">Pool PDA</label>
    <input id="lp-pool" type="text" bind:value={poolPdaStr} placeholder="Pool address" />
  </div>
  <button
    class="btn btn-primary"
    on:click={submit}
    disabled={submitting || !$wallet.connected}
  >
    {#if submitting}
      <Loader2 size={14} class="spin" />
      Submitting…
    {:else}
      Submit claim_lp_fees
    {/if}
  </button>
</article>

{#if toasts.length > 0}
  <div class="toasts">
    {#each toasts as toast (toast.id)}
      <div class="toast {toast.type}">{toast.text}</div>
    {/each}
  </div>
{/if}

<style>
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .panel-head h3 {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .role {
    font-size: var(--text-xs);
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .hint {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .form-row { display: flex; flex-direction: column; gap: 4px; }
  .form-row label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  input[type='text'] {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
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
    align-self: flex-start;
  }
  .btn:disabled { cursor: not-allowed; opacity: 0.6; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }

  .toasts {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
  }
  .toast {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    color: white;
    font-size: var(--text-sm);
    max-width: 480px;
    word-break: break-all;
  }
  .toast.success { background: var(--color-success); }
  .toast.error { background: var(--color-danger); }
  .toast.info { background: var(--color-primary); }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
