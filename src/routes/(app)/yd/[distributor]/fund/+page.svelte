<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { ydStore } from '$lib/stores/yd';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { getAtaAddress } from '$lib/utils/spl';
  import { TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { ArrowLeft } from 'lucide-svelte';
  import { getDistributorContext } from '../context';

  const RWT_DECIMALS = 6;

  const { distributor, refresh } = getDistributorContext();

  $: d = $distributor;
  $: config = $ydStore.config;

  let amount = '';
  let txStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let txSig = '';
  let txError = '';

  $: amountNum = Number(amount) || 0;
  $: amountLamports = BigInt(Math.floor(amountNum * 10 ** RWT_DECIMALS));
  $: fee = config ? (amountLamports * BigInt(config.protocolFeeBps)) / 10_000n : 0n;
  $: net = amountLamports - fee;
  $: belowMin = config ? amountLamports < config.minDistributionAmount : false;

  function formatRwt(amount: bigint): string {
    const divisor = BigInt(10 ** RWT_DECIMALS);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(RWT_DECIMALS, '0').replace(/0+$/, '');
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  $: canSubmit = !!d && !!config && config.isActive && d.isActive && amountLamports > 0n && !belowMin && txStatus === 'idle';

  async function handleFund() {
    if (!d || !config) return;
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { txError = 'No active dev keypair'; txStatus = 'error'; return; }

    txStatus = 'signing';
    txError = '';
    txSig = '';
    try {
      const conn = get(connection);
      // Lazy import of ydClient to mirror pattern from other layers.
      const { ydClient, ydProgramId } = await import('$lib/stores/yd');
      const { findYdConfigPda, findMerkleDistributorPda } = await import('$lib/utils/pda');

      const client = get(ydClient);
      const distributorPda = new PublicKey(d.address);
      const otMint = new PublicKey(d.otMint);
      const [configPda] = findYdConfigPda(ydProgramId);

      const rewardVault = new PublicKey(d.rewardVault);
      const feeAccount = new PublicKey(config.arealFeeDestination);

      // Depositor token is depositor's RWT ATA. We derive it from reward_vault's mint.
      // The reward_vault is an RWT ATA owned by distributor PDA. Its mint is RWT.
      // For correctness we re-read the mint from the reward_vault account.
      const info = await conn.getAccountInfo(rewardVault);
      if (!info) throw new Error('Reward vault account not found');
      const rwtMint = new PublicKey(info.data.slice(0, 32));
      const depositorToken = getAtaAddress(deployer.publicKey, rwtMint);

      const tx = client.buildTransaction('fund_distributor', {
        accounts: {
          depositor: deployer.publicKey,
          config: configPda,
          distributor: distributorPda,
          ot_mint: otMint,
          depositor_token: depositorToken,
          reward_vault: rewardVault,
          fee_account: feeAccount,
          token_program: TOKEN_PROGRAM_ID
        },
        args: { amount: amountLamports }
      });

      txStatus = 'sending';
      txSig = await signAndSendTransaction(conn, tx, [deployer]);
      txStatus = 'success';
      amount = '';
      await refresh();
      await ydStore.refresh();
    } catch (err: any) {
      txError = err?.message ?? String(err);
      txStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <a href={d ? `/yd/${d.address}` : '/yd'} class="back-link"><ArrowLeft size={14} /> Back</a>
</div>

{#if !d}
  <p class="text-muted">Distributor not found.</p>
{:else if !config}
  <p class="text-muted">Load global config first.</p>
{:else}
  <h1 class="title">Fund Distributor</h1>
  <p class="subtitle mono">{d.address}</p>

  <div class="card">
    <div class="card-body">
      <div class="info-row"><span class="info-label">Reward Vault</span><CopyAddress address={d.rewardVault} /></div>
      <div class="info-row"><span class="info-label">Fee Destination</span><CopyAddress address={config.arealFeeDestination} /></div>
      <div class="info-row"><span class="info-label">Protocol Fee</span><span class="info-value mono">{(config.protocolFeeBps / 100).toFixed(2)}%</span></div>
      <div class="info-row"><span class="info-label">Min Distribution</span><span class="info-value mono">{formatRwt(config.minDistributionAmount)} RWT</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h3>Amount</h3></div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label" for="amount-input">RWT Amount</label>
        <input id="amount-input" class="form-input" type="number" bind:value={amount} min="0" step="0.000001" placeholder="100.0" />
      </div>

      {#if amountNum > 0}
        <div class="preview">
          <div class="preview-row"><span>Fee ({(config.protocolFeeBps / 100).toFixed(2)}%)</span><span class="mono">{formatRwt(fee)}</span></div>
          <div class="preview-row"><span>Net to reward vault</span><span class="mono">{formatRwt(net)}</span></div>
          <div class="preview-row total"><span>Total debit</span><span class="mono">{formatRwt(amountLamports)} RWT</span></div>
        </div>

        {#if belowMin}
          <div class="alert alert-warning">
            Amount is below the minimum distribution ({formatRwt(config.minDistributionAmount)} RWT).
          </div>
        {/if}

        {#if !d.isActive}
          <div class="alert alert-error">Distributor is closed.</div>
        {:else if !config.isActive}
          <div class="alert alert-error">YD system is paused.</div>
        {/if}
      {/if}

      <button class="btn btn-primary" on:click={handleFund} disabled={!canSubmit}>
        Fund Distributor
      </button>
      <TxStatus status={txStatus} signature={txSig} error={txError} />
    </div>
  </div>
{/if}

<style>
  .page-header { margin-bottom: var(--space-3); }
  .back-link { color: var(--color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-sm); }
  .title { font-size: var(--text-2xl); font-weight: 700; margin: 0 0 var(--space-1); }
  .subtitle { color: var(--color-text-secondary); font-size: var(--text-sm); font-family: var(--font-mono); margin-bottom: var(--space-5); }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: var(--space-4);
  }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .info-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .info-value { font-family: var(--font-mono); font-size: var(--text-sm); }

  .form-group { margin-bottom: var(--space-3); }
  .form-label { display: block; font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .form-input { width: 100%; padding: var(--space-2) var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }
  .form-input:focus { outline: none; border-color: var(--color-primary); }

  .preview { background: var(--color-bg); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3); }
  .preview-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: var(--text-sm); color: var(--color-text-secondary); }
  .preview-row.total { border-top: 1px solid var(--color-border); padding-top: var(--space-2); margin-top: var(--space-1); color: var(--color-text); font-weight: 600; }

  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); margin-bottom: var(--space-3); font-size: var(--text-sm); }
  .alert-warning { background: rgba(245, 158, 11, 0.1); color: var(--color-warning, #f59e0b); border: 1px solid rgba(245, 158, 11, 0.3); }
  .alert-error { background: rgba(239, 68, 68, 0.1); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.3); }

  .mono { font-family: var(--font-mono); }
  .text-muted { color: var(--color-text-muted); }
</style>
