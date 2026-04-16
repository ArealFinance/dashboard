<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { page } from '$app/stores';
  import { dexStore, dexClient, dexProgramId } from '$lib/stores/dex';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findDexConfigPda, findPoolStatePda, findLpPositionPda, findBinArrayPda, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '$lib/utils/pda';
  import { getAtaAddress } from '$lib/utils/spl';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';

  $: poolAddr = ($page.params as any).pool ?? '';
  $: pool = $dexStore.pools.find(p => p.pda === poolAddr);

  // Add liquidity
  let addAmountA = '';
  let addAmountB = '';
  let addTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let addTxSig = '';
  let addTxError = '';

  // Remove liquidity
  let removeShares = '';
  let removeTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let removeTxSig = '';
  let removeTxError = '';

  // Zap liquidity
  let zapAmountA = '';
  let zapAmountB = '';
  let zapMinShares = '0';
  let zapTxStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let zapTxSig = '';
  let zapTxError = '';

  async function handleAddLiquidity() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer || !pool) { addTxError = 'No keypair or pool'; addTxStatus = 'error'; return; }

    addTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const poolPda = new PublicKey(pool.pda);
      const mintA = new PublicKey(pool.tokenAMint);
      const mintB = new PublicKey(pool.tokenBMint);
      const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);

      const [configPda] = findDexConfigPda(dexProgramId);
      // For concentrated pools, pass BinArray as remaining_account
      const remainingAccounts = pool.poolType === 1
        ? [{ pubkey: findBinArrayPda(poolPda, dexProgramId)[0], isSigner: false, isWritable: true }]
        : [];

      const tx = client.buildTransaction('add_liquidity', {
        accounts: {
          provider: deployer.publicKey,
          payer: deployer.publicKey,
          dex_config: configPda,
          pool_state: poolPda,
          lp_position: lpPda,
          provider_token_a: getAtaAddress(deployer.publicKey, mintA),
          provider_token_b: getAtaAddress(deployer.publicKey, mintB),
          vault_a: new PublicKey(pool.vaultA),
          vault_b: new PublicKey(pool.vaultB),
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {
          amount_a: Math.floor(Number(addAmountA) * 1_000_000),
          amount_b: Math.floor(Number(addAmountB) * 1_000_000),
          min_shares: 0,
        },
        remainingAccounts,
      });

      addTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      addTxSig = sig;
      addTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      addTxStatus = 'success';
      addAmountA = ''; addAmountB = '';
      await dexStore.refreshPool(mintA, mintB);
    } catch (e: any) {
      addTxError = e.message;
      addTxStatus = 'error';
    }
  }

  async function handleRemoveLiquidity() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer || !pool) { removeTxError = 'No keypair or pool'; removeTxStatus = 'error'; return; }

    removeTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const poolPda = new PublicKey(pool.pda);
      const mintA = new PublicKey(pool.tokenAMint);
      const mintB = new PublicKey(pool.tokenBMint);
      const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);

      // For concentrated pools, pass BinArray for proportional bin reduction
      const removeRemainingAccounts = pool.poolType === 1
        ? [{ pubkey: findBinArrayPda(poolPda, dexProgramId)[0], isSigner: false, isWritable: true }]
        : [];

      const tx = client.buildTransaction('remove_liquidity', {
        accounts: {
          provider: deployer.publicKey,
          pool_state: poolPda,
          lp_position: lpPda,
          provider_token_a: getAtaAddress(deployer.publicKey, mintA),
          provider_token_b: getAtaAddress(deployer.publicKey, mintB),
          vault_a: new PublicKey(pool.vaultA),
          vault_b: new PublicKey(pool.vaultB),
          token_program: TOKEN_PROGRAM_ID,
        },
        args: {
          shares_to_burn: removeShares,
        },
        remainingAccounts: removeRemainingAccounts,
      });

      removeTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      removeTxSig = sig;
      removeTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      removeTxStatus = 'success';
      removeShares = '';
      await dexStore.refreshPool(mintA, mintB);
    } catch (e: any) {
      removeTxError = e.message;
      removeTxStatus = 'error';
    }
  }

  async function handleZapLiquidity() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer || !pool) { zapTxError = 'No keypair or pool'; zapTxStatus = 'error'; return; }

    zapTxStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const poolPda = new PublicKey(pool.pda);
      const mintA = new PublicKey(pool.tokenAMint);
      const mintB = new PublicKey(pool.tokenBMint);
      const [configPda] = findDexConfigPda(dexProgramId);
      const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);
      const arealFee = $dexStore.config ? new PublicKey($dexStore.config.arealFeeDestination) : deployer.publicKey;

      const tx = client.buildTransaction('zap_liquidity', {
        accounts: {
          provider: deployer.publicKey,
          payer: deployer.publicKey,
          dex_config: configPda,
          pool_state: poolPda,
          lp_position: lpPda,
          provider_token_a: getAtaAddress(deployer.publicKey, mintA),
          provider_token_b: getAtaAddress(deployer.publicKey, mintB),
          vault_a: new PublicKey(pool.vaultA),
          vault_b: new PublicKey(pool.vaultB),
          areal_fee_account: arealFee,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {
          amount_a: Math.floor(Number(zapAmountA || 0) * 1_000_000),
          amount_b: Math.floor(Number(zapAmountB || 0) * 1_000_000),
          min_shares: zapMinShares || '0',
        }
      });

      zapTxStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      zapTxSig = sig;
      zapTxStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      zapTxStatus = 'success';
      zapAmountA = ''; zapAmountB = '';
      await dexStore.refreshPool(mintA, mintB);
    } catch (e: any) {
      zapTxError = e.message;
      zapTxStatus = 'error';
    }
  }
