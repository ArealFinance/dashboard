<script lang="ts">
  import { getContext } from 'svelte';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { Coins, Zap, Send } from 'lucide-svelte';
  import { arlexClient, programId } from '$lib/stores/ot';
  import { wallet, connected, publicKey } from '$lib/stores/wallet';
  import { connection, network } from '$lib/stores/network';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import {
    formatAmount, formatUsdc, formatCooldown, bytesToBase58, isValidAddress, formatAddress, parseDecimal
  } from '$lib/utils/format';
  import {
    findOtConfigPda, findRevenueAccountPda, findRevenueConfigPda,
    findOtGovernancePda, findOtTreasuryPda, findAta,
    TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    USDC_MINTS
  } from '$lib/utils/pda';
  import type { OtState } from '$lib/stores/ot';
  import type { Writable } from 'svelte/store';

  const otStore = getContext<{ subscribe: Writable<OtState>['subscribe']; refresh: () => Promise<void> }>('otStore');

  $: mintAddress = $page.params.mint ?? '';
  $: otMint = mintAddress ? new PublicKey(mintAddress) : PublicKey.default;

  // Mint OT form
  let mintAmount = '';
  let mintRecipient = '';
  let mintTxStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let mintTxSig = '';
  let mintTxError = '';

  $: mintRecipientValid = isValidAddress(mintRecipient);
  $: mintAmountValid = mintAmount !== '' && Number(mintAmount) > 0;
  $: decimals = $otStore.otConfig?.decimals ?? 6;
  $: isAuthority = $publicKey && $otStore.governance &&
    bytesToBase58($otStore.governance.authority) === $publicKey.toBase58();

  // Distribute form
  let distTxStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let distTxSig = '';
  let distTxError = '';

  const COOLDOWN_SECONDS = 604_800;
  $: lastDistTs = Number($otStore.revenueAccount?.last_distribution_ts ?? 0n);
  $: cooldownRemaining = lastDistTs === 0 ? 0 : Math.max(0, COOLDOWN_SECONDS - (Math.floor(Date.now() / 1000) - lastDistTs));
  $: ataBalance = BigInt($otStore.revenueAtaBalance?.toString() ?? '0');
  $: minAmount = BigInt($otStore.revenueAccount?.min_distribution_amount?.toString() ?? '100000000');
  $: canDistribute = cooldownRemaining === 0 && ataBalance >= minAmount &&
    ($otStore.revenueConfig?.active_count ?? 0) > 0;

  // Spend Treasury form
  let spendAmount = '';
  let spendDestination = '';
  let spendTokenIndex = 0;
  let spendTxStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let spendTxSig = '';
  let spendTxError = '';

  $: spendDestValid = isValidAddress(spendDestination);
  $: spendAmountValid = spendAmount !== '' && Number(spendAmount) > 0;
  $: treasuryAccounts = $otStore.treasuryTokenAccounts ?? [];

  async function handleMint() {
    if (!$publicKey || !mintAmountValid || !mintRecipientValid) return;

    mintTxStatus = 'signing';
    mintTxSig = '';
    mintTxError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);
      const recipient = new PublicKey(mintRecipient);

      const [otConfigPda] = findOtConfigPda(otMint, programId);
      const [governancePda] = findOtGovernancePda(otMint, programId);

      // Calculate raw amount from human input
      // M-11: string-based decimal parsing avoids float precision loss
      const rawAmount = parseDecimal(mintAmount, decimals);

      // Derive recipient ATA
      const recipientAta = findAta(recipient, otMint);

      const tx = client.buildTransaction('mint_ot', {
        accounts: {
          authority: $publicKey,
          ot_governance: governancePda,
          ot_config: otConfigPda,
          ot_mint: otMint,
          recipient_token_account: recipientAta,
          recipient: recipient,
          payer: $publicKey,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
        },
        args: { amount: rawAmount },
        computeUnits: 200_000
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      mintTxStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      mintTxSig = sig;
      mintTxStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      mintTxStatus = 'success';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      mintTxStatus = 'error';
      mintTxError = err.message || 'Mint failed';
    }
  }

  async function handleDistribute() {
    if (!$publicKey || !canDistribute) return;

    distTxStatus = 'signing';
    distTxSig = '';
    distTxError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);
      const cluster = get(network);

      const [revenuePda] = findRevenueAccountPda(otMint, programId);
      const [revenueConfigPda] = findRevenueConfigPda(otMint, programId);
      const usdcMint = USDC_MINTS[cluster];
      if (!usdcMint) throw new Error('USDC mint not configured');

      const revenueAta = findAta(revenuePda, usdcMint);

      // Build remaining accounts from active destinations
      const rcfg = $otStore.revenueConfig;
      if (!rcfg) throw new Error('Revenue config not loaded');

      const remainingAccounts = [];
      for (let i = 0; i < rcfg.active_count; i++) {
        const dest = rcfg.destinations[i];
        const destPk = new PublicKey(
          dest.address instanceof Uint8Array ? dest.address : new Uint8Array(dest.address)
        );
        remainingAccounts.push({
          pubkey: destPk,
          isSigner: false,
          isWritable: true
        });
      }

      // Fee account from config
      const feeDestPk = new PublicKey(
        rcfg.areal_fee_destination instanceof Uint8Array
          ? rcfg.areal_fee_destination
          : new Uint8Array(rcfg.areal_fee_destination)
      );

      const tx = client.buildTransaction('distribute_revenue', {
        accounts: {
          crank: $publicKey,
          ot_mint: otMint,
          revenue_account: revenuePda,
          revenue_token_account: revenueAta,
          revenue_config: revenueConfigPda,
          areal_fee_account: feeDestPk,
          token_program: TOKEN_PROGRAM_ID
        },
        remainingAccounts,
        computeUnits: 300_000
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      distTxStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      distTxSig = sig;
      distTxStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      distTxStatus = 'success';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      distTxStatus = 'error';
      distTxError = err.message || 'Distribution failed';
    }
  }

  async function handleSpend() {
    if (!$publicKey || !spendAmountValid || !spendDestValid || treasuryAccounts.length === 0) return;

    spendTxStatus = 'signing';
    spendTxSig = '';
    spendTxError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);

      const [governancePda] = findOtGovernancePda(otMint, programId);
      const [treasuryPda] = findOtTreasuryPda(otMint, programId);

      const selectedTa = treasuryAccounts[spendTokenIndex];
      if (!selectedTa) throw new Error('No token account selected');

      const rawAmount = BigInt(spendAmount);
      const destination = new PublicKey(spendDestination);

      const tx = client.buildTransaction('spend_treasury', {
        accounts: {
          authority: $publicKey,
          ot_mint: otMint,
          ot_governance: governancePda,
          ot_treasury: treasuryPda,
          treasury_token_account: selectedTa.address,
          destination_token_account: destination,
          token_mint: selectedTa.mint,
          token_program: TOKEN_PROGRAM_ID
        },
        args: { amount: rawAmount },
        computeUnits: 200_000
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      spendTxStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      spendTxSig = sig;
      spendTxStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      spendTxStatus = 'success';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      spendTxStatus = 'error';
      spendTxError = err.message || 'Spend failed';
    }
  }
