<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Plus, RefreshCw, Hexagon, Loader2 } from 'lucide-svelte';
  import { PublicKey, Transaction } from '@solana/web3.js';
  import { otList, arlexClient, programId } from '$lib/stores/ot';
  import { wallet, connected, publicKey } from '$lib/stores/wallet';
  import { connection, network } from '$lib/stores/network';
  import { get } from 'svelte/store';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import { formatAmount, isValidAddress, stringToFixedBytes } from '$lib/utils/format';
  import {
    findOtConfigPda, findRevenueAccountPda, findRevenueConfigPda,
    findOtGovernancePda, findOtTreasuryPda, findAta,
    TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    USDC_MINTS
  } from '$lib/utils/pda';

  // Initialize form state
  let showInitForm = false;
  let formMint = '';
  let formName = '';
  let formSymbol = '';
  let formUri = '';
  let formAuthority = '';
  let formFeeDestination = '';
  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSignature = '';
  let txError = '';

  onMount(() => {
    otList.refresh();
  });

  // Validation
  $: mintValid = isValidAddress(formMint);
  $: authorityValid = isValidAddress(formAuthority);
  $: feeDestValid = isValidAddress(formFeeDestination);
  $: nameValid = formName.length > 0 && new TextEncoder().encode(formName).length <= 32;
  $: symbolValid = formSymbol.length > 0 && new TextEncoder().encode(formSymbol).length <= 10;
  $: uriValid = formUri.length > 0 && new TextEncoder().encode(formUri).length <= 200;
  $: formValid = mintValid && authorityValid && feeDestValid && nameValid && symbolValid && uriValid && $connected;

  async function handleInitialize() {
    if (!formValid || !$publicKey) return;

    txStatus = 'signing';
    txSignature = '';
    txError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);
      const cluster = get(network);

      const otMint = new PublicKey(formMint);
      const usdcMint = USDC_MINTS[cluster];
      if (!usdcMint) throw new Error('USDC mint not configured for this cluster');

      // Derive PDAs
      const [otConfigPda] = findOtConfigPda(otMint, programId);
      const [revenuePda] = findRevenueAccountPda(otMint, programId);
      const [revenueConfigPda] = findRevenueConfigPda(otMint, programId);
      const [governancePda] = findOtGovernancePda(otMint, programId);
      const [treasuryPda] = findOtTreasuryPda(otMint, programId);
      const revenueAta = findAta(revenuePda, usdcMint);

      const tx = client.buildTransaction('initialize_ot', {
        accounts: {
          deployer: $publicKey,
          ot_mint: otMint,
          usdc_mint: usdcMint,
          ot_config: otConfigPda,
          revenue_account: revenuePda,
          revenue_token_account: revenueAta,
          revenue_config: revenueConfigPda,
          ot_governance: governancePda,
          ot_treasury: treasuryPda,
          areal_fee_destination_account: new PublicKey(formFeeDestination),
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
        },
        args: {
          name: Array.from(stringToFixedBytes(formName, 32)),
          symbol: Array.from(stringToFixedBytes(formSymbol, 10)),
          uri: Array.from(stringToFixedBytes(formUri, 200)),
          initial_authority: Array.from(new PublicKey(formAuthority).toBytes())
        },
        computeUnits: 400_000
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      txStatus = 'signing';
      const signedTx = await wallet.signTransaction(tx);

      txStatus = 'sending';
      const sig = await conn.sendRawTransaction(signedTx.serialize());
      txSignature = sig;

      txStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');

      txStatus = 'success';

      // Refresh list and navigate
      setTimeout(() => {
        otList.refresh();
      }, 1000);
    } catch (err: any) {
      txStatus = 'error';
      txError = err.message || 'Transaction failed';
    }
  }
</script>

