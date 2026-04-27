<script lang="ts">
  import { ArrowDownToLine, Loader2 } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import { dexProgramId } from '$lib/stores/dex';
  import {
    nexusStore,
    resolveUsdcMint,
  } from '$lib/stores/layer9';
  import {
    buildNexusDepositIx,
    TOKEN_KIND_RWT,
    TOKEN_KIND_USDC,
  } from '$lib/api/layer9';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { findAta } from '$lib/utils/pda';
  import { rwtStore } from '$lib/stores/rwt';
  import { parseDecimal } from '$lib/utils/format';

  type ToastType = 'success' | 'error' | 'info';
  let toasts: { id: number; type: ToastType; text: string }[] = [];
  function pushToast(type: ToastType, text: string): void {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    toasts = [...toasts, { id, type, text }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 3500);
  }

  let kind: 'usdc' | 'rwt' = 'usdc';
  let amountStr = '';
  let submitting = false;

  // Token decimals — both USDC and RWT use 6 decimals on devnet/mainnet.
  const DECIMALS = 6;

  async function submit(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const nexusPda = $nexusStore.pda;
    if (!nexusPda) {
      pushToast('error', 'Nexus PDA not derived.');
      return;
    }
    const amount = parseDecimal(amountStr, DECIMALS);
    if (amount <= 0n) {
      pushToast('error', 'Enter a positive amount.');
      return;
    }
    let mint: PublicKey;
    let tokenKind: number;
    if (kind === 'usdc') {
      mint = resolveUsdcMint();
      tokenKind = TOKEN_KIND_USDC;
    } else {
      const vault = $rwtStore.vault;
      if (!vault?.rwtMint) {
        pushToast('error', 'RWT mint not loaded — open the RWT page first to populate.');
        return;
      }
      mint = new PublicKey(vault.rwtMint);
      tokenKind = TOKEN_KIND_RWT;
    }

    submitting = true;
    try {
      const depositorAta = findAta(w.publicKey, mint);
      const nexusAta = findAta(nexusPda, mint);
      const ix = await buildNexusDepositIx({
        dexProgramId,
        depositor: w.publicKey,
        liquidityNexus: nexusPda,
        depositorTokenAta: depositorAta,
        nexusTokenAta: nexusAta,
        amount,
        tokenKind,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `Deposit submitted: ${sig.slice(0, 12)}…`);
      void nexusStore.refresh();
      amountStr = '';
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
      <ArrowDownToLine size={16} />
      Nexus Deposit
    </h3>
    <span class="role">Permissionless</span>
  </header>
  <p class="hint">
    Deposit USDC or RWT into the Nexus pool of liquidity. The amount lifts
    the on-chain principal floor (`total_deposited_<kind>`) by the same value;
    only the surplus above floor is later sweepable as profit. Layer 9 §4.2.
  </p>

  <div class="kind-toggle" role="tablist">
    <button class:active={kind === 'usdc'} on:click={() => (kind = 'usdc')}>USDC</button>
    <button class:active={kind === 'rwt'} on:click={() => (kind = 'rwt')}>RWT</button>
  </div>

  <div class="form-row">
    <label for="dep-amount">Amount</label>
    <input
      id="dep-amount"
      type="text"
      bind:value={amountStr}
      placeholder="0.0"
    />
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
      Deposit {kind.toUpperCase()}
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
  .kind-toggle {
    display: flex;
    gap: var(--space-1);
    background: var(--color-bg);
    padding: 4px;
    border-radius: var(--radius-md);
    align-self: flex-start;
  }
  .kind-toggle button {
    background: transparent;
    border: none;
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .kind-toggle button.active {
    background: var(--color-surface);
    color: var(--color-primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
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
