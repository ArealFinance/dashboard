<script lang="ts">
  import { getContext } from 'svelte';
  import type { FutarchyStore } from '$lib/stores/futarchy';
  import { page } from '$app/stores';
  import { PublicKey } from '@solana/web3.js';
  import { Check, X, Play, ArrowLeft } from 'lucide-svelte';
  import { wallet } from '$lib/stores/wallet';
  import { futarchyClient, futarchyProgramId, PROPOSAL_TYPES, PROPOSAL_STATUSES } from '$lib/stores/futarchy';
  import { programId as otProgramId } from '$lib/stores/ot';
  import { findOtGovernancePda, findOtConfigPda, findOtTreasuryPda, findRevenueConfigPda, findAta,
    TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import { bytesToBase58, formatTimestamp, isZeroAddress, formatAddress } from '$lib/utils/format';
  import { sendWalletTransaction } from '$lib/utils/tx';
  import { connection } from '$lib/stores/network';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import TxStatus from '$lib/components/TxStatus.svelte';

  const store = getContext<FutarchyStore>('futarchyStore')!;

  $: proposalIdStr = ($page.params as { id?: string }).id ?? '0';
  $: proposalId = BigInt(proposalIdStr);
  $: proposal = $store.proposals.find((p: any) => p.proposalId === proposalId);
  $: config = $store.config;

  $: statusInfo = proposal ? (PROPOSAL_STATUSES[proposal.status] ?? { label: 'Unknown', color: 'var(--color-text-muted)' }) : null;
  $: typeLabel = proposal ? (PROPOSAL_TYPES[proposal.proposalType] ?? 'Unknown') : '';

  $: isAuthority = config && $wallet.publicKey
    ? bytesToBase58(config.authority) === $wallet.publicKey.toBase58()
    : false;

  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSignature = '';
  let txError = '';

  async function handleApprove() {
    if (!proposal || !$wallet.publicKey) return;
    txStatus = 'signing';
    txError = '';
    try {
      const client = $futarchyClient;
      const tx = client.buildTransaction('approve_proposal', {
        accounts: {
          authority: $wallet.publicKey,
          config: $store.configAddress,
          proposal: proposal.address
        },
        args: {}
      });
      txStatus = 'sending';
      const sig = await sendWalletTransaction($connection, tx, $wallet.provider!);
      txSignature = sig;
      txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }

  async function handleCancel() {
    if (!proposal || !$wallet.publicKey) return;
    txStatus = 'signing';
    txError = '';
    try {
      const client = $futarchyClient;
      const tx = client.buildTransaction('cancel_proposal', {
        accounts: {
          authority: $wallet.publicKey,
          config: $store.configAddress,
          proposal: proposal.address
        },
        args: {}
      });
      txStatus = 'sending';
      const sig = await sendWalletTransaction($connection, tx, $wallet.provider!);
      txSignature = sig;
      txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }

  async function handleExecute() {
    if (!proposal || !config || !$wallet.publicKey) return;
    txStatus = 'signing';
    txError = '';
    try {
      const client = $futarchyClient;
      const otMint = new PublicKey(proposal.otMint);
      const [otGovPda] = findOtGovernancePda(otMint, otProgramId);

      // Build remaining accounts based on proposal type
      let remainingAccounts: any[] = [];

      if (proposal.proposalType === 0) {
        // MintOt
        const [otConfigPda] = findOtConfigPda(otMint, otProgramId);
        const recipient = new PublicKey(proposal.destination);
        const recipientAta = findAta(recipient, otMint);
        remainingAccounts = [
          { pubkey: otGovPda, isWritable: false, isSigner: false },
          { pubkey: otConfigPda, isWritable: true, isSigner: false },
          { pubkey: otMint, isWritable: true, isSigner: false },
          { pubkey: recipientAta, isWritable: true, isSigner: false },
          { pubkey: recipient, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ];
      } else if (proposal.proposalType === 1) {
        // SpendTreasury
        const [otTreasuryPda] = findOtTreasuryPda(otMint, otProgramId);
        const tokenMintPk = new PublicKey(proposal.tokenMint);
        const treasuryAta = findAta(otTreasuryPda, tokenMintPk);
        const destAta = findAta(new PublicKey(proposal.destination), tokenMintPk);
        remainingAccounts = [
          { pubkey: otGovPda, isWritable: false, isSigner: false },
          { pubkey: otMint, isWritable: false, isSigner: false },
          { pubkey: otTreasuryPda, isWritable: false, isSigner: false },
          { pubkey: treasuryAta, isWritable: true, isSigner: false },
          { pubkey: destAta, isWritable: true, isSigner: false },
          { pubkey: tokenMintPk, isWritable: false, isSigner: false },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ];
      } else if (proposal.proposalType === 2) {
        // UpdateDestinations — requires temp data account (not handled in UI yet)
        const [revConfigPda] = findRevenueConfigPda(otMint, otProgramId);
        remainingAccounts = [
          { pubkey: otGovPda, isWritable: false, isSigner: false },
          { pubkey: otMint, isWritable: false, isSigner: false },
          { pubkey: revConfigPda, isWritable: true, isSigner: false },
          // destinations_data account must be provided separately
        ];
      }

      const tx = client.buildTransaction('execute_proposal', {
        accounts: {
          executor: $wallet.publicKey,
          config: $store.configAddress,
          proposal: proposal.address,
          ot_program: otProgramId
        },
        args: {},
        remainingAccounts
      });

      txStatus = 'sending';
      const sig = await sendWalletTransaction($connection, tx, $wallet.provider!);
      txSignature = sig;
      txStatus = 'confirming';
      await $connection.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      await store.refresh();
    } catch (e: any) { txError = e.message; txStatus = 'error'; }
  }
</script>

<div class="detail-page">
  <a href="/futarchy/{$store.configAddress.toBase58()}" class="back">
    <ArrowLeft size={14} /> Back to proposals
  </a>

  {#if !proposal}
    <div class="center-msg">Proposal #{proposalIdStr} not found.</div>
  {:else}
    <div class="card">
      <div class="card-header">
        <div class="header-left">
          <h3>Proposal #{proposal.proposalId.toString()}</h3>
          <span class="badge-type">{typeLabel}</span>
        </div>
        {#if statusInfo}
          <span class="badge-status" style="--sc: {statusInfo.color}">{statusInfo.label}</span>
        {/if}
      </div>
      <div class="card-body">
        <div class="field-grid">
          <div class="field"><span class="fl">Proposer</span> <CopyAddress address={proposal.proposer} chars={8} /></div>
          <div class="field"><span class="fl">OT Mint</span> <CopyAddress address={proposal.otMint} chars={8} /></div>
          <div class="field"><span class="fl">Created</span> <span class="fv">{formatTimestamp(proposal.createdTs)}</span></div>
          {#if proposal.executedTs > 0n}
            <div class="field"><span class="fl">Executed</span> <span class="fv">{formatTimestamp(proposal.executedTs)}</span></div>
          {/if}

          {#if proposal.proposalType === 0 || proposal.proposalType === 1}
            <div class="field"><span class="fl">Amount</span> <span class="fv mono">{proposal.amount.toString()}</span></div>
            <div class="field"><span class="fl">Destination</span> <CopyAddress address={proposal.destination} chars={8} /></div>
          {/if}
          {#if proposal.proposalType === 1}
            <div class="field"><span class="fl">Token Mint</span> <CopyAddress address={proposal.tokenMint} chars={8} /></div>
          {/if}
          {#if proposal.proposalType === 2}
            <div class="field full"><span class="fl">Params Hash</span>
              <span class="fv mono hash">{Array.from(proposal.paramsHash as Uint8Array).map((b) => (b as number).toString(16).padStart(2, '0')).join('')}</span>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Actions -->
    {#if proposal.status === 0 && isAuthority}
      <div class="actions">
        <button class="btn btn-success" on:click={handleApprove} disabled={txStatus === 'signing' || txStatus === 'sending'}>
          <Check size={14} /> Approve
        </button>
        <button class="btn btn-danger" on:click={handleCancel} disabled={txStatus === 'signing' || txStatus === 'sending'}>
          <X size={14} /> Cancel
        </button>
      </div>
    {/if}

    {#if proposal.status === 1}
      <div class="actions">
        <button class="btn btn-primary" on:click={handleExecute} disabled={txStatus === 'signing' || txStatus === 'sending'}>
          <Play size={14} /> Execute Proposal
        </button>
        <p class="hint">Permissionless — anyone can execute approved proposals.</p>
      </div>
    {/if}

    <TxStatus status={txStatus} signature={txSignature} error={txError} />
  {/if}
</div>

<style>
  .detail-page { display: flex; flex-direction: column; gap: var(--space-4); }
  .back { display: flex; align-items: center; gap: var(--space-1); color: var(--color-text-secondary); text-decoration: none; font-size: var(--text-sm); }
  .back:hover { color: var(--color-text); }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .header-left { display: flex; align-items: center; gap: var(--space-3); }
  .card-header h3 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .card-body { padding: var(--space-4); }
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field.full { grid-column: 1 / -1; }
  .fl { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .fv { font-size: var(--text-sm); }
  .fv.mono { font-family: var(--font-mono); }
  .hash { word-break: break-all; font-size: var(--text-xs); }
  .badge-type { padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-xs); background: rgba(139,92,246,0.15); color: var(--color-primary); font-weight: 500; }
  .badge-status { padding: 2px 10px; border-radius: 999px; font-size: var(--text-xs); background: color-mix(in srgb, var(--sc) 15%, transparent); color: var(--sc); font-weight: 600; }
  .actions { display: flex; gap: var(--space-3); align-items: center; }
  .hint { font-size: var(--text-xs); color: var(--color-text-muted); margin: 0; }
  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; border: none; cursor: pointer; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-success { background: var(--color-success); color: white; }
  .btn-danger { background: var(--color-danger); color: white; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .center-msg { padding: var(--space-8); text-align: center; color: var(--color-text-muted); }
</style>
