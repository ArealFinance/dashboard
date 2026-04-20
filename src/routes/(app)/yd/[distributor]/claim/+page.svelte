<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import {
    ydStore,
    calculateTotalVested,
    calculateClaimable,
    getClaimStatusPda
  } from '$lib/stores/yd';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { getAtaAddress } from '$lib/utils/spl';
  import { TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '$lib/utils/pda';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { ArrowLeft } from 'lucide-svelte';
  import { getDistributorContext } from '../context';

  const RWT_DECIMALS = 6;
  const MIN_VESTED = 1_000_000n;

  const { distributor, claimStatus, refresh } = getDistributorContext();

  $: d = $distributor;
  $: cs = $claimStatus;
  $: config = $ydStore.config;

  let cumulativeAmount = '';
  let proofJson = '';
  let txStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let txSig = '';
  let txError = '';

  let nowSecs = BigInt(Math.floor(Date.now() / 1000));
  let timer: any = null;
  onMount(() => {
    timer = setInterval(() => { nowSecs = BigInt(Math.floor(Date.now() / 1000)); }, 1000);
  });
  onDestroy(() => { if (timer) clearInterval(timer); });

  function formatRwt(amount: bigint): string {
    const divisor = BigInt(10 ** RWT_DECIMALS);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(RWT_DECIMALS, '0').replace(/0+$/, '');
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  $: cumulativeNum = (() => {
    const trimmed = cumulativeAmount.trim();
    if (!trimmed) return 0n;
    try {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) return 0n;
      return BigInt(Math.floor(num * 10 ** RWT_DECIMALS));
    } catch {
      return 0n;
    }
  })();

  $: totalVested = d ? calculateTotalVested(d, nowSecs, MIN_VESTED) : 0n;
  $: alreadyClaimed = cs ? cs.claimedAmount : 0n;
  $: claimablePreview = d
    ? calculateClaimable(totalVested, cumulativeNum, d.maxTotalClaim, alreadyClaimed)
    : 0n;

  $: canSubmit = !!d && !!config && d.isActive && config.isActive && d.epoch > 0n &&
    cumulativeNum > 0n && proofJson.trim().length >= 0 && txStatus === 'idle';

  async function handleClaim() {
    if (!d || !config) return;
    const claimant = devKeys.getActiveKeypair();
    if (!claimant) { txError = 'No active dev keypair'; txStatus = 'error'; return; }

    txStatus = 'signing';
    txError = '';
    txSig = '';
    try {
      // Lazy imports
      const { parseProofJson } = await import('$lib/utils/merkle');
      const { ydClient, ydProgramId } = await import('$lib/stores/yd');
      const { findYdConfigPda } = await import('$lib/utils/pda');

      let proof: Uint8Array[] = [];
      if (proofJson.trim().length > 0) {
        proof = parseProofJson(proofJson);
      }
      if (proof.length > 20) {
        throw new Error(`Proof too long (${proof.length} > 20)`);
      }

      const conn = get(connection);
      const client = get(ydClient);
      const distributorPda = new PublicKey(d.address);
      const otMint = new PublicKey(d.otMint);
      const [configPda] = findYdConfigPda(ydProgramId);
      const [claimStatusPda] = getClaimStatusPda(distributorPda, claimant.publicKey);

      const rewardVault = new PublicKey(d.rewardVault);

      // Resolve RWT mint from reward vault (first 32 bytes are mint).
      const info = await conn.getAccountInfo(rewardVault);
      if (!info) throw new Error('Reward vault account not found');
      const rwtMint = new PublicKey(info.data.slice(0, 32));
      const claimantToken = getAtaAddress(claimant.publicKey, rwtMint);

      // Build proof as number[][] matching IDL { vec: { array: [u8, 32] } }.
      const proofArg = proof.map(p => Array.from(p));

      const tx = client.buildTransaction('claim', {
        accounts: {
          claimant: claimant.publicKey,
          payer: claimant.publicKey,
          config: configPda,
          distributor: distributorPda,
          ot_mint: otMint,
          claim_status: claimStatusPda,
          reward_vault: rewardVault,
          claimant_token: claimantToken,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID
        },
        args: { cumulative_amount: cumulativeNum, proof: proofArg },
        computeUnits: 100_000
      });

      txStatus = 'sending';
      txSig = await signAndSendTransaction(conn, tx, [claimant]);
      txStatus = 'success';
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
  <h1 class="title">Claim Rewards</h1>
  <p class="subtitle mono">{d.address}</p>

  <div class="grid-3">
    <div class="stat-card">
      <div class="stat-label">Total Vested (now)</div>
      <div class="stat-value mono">{formatRwt(totalVested)}</div>
      <div class="stat-sub">RWT</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">You've Claimed</div>
      <div class="stat-value mono">{formatRwt(alreadyClaimed)}</div>
      <div class="stat-sub">RWT</div>
    </div>
    <div class="stat-card highlight">
      <div class="stat-label">Claimable (estimate)</div>
      <div class="stat-value mono">{formatRwt(claimablePreview)}</div>
      <div class="stat-sub">RWT</div>
    </div>
  </div>

  {#if d.epoch === 0n}
    <div class="alert alert-warning">
      No merkle root has been published yet. Wait for first <code>publish_root</code>.
    </div>
  {:else if !d.isActive}
    <div class="alert alert-error">Distributor is closed. Claims are disabled.</div>
  {:else if !config.isActive}
    <div class="alert alert-error">YD system is paused.</div>
  {/if}

  <div class="card">
    <div class="card-header"><h3>Claim Inputs</h3></div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label" for="cum-input">Cumulative Amount (your merkle leaf value, in RWT)</label>
        <input id="cum-input" class="form-input" type="number" bind:value={cumulativeAmount} min="0" step="0.000001" placeholder="1000.0" />
        {#if cumulativeNum > 0n}
          <div class="form-hint">= {cumulativeNum.toString()} lamports</div>
        {/if}
      </div>

      <div class="form-group">
        <label class="form-label" for="proof-input">Merkle Proof (JSON array of 32-byte hex strings or byte arrays)</label>
        <textarea id="proof-input" class="form-textarea" bind:value={proofJson} rows="6" placeholder={`[\n  "aabbccdd...32bytes",\n  "..."\n]`}></textarea>
        <div class="form-hint">Empty proof = single-leaf tree (root == leaf). Max 20 nodes.</div>
      </div>

      <button class="btn btn-primary" on:click={handleClaim} disabled={!canSubmit}>
        {claimablePreview === 0n && cumulativeNum > 0n ? 'Submit Claim (0 transferable)' : 'Claim Rewards'}
      </button>
      <TxStatus status={txStatus} signature={txSig} error={txError} />
    </div>
  </div>

  {#if cs}
    <div class="card">
      <div class="card-header"><h3>On-chain Claim Status</h3></div>
      <div class="card-body">
        <div class="info-row"><span class="info-label">Claimant</span><CopyAddress address={cs.claimant} /></div>
        <div class="info-row"><span class="info-label">Claimed So Far</span><span class="info-value mono">{formatRwt(cs.claimedAmount)} RWT</span></div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .page-header { margin-bottom: var(--space-3); }
  .back-link { color: var(--color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-sm); }
  .title { font-size: var(--text-2xl); font-weight: 700; margin: 0 0 var(--space-1); }
  .subtitle { color: var(--color-text-secondary); font-size: var(--text-sm); font-family: var(--font-mono); margin-bottom: var(--space-5); }

  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-4); }
  .stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }
  .stat-card.highlight { border-color: var(--color-primary); }
  .stat-label { font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: var(--text-xl); font-weight: 700; margin-top: var(--space-1); }
  .stat-sub { font-size: var(--text-xs); color: var(--color-text-secondary); margin-top: 2px; }

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
  .form-input, .form-textarea {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    box-sizing: border-box;
  }
  .form-textarea { resize: vertical; min-height: 96px; }
  .form-input:focus, .form-textarea:focus { outline: none; border-color: var(--color-primary); }
  .form-hint { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 4px; }

  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); margin-bottom: var(--space-3); font-size: var(--text-sm); }
  .alert-warning { background: rgba(245, 158, 11, 0.1); color: var(--color-warning, #f59e0b); border: 1px solid rgba(245, 158, 11, 0.3); }
  .alert-error { background: rgba(239, 68, 68, 0.1); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.3); }

  .mono { font-family: var(--font-mono); }
  .text-muted { color: var(--color-text-muted); }
  code { font-family: var(--font-mono); font-size: var(--text-xs); background: var(--color-bg); padding: 1px 4px; border-radius: 4px; }
</style>