</script>

<div class="page">
  <h1>Liquidity</h1>
  {#if !pool}
    <p class="muted">Pool not loaded.</p>
  {:else}
    <div class="card">
      <h2>Add Liquidity</h2>
      <p class="muted">Both amounts required. Excess returned to wallet.</p>
      <div class="form">
        <label>Amount A <input type="number" bind:value={addAmountA} placeholder="0.00" /></label>
        <label>Amount B <input type="number" bind:value={addAmountB} placeholder="0.00" /></label>
        <button on:click={handleAddLiquidity}>Add Liquidity</button>
        <TxStatus status={addTxStatus} signature={addTxSig} error={addTxError} />
      </div>
    </div>

    <div class="card">
      <h2>Zap Liquidity</h2>
      <p class="muted">Single-sided or imbalanced deposit. Auto-swaps excess.</p>
      <div class="form">
        <label>Amount A (optional) <input type="number" bind:value={zapAmountA} placeholder="0.00" /></label>
        <label>Amount B (optional) <input type="number" bind:value={zapAmountB} placeholder="0.00" /></label>
        <label>Min Shares <input type="text" bind:value={zapMinShares} placeholder="0" /></label>
        <button on:click={handleZapLiquidity}>Zap</button>
        <TxStatus status={zapTxStatus} signature={zapTxSig} error={zapTxError} />
      </div>
    </div>

    <div class="card">
      <h2>Remove Liquidity</h2>
      <p class="muted">Works even when pool is paused.</p>
      <div class="form">
        <label>Shares to Burn <input type="text" bind:value={removeShares} placeholder="Amount of LP shares" /></label>
        <button class="danger" on:click={handleRemoveLiquidity}>Remove</button>
        <TxStatus status={removeTxStatus} signature={removeTxSig} error={removeTxError} />
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 600px; }
  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4);
  }
  .card h2 { margin: 0 0 var(--space-2) 0; font-size: 1.1rem; }
  .form { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-2); }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
  .form input {
    padding: 10px 12px; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); font-family: var(--font-mono); background: var(--color-bg);
  }
  button {
    padding: 12px; background: var(--color-primary); color: white;
    border: none; border-radius: var(--radius-md); cursor: pointer; font-weight: 600;
  }
  button.danger { background: var(--color-danger); }
  .muted { color: var(--color-text-muted); font-size: 0.85rem; }
</style>