</script>

<div class="actions-page">
  <!-- Mint OT -->
  <section class="card">
    <div class="card-header">
      <Coins size={16} />
      <h3>Mint OT Tokens</h3>
      {#if !isAuthority}
        <span class="badge-restricted">Authority only</span>
      {/if}
    </div>

    <div class="form-row">
      <label class="form-field grow">
        <span class="label">Amount</span>
        <input type="number" bind:value={mintAmount} placeholder="0.0" min="0" step="any" />
      </label>
      <label class="form-field grow-2">
        <span class="label">Recipient</span>
        <input type="text" bind:value={mintRecipient} placeholder="Recipient wallet address"
          class:invalid={mintRecipient && !mintRecipientValid} />
      </label>
    </div>

    {#if mintAmount && mintRecipientValid}
      <p class="preview">
        Will mint <strong>{mintAmount}</strong> tokens to <strong>{formatAddress(mintRecipient, 4)}</strong>
      </p>
    {/if}

    <div class="form-actions">
      <button class="btn-primary" disabled={!isAuthority || !mintAmountValid || !mintRecipientValid || !$connected ||
        mintTxStatus === 'signing' || mintTxStatus === 'sending' || mintTxStatus === 'confirming'}
        on:click={handleMint}>
        Mint
      </button>
    </div>
    <TxStatus status={mintTxStatus} signature={mintTxSig} error={mintTxError} />
  </section>

  <!-- Distribute Revenue -->
  <section class="card">
    <div class="card-header">
      <Zap size={16} />
      <h3>Distribute Revenue</h3>
      <span class="badge-open">Permissionless</span>
    </div>

    <div class="conditions">
      <div class="condition" class:met={cooldownRemaining === 0} class:unmet={cooldownRemaining > 0}>
        <span class="condition-label">Cooldown:</span>
        {#if lastDistTs === 0}
          <span>Ready (first distribution)</span>
        {:else}
          <span>{formatCooldown(cooldownRemaining)}</span>
        {/if}
      </div>
      <div class="condition" class:met={ataBalance >= minAmount} class:unmet={ataBalance < minAmount}>
        <span class="condition-label">Balance:</span>
        <span>{formatUsdc(ataBalance)} / {formatUsdc(minAmount)} minimum</span>
      </div>
      <div class="condition" class:met={($otStore.revenueConfig?.active_count ?? 0) > 0}
        class:unmet={($otStore.revenueConfig?.active_count ?? 0) === 0}>
        <span class="condition-label">Destinations:</span>
        <span>{$otStore.revenueConfig?.active_count ?? 0} configured</span>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn-primary" disabled={!canDistribute || !$connected ||
        distTxStatus === 'signing' || distTxStatus === 'sending' || distTxStatus === 'confirming'}
        on:click={handleDistribute}>
        Distribute
      </button>
    </div>
    <TxStatus status={distTxStatus} signature={distTxSig} error={distTxError} />
  </section>

  <!-- Spend Treasury -->
  <section class="card">
    <div class="card-header">
      <Send size={16} />
      <h3>Spend Treasury</h3>
      {#if !isAuthority}
        <span class="badge-restricted">Authority only</span>
      {/if}
    </div>

    {#if treasuryAccounts.length === 0}
      <p class="empty-text">No token accounts in treasury.</p>
    {:else}
      <div class="form-row">
        <label class="form-field">
          <span class="label">Token</span>
          <select bind:value={spendTokenIndex}>
            {#each treasuryAccounts as ta, i}
              <option value={i}>
                {formatAddress(ta.mint.toBase58(), 6)} (bal: {ta.balance.toString()})
              </option>
            {/each}
          </select>
        </label>
        <label class="form-field grow">
          <span class="label">Amount (raw)</span>
          <input type="number" bind:value={spendAmount} placeholder="0" min="1" step="1" />
        </label>
      </div>
      <label class="form-field">
        <span class="label">Destination Token Account</span>
        <input type="text" bind:value={spendDestination} placeholder="Existing token account address"
          class:invalid={spendDestination && !spendDestValid} />
      </label>

      <div class="form-actions">
        <button class="btn-primary" disabled={!isAuthority || !spendAmountValid || !spendDestValid || !$connected ||
          spendTxStatus === 'signing' || spendTxStatus === 'sending' || spendTxStatus === 'confirming'}
          on:click={handleSpend}>
          Spend
        </button>
      </div>
      <TxStatus status={spendTxStatus} signature={spendTxSig} error={spendTxError} />
    {/if}
  </section>
</div>

<style>
  .actions-page {
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

  .badge-restricted {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-warning-muted);
    color: var(--color-warning);
  }

  .badge-open {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-success-muted);
    color: var(--color-success);
  }

  .form-row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-field.grow { flex: 1; }
  .form-field.grow-2 { flex: 2; }

  .label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .form-field input, .form-field select {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .form-field input.invalid {
    border-color: var(--color-danger);
  }

  .preview {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-active);
    border-radius: var(--radius-sm);
  }

  .conditions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .condition {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }

  .condition.met {
    background: var(--color-success-muted);
    color: var(--color-success);
  }

  .condition.unmet {
    background: var(--color-danger-muted);
    color: var(--color-danger);
  }

  .condition-label {
    font-weight: 500;
    min-width: 100px;
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

  .empty-text {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
    padding: var(--space-4);
  }
</style>
