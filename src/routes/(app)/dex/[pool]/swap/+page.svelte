<script lang="ts">
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { page } from '$app/stores';
  import { dexStore, dexClient, dexProgramId } from '$lib/stores/dex';
  import { devKeys } from '$lib/stores/devkeys';
  import { connection } from '$lib/stores/network';
  import { findDexConfigPda, findBinArrayPda, TOKEN_PROGRAM_ID } from '$lib/utils/pda';
  import { getAtaAddress } from '$lib/utils/spl';
  import { signAndSendTransaction } from '$lib/utils/tx';
  import TxStatus from '$lib/components/TxStatus.svelte';

  $: poolAddr = ($page.params as any).pool ?? '';
  $: pool = $dexStore.pools.find(p => p.pda === poolAddr);
  $: config = $dexStore.config;

  let amountIn = '';
  let aToB = true;
  let minAmountOut = '0';
  let txStatus: 'idle'|'signing'|'sending'|'confirming'|'success'|'error' = 'idle';
  let txSig = '';
  let txError = '';

  // Swap preview
  $: amountInNum = Number(amountIn) || 0;
  $: amountInLamports = Math.floor(amountInNum * 1_000_000);
  $: estimatedOut = pool && amountInLamports > 0 ? estimateOutput(amountInLamports) : 0;

  function estimateOutput(input: number): number {
    if (!pool) return 0;
    const rIn = Number(aToB ? pool.reserveA : pool.reserveB);
    const rOut = Number(aToB ? pool.reserveB : pool.reserveA);
    if (rIn === 0 || rOut === 0) return 0;
    // Simplified: fee deducted, then constant product
    const feeBps = pool.feeBps;
    const feeTotal = Math.floor(input * feeBps / 10000);
    const net = input - feeTotal;
    return Math.floor(rOut * net / (rIn + net));
  }

  async function handleSwap() {
    const deployer = devKeys.getActiveKeypair();
    if (!deployer || !pool) { txError = 'No keypair or pool'; txStatus = 'error'; return; }

    txStatus = 'signing';
    try {
      const conn = get(connection);
      const client = get(dexClient);
      const [configPda] = findDexConfigPda(dexProgramId);
      const poolPda = new PublicKey(pool.pda);

      const mintA = new PublicKey(pool.tokenAMint);
      const mintB = new PublicKey(pool.tokenBMint);
      const [mintIn, mintOut] = aToB ? [mintA, mintB] : [mintB, mintA];
      const [vaultIn, vaultOut] = aToB
        ? [new PublicKey(pool.vaultA), new PublicKey(pool.vaultB)]
        : [new PublicKey(pool.vaultB), new PublicKey(pool.vaultA)];

      const userTokenIn = getAtaAddress(deployer.publicKey, mintIn);
      const userTokenOut = getAtaAddress(deployer.publicKey, mintOut);
      const arealFee = config ? new PublicKey(config.arealFeeDestination) : deployer.publicKey;

      // For concentrated pools, pass BinArray as remaining_account
      // OT treasury goes first if present, BinArray after
      const swapRemainingAccounts: Array<{pubkey: PublicKey, isSigner: boolean, isWritable: boolean}> = [];
      if (pool.hasOtTreasury) {
        swapRemainingAccounts.push({ pubkey: new PublicKey(pool.otTreasuryFeeDestination), isSigner: false, isWritable: true });
      }
      if (pool.poolType === 1) {
        swapRemainingAccounts.push({ pubkey: findBinArrayPda(poolPda, dexProgramId)[0], isSigner: false, isWritable: true });
      }

      const tx = client.buildTransaction('swap', {
        accounts: {
          user: deployer.publicKey,
          dex_config: configPda,
          pool_state: poolPda,
          user_token_in: userTokenIn,
          user_token_out: userTokenOut,
          vault_in: vaultIn,
          vault_out: vaultOut,
          areal_fee_account: arealFee,
          token_program: TOKEN_PROGRAM_ID,
        },
        args: {
          amount_in: amountInLamports,
          min_amount_out: parseInt(minAmountOut) || 0,
          a_to_b: aToB,
        },
        remainingAccounts: swapRemainingAccounts,
      });

      txStatus = 'sending';
      const sig = await signAndSendTransaction(conn, tx, [deployer]);
      txSig = sig;
      txStatus = 'confirming';
      await conn.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      amountIn = '';
      if (pool) await dexStore.refreshPool(mintA, mintB);
    } catch (e: any) {
      txError = e.message;
      txStatus = 'error';
    }
  }
</script>

<div class="page">
  <h1>Swap</h1>
  {#if !pool}
    <p class="muted">Pool not loaded.</p>
  {:else}
    <div class="card">
      <div class="direction">
        <button class:active={aToB} on:click={() => aToB = true}>A → B</button>
        <button class:active={!aToB} on:click={() => aToB = false}>B → A</button>
      </div>

      <div class="form">
        <label>
          Amount In
          <input type="number" bind:value={amountIn} placeholder="0.00" step="0.000001" />
        </label>

        <div class="preview">
          <span class="label">Estimated Output</span>
          <span class="value">{(estimatedOut / 1_000_000).toFixed(6)}</span>
        </div>

        <label>
          Min Amount Out (slippage protection)
          <input type="number" bind:value={minAmountOut} placeholder="0" />
        </label>

        <button on:click={handleSwap} disabled={txStatus === 'signing' || txStatus === 'sending' || !amountIn}>
          Swap
        </button>
        <TxStatus status={txStatus} signature={txSig} error={txError} />
      </div>
    </div>
  {/if}
</div>

<style>
  .page { padding: var(--space-4); max-width: 500px; }
  .card {
    background: var(--color-surface); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); padding: var(--space-4);
  }
  .direction { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
  .direction button {
    flex: 1; padding: 8px; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-bg); cursor: pointer;
  }
  .direction button.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
  .form input {
    padding: 10px 12px; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); font-family: var(--font-mono); background: var(--color-bg);
  }
  .preview {
    display: flex; justify-content: space-between; padding: var(--space-3);
    background: var(--color-bg); border-radius: var(--radius-sm);
  }
  .label { font-size: 0.8rem; color: var(--color-text-muted); }
  .value { font-family: var(--font-mono); font-weight: 600; }
  button {
    padding: 12px; background: var(--color-primary); color: white;
    border: none; border-radius: var(--radius-md); cursor: pointer; font-weight: 600;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--color-text-muted); }
</style>
