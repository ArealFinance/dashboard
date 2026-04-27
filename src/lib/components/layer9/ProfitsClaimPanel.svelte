<script lang="ts">
  import { Banknote, Coins, Loader2 } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { connection } from '$lib/stores/network';
  import { dexProgramId, dexStore } from '$lib/stores/dex';
  import { nexusStore, resolveUsdcMint } from '$lib/stores/layer9';
  import { rwtStore } from '$lib/stores/rwt';
  import {
    buildNexusWithdrawProfitsIx,
    buildNexusClaimRewardsIx,
    TOKEN_KIND_RWT,
    TOKEN_KIND_USDC,
  } from '$lib/api/layer9';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { findAta, findLpPositionPda } from '$lib/utils/pda';
  import { parseDecimal, isValidAddress } from '$lib/utils/format';

  type ToastType = 'success' | 'error' | 'info';
  let toasts: { id: number; type: ToastType; text: string }[] = [];
  function pushToast(type: ToastType, text: string): void {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    toasts = [...toasts, { id, type, text }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 3500);
  }

  // Withdraw profits state
  let kind: 'usdc' | 'rwt' = 'usdc';
  let amountStr = '';
  let recipientAtaStr = '';
  let withdrawSubmitting = false;
  let nexusAtaBalance: bigint | null = null;
  let nexusAtaBalanceLoading = false;

  const DECIMALS = 6;

  $: nexusState = $nexusStore.state;
  $: nexusPdaForUi = $nexusStore.pda;

  // Pre-flight P&L: fetch the Nexus-owned ATA balance (USDC or RWT) and
  // compare against the principal floor read from LiquidityNexus state.
  // The on-chain handler enforces the principal-lock invariant
  // (post-transfer ATA balance >= total_deposited_*); the UI mirrors it
  // so operators do not sign a guaranteed-revert TX (security M-3).
  async function fetchNexusAtaBalance(): Promise<void> {
    nexusAtaBalance = null;
    if (!nexusPdaForUi) return;
    let mint: PublicKey;
    if (kind === 'usdc') {
      mint = resolveUsdcMint();
    } else {
      const vault = $rwtStore.vault;
      if (!vault?.rwtMint) return;
      mint = new PublicKey(vault.rwtMint);
    }
    const ata = findAta(nexusPdaForUi, mint);
    nexusAtaBalanceLoading = true;
    try {
      const res = await $connection.getTokenAccountBalance(ata, 'confirmed');
      nexusAtaBalance = BigInt(res.value.amount);
    } catch {
      // ATA may not exist yet — surface as zero-balance.
      nexusAtaBalance = 0n;
    } finally {
      nexusAtaBalanceLoading = false;
    }
  }

  // Refetch when kind toggles or when nexus state arrives.
  $: void (kind, nexusPdaForUi, fetchNexusAtaBalance());

  $: principalFloor = (() => {
    if (!nexusState) return null;
    return kind === 'usdc'
      ? nexusState.totalDepositedUsdc
      : nexusState.totalDepositedRwt;
  })();

  $: withdrawableProfit = (() => {
    if (nexusAtaBalance === null || principalFloor === null) return null;
    const diff = nexusAtaBalance - principalFloor;
    return diff > 0n ? diff : 0n;
  })();

  $: requestedAmount = parseDecimal(amountStr, DECIMALS);
  $: amountExceedsProfit =
    withdrawableProfit !== null &&
    requestedAmount > 0n &&
    requestedAmount > withdrawableProfit;
  $: hasNoProfit = withdrawableProfit !== null && withdrawableProfit === 0n;

  async function submitWithdraw(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const dex = $dexStore;
    const nexusPda = $nexusStore.pda;
    if (!dex.configPda || !nexusPda) {
      pushToast('error', 'DEX/Nexus state not loaded.');
      return;
    }
    const trimmedAta = recipientAtaStr.trim();
    if (!isValidAddress(trimmedAta)) {
      pushToast('error', 'Invalid recipient ATA.');
      return;
    }
    const amount = parseDecimal(amountStr, DECIMALS);
    if (amount <= 0n) {
      pushToast('error', 'Amount must be positive.');
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
        pushToast('error', 'RWT mint not loaded.');
        return;
      }
      mint = new PublicKey(vault.rwtMint);
      tokenKind = TOKEN_KIND_RWT;
    }

    withdrawSubmitting = true;
    try {
      const nexusAta = findAta(nexusPda, mint);
      const ix = await buildNexusWithdrawProfitsIx({
        dexProgramId,
        authority: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        nexusTokenAta: nexusAta,
        recipientTokenAta: new PublicKey(trimmedAta),
        amount,
        tokenKind,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `Profits withdrawn: ${sig.slice(0, 12)}…`);
      void nexusStore.refresh();
      amountStr = '';
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      withdrawSubmitting = false;
    }
  }

  // ----- Claim rewards (LP fees on a Nexus position) -----
  let claimPoolStr = '';
  let claimSubmitting = false;

  async function submitClaimRewards(): Promise<void> {
    const w = $wallet;
    if (!w.connected || !w.publicKey || !w.provider) {
      pushToast('error', 'Connect a wallet first.');
      return;
    }
    const dex = $dexStore;
    const nexusPda = $nexusStore.pda;
    if (!dex.configPda || !nexusPda) {
      pushToast('error', 'DEX/Nexus state not loaded.');
      return;
    }
    const trimmed = claimPoolStr.trim();
    if (!isValidAddress(trimmed)) {
      pushToast('error', 'Invalid pool PDA.');
      return;
    }
    const poolPda = new PublicKey(trimmed);
    const pool = dex.pools.find((p) => p.pda === trimmed);
    if (!pool) {
      pushToast('error', 'Pool not found in dex store. Refresh DEX first.');
      return;
    }

    claimSubmitting = true;
    try {
      const tokenAMint = new PublicKey(pool.tokenAMint);
      const tokenBMint = new PublicKey(pool.tokenBMint);
      const [lpPda] = findLpPositionPda(poolPda, nexusPda, dexProgramId);
      const nexusTokenA = findAta(nexusPda, tokenAMint);
      const nexusTokenB = findAta(nexusPda, tokenBMint);
      const ix = await buildNexusClaimRewardsIx({
        dexProgramId,
        authority: w.publicKey,
        dexConfig: dex.configPda,
        liquidityNexus: nexusPda,
        poolState: poolPda,
        lpPosition: lpPda,
        poolVaultA: new PublicKey(pool.vaultA),
        poolVaultB: new PublicKey(pool.vaultB),
        nexusTokenAAta: nexusTokenA,
        nexusTokenBAta: nexusTokenB,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendWalletTransaction($connection, tx, {
        publicKey: w.publicKey,
        signTransaction: w.provider.signTransaction.bind(w.provider),
      });
      pushToast('success', `Rewards claimed: ${sig.slice(0, 12)}…`);
      void nexusStore.refresh();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      claimSubmitting = false;
    }
  }
</script>

<div class="panels">
  <article class="panel">
    <header class="panel-head">
      <h3>
        <Banknote size={16} />
        Withdraw Profits
      </h3>
      <span class="role">Authority</span>
    </header>
    <p class="hint">
      Sweep the above-principal ATA balance to a Treasury-owned recipient ATA.
      Reverts on impermanent loss (`ata_balance &lt; principal_floor`). Counter
      is NOT decremented (principal-lock invariant). Layer 9 §4.6.
    </p>

    <div class="kind-toggle">
      <button class:active={kind === 'usdc'} on:click={() => (kind = 'usdc')}>USDC</button>
      <button class:active={kind === 'rwt'} on:click={() => (kind = 'rwt')}>RWT</button>
    </div>

    {#if nexusState}
      <div class="cell">
        <span class="cell-label">Principal floor ({kind.toUpperCase()})</span>
        <span class="cell-value mono">
          {kind === 'usdc'
            ? nexusState.totalDepositedUsdc.toString()
            : nexusState.totalDepositedRwt.toString()}
        </span>
      </div>
    {/if}

    <div class="form-row">
      <label for="wp-amount">Amount</label>
      <input id="wp-amount" type="text" bind:value={amountStr} placeholder="0.0" />
    </div>
    <div class="form-row">
      <label for="wp-rcpt">Recipient ATA</label>
      <input id="wp-rcpt" type="text" bind:value={recipientAtaStr} placeholder="Treasury ATA" />
    </div>

    <div class="profit-preview">
      {#if nexusAtaBalanceLoading}
        <span class="muted">Loading Nexus ATA balance…</span>
      {:else if withdrawableProfit !== null}
        <span class="muted">
          Withdrawable profit: <span class="mono">{withdrawableProfit.toString()}</span>
          (ATA balance <span class="mono">{nexusAtaBalance ?? 0n}</span> − principal floor
          <span class="mono">{principalFloor ?? 0n}</span>)
        </span>
      {/if}
      {#if hasNoProfit}
        <span class="warn">Principal-lock invariant: nothing withdrawable.</span>
      {/if}
      {#if amountExceedsProfit}
        <span class="warn">Amount exceeds withdrawable profit — TX would revert.</span>
      {/if}
    </div>

    <button
      class="btn btn-primary"
      on:click={submitWithdraw}
      disabled={withdrawSubmitting
        || !$wallet.connected
        || hasNoProfit
        || amountExceedsProfit}
    >
      {#if withdrawSubmitting}
        <Loader2 size={14} class="spin" />
        Submitting…
      {:else}
        Withdraw {kind.toUpperCase()} profits
      {/if}
    </button>
  </article>

  <article class="panel">
    <header class="panel-head">
      <h3>
        <Coins size={16} />
        Claim Rewards
      </h3>
      <span class="role">Authority</span>
    </header>
    <p class="hint">
      Realise accumulator-tracked LP fees on a Nexus position. Claimed fees
      flow back into the Nexus-owned ATAs and accrue as profit above the
      principal floor. Layer 9 §4.7.
    </p>
    <div class="form-row">
      <label for="claim-pool">Pool PDA</label>
      <input id="claim-pool" type="text" bind:value={claimPoolStr} placeholder="Pool address" />
    </div>
    <button
      class="btn btn-primary"
      on:click={submitClaimRewards}
      disabled={claimSubmitting || !$wallet.connected}
    >
      {#if claimSubmitting}
        <Loader2 size={14} class="spin" />
        Submitting…
      {:else}
        Submit nexus_claim_rewards
      {/if}
    </button>
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
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-bg);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }
  .cell-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cell-value {
    font-size: var(--text-sm);
    color: var(--color-text);
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
  .mono { font-family: var(--font-mono); }

  .muted { color: var(--color-text-muted); font-size: var(--text-xs); }
  .warn { color: var(--color-danger); font-size: var(--text-xs); }
  .profit-preview {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2);
    border-left: 2px solid var(--color-border);
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
