/**
 * ExceedsMaxClaim cap probe (Layer 7 tester review §C3).
 *
 * Goal: assert the contract's `total_claimed + claimable > max_total_claim`
 * guard actually rejects. Reaching this guard from the outside is hard:
 *
 *   publish_root requires  max_total_claim == total_funded
 *   claim handler computes claimable = mul_div_u128_u64(
 *                             total_vested, cumulative, max_total_claim)
 *                           .saturating_sub(already_claimed)
 *
 * To make `total_claimed + claimable > max_total_claim` we need a TREE whose
 * sum of cumulative amounts EXCEEDS max_total_claim — which the protocol's
 * invariant (Σ cumulative == total_funded == max_total_claim) does not allow
 * under normal operation. The guard is a defense-in-depth against a
 * compromised publisher who issues an inflated tree.
 *
 * This scenario emulates a compromised publisher by:
 *   1. Funding N units.
 *   2. Publishing a tree with one holder whose cumulative = 2*N (> max).
 *      Since max_total_claim must still equal total_funded, this is only
 *      possible by literally presenting the tree at claim time while the
 *      leaf's cumulative exceeds max. We do it by setting the single-leaf
 *      root = sha256(claimant || 2N) and max_total_claim = N.
 *
 * When Alice claims with cumulative_amount=2N and the contract computes
 *    my_share = mul_div_u128_u64(total_vested, 2N, N) = 2 * total_vested
 * the new_total_claimed will exceed max_total_claim → ExceedsMaxClaim.
 */
