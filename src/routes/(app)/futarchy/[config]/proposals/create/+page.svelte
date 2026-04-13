<script lang="ts">
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { PublicKey, SystemProgram } from '@solana/web3.js';
  import { wallet } from '$lib/stores/wallet';
  import { futarchyClient, futarchyProgramId } from '$lib/stores/futarchy';
  import { findProposalPda } from '$lib/utils/pda';
  import { isValidAddress, stringToFixedBytes } from '$lib/utils/format';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { connection } from '$lib/stores/network';
  import TxStatus from '$lib/components/TxStatus.svelte';

  const store: any = getContext('futarchyStore');

  // Tab selection
  let activeTab: 0 | 1 | 2 = 0; // MintOt, SpendTreasury, UpdateDest

  // Shared form state
  let amount = '';
  let destination = '';
  let tokenMint = '';
  let paramsHashInput = '';

  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSignature = '';
  let txError = '';

  $: amountValid = activeTab !== 2 ? Number(amount) > 0 : true;
  $: destValid = activeTab !== 2 ? isValidAddress(destination) : true;
  $: tokenMintValid = activeTab === 1 ? isValidAddress(tokenMint) : true;
  $: hashValid = activeTab === 2 ? paramsHashInput.length === 64 : true;
  $: formValid = amountValid && destValid && tokenMintValid && hashValid;

  async function handleCreate() {
    if (!$wallet.publicKey || !$store.config) return;
    txStatus = 'signing';
    txError = '';

    try {
      const client = $futarchyClient;
      const nextId = BigInt($store.config.next_proposal_id.toString());
      const [proposalPda] = findProposalPda($store.configAddress, nextId, futarchyProgramId);

      // Build args
      const destBytes = activeTab !== 2
        ? new PublicKey(destination).toBytes()
        : new Uint8Array(32);
      const tokenMintBytes = activeTab === 1
        ? new PublicKey(tokenMint).toBytes()
        : new Uint8Array(32);
      const hashBytes = activeTab === 2
        ? Uint8Array.from(paramsHashInput.match(/.{2}/g)!.map(b => parseInt(b, 16)))
        : new Uint8Array(32);

      const tx = client.buildTransaction('create_proposal', {
        accounts: {
          authority: $wallet.publicKey,
          config: $store.configAddress,
          proposal: proposalPda,
          system_program: SystemProgram.programId
        },
        args: {
          proposal_type: activeTab,
          amount: activeTab !== 2 ? BigInt(amount) : 0n,
          destination: Array.from(destBytes),
          token_mint: Array.from(tokenMintBytes),
          params_hash: Array.from(hashBytes)
        }
      });

      txStatus = 'sending';
      const sig = await signAndSendTransaction($connection, tx, []);
      txSignature = sig;
      txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';

      await store.refresh();
    } catch (e: any) {
      txError = e.message || 'Unknown error';
      txStatus = 'error';
    }
  }
</script>

<div class="create-page">
  <div class="card">
    <div class="card-header"><h3>Create Proposal</h3></div>
    <div class="card-body">
      <!-- Type tabs -->
      <div class="type-tabs">
        <button class="type-tab" class:active={activeTab === 0} on:click={() => activeTab = 0}>Mint OT</button>
        <button class="type-tab" class:active={activeTab === 1} on:click={() => activeTab = 1}>Spend Treasury</button>
        <button class="type-tab" class:active={activeTab === 2} on:click={() => activeTab = 2}>Update Destinations</button>
      </div>

      <!-- MintOt form -->
      {#if activeTab === 0}
        <div class="form-section">
          <div class="form-group">
            <label class="form-label">Amount (raw tokens)</label>
            <input class="form-input" type="number" bind:value={amount} min="1" placeholder="e.g. 1000000000" />
          </div>
          <div class="form-group">
            <label class="form-label">Recipient Address</label>
            <input class="form-input" type="text" bind:value={destination} placeholder="Base58 wallet address" />
          </div>
        </div>
      {/if}

      <!-- SpendTreasury form -->
      {#if activeTab === 1}
        <div class="form-section">
          <div class="form-group">
            <label class="form-label">Amount (raw tokens)</label>
            <input class="form-input" type="number" bind:value={amount} min="1" placeholder="e.g. 100000000" />
          </div>
          <div class="form-group">
            <label class="form-label">Destination Address</label>
            <input class="form-input" type="text" bind:value={destination} placeholder="Wallet that receives tokens" />
          </div>
          <div class="form-group">
            <label class="form-label">Token Mint</label>
            <input class="form-input" type="text" bind:value={tokenMint} placeholder="Mint of token to spend" />
          </div>
        </div>
      {/if}

      <!-- UpdateDestinations form -->
      {#if activeTab === 2}
        <div class="form-section">
          <div class="form-group">
            <label class="form-label">Params Hash (64 hex chars = SHA256 of serialized destinations)</label>
            <input class="form-input mono" type="text" bind:value={paramsHashInput}
              placeholder="e.g. a1b2c3d4..." maxlength="64" />
          </div>
          <p class="hint">Compute SHA256 of Borsh-serialized Vec&lt;BatchDestination&gt; off-chain and paste the hex hash here.</p>
        </div>
      {/if}

      <button class="btn btn-primary" disabled={!formValid || !$wallet.publicKey || txStatus === 'signing' || txStatus === 'sending'} on:click={handleCreate}>
        Create Proposal
      </button>

      <TxStatus status={txStatus} signature={txSignature} error={txError} />
    </div>
  </div>
</div>

<style>
  .create-page { display: flex; flex-direction: column; gap: var(--space-4); }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); }
  .card-header h3 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .card-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }

  .type-tabs { display: flex; gap: var(--space-1); background: var(--color-bg); border-radius: var(--radius-md); padding: 2px; }
  .type-tab { flex: 1; padding: var(--space-2); border: none; background: none; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--color-text-secondary); cursor: pointer; transition: all 0.15s; }
  .type-tab.active { background: var(--color-primary); color: white; font-weight: 500; }

  .form-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-label { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-input { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); color: var(--color-text); font-size: var(--text-sm); }
  .form-input.mono { font-family: var(--font-mono); }
  .hint { font-size: var(--text-xs); color: var(--color-text-muted); margin: 0; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; border: none; cursor: pointer; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
