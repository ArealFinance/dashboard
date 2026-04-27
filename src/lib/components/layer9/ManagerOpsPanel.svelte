<script lang="ts">
  import { ArrowLeftRight, Plus, Minus, Loader2, AlertTriangle } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import { dexProgramId, dexStore } from '$lib/stores/dex';
  import { nexusStore, resolveUsdcMint } from '$lib/stores/layer9';
  import {
    buildNexusSwapIx,
    buildNexusAddLiquidityIx,
    buildNexusRemoveLiquidityIx,
    resolveUsdcSide,
  } from '$lib/api/layer9';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { findAta, findLpPositionPda } from '$lib/utils/pda';
  import { isValidAddress, parseDecimal } from '$lib/utils/format';

  type ToastType = 'success' | 'error' | 'info';
  let toasts: { id: number; type: ToastType; text: string }[] = [];
  function pushToast(type: ToastType, text: string): void {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    toasts = [...toasts, { id, type, text }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 3500);
  }

  const DECIMALS = 6;

  // Common pool selection
  let poolPdaStr = '';

  // ---- swap state ----
  let swapAmountIn = '';
  let swapMinOut = '';
  let swapDirection: 'aToB' | 'bToA' = 'aToB';
  let swapSubmitting = false;

  // ---- add state ----
  let addAmountA = '';
  let addAmountB = '';
  let addMinShares = '';
  let addSubmitting = false;

  // ---- remove state ----
  let removeShares = '';
  let removeSubmitting = false;

  $: nexusState = $nexusStore.state;
  $: killSwitch = nexusState?.killSwitchEngaged === true;

  function loadPool(): { ok: true; pool: typeof $dexStore.pools[number] } | { ok: false; reason: string } {
    const trimmed = poolPdaStr.trim();
    if (!isValidAddress(trimmed)) return { ok: false, reason: 'Invalid pool PDA' };
    const pool = $dexStore.pools.find((p) => p.pda === trimmed);
    if (!pool) return { ok: false, reason: 'Pool not in dex store — refresh DEX first.' };
    return { ok: true, pool };
  }

  async function submitSwap(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect Manager wallet first.');
      return;
    }
    const dex = $dexStore;
    const nexusPda = $nexusStore.pda;
    if (!dex.config || !dex.configPda || !nexusPda) {
      pushToast('error', 'DEX/Nexus state not loaded.');
      return;
    }
    const sel = loadPool();
    if (!sel.ok) {
      pushToast('error', sel.reason);
      return;
    }
    const pool = sel.pool;
    const aIn = parseDecimal(swapAmountIn, DECIMALS);
    const minOut = parseDecimal(swapMinOut, DECIMALS);
    if (aIn <= 0n || minOut <= 0n) {
      pushToast('error', 'amount_in and min_amount_out must both be positive.');
      return;
    }

    swapSubmitting = true;
    try {
      const aToB = swapDirection === 'aToB';
      const tokenAMint = new PublicKey(pool.tokenAMint);
      const tokenBMint = new PublicKey(pool.tokenBMint);
      const nexusTokenA = findAta(nexusPda, tokenAMint);
      const nexusTokenB = findAta(nexusPda, tokenBMint);
      const ix = await buildNexusSwapIx({
        dexProgramId,
        manager: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        poolState: new PublicKey(pool.pda),
        nexusTokenIn: aToB ? nexusTokenA : nexusTokenB,
        nexusTokenOut: aToB ? nexusTokenB : nexusTokenA,
        vaultIn: aToB ? new PublicKey(pool.vaultA) : new PublicKey(pool.vaultB),
        vaultOut: aToB ? new PublicKey(pool.vaultB) : new PublicKey(pool.vaultA),
        arealFeeAccount: new PublicKey(dex.config.arealFeeDestination),
        amountIn: aIn,
        minAmountOut: minOut,
        aToB,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `nexus_swap submitted: ${sig.slice(0, 12)}…`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      swapSubmitting = false;
    }
  }

  async function submitAdd(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect Manager wallet first.');
      return;
    }
    const dex = $dexStore;
    const nexusPda = $nexusStore.pda;
    if (!dex.configPda || !nexusPda) {
      pushToast('error', 'DEX/Nexus state not loaded.');
      return;
    }
    const sel = loadPool();
    if (!sel.ok) {
      pushToast('error', sel.reason);
      return;
    }
    const pool = sel.pool;
    const amountA = parseDecimal(addAmountA, DECIMALS);
    const amountB = parseDecimal(addAmountB, DECIMALS);
    // Slippage floor: empty / non-numeric / zero `min_shares` would let a
    // sandwich-attacker take any share quantity. Require an explicit
    // non-zero u128.
    const trimmed = addMinShares.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      pushToast('error', 'Min shares must be a non-empty positive integer (slippage floor).');
      return;
    }
    let minShares: bigint;
    try {
      minShares = BigInt(trimmed);
    } catch {
      pushToast('error', 'Min shares must be a positive integer.');
      return;
    }
    if (minShares <= 0n) {
      pushToast('error', 'Min shares must be > 0 to enforce a slippage floor.');
      return;
    }
    if (amountA <= 0n && amountB <= 0n) {
      pushToast('error', 'At least one of amount A / amount B must be > 0.');
      return;
    }

    addSubmitting = true;
    try {
      const tokenAMint = new PublicKey(pool.tokenAMint);
      const tokenBMint = new PublicKey(pool.tokenBMint);
      const poolPda = new PublicKey(pool.pda);
      const [lpPda] = findLpPositionPda(poolPda, nexusPda, dexProgramId);
      const ix = await buildNexusAddLiquidityIx({
        dexProgramId,
        manager: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        poolState: poolPda,
        lpPosition: lpPda,
        nexusTokenA: findAta(nexusPda, tokenAMint),
        nexusTokenB: findAta(nexusPda, tokenBMint),
        vaultA: new PublicKey(pool.vaultA),
        vaultB: new PublicKey(pool.vaultB),
        amountA,
        amountB,
        minShares,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `nexus_add_liquidity submitted: ${sig.slice(0, 12)}…`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      addSubmitting = false;
    }
  }

  async function submitRemove(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect Manager wallet first.');
      return;
    }
    const dex = $dexStore;
    const nexusPda = $nexusStore.pda;
    if (!nexusPda) {
      pushToast('error', 'Nexus PDA not derived.');
      return;
    }
    const sel = loadPool();
    if (!sel.ok) {
      pushToast('error', sel.reason);
      return;
    }
    const pool = sel.pool;
    const trimmedShares = removeShares.trim();
    if (!trimmedShares || /[^0-9]/.test(trimmedShares)) {
      pushToast('error', 'Shares must be a positive integer.');
      return;
    }
    const sharesToBurn = BigInt(trimmedShares);
    if (sharesToBurn <= 0n) {
      pushToast('error', 'Shares to burn must be positive.');
      return;
    }

    removeSubmitting = true;
    try {
      const tokenAMint = new PublicKey(pool.tokenAMint);
      const tokenBMint = new PublicKey(pool.tokenBMint);
      const poolPda = new PublicKey(pool.pda);
      const [lpPda] = findLpPositionPda(poolPda, nexusPda, dexProgramId);
      const ix = await buildNexusRemoveLiquidityIx({
        dexProgramId,
        manager: w.publicKey,
        liquidityNexus: nexusPda,
        poolState: poolPda,
        lpPosition: lpPda,
        nexusTokenA: findAta(nexusPda, tokenAMint),
        nexusTokenB: findAta(nexusPda, tokenBMint),
        vaultA: new PublicKey(pool.vaultA),
        vaultB: new PublicKey(pool.vaultB),
        sharesToBurn,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `nexus_remove_liquidity submitted: ${sig.slice(0, 12)}…`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      removeSubmitting = false;
    }
  }

  // M-1 reminder — surface USDC-side info if the entered pool can be resolved.
  $: usdcMint = resolveUsdcMint();
  $: poolHint = (() => {
    const sel = loadPool();
    if (!sel.ok) return null;
    const aMint = new PublicKey(sel.pool.tokenAMint);
    const bMint = new PublicKey(sel.pool.tokenBMint);
    const side = resolveUsdcSide(aMint, bMint, usdcMint);
    return side === null
      ? 'Pool has no USDC side — non-canonical pair.'
      : `USDC is on side ${side.toUpperCase()}`;
  })();
</script>

<div class="container">
  {#if killSwitch}
    <div class="alert danger">
      <AlertTriangle size={14} />
      Manager kill-switch engaged — all Manager-gated ix will revert
      with NexusManagerDisabled.
    </div>
  {/if}

  <div class="form-row pool-row">
    <label for="pool-pda">Pool PDA</label>
    <input id="pool-pda" type="text" bind:value={poolPdaStr} placeholder="Pool address (must exist in DEX store)" />
    {#if poolHint}
      <span class="hint mono">{poolHint}</span>
    {/if}
  </div>

  <div class="panels">
    <article class="panel">
      <header class="panel-head">
        <h3>
          <ArrowLeftRight size={16} />
          nexus_swap
        </h3>
        <span class="role">Manager</span>
      </header>
      <div class="kind-toggle">
        <button class:active={swapDirection === 'aToB'} on:click={() => (swapDirection = 'aToB')}>A → B</button>
        <button class:active={swapDirection === 'bToA'} on:click={() => (swapDirection = 'bToA')}>B → A</button>
      </div>
      <div class="form-row">
        <label for="swap-in">amount_in</label>
        <input id="swap-in" type="text" bind:value={swapAmountIn} placeholder="0.0" />
      </div>
      <div class="form-row">
        <label for="swap-min">min_amount_out</label>
        <input id="swap-min" type="text" bind:value={swapMinOut} placeholder="0.0" />
      </div>
      <button class="btn btn-primary" on:click={submitSwap} disabled={swapSubmitting || !$wallet.connected || killSwitch}>
        {#if swapSubmitting}
          <Loader2 size={14} class="spin" />
          Submitting…
        {:else}
          Submit swap
        {/if}
      </button>
    </article>

    <article class="panel">
      <header class="panel-head">
        <h3>
          <Plus size={16} />
          nexus_add_liquidity
        </h3>
        <span class="role">Manager</span>
      </header>
      <div class="form-row">
        <label for="add-a">amount_a</label>
        <input id="add-a" type="text" bind:value={addAmountA} placeholder="0.0" />
      </div>
      <div class="form-row">
        <label for="add-b">amount_b</label>
        <input id="add-b" type="text" bind:value={addAmountB} placeholder="0.0" />
      </div>
      <div class="form-row">
        <label for="add-min">min_shares (u128, raw)</label>
        <input id="add-min" type="text" bind:value={addMinShares} placeholder="0" />
      </div>
      <button class="btn btn-primary" on:click={submitAdd} disabled={addSubmitting || !$wallet.connected || killSwitch}>
        {#if addSubmitting}
          <Loader2 size={14} class="spin" />
          Submitting…
        {:else}
          Submit add_liquidity
        {/if}
      </button>
    </article>

    <article class="panel">
      <header class="panel-head">
        <h3>
          <Minus size={16} />
          nexus_remove_liquidity
        </h3>
        <span class="role">Manager</span>
      </header>
      <div class="form-row">
        <label for="rem-shares">shares_to_burn (u128, raw)</label>
        <input id="rem-shares" type="text" bind:value={removeShares} placeholder="0" />
      </div>
      <button class="btn btn-primary" on:click={submitRemove} disabled={removeSubmitting || !$wallet.connected || killSwitch}>
        {#if removeSubmitting}
          <Loader2 size={14} class="spin" />
          Submitting…
        {:else}
          Submit remove_liquidity
        {/if}
      </button>
    </article>
  </div>
</div>

{#if toasts.length > 0}
  <div class="toasts">
    {#each toasts as toast (toast.id)}
      <div class="toast {toast.type}">{toast.text}</div>
    {/each}
  </div>
{/if}

<style>
  .container {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-3);
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
  .pool-row {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
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
  .alert {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .alert.danger {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
  }
  .hint {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    margin-top: 4px;
  }
  .mono { font-family: var(--font-mono); }

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