<div class="page">
  <div class="page-header">
    <h2>Ownership Tokens</h2>
    <div class="header-actions">
      <button class="btn-secondary" on:click={() => otList.refresh()}>
        <RefreshCw size={14} />
        <span>Refresh</span>
      </button>
      <button class="btn-primary" on:click={() => { showInitForm = !showInitForm; }}>
        <Plus size={14} />
        <span>Initialize New</span>
      </button>
    </div>
  </div>

  {#if showInitForm}
    <div class="card init-form">
      <h3>Initialize Ownership Token</h3>
      <p class="hint">
        Create an SPL mint first via CLI:
        <code>spl-token create-token keypair.json --decimals 6</code>
      </p>

      <div class="form-grid">
        <label class="form-field">
          <span class="label">OT Mint Address</span>
          <input type="text" bind:value={formMint}
            placeholder="Pubkey of pre-created SPL mint"
            class:invalid={formMint && !mintValid} />
        </label>

        <label class="form-field">
          <span class="label">Name <span class="limit">{new TextEncoder().encode(formName).length}/32 bytes</span></span>
          <input type="text" bind:value={formName} placeholder="Token name"
            class:invalid={formName && !nameValid} />
        </label>

        <label class="form-field">
          <span class="label">Symbol <span class="limit">{new TextEncoder().encode(formSymbol).length}/10 bytes</span></span>
          <input type="text" bind:value={formSymbol} placeholder="Token symbol"
            class:invalid={formSymbol && !symbolValid} />
        </label>

        <label class="form-field full-width">
          <span class="label">URI <span class="limit">{new TextEncoder().encode(formUri).length}/200 bytes</span></span>
          <input type="text" bind:value={formUri} placeholder="Metadata URI"
            class:invalid={formUri && !uriValid} />
        </label>

        <label class="form-field">
          <span class="label">Initial Authority</span>
          <input type="text" bind:value={formAuthority} placeholder="Governance authority pubkey"
            class:invalid={formAuthority && !authorityValid} />
        </label>

        <label class="form-field">
          <span class="label">Areal Fee Destination</span>
          <input type="text" bind:value={formFeeDestination}
            placeholder="USDC ATA for protocol fees"
            class:invalid={formFeeDestination && !feeDestValid} />
        </label>
      </div>

      <div class="form-actions">
        <button class="btn-secondary" on:click={() => { showInitForm = false; }}>Cancel</button>
        <button class="btn-primary" disabled={!formValid || txStatus === 'signing' || txStatus === 'sending' || txStatus === 'confirming'}
          on:click={handleInitialize}>
          {#if !$connected}
            Connect Wallet First
          {:else}
            Initialize OT
          {/if}
        </button>
      </div>

      <TxStatus status={txStatus} signature={txSignature} error={txError} />
    </div>
  {/if}

  {#if $otList.loading}
    <div class="loading">
      <Loader2 size={24} class="spin" />
      <span>Loading tokens...</span>
    </div>
  {:else if $otList.error}
    <div class="error-banner">{$otList.error}</div>
  {:else if $otList.items.length === 0}
    <div class="empty-state">
      <Hexagon size={48} />
      <p>No Ownership Tokens found on this network.</p>
      <p class="secondary">Initialize a new OT to get started.</p>
    </div>
  {:else}
    <div class="token-grid">
      {#each $otList.items as item}
        <a href="/ot/{item.mint}" class="token-card">
          <div class="token-header">
            <span class="token-symbol">{item.symbol}</span>
            <span class="token-name">{item.name}</span>
          </div>
          <div class="token-meta">
            <div class="meta-row">
              <span class="meta-label">Mint</span>
              <CopyAddress address={item.mint} chars={6} />
            </div>
            <div class="meta-row">
              <span class="meta-label">Total Minted</span>
              <span class="mono">{formatAmount(item.totalMinted, item.decimals)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Decimals</span>
              <span>{item.decimals}</span>
            </div>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-actions {
    display: flex;
    gap: var(--space-2);
  }

  .btn-primary, .btn-secondary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: all var(--transition-fast);
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover {
    background: var(--color-surface-hover);
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
  }

  .init-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .init-form h3 {
    margin-bottom: var(--space-1);
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .hint code {
    background: var(--color-surface-active);
    padding: 2px var(--space-1);
    border-radius: var(--radius-xs);
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-field.full-width {
    grid-column: 1 / -1;
  }

  .label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text-secondary);
    display: flex;
    justify-content: space-between;
  }

  .limit {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .form-field input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .form-field input.invalid {
    border-color: var(--color-danger);
  }

  .form-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
    padding-top: var(--space-2);
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-12);
    color: var(--color-text-muted);
  }

  .error-banner {
    padding: var(--space-4);
    background: var(--color-danger-muted);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    color: var(--color-danger);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-12);
    color: var(--color-text-muted);
    text-align: center;
  }

  .token-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--space-4);
  }

  .token-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    color: var(--color-text);
    text-decoration: none;
    transition: all var(--transition-fast);
  }

  .token-card:hover {
    border-color: var(--color-primary);
    box-shadow: var(--shadow-card);
    text-decoration: none;
  }

  .token-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .token-symbol {
    font-weight: 700;
    font-size: var(--text-lg);
    color: var(--color-primary);
  }

  .token-name {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .token-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--text-sm);
  }

  .meta-label {
    color: var(--color-text-muted);
  }
</style>
