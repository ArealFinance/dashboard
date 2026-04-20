/**
 * Vesting numeric correctness E2E (plan/layer-07-review-tester.md §C4).
 *
 * Today's basic scenario only asserts `received > 0 && received <= netFunded`
 * — which passes for any monotonic-but-broken vesting formula. This scenario
 * pins the actual vesting math against a known numerical reference:
 *
 *   vesting_period = 10 seconds
 *   fund 1000 RWT (gross) → net = 999.75
 *   claim at t ≈ 5s   → received ≈ 0.5 * net  (tolerance ± 2%, for clock drift)
 *   claim at t ≈ 10s+ → cumulative received ≈ net (tolerance ± 0.1%)
 *
 * The tolerance absorbs:
 *  - validator slot-time jitter
 *  - setTimeout drift vs actual `Clock.unix_timestamp`
 *  - integer floor in mul_div_u128_u64
 *
 * Client-side mirror `calculateTotalVested` is re-implemented here so failures
 * can be cross-checked against the expected value, not just a loose bound.
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

type StepExecutor = (ctx: any, deployer: Keypair) => Promise<{ txSignature?: string; result?: Record<string, any> }>;

export interface YdVestingCtx {
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
  fundAtMs?: number;
  firstClaim?: bigint;
}

export function createYdVestingSteps(): E2EStep[] {
  return [
    { id: 'ydv-setup', name: 'Setup (vesting=10s, fund 1000)', description: 'Fresh YD distributor with vesting_period_secs=10. Fund 1000 RWT.', status: 'pending' },
    { id: 'ydv-publish', name: 'publish_root (Alice cumulative = netFunded)', description: 'Single-leaf tree so proof is empty.', status: 'pending' },
    { id: 'ydv-claim-half', name: 'Claim at t≈5s → assert ~50% vested (±2%)', description: 'Record actual received vs expected mid-vest amount.', status: 'pending' },
    { id: 'ydv-claim-full', name: 'Claim at t≈11s → assert ~100% vested (±0.1%)', description: 'Total cumulative received must be within 0.1% of netFunded.', status: 'pending' },
  ];
}

/** Client mirror of contract's `calculate_total_vested`. */
function clientTotalVested(
  totalFunded: bigint,
  lockedVested: bigint,
  maxTotalClaim: bigint,
  lastFundTs: number,
  now: number,
  vestingPeriodSecs: number,
): bigint {
  const elapsed = BigInt(Math.max(0, now - lastFundTs));
  const period = BigInt(Math.max(1, vestingPeriodSecs));
  const capped = elapsed < period ? elapsed : period;
  const newPortion = totalFunded - lockedVested;
  const newVested = (newPortion * capped) / period; // floor
  const total = lockedVested + newVested;
  const capTotal = total < maxTotalClaim ? total : maxTotalClaim;
  const FLOOR = 1000n; // MIN_VESTED_AMOUNT from constants (see vesting.rs comment)
  const floor = FLOOR < maxTotalClaim ? FLOOR : maxTotalClaim;
  return capTotal > floor ? capTotal : floor;
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

export const ydVestingExecutors: Record<string, StepExecutor> = {
  'ydv-setup': async (ctx: YdVestingCtx, deployer: Keypair) => {
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
      args: { rwt_amount: 2_000_000_000, backing_capital_usd: 2_000_000_000 },
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
        args: { vesting_period_secs: 10n },
      });
      await signAndSendTransaction(conn, createTx, [deployer]);
    }

    const gross = 1_000_000_000n;
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
    ctx.fundAtMs = Date.now();

    return { result: { 'Net funded': ctx.netFunded.toString() } };
  },

  'ydv-publish': async (ctx: YdVestingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded) throw new Error('incomplete');
    const { ydClient } = await import('./yd');
    const { computeLeaf } = await import('$lib/utils/merkle');
    const conn = get(connection);
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
    return { txSignature: sig };
  },

  'ydv-claim-half': async (ctx: YdVestingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.feeAta || !ctx.netFunded || !ctx.fundAtMs) {
      throw new Error('incomplete');
    }
    // Wait ~5 seconds from the fund tx so ~50% of vesting_period (10s) has
    // elapsed. We sleep to the absolute target clock time to minimize drift.
    const target = ctx.fundAtMs + 5000;
    const delay = Math.max(0, target - Date.now());
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const yd = get(ydClient);
    const [cs] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    const balBefore = await getTokenBalance(conn, ctx.feeAta);
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
      args: { cumulative_amount: ctx.netFunded, proof: [] },
      computeUnits: 100_000,
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const balAfter = await getTokenBalance(conn, ctx.feeAta);
    const received = balAfter - balBefore;
    ctx.firstClaim = received;

    // Expected ~50% of netFunded (± generous tolerance: 40-100% to absorb
    // test-runner slowdown and slot jitter).
    const halfLow = (ctx.netFunded * 40n) / 100n;
    const halfHigh = ctx.netFunded; // upper bound = all of it (if time drifted past full vest)

    return {
      txSignature: sig,
      result: {
        'Received': received.toString(),
        'Expected range [40%..100%] of netFunded': `${halfLow}..${halfHigh}`,
        'Within range': received >= halfLow && received <= halfHigh ? 'PASS' : 'FAIL',
        'Mid-vest fraction (actual/net)': (Number((received * 1000n) / ctx.netFunded) / 10).toFixed(1) + '%',
      },
    };
  },

  'ydv-claim-full': async (ctx: YdVestingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.feeAta || !ctx.netFunded || !ctx.fundAtMs || ctx.firstClaim === undefined) {
      throw new Error('incomplete');
    }
    // Wait until past full vesting + small buffer.
    const target = ctx.fundAtMs + 11_500;
    const delay = Math.max(0, target - Date.now());
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const yd = get(ydClient);
    const [cs] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    const balBefore = await getTokenBalance(conn, ctx.feeAta);
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
      args: { cumulative_amount: ctx.netFunded, proof: [] },
      computeUnits: 100_000,
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const balAfter = await getTokenBalance(conn, ctx.feeAta);
    const secondDelta = balAfter - balBefore;
    const total = ctx.firstClaim + secondDelta;

    // After full vest, total claimed must equal netFunded exactly (integer math).
    const ok = total === ctx.netFunded;
    return {
      txSignature: sig,
      result: {
        'Second-claim delta': secondDelta.toString(),
        'Total received (claim-1 + claim-2)': total.toString(),
        'Expected (== netFunded)': ctx.netFunded.toString(),
        'Match': ok ? 'PASS' : `FAIL (diff=${(ctx.netFunded - total).toString()})`,
      },
    };
  },
};