import { get } from 'svelte/store';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { E2EStep } from './e2e-runner';
import { connection } from './network';
import {
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '$lib/utils/pda';
import { createMint, createAta, getTokenBalance, getAtaAddress } from '$lib/utils/spl';
import { signAndSendTransaction } from '$lib/utils/tx';
import { expectYdError } from './e2e-error-parser';

type StepExecutor = (ctx: any, deployer: Keypair) => Promise<{ txSignature?: string; result?: Record<string, any> }>;

export interface YdExceedsCtx {
  rwtMint?: PublicKey;
  usdcMint?: PublicKey;
  otMint?: PublicKey;
  configPda?: PublicKey;
  distributorPda?: PublicKey;
  accumulatorPda?: PublicKey;
  rewardVault?: PublicKey;
  accUsdcAta?: PublicKey;
  feeAta?: PublicKey;
  netFunded?: bigint;
  inflatedCumulative?: bigint;
}

export function createYdExceedsSteps(): E2EStep[] {
  return [
    { id: 'yde-setup', name: 'Setup (vesting=1s, fund small amount)', description: 'Fresh distributor + fund 200 RWT so vesting completes quickly.', status: 'pending' },
    { id: 'yde-publish-inflated', name: 'Publish root with INFLATED leaf (cumulative = 2 * netFunded)', description: 'Simulates a compromised publisher. max_total_claim still == total_funded.', status: 'pending' },
    { id: 'yde-claim-exceeds', name: 'Claim with inflated cumulative → ExceedsMaxClaim', description: 'Contract must reject before transferring tokens.', status: 'pending' },
    { id: 'yde-cleanup', name: 'Restore legitimate root (cumulative = netFunded)', description: 'Re-publish the honest root so follow-up scenarios see clean state.', status: 'pending' },
  ];
}

async function loadRwtAndUsdc(conn: any) {
  const { rwtProgramId } = await import('./rwt');
  const { findRwtVaultPda } = await import('$lib/utils/pda');
  const [vaultPda] = findRwtVaultPda(rwtProgramId);
  const info = await conn.getAccountInfo(vaultPda);
  if (!info) throw new Error('RWT Vault not found — run rwt-lifecycle first');
  const capAta = new PublicKey(info.data.slice(40, 72));
  const rwtMint = new PublicKey(info.data.slice(72, 104));
  const capInfo = await conn.getAccountInfo(capAta);
  if (!capInfo) throw new Error('Capital ATA not found');
  const usdcMint = new PublicKey(capInfo.data.slice(0, 32));
  return { rwtMint, usdcMint };
}

export const ydExceedsExecutors: Record<string, StepExecutor> = {
  'yde-setup': async (ctx: YdExceedsCtx, deployer: Keypair) => {
    const conn = get(connection);
    const { rwtMint, usdcMint } = await loadRwtAndUsdc(conn);
    ctx.rwtMint = rwtMint;
    ctx.usdcMint = usdcMint;

    const { mintAddress } = await createMint(conn, deployer, 6);
    ctx.otMint = mintAddress;
    const ata = await createAta(conn, deployer, rwtMint, deployer.publicKey);
    ctx.feeAta = ata;

    const { rwtClient: rwtClientStore, rwtProgramId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const rwt = get(rwtClientStore);
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const mintTx = rwt.buildTransaction('admin_mint_rwt', {
      accounts: {
        authority: deployer.publicKey, rwt_vault: vaultPda,
        rwt_mint: rwtMint, recipient_rwt: ata, token_program: TOKEN_PROGRAM_ID,
      },
      args: { rwt_amount: 1_000_000_000, backing_capital_usd: 1_000_000_000 },
    });
    await signAndSendTransaction(conn, mintTx, [deployer]);

    const { ydClient, ydProgramId } = await import('./yd');
    const { findYdConfigPda, findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const yd = get(ydClient);
    const [configPda] = findYdConfigPda(ydProgramId);
    const [distributorPda] = findMerkleDistributorPda(ydProgramId, mintAddress);
    const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, mintAddress);
    ctx.configPda = configPda;
    ctx.distributorPda = distributorPda;
    ctx.accumulatorPda = accumulatorPda;
    ctx.rewardVault = getAtaAddress(distributorPda, rwtMint);
    ctx.accUsdcAta = getAtaAddress(accumulatorPda, usdcMint);

    const cfgInfo = await conn.getAccountInfo(configPda);
    if (!cfgInfo) {
      const initTx = yd.buildTransaction('initialize_config', {
        accounts: {
          deployer: deployer.publicKey,
          config: configPda,
          areal_fee_destination_account: ata,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {
          publish_authority: Array.from(deployer.publicKey.toBytes()),
          protocol_fee_bps: 25,
          min_distribution_amount: 100_000_000n,
        },
      });
      await signAndSendTransaction(conn, initTx, [deployer]);
    }

    const distInfo = await conn.getAccountInfo(distributorPda);
    if (!distInfo) {
      const createTx = yd.buildTransaction('create_distributor', {
        accounts: {
          authority: deployer.publicKey,
          config: configPda,
          ot_mint: mintAddress,
          distributor: distributorPda,
          accumulator: accumulatorPda,
          rwt_mint: rwtMint,
          usdc_mint: usdcMint,
          reward_vault: ctx.rewardVault,
          accumulator_usdc_ata: ctx.accUsdcAta,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        },
        args: { vesting_period_secs: 1n },
      });
      await signAndSendTransaction(conn, createTx, [deployer]);
    }

    const gross = 200_000_000n;
    const fee = (gross * 25n) / 10000n;
    ctx.netFunded = gross - fee;
    const fundTx = yd.buildTransaction('fund_distributor', {
      accounts: {
        depositor: deployer.publicKey,
        config: configPda,
        distributor: distributorPda,
        ot_mint: mintAddress,
        depositor_token: ata,
        reward_vault: ctx.rewardVault,
        fee_account: ata,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount: gross },
    });
    await signAndSendTransaction(conn, fundTx, [deployer]);

    return { result: { netFunded: ctx.netFunded.toString() } };
  },

  'yde-publish-inflated': async (ctx: YdExceedsCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const { computeLeaf } = await import('$lib/utils/merkle');
    const yd = get(ydClient);

    // Inflated leaf: Alice = 2 * netFunded (double). max_total_claim stays at
    // netFunded (== total_funded, required by publish_root).
    ctx.inflatedCumulative = ctx.netFunded * 2n;
    const leaf = await computeLeaf(deployer.publicKey, ctx.inflatedCumulative);

    const tx = yd.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
      },
      args: { merkle_root: Array.from(leaf), max_total_claim: ctx.netFunded },
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return {
      txSignature: sig,
      result: {
        'Inflated cumulative (2 * netFunded)': ctx.inflatedCumulative.toString(),
        'max_total_claim (unchanged)': ctx.netFunded.toString(),
      },
    };
  },

  'yde-claim-exceeds': async (ctx: YdExceedsCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault ||
        !ctx.feeAta || !ctx.inflatedCumulative) {
      throw new Error('incomplete');
    }
    // Wait for full vest so total_vested = max_total_claim; then
    // my_share = mul_div(max, 2N, N) = 2 * max → new_total_claimed > max.
    await new Promise(r => setTimeout(r, 1500));

    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const yd = get(ydClient);
    const [cs] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    const tx = yd.buildTransaction('claim', {
      accounts: {
        claimant: deployer.publicKey,
        payer: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        claim_status: cs,
        reward_vault: ctx.rewardVault,
        claimant_token: ctx.feeAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { cumulative_amount: ctx.inflatedCumulative, proof: [] },
      computeUnits: 100_000,
    });
    const res = await expectYdError(signAndSendTransaction(conn, tx, [deployer]), 'ExceedsMaxClaim');
    return { result: { 'Negative (ExceedsMaxClaim)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}` } };
  },

  'yde-cleanup': async (ctx: YdExceedsCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const { computeLeaf } = await import('$lib/utils/merkle');
    const yd = get(ydClient);

    const leaf = await computeLeaf(deployer.publicKey, ctx.netFunded);
    const tx = yd.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
      },
      args: { merkle_root: Array.from(leaf), max_total_claim: ctx.netFunded },
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { 'Root restored to honest cumulative': 'PASS' } };
  },
};
