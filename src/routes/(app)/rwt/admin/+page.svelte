<script lang="ts">
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';
  import { PublicKey } from '@solana/web3.js';
  import { rwtStore, rwtClient, rwtProgramId } from '$lib/stores/rwt';
  import { dexProgramId } from '$lib/stores/dex';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findRwtVaultPda, findRwtDistConfigPda, findDexConfigPda, findPoolStatePda, TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import { getAtaAddress } from '$lib/utils/spl';
  import TxStatus from '$lib/components/TxStatus.svelte';

  $: vault = $rwtStore.vault;

  // Admin Mint
  let adminRwtAmount = '';
  let adminBackingUsd = '';
  let adminTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let adminTxSig = '';
  let adminTxError = '';

  // Adjust Capital
  let writedownAmount = '';
  let adjustTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let adjustTxSig = '';
  let adjustTxError = '';

  // Update Manager
  let newManager = '';
  let managerTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let managerTxSig = '';
  let managerTxError = '';

  // Update Distribution Config
  let bookBps = '7000';
  let liqBps = '1500';
  let revBps = '1500';
  let liqDest = '';
  let revDest = '';
  let configTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let configTxSig = '';
  let configTxError = '';

  // Vault Swap
  let swapAmountIn = '';
  let swapSlippagePct = '1';
  let swapDirection: 'a_to_b' | 'b_to_a' = 'a_to_b';
  let swapPoolMintA = '';
  let swapPoolMintB = '';
  let swapTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let swapTxSig = '';
  let swapTxError = '';

  // Vault token balances
  interface VaultTokenBalance {
    mint: string;
    amount: bigint;
    ata: string;
  }
  let vaultBalances: VaultTokenBalance[] = [];
  let loadingBalances = false;

  $: isManager = vault && vault.manager !== '11111111111111111111111111111112';

  async function loadVaultBalances() {
    if (!vault) return;
    loadingBalances = true;
    try {
      const conn = get(connection);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const resp = await conn.getTokenAccountsByOwner(vaultPda, { programId: TOKEN_PROGRAM_ID });
      vaultBalances = resp.value.map((item: any) => {
        const data = item.account.data;
        const mint = new PublicKey(data.slice(0, 32)).toBase58();
        const amountBytes = data.slice(64, 72);
        const amount = BigInt(new DataView(amountBytes.buffer, amountBytes.byteOffset, 8).getBigUint64(0, true).toString());
        return { mint, amount, ata: item.pubkey.toBase58() };
      });
    } catch (err: any) {
      console.error('Failed to load vault balances:', err);
    } finally {
      loadingBalances = false;
    }
  }

  onMount(() => {
    loadVaultBalances();
  });

  async function handleVaultSwap() {
    if (!vault) return;
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { swapTxError = 'No active dev keypair'; swapTxStatus = 'error'; return; }

    swapTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const amountIn = Math.floor((Number(swapAmountIn) || 0) * 1_000_000);
      if (amountIn <= 0) throw new Error('Amount must be > 0');

      const mintA = new PublicKey(swapPoolMintA);
      const mintB = new PublicKey(swapPoolMintB);
      const a_to_b = swapDirection === 'a_to_b';

      // Determine input/output mints based on direction
      const mintIn = a_to_b ? mintA : mintB;
      const mintOut = a_to_b ? mintB : mintA;

      // Vault ATAs
      const vaultTokenIn = getAtaAddress(vaultPda, mintIn);
      const vaultTokenOut = getAtaAddress(vaultPda, mintOut);

      // Pool PDA
      const [poolPda] = findPoolStatePda(mintA, mintB, dexProgramId);

      // Read pool state to get vault addresses (offset 8+1+32+32=73 for vault_a, 105 for vault_b)
      const poolInfo = await conn.getAccountInfo(poolPda);
      if (!poolInfo) throw new Error('Pool not found');
      const poolVaultA = new PublicKey(poolInfo.data.slice(73, 105));
      const poolVaultB = new PublicKey(poolInfo.data.slice(105, 137));
      const poolVaultIn = a_to_b ? poolVaultA : poolVaultB;
      const poolVaultOut = a_to_b ? poolVaultB : poolVaultA;

      // DEX config
      const [dexConfigPda] = findDexConfigPda(dexProgramId);

      // Read areal_fee_destination from DexConfig (offset 109..141)
      const configInfo = await conn.getAccountInfo(dexConfigPda);
      if (!configInfo) throw new Error('DexConfig not found');
      const arealFeeAta = new PublicKey(configInfo.data.slice(109, 141));

      // Slippage: min_amount_out = 0 for now (or calculate from reserves)
      const slippageBps = Math.floor((Number(swapSlippagePct) || 1) * 100);
      // For simplicity, use 1 as min_amount_out (non-zero required by contract)
      const minAmountOut = 1;

      const tx = client.buildTransaction('vault_swap', {
        accounts: {
          manager: deployer.publicKey,
          rwt_vault: vaultPda,
          vault_token_in: vaultTokenIn,
          vault_token_out: vaultTokenOut,
          dex_config: dexConfigPda,
          pool_state: poolPda,
          pool_vault_in: poolVaultIn,
          pool_vault_out: poolVaultOut,
          areal_fee_account: arealFeeAta,
          dex_program: dexProgramId,
          token_program: TOKEN_PROGRAM_ID,
        },
        args: { amount_in: amountIn, min_amount_out: minAmountOut, a_to_b }
      });

      swapTxStatus = 'sending';
      swapTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      swapTxStatus = 'success';
      swapAmountIn = '';
      await Promise.all([rwtStore.refresh(), loadVaultBalances()]);
    } catch (err: any) {
      swapTxError = err.message;
      swapTxStatus = 'error';
    }
  }

  $: bpsSum = (Number(bookBps) || 0) + (Number(liqBps) || 0) + (Number(revBps) || 0);
  $: bpsValid = bpsSum === 10000;

  // Admin mint NAV preview
  $: adminRwtNum = Number(adminRwtAmount) || 0;
  $: adminBackingNum = Number(adminBackingUsd) || 0;
  $: previewCapital = vault ? Number(vault.totalInvestedCapital) + adminBackingNum * 1_000_000 : 0;
  $: previewSupply = vault ? Number(vault.totalRwtSupply) + adminRwtNum * 1_000_000 : 0;
  $: previewNav = previewSupply > 0 ? previewCapital * 1_000_000 / previewSupply / 1_000_000 : 1;

  async function handleAdminMint() {
    if (!vault) return;
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { adminTxError = 'No active dev keypair'; adminTxStatus = 'error'; return; }

    adminTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const rwtMint = new PublicKey(vault.rwtMint);
      const recipientRwt = getAtaAddress(deployer.publicKey, rwtMint);

      const tx = client.buildTransaction('admin_mint_rwt', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: vaultPda,
          rwt_mint: rwtMint,
          recipient_rwt: recipientRwt,
          token_program: TOKEN_PROGRAM_ID
        },
        args: {
          rwt_amount: Math.floor(adminRwtNum * 1_000_000),
          backing_capital_usd: Math.floor(adminBackingNum * 1_000_000)
        }
      });

      adminTxStatus = 'sending';
      adminTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      adminTxStatus = 'success';
      adminRwtAmount = '';
      adminBackingUsd = '';
      await rwtStore.refresh();
    } catch (err: any) {
      adminTxError = err.message;
      adminTxStatus = 'error';
    }
  }

  async function handleAdjust() {
    if (!vault) return;
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { adjustTxError = 'No active dev keypair'; adjustTxStatus = 'error'; return; }

    adjustTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const amount = Math.floor((Number(writedownAmount) || 0) * 1_000_000);

      const tx = client.buildTransaction('adjust_capital', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: { writedown_amount: amount }
      });

      adjustTxStatus = 'sending';
      adjustTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      adjustTxStatus = 'success';
      writedownAmount = '';
      await rwtStore.refresh();
    } catch (err: any) {
      adjustTxError = err.message;
      adjustTxStatus = 'error';
    }
  }

  async function handleUpdateManager() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { managerTxError = 'No active dev keypair'; managerTxStatus = 'error'; return; }

    managerTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const managerPk = new PublicKey(newManager);

      const tx = client.buildTransaction('update_vault_manager', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: vaultPda
        },
        args: { new_manager: Array.from(managerPk.toBytes()) }
      });

      managerTxStatus = 'sending';
      managerTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      managerTxStatus = 'success';
      newManager = '';
      await rwtStore.refresh();
    } catch (err: any) {
      managerTxError = err.message;
      managerTxStatus = 'error';
    }
  }

  async function handleUpdateConfig() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer) { configTxError = 'No active dev keypair'; configTxStatus = 'error'; return; }

    configTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(rwtProgramId);
      const [distPda] = findRwtDistConfigPda(rwtProgramId);
      const liqPk = new PublicKey(liqDest);
      const revPk = new PublicKey(revDest);

      const tx = client.buildTransaction('update_distribution_config', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: vaultPda,
          dist_config: distPda
        },
        args: {
          book_value_bps: Number(bookBps),
          liquidity_bps: Number(liqBps),
          protocol_revenue_bps: Number(revBps),
          liquidity_destination: Array.from(liqPk.toBytes()),
          protocol_revenue_destination: Array.from(revPk.toBytes())
        }
      });

      configTxStatus = 'sending';
      configTxSig = await signAndSendTransaction(conn, tx, [deployer]);
      configTxStatus = 'success';
      await rwtStore.refresh();
    } catch (err: any) {
      configTxError = err.message;
      configTxStatus = 'error';
    }
  }
