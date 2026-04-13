<script lang="ts">
  import { get } from 'svelte/store';
  import { Keypair, PublicKey } from '@solana/web3.js';
  import { rwtStore, rwtClient, rwtProgramId } from '$lib/stores/rwt';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findRwtVaultPda, findRwtDistConfigPda, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import { formatAddress } from '$lib/utils/format';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { getAtaAddress } from '$lib/utils/spl';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: vault = $rwtStore.vault;
  $: distConfig = $rwtStore.distConfig;
  $: loading = $rwtStore.loading;

  // Initialize form
  let initTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let initTxSig = '';
  let initTxError = '';

  // Mint form
  let mintAmount = '';
  let mintTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let mintTxSig = '';
  let mintTxError = '';

  $: navUsd = vault ? Number(vault.navBookValue) / 1_000_000 : 1;
  $: capitalUsd = vault ? Number(vault.totalInvestedCapital) / 1_000_000 : 0;
  $: supplyTokens = vault ? Number(vault.totalRwtSupply) / 1_000_000 : 0;

  // Mint preview
  $: mintAmountNum = Number(mintAmount) || 0;
  $: mintAmountLamports = Math.floor(mintAmountNum * 1_000_000);
  $: feeTotal = Math.floor(mintAmountLamports * 100 / 10_000);
  $: daoFee = Math.floor(feeTotal / 2);
  $: vaultFee = feeTotal - daoFee;
  $: netDeposit = mintAmountLamports - feeTotal;
  $: rwtOut = navUsd > 0 ? netDeposit / (Number(vault?.navBookValue ?? 1_000_000) / 1_000_000) : 0;
  $: mintDisabled = !vault || vault.mintPaused || mintAmountLamports < 1_000_000 || mintTxStatus === 'signing' || mintTxStatus === 'sending' || mintTxStatus === 'confirming';

  async function handleInitialize() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { initTxError = 'No active dev keypair'; initTxStatus = 'error'; return; }

    initTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);

      const rwtMintKeypair = Keypair.generate();
      const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const [distConfigPda] = findRwtDistConfigPda(rwtProgramId);
      const capitalAccAta = getAtaAddress(vaultPda, usdcMint);
      const feeAta = getAtaAddress(deployer.publicKey, usdcMint);

      const tx = client.buildTransaction('initialize_vault', {
        accounts: {
          deployer: deployer.publicKey,
          rwt_vault: vaultPda,
          dist_config: distConfigPda,
          rwt_mint: rwtMintKeypair.publicKey,
          usdc_mint: usdcMint,
          capital_accumulator_ata: capitalAccAta,
          areal_fee_destination_account: feeAta,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
        },
        args: {
          initial_authority: Array.from(deployer.publicKey.toBytes()),
          pause_authority: Array.from(deployer.publicKey.toBytes()),
          liquidity_destination: Array.from(deployer.publicKey.toBytes()),
          protocol_revenue_destination: Array.from(deployer.publicKey.toBytes())
        }
      });

      initTxStatus = 'sending';
      initTxSig = await signAndSendTransaction(conn, tx, [deployer, rwtMintKeypair]);
      initTxStatus = 'success';
      await rwtStore.refresh();
    } catch (err: any) {
      initTxError = err.message;
      initTxStatus = 'error';
    }
  }

  async function handleMint() {
    if (!vault) return;
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { mintTxError = 'No active dev keypair'; mintTxStatus = 'error'; return; }

    mintTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const rwtMint = new PublicKey(vault.rwtMint);

      const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
      const userUsdcAta = getAtaAddress(deployer.publicKey, usdcMint);
      const userRwtAta = getAtaAddress(deployer.publicKey, rwtMint);
      const capitalAcc = new PublicKey(vault.capitalAccumulatorAta);
      const daoFeeAcc = new PublicKey(vault.arealFeeDestination);

      const tx = client.buildTransaction('mint_rwt', {
        accounts: {
          user: deployer.publicKey,
          rwt_vault: vaultPda,
          rwt_mint: rwtMint,
          user_deposit: userUsdcAta,
          user_rwt: userRwtAta,
          capital_acc: capitalAcc,
          dao_fee_account: daoFeeAcc,
          token_program: TOKEN_PROGRAM_ID
        },
        args: { amount: mintAmountLamports, min_rwt_out: 1 }
      });

      mintTxStatus = 'sending';
      mintTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      mintTxStatus = 'success';
      mintAmount = '';
      await rwtStore.refresh();
    } catch (err: any) {
      mintTxError = err.message;
      mintTxStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <h1>RWT Engine</h1>
  <p class="page-description">Index token backed by OT positions with NAV-based pricing</p>
</div>

{#if loading}
  <div class="loading">Loading vault state...</div>
{:else if !vault}
  <div class="card">
    <div class="card-header"><h3>Initialize RWT Vault</h3></div>
    <div class="card-body">
      <p class="text-muted">RWT Vault not initialized. Deploy the program and initialize.</p>
      <button class="btn btn-primary" on:click={handleInitialize} disabled={initTxStatus === 'signing' || initTxStatus === 'sending'}>
        Initialize Vault
      </button>
      <TxStatus status={initTxStatus} signature={initTxSig} error={initTxError} />
    </div>
  </div>
{:else}
  <div class="grid grid-3">
    <div class="card stat-card">
      <div class="stat-label">NAV per RWT</div>
      <div class="stat-value">${navUsd.toFixed(6)}</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label">Total Capital</div>
      <div class="stat-value">${capitalUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label">RWT Supply</div>
      <div class="stat-value">{supplyTokens.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-header">
        <h3>Vault Status</h3>
        <span class="badge" class:badge-success={!vault.mintPaused} class:badge-danger={vault.mintPaused}>
          {vault.mintPaused ? 'Paused' : 'Active'}
        </span>
      </div>
      <div class="card-body">
        <div class="info-row"><span class="info-label">Authority</span><CopyAddress address={vault.authority} /></div>
        <div class="info-row"><span class="info-label">Manager</span><CopyAddress address={vault.manager} /></div>
        <div class="info-row"><span class="info-label">Pause Authority</span><CopyAddress address={vault.pauseAuthority} /></div>
        <div class="info-row"><span class="info-label">RWT Mint</span><CopyAddress address={vault.rwtMint} /></div>
        <div class="info-row"><span class="info-label">Capital ATA</span><CopyAddress address={vault.capitalAccumulatorAta} /></div>
        <div class="info-row"><span class="info-label">Fee Destination</span><CopyAddress address={vault.arealFeeDestination} /></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>Distribution Config</h3></div>
      <div class="card-body">
        {#if distConfig}
          <div class="info-row"><span class="info-label">Book Value</span><span class="info-value">{(distConfig.bookValueBps / 100).toFixed(1)}%</span></div>
          <div class="info-row"><span class="info-label">Liquidity</span><span class="info-value">{(distConfig.liquidityBps / 100).toFixed(1)}%</span></div>
          <div class="info-row"><span class="info-label">Protocol Revenue</span><span class="info-value">{(distConfig.protocolRevenueBps / 100).toFixed(1)}%</span></div>
          <div class="info-row"><span class="info-label">Liquidity Dest</span><CopyAddress address={distConfig.liquidityDestination} /></div>
          <div class="info-row"><span class="info-label">Revenue Dest</span><CopyAddress address={distConfig.protocolRevenueDestination} /></div>
        {:else}
          <p class="text-muted">Not initialized</p>
        {/if}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h3>Mint RWT</h3>
      {#if vault.mintPaused}<span class="badge badge-danger">Minting Paused</span>{/if}
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label">USDC Amount (min $1.00)</label>
        <input class="form-input" type="number" bind:value={mintAmount} min="1" step="0.01" placeholder="10.00" disabled={vault.mintPaused} />
      </div>
      {#if mintAmountNum > 0}
        <div class="preview-grid">
          <div class="preview-row"><span>Fee (1%)</span><span>${(feeTotal / 1_000_000).toFixed(6)}</span></div>
          <div class="preview-row sub"><span>Vault fee (0.5%)</span><span>${(vaultFee / 1_000_000).toFixed(6)}</span></div>
          <div class="preview-row sub"><span>DAO fee (0.5%)</span><span>${(daoFee / 1_000_000).toFixed(6)}</span></div>
          <div class="preview-row"><span>Net deposit</span><span>${(netDeposit / 1_000_000).toFixed(6)}</span></div>
          <div class="preview-row highlight"><span>RWT output</span><span>{(rwtOut / 1_000_000).toFixed(6)} RWT</span></div>
        </div>
      {/if}
      <button class="btn btn-primary" on:click={handleMint} disabled={mintDisabled}>
        {vault.mintPaused ? 'Minting Paused' : 'Mint RWT'}
      </button>
      <TxStatus status={mintTxStatus} signature={mintTxSig} error={mintTxError} />
    </div>
  </div>

  <div class="grid grid-3 nav-cards">
    <a href="/rwt/admin" class="card nav-card"><h4>Admin Panel</h4><p class="text-muted">Admin mint, adjust capital, manager, config</p></a>
    <a href="/rwt/pause" class="card nav-card"><h4>Pause Controls</h4><p class="text-muted">Emergency pause/unpause minting</p></a>
    <a href="/rwt/governance" class="card nav-card"><h4>Governance</h4><p class="text-muted">Authority transfer</p></a>
  </div>
{/if}

<style>
  .page-header { margin-bottom: var(--space-6); }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; color: var(--color-text); margin: 0; }
  .page-description { color: var(--color-text-secondary); margin-top: var(--space-1); font-size: var(--text-sm); }
  .grid { display: grid; gap: var(--space-4); margin-bottom: var(--space-4); }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }
  .stat-card { padding: var(--space-4); text-align: center; }
  .stat-label { font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: var(--text-xl); font-weight: 700; font-family: var(--font-mono); margin-top: var(--space-1); }
  .badge { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-sm); font-weight: 500; }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }
  .info-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .info-value { font-family: var(--font-mono); font-size: var(--text-sm); }
  .form-group { margin-bottom: var(--space-4); }
  .form-label { display: block; font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .form-input { width: 100%; padding: var(--space-2) var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }
  .form-input:focus { outline: none; border-color: var(--color-primary); }
  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .preview-grid { background: var(--color-bg); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-4); }
  .preview-row { display: flex; justify-content: space-between; padding: var(--space-1) 0; font-size: var(--text-sm); color: var(--color-text-secondary); }
  .preview-row.sub { padding-left: var(--space-4); font-size: var(--text-xs); color: var(--color-text-muted); }
  .preview-row.highlight { color: var(--color-primary); font-weight: 600; border-top: 1px solid var(--color-border); padding-top: var(--space-2); margin-top: var(--space-1); }
  .nav-cards { margin-top: var(--space-4); }
  .nav-card { padding: var(--space-4); text-decoration: none; cursor: pointer; }
  .nav-card:hover { border-color: var(--color-primary); background: var(--color-surface-hover); }
  .nav-card h4 { margin: 0 0 var(--space-1); color: var(--color-text); font-size: var(--text-sm); }
  .text-muted { color: var(--color-text-muted); font-size: var(--text-sm); }
  .loading { color: var(--color-text-secondary); padding: var(--space-8); text-align: center; }
</style>
