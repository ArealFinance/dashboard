<script lang="ts">
  import { Crown, ShieldOff, AlertTriangle, Loader2 } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import { dexProgramId, dexStore } from '$lib/stores/dex';
  import { nexusStore } from '$lib/stores/layer9';
  import {
    buildInitializeNexusIx,
    buildUpdateNexusManagerIx,
    NEXUS_MANAGER_KILL_SWITCH_BASE58,
  } from '$lib/api/layer9';
  import { sendWalletTransaction } from '$lib/utils/tx';
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

  // ---------------------------------------------------------------
  // initialize_nexus
  // ---------------------------------------------------------------
  let initManagerInput = '';
  let initSubmitting = false;

  async function submitInitialize(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const dex = $dexStore;
    if (!dex.configPda) {
      pushToast('error', 'DexConfig not loaded — cannot initialize Nexus.');
      return;
    }
    const nexusPda = $nexusStore.pda;
    if (!nexusPda) {
      pushToast('error', 'Nexus PDA not derived.');
      return;
    }
    const trimmed = initManagerInput.trim();
    if (!isValidAddress(trimmed)) {
      pushToast('error', 'Invalid manager pubkey.');
      return;
    }

    initSubmitting = true;
    try {
      const managerBytes = new PublicKey(trimmed).toBytes();
      const ix = await buildInitializeNexusIx({
        dexProgramId,
        authority: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        manager: managerBytes,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `Nexus initialized: ${sig.slice(0, 12)}…`);
      void nexusStore.refresh();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      initSubmitting = false;
    }
  }

  // ---------------------------------------------------------------
  // update_nexus_manager (rotate / kill-switch)
  // ---------------------------------------------------------------
  let rotateManagerInput = '';
  let rotateSubmitting = false;
  let killSwitchConfirmOpen = false;

  async function submitRotate(rotateToZero: boolean): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const dex = $dexStore;
    if (!dex.configPda) {
      pushToast('error', 'DexConfig not loaded.');
      return;
    }
    const nexusPda = $nexusStore.pda;
    if (!nexusPda) {
      pushToast('error', 'Nexus PDA not derived.');
      return;
    }

    let newManagerBytes: Uint8Array;
    if (rotateToZero) {
      newManagerBytes = new Uint8Array(32);
    } else {
      const trimmed = rotateManagerInput.trim();
      if (!isValidAddress(trimmed)) {
        pushToast('error', 'Invalid manager pubkey.');
        return;
      }
      newManagerBytes = new PublicKey(trimmed).toBytes();
    }

    rotateSubmitting = true;
    try {
      const ix = await buildUpdateNexusManagerIx({
        dexProgramId,
        authority: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        newManager: newManagerBytes,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `Manager updated: ${sig.slice(0, 12)}…`);
      void nexusStore.refresh();
      killSwitchConfirmOpen = false;
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      rotateSubmitting = false;
    }
  }

  $: walletConnected = $wallet.connected;
  $: nexusState = $nexusStore.state;
</script>

<div class="panels">
  <!-- initialize_nexus -->
  <article class="panel">
    <header class="panel-head">
      <h3>
        <Crown size={16} />
        Initialize Nexus
      </h3>
      <span class="role">Authority</span>
    </header>
    <p class="hint">
      One-shot bootstrap of the Nexus singleton. Sets the initial Manager
      wallet. Layer 9 §4.1.
    </p>
    {#if nexusState && nexusState.isActive}
      <div class="alert info">Nexus already initialized — this ix will revert.</div>
    {/if}
    <div class="form-row">
      <label for="init-mgr">Initial manager</label>
      <input
        id="init-mgr"
        type="text"
        bind:value={initManagerInput}
        placeholder="Manager wallet pubkey (or zero for kill-switched init)"
      />
    </div>
    <button
      class="btn btn-primary"
      on:click={submitInitialize}
      disabled={initSubmitting || !walletConnected}
    >
      {#if initSubmitting}
        <Loader2 size={14} class="spin" />
        Submitting…
      {:else}
        Submit initialize_nexus
      {/if}
    </button>
  </article>

  <!-- update_nexus_manager -->
  <article class="panel">
    <header class="panel-head">
      <h3>
        <Crown size={16} />
        Rotate Manager
      </h3>
      <span class="role">Authority</span>
    </header>
    <p class="hint">
      Replace the Nexus Manager wallet. Layer 9 §4.8.
    </p>
    <div class="form-row">
      <label for="rot-mgr">New manager</label>
      <input
        id="rot-mgr"
        type="text"
        bind:value={rotateManagerInput}
        placeholder="New manager wallet pubkey"
      />
    </div>
    <button
      class="btn btn-primary"
      on:click={() => submitRotate(false)}
      disabled={rotateSubmitting || !walletConnected}
    >
      {#if rotateSubmitting}
        <Loader2 size={14} class="spin" />
        Submitting…
      {:else}
        Rotate to new manager
      {/if}
    </button>

    <div class="divider"></div>

    <h4 class="kill-title">
      <ShieldOff size={14} />
      Kill-switch
    </h4>
    <p class="hint danger">
      Sets the manager to the all-zero pubkey ({NEXUS_MANAGER_KILL_SWITCH_BASE58.slice(0, 6)}…).
      Every Manager-gated ix (swap / add / remove) will revert until Authority rotates back.
      Counters and `is_active` are unaffected.
    </p>
    {#if !killSwitchConfirmOpen}
      <button
        class="btn btn-danger"
        on:click={() => (killSwitchConfirmOpen = true)}
        disabled={!walletConnected}
      >
        <ShieldOff size={14} />
        Engage kill-switch
      </button>
    {:else}
      <div class="confirm-row">
        <span class="confirm-text">
          <AlertTriangle size={14} />
          This is irreversible until Authority rotates back. Proceed?
        </span>
        <button
          class="btn btn-danger"
          on:click={() => submitRotate(true)}
          disabled={rotateSubmitting}
        >
          {#if rotateSubmitting}
            <Loader2 size={14} class="spin" />
          {/if}
          Confirm kill-switch
        </button>
        <button class="btn btn-ghost" on:click={() => (killSwitchConfirmOpen = false)}>
          Cancel
        </button>
      </div>
    {/if}
  </article>
</div>

{#if toasts.length > 0}
  <div class="toasts">
    {#each toasts as toast (toast.id)}
      <div class="toast {toast.type}">{toast.text}</div>
    {/each}
  </div>
{/if}

<style>
  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: var(--space-4);
  }
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
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
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .hint {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .hint.danger { color: var(--color-danger); }
  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
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
  .btn-danger { background: var(--color-danger); color: white; }
  .btn-danger:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }
  .divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-2) 0;
  }
  .kill-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .confirm-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .confirm-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }
  .alert.info {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: var(--color-text);
  }
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