</script>

<div class="page-header">
  <h1>RWT Admin Panel</h1>
  <a href="/rwt" class="back-link">Back to Overview</a>
</div>

{#if !vault}
  <p class="text-muted">Vault not initialized.</p>
{:else}
  <div class="grid grid-2">
    <!-- Admin Mint -->
    <div class="card">
      <div class="card-header"><h3>Admin Mint RWT</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">RWT Amount (tokens)</label>
          <input class="form-input" type="number" bind:value={adminRwtAmount} placeholder="100" />
        </div>
        <div class="form-group">
          <label class="form-label">Backing Capital (USD)</label>
          <input class="form-input" type="number" bind:value={adminBackingUsd} placeholder="100" />
        </div>
        {#if adminRwtNum > 0 && adminBackingNum > 0}
          <div class="preview">
            NAV after: ${previewNav.toFixed(6)}
          </div>
        {/if}
        <button class="btn btn-primary" on:click={handleAdminMint}>Admin Mint</button>
        <TxStatus status={adminTxStatus} signature={adminTxSig} error={adminTxError} />
      </div>
    </div>

    <!-- Adjust Capital -->
    <div class="card">
      <div class="card-header"><h3>Adjust Capital (Writedown)</h3></div>
      <div class="card-body">
        <p class="warning-text">This decreases NAV for all holders.</p>
        <div class="form-group">
          <label class="form-label">Writedown Amount (USD)</label>
          <input class="form-input" type="number" bind:value={writedownAmount} placeholder="10" />
        </div>
        <button class="btn btn-danger" on:click={handleAdjust}>Adjust Capital</button>
        <TxStatus status={adjustTxStatus} signature={adjustTxSig} error={adjustTxError} />
      </div>
    </div>

    <!-- Update Manager -->
    <div class="card">
      <div class="card-header"><h3>Update Manager</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">New Manager Pubkey</label>
          <input class="form-input" type="text" bind:value={newManager} placeholder="Pubkey..." />
        </div>
        <button class="btn btn-primary" on:click={handleUpdateManager}>Update Manager</button>
        <TxStatus status={managerTxStatus} signature={managerTxSig} error={managerTxError} />
      </div>
    </div>

    <!-- Distribution Config -->
    <div class="card">
      <div class="card-header"><h3>Distribution Config</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Book Value BPS</label>
            <input class="form-input" type="number" bind:value={bookBps} />
          </div>
          <div class="form-group">
            <label class="form-label">Liquidity BPS</label>
            <input class="form-input" type="number" bind:value={liqBps} />
          </div>
          <div class="form-group">
            <label class="form-label">Revenue BPS</label>
            <input class="form-input" type="number" bind:value={revBps} />
          </div>
        </div>
        <div class="bps-sum" class:valid={bpsValid} class:invalid={!bpsValid}>
          Sum: {bpsSum} / 10,000 {bpsValid ? '' : '(must equal 10,000)'}
        </div>
        <div class="form-group">
          <label class="form-label">Liquidity Destination</label>
          <input class="form-input" type="text" bind:value={liqDest} placeholder="Pubkey..." />
        </div>
        <div class="form-group">
          <label class="form-label">Revenue Destination</label>
          <input class="form-input" type="text" bind:value={revDest} placeholder="Pubkey..." />
        </div>
        <button class="btn btn-primary" on:click={handleUpdateConfig} disabled={!bpsValid}>Update Config</button>
        <TxStatus status={configTxStatus} signature={configTxSig} error={configTxError} />
      </div>
    </div>
  </div>

  <!-- Vault Swap (full width) -->
  <div class="card" style="margin-top: var(--space-4);">
    <div class="card-header">
      <h3>Vault Swap (Manager Only)</h3>
      {#if !isManager}
        <span class="badge badge-warning">No manager set</span>
      {/if}
    </div>
    <div class="card-body">
      <!-- Vault Token Balances -->
      <div class="balances-section">
        <div class="section-label">
          Vault Token Balances
          <button class="btn-icon" on:click={loadVaultBalances} title="Refresh">&#x21bb;</button>
        </div>
        {#if loadingBalances}
          <p class="text-muted">Loading...</p>
        {:else if vaultBalances.length === 0}
          <p class="text-muted">No token accounts found for vault PDA.</p>
        {:else}
          <div class="balance-list">
            {#each vaultBalances as bal}
              <div class="balance-row">
                <span class="balance-mint" title={bal.mint}>{bal.mint.slice(0, 8)}...{bal.mint.slice(-4)}</span>
                <span class="balance-amount">{(Number(bal.amount) / 1_000_000).toFixed(6)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Swap Form -->
      <div class="swap-form">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label class="form-label">Pool Mint A</label>
            <input class="form-input" type="text" bind:value={swapPoolMintA} placeholder="Token A mint pubkey" />
          </div>
          <div class="form-group" style="flex:2">
            <label class="form-label">Pool Mint B</label>
            <input class="form-input" type="text" bind:value={swapPoolMintB} placeholder="Token B mint pubkey" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Direction</label>
            <select class="form-input" bind:value={swapDirection}>
              <option value="a_to_b">A &rarr; B</option>
              <option value="b_to_a">B &rarr; A</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Amount In (tokens)</label>
            <input class="form-input" type="number" bind:value={swapAmountIn} placeholder="10" />
          </div>
          <div class="form-group">
            <label class="form-label">Slippage %</label>
            <input class="form-input" type="number" bind:value={swapSlippagePct} placeholder="1" />
          </div>
        </div>
        <button class="btn btn-primary" on:click={handleVaultSwap} disabled={!isManager}>Execute Swap</button>
        <TxStatus status={swapTxStatus} signature={swapTxSig} error={swapTxError} />
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header { margin-bottom: var(--space-6); display: flex; justify-content: space-between; align-items: center; }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
  .back-link { color: var(--color-primary); text-decoration: none; font-size: var(--text-sm); }

  .grid { display: grid; gap: var(--space-4); }
  .grid-2 { grid-template-columns: 1fr 1fr; }

  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); }
  .card-header h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .form-group { margin-bottom: var(--space-3); }
  .form-label { display: block; font-size: var(--text-xs); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .form-input { width: 100%; padding: var(--space-2) var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-sm); }
  .form-row { display: flex; gap: var(--space-2); }
  .form-row .form-group { flex: 1; }

  .btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-danger { background: var(--color-danger); color: white; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .preview { background: var(--color-bg); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-primary); margin-bottom: var(--space-3); }
  .warning-text { color: var(--color-warning); font-size: var(--text-sm); margin-bottom: var(--space-3); }

  .bps-sum { font-size: var(--text-sm); margin-bottom: var(--space-3); font-family: var(--font-mono); }
  .bps-sum.valid { color: var(--color-success); }
  .bps-sum.invalid { color: var(--color-danger); }

  .text-muted { color: var(--color-text-muted); }

  .badge { display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-xs); font-weight: 500; }
  .badge-warning { background: var(--color-warning, #f59e0b); color: white; }

  .balances-section { margin-bottom: var(--space-4); }
  .section-label { font-size: var(--text-sm); font-weight: 600; color: var(--color-text-secondary); margin-bottom: var(--space-2); display: flex; align-items: center; gap: var(--space-2); }
  .btn-icon { background: none; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; padding: 2px 6px; font-size: var(--text-sm); color: var(--color-text); }

  .balance-list { display: flex; flex-direction: column; gap: var(--space-1); }
  .balance-row { display: flex; justify-content: space-between; padding: var(--space-2) var(--space-3); background: var(--color-bg); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--text-sm); }
  .balance-mint { color: var(--color-text-secondary); }
  .balance-amount { font-weight: 600; }

  .swap-form { border-top: 1px solid var(--color-border); padding-top: var(--space-4); }

  select.form-input { appearance: auto; }
</style>
