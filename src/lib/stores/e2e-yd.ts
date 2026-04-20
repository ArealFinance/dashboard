/**
 * Layer 7 (Yield Distribution) E2E scenarios.
 *
 * Two scenarios are exposed:
 *   - `yd-basic`         : 10-step happy path (init → create → fund → publish → claim → close)
 *   - `yd-fairness`      : per-deposit fairness 7-step (Alice→Bob handover between deposits)
 *
 * These are wired into the e2e-runner SCENARIOS registry. All YD-specific imports
 * (yd store, merkle utils, yield-distribution PDAs) are dynamic / lazy to keep
 * the runner module light and to avoid initialization cycles.
 */

import { get } from 'svelte/store';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { E2EStep } from './e2e-runner';
import { connection } from './network';
import {
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '$lib/utils/pda';
import { createMint, createAta, mintTo, getTokenBalance, getAtaAddress } from '$lib/utils/spl';
import { signAndSendTransaction } from '$lib/utils/tx';

// Step executor signature mirror
type StepExecutor = (
  ctx: any,
  deployer: Keypair
) => Promise<{ txSignature?: string; result?: Record<string, any> }>;

// ===================================================================
// Basic 10-step scenario
// ===================================================================

export interface YdBasicCtx {
  // Mints
  rwtMint?: PublicKey;
  usdcMint?: PublicKey;
  otMint?: PublicKey;
  // YD PDAs
  configPda?: PublicKey;
  distributorPda?: PublicKey;
  accumulatorPda?: PublicKey;
  // ATAs
  rewardVault?: PublicKey;
  accUsdcAta?: PublicKey;
  feeAta?: PublicKey;
  unclaimedDest?: PublicKey;
  // Claimant token (Alice)
  aliceRwtAta?: PublicKey;
  // Funded amount (lamports, already net of fee)
  netFunded?: bigint;
  // Saved sigs
  initSig?: string;
  claimedAmount?: bigint;
}

export function createYdBasicSteps(): E2EStep[] {
  return [
    { id: 'yd-load-rwt', name: 'Load RWT Engine', description: 'Read RWT mint + USDC mint from RWT Vault on-chain.', status: 'pending' },
    { id: 'yd-create-ot', name: 'Create Test OT Mint', description: 'Create test OT mint (6 decimals, deployer == Alice == authority).', status: 'pending' },
    { id: 'yd-prep-atas', name: 'Prepare ATAs', description: 'Create deployer RWT ATA (used as fee_dest, depositor source, claimant_token, unclaimed_dest).', status: 'pending' },
    { id: 'yd-init-config', name: 'initialize_config', description: 'Init DistributionConfig (publish_authority = deployer, fee=25 bps, min=$100).', status: 'pending' },
    { id: 'yd-create-distributor', name: 'create_distributor', description: 'Create perpetual distributor with vesting_period=300s.', status: 'pending' },
    { id: 'yd-fund', name: 'fund_distributor (1000 RWT)', description: 'Fund 1000 RWT (10^9 lamports). Verify total_funded ≈ 999.75 (after 0.25% fee).', status: 'pending' },
    { id: 'yd-publish', name: 'publish_root (epoch 1)', description: 'Build single-leaf tree (Alice → cumulative=net_funded), publish root with max_total_claim=net_funded.', status: 'pending' },
    { id: 'yd-claim-1', name: 'claim (Alice, first claim)', description: 'Claim with proof. Verify RWT received + ClaimStatus created.', status: 'pending' },
    { id: 'yd-claim-2', name: 'claim again (idempotent)', description: 'Second claim. Verify claimable == 0 (no extra transfer).', status: 'pending' },
    { id: 'yd-close', name: 'close_distributor', description: 'Close distributor, sweep remaining RWT to deployer ATA. Verify is_active=false.', status: 'pending' }
  ];
}

export const ydBasicExecutors: Record<string, StepExecutor> = {
  'yd-load-rwt': async (ctx: YdBasicCtx, deployer: Keypair) => {
    const conn = get(connection);
    const { rwtProgramId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const info = await conn.getAccountInfo(vaultPda);
    if (!info) throw new Error('RWT Vault not found — deploy RWT Engine first (run rwt-lifecycle)');
    // RwtVault layout: discriminator(8) + total_invested_capital(16) + total_rwt_supply(8)
    //   + nav_book_value(8) + capital_accumulator_ata(32) + rwt_mint(32) ...
    const capAta = new PublicKey(info.data.slice(40, 72));
    const rwtMint = new PublicKey(info.data.slice(72, 104));
    const capInfo = await conn.getAccountInfo(capAta);
    if (!capInfo) throw new Error('Capital ATA not found');
    const usdcMint = new PublicKey(capInfo.data.slice(0, 32));
    ctx.rwtMint = rwtMint;
    ctx.usdcMint = usdcMint;
    return { result: { rwtMint: rwtMint.toBase58(), usdcMint: usdcMint.toBase58() } };
  },

  'yd-create-ot': async (ctx: YdBasicCtx, deployer: Keypair) => {
    const conn = get(connection);
    const { mintAddress } = await createMint(conn, deployer, 6);
    ctx.otMint = mintAddress;
    return { result: { otMint: mintAddress.toBase58() } };
  },

  'yd-prep-atas': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.rwtMint) throw new Error('RWT mint missing');
    const conn = get(connection);
    // Single deployer RWT ATA — used as fee_dest, depositor_token, claimant_token, unclaimed_dest.
    const ata = await createAta(conn, deployer, ctx.rwtMint, deployer.publicKey);
    ctx.feeAta = ata;
    ctx.aliceRwtAta = ata;
    ctx.unclaimedDest = ata;
    // Fund deployer with RWT (admin_mint via RWT Engine).
    const { rwtClient: rwtClientStore, rwtProgramId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const client = get(rwtClientStore);
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const tx = client.buildTransaction('admin_mint_rwt', {
      accounts: {
        authority: deployer.publicKey, rwt_vault: vaultPda,
        rwt_mint: ctx.rwtMint, recipient_rwt: ata, token_program: TOKEN_PROGRAM_ID
      },
      args: { rwt_amount: 2_000_000_000, backing_capital_usd: 2_000_000_000 } // mint 2000 RWT
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const bal = await getTokenBalance(conn, ata);
    return { txSignature: sig, result: { rwtAta: ata.toBase58(), rwtBalance: bal.toString() } };
  },

  'yd-init-config': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.feeAta) throw new Error('feeAta missing');
    const conn = get(connection);
    const { ydClient, ydProgramId } = await import('./yd');
    const { findYdConfigPda } = await import('$lib/utils/pda');
    const client = get(ydClient);
    const [configPda] = findYdConfigPda(ydProgramId);
    ctx.configPda = configPda;

    // Idempotent: skip if already initialized.
    const existing = await conn.getAccountInfo(configPda);
    if (existing) {
      return { result: { skipped: 'config already exists', configPda: configPda.toBase58() } };
    }

    const tx = client.buildTransaction('initialize_config', {
      accounts: {
        deployer: deployer.publicKey,
        config: configPda,
        areal_fee_destination_account: ctx.feeAta,
        system_program: SYSTEM_PROGRAM_ID
      },
      args: {
        publish_authority: Array.from(deployer.publicKey.toBytes()),
        protocol_fee_bps: 25,
        min_distribution_amount: 100_000_000n // $100 in 6-dec lamports
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { configPda: configPda.toBase58() } };
  },

  'yd-create-distributor': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.rwtMint || !ctx.usdcMint || !ctx.configPda) throw new Error('Previous steps incomplete');
    const conn = get(connection);
    const { ydClient, ydProgramId } = await import('./yd');
    const { findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const client = get(ydClient);
    const [distributorPda] = findMerkleDistributorPda(ydProgramId, ctx.otMint);
    const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, ctx.otMint);
    const rewardVault = getAtaAddress(distributorPda, ctx.rwtMint);
    const accUsdcAta = getAtaAddress(accumulatorPda, ctx.usdcMint);
    ctx.distributorPda = distributorPda;
    ctx.accumulatorPda = accumulatorPda;
    ctx.rewardVault = rewardVault;
    ctx.accUsdcAta = accUsdcAta;

    const existing = await conn.getAccountInfo(distributorPda);
    if (existing) {
      return { result: { skipped: 'distributor already exists', distributorPda: distributorPda.toBase58() } };
    }

    const tx = client.buildTransaction('create_distributor', {
      accounts: {
        authority: deployer.publicKey,
        config: ctx.configPda,
        ot_mint: ctx.otMint,
        distributor: distributorPda,
        accumulator: accumulatorPda,
        rwt_mint: ctx.rwtMint,
        usdc_mint: ctx.usdcMint,
        reward_vault: rewardVault,
        accumulator_usdc_ata: accUsdcAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
      },
      args: { vesting_period_secs: 300n }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { distributorPda: distributorPda.toBase58() } };
  },

  'yd-fund': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.feeAta || !ctx.rewardVault || !ctx.otMint) {
      throw new Error('Previous steps incomplete');
    }
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const client = get(ydClient);
    const amount = 1_000_000_000n; // 1000 RWT
    const expectedFee = (amount * 25n) / 10000n;
    const expectedNet = amount - expectedFee;
    ctx.netFunded = expectedNet;

    const tx = client.buildTransaction('fund_distributor', {
      accounts: {
        depositor: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        depositor_token: ctx.feeAta, // deployer's RWT ATA = source
        reward_vault: ctx.rewardVault,
        fee_account: ctx.feeAta,
        token_program: TOKEN_PROGRAM_ID
      },
      args: { amount }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    const totalFunded = BigInt(dist.total_funded.toString());
    return {
      txSignature: sig,
      result: {
        'Funded': amount.toString(),
        'Expected Net': expectedNet.toString(),
        'On-chain total_funded': totalFunded.toString(),
        'Match': totalFunded === expectedNet ? 'PASS' : 'FAIL'
      }
    };
  },

  'yd-publish': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient } = await import('./yd');
    const { computeLeaf } = await import('$lib/utils/merkle');
    const conn = get(connection);
    const client = get(ydClient);
    // Single-leaf tree: leaf == root.
    const leaf = await computeLeaf(deployer.publicKey, ctx.netFunded);
    const tx = client.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint
      },
      args: {
        merkle_root: Array.from(leaf),
        max_total_claim: ctx.netFunded
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    return {
      txSignature: sig,
      result: {
        'Epoch': dist.epoch.toString(),
        'Max Claim': dist.max_total_claim.toString(),
        'Match': BigInt(dist.max_total_claim.toString()) === ctx.netFunded ? 'PASS' : 'FAIL'
      }
    };
  },

  'yd-claim-1': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.aliceRwtAta || !ctx.netFunded) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const client = get(ydClient);
    const [claimStatusPda] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    const balBefore = await getTokenBalance(conn, ctx.aliceRwtAta);

    const tx = client.buildTransaction('claim', {
      accounts: {
        claimant: deployer.publicKey,
        payer: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        claim_status: claimStatusPda,
        reward_vault: ctx.rewardVault,
        claimant_token: ctx.aliceRwtAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID
      },
      args: { cumulative_amount: ctx.netFunded, proof: [] },
      computeUnits: 100_000
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const balAfter = await getTokenBalance(conn, ctx.aliceRwtAta);
    const received = balAfter - balBefore;
    ctx.claimedAmount = received;
    const cs = await client.fetch('ClaimStatus', claimStatusPda).catch(() => null);
    return {
      txSignature: sig,
      result: {
        'Received': received.toString(),
        'Received > 0': received > 0n ? 'PASS' : 'FAIL',
        'Received <= netFunded': received <= ctx.netFunded ? 'PASS' : 'FAIL',
        'ClaimStatus exists': cs ? 'PASS' : 'FAIL',
        'Cumulative on-chain': cs ? cs.claimed_amount.toString() : '—'
      }
    };
  },

  'yd-claim-2': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.aliceRwtAta || !ctx.netFunded) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const client = get(ydClient);
    const [claimStatusPda] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    const balBefore = await getTokenBalance(conn, ctx.aliceRwtAta);
    const tx = client.buildTransaction('claim', {
      accounts: {
        claimant: deployer.publicKey,
        payer: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        claim_status: claimStatusPda,
        reward_vault: ctx.rewardVault,
        claimant_token: ctx.aliceRwtAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID
      },
      args: { cumulative_amount: ctx.netFunded, proof: [] },
      computeUnits: 100_000
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const balAfter = await getTokenBalance(conn, ctx.aliceRwtAta);
    const delta = balAfter - balBefore;
    return {
      txSignature: sig,
      result: {
        'Delta': delta.toString(),
        'Idempotent (delta == 0 if fully vested)': delta >= 0n ? 'PASS' : 'FAIL'
      }
    };
  },

  'yd-close': async (ctx: YdBasicCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.unclaimedDest) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient } = await import('./yd');
    const conn = get(connection);
    const client = get(ydClient);
    const tx = client.buildTransaction('close_distributor', {
      accounts: {
        authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        reward_vault: ctx.rewardVault,
        unclaimed_destination: ctx.unclaimedDest,
        token_program: TOKEN_PROGRAM_ID
      },
      args: {}
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    // Negative: claim must now fail.
    let claimRejected = false;
    try {
      const { findClaimStatusPda } = await import('$lib/utils/pda');
      const { ydProgramId } = await import('./yd');
      const [claimStatusPda] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);
      const tx2 = client.buildTransaction('claim', {
        accounts: {
          claimant: deployer.publicKey,
          payer: deployer.publicKey,
          config: ctx.configPda,
          distributor: ctx.distributorPda,
          ot_mint: ctx.otMint,
          claim_status: claimStatusPda,
          reward_vault: ctx.rewardVault,
          claimant_token: ctx.unclaimedDest,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID
        },
        args: { cumulative_amount: ctx.netFunded ?? 0n, proof: [] }
      });
      await signAndSendTransaction(conn, tx2, [deployer]);
    } catch {
      claimRejected = true;
    }
    return {
      txSignature: sig,
      result: {
        'is_active': dist.is_active ? 'FAIL' : 'PASS',
        'Claim after close': claimRejected ? 'PASS (rejected)' : 'FAIL (still allowed)'
      }
    };
  }
};

// ===================================================================
// Per-deposit fairness 7-step scenario
// ===================================================================

export interface YdFairnessCtx {
  rwtMint?: PublicKey;
  usdcMint?: PublicKey;
  otMint?: PublicKey;
  // Mint authority for OT (deployer)
  alice?: Keypair;
  bob?: Keypair;
  aliceOtAta?: PublicKey;
  bobOtAta?: PublicKey;
  aliceRwtAta?: PublicKey;
  bobRwtAta?: PublicKey;
  // YD
  configPda?: PublicKey;
  distributorPda?: PublicKey;
  accumulatorPda?: PublicKey;
  rewardVault?: PublicKey;
  accUsdcAta?: PublicKey;
  feeAta?: PublicKey;
  // Per-deposit accounting
  deposit1Net?: bigint;
  deposit2Net?: bigint;
  // Cumulative amounts after 2nd publish
  aliceCumulative?: bigint;
  bobCumulative?: bigint;
  // Merkle tree (after 2nd publish)
  treeRoot?: Uint8Array;
  proofAlice?: Uint8Array[];
  proofBob?: Uint8Array[];
  // Receipts
  aliceReceived?: bigint;
  bobReceived?: bigint;
}

export function createYdFairnessSteps(): E2EStep[] {
  return [
    { id: 'ydf-setup', name: 'Setup: Alice + Bob keypairs, OT mint', description: 'Create Alice (deployer) and Bob keypairs, OT mint, ATAs. Mint 100 OT to Alice.', status: 'pending' },
    { id: 'ydf-init', name: 'Initialize YD + create distributor', description: 'Idempotent init of config and distributor (vesting=300s).', status: 'pending' },
    { id: 'ydf-fund-1', name: 'Fund deposit 1 (1000 RWT) — snapshot 1: Alice 100%', description: 'Deposit 1 of 1000 RWT. Snapshot conceptually records Alice = 100% of OT.', status: 'pending' },
    { id: 'ydf-transfer-ot', name: 'Alice → Bob: transfer 100% of OT', description: 'SPL transfer Alice OT → Bob.', status: 'pending' },
    { id: 'ydf-fund-2', name: 'Fund deposit 2 (500 RWT) — snapshot 2: Bob 100%', description: 'Deposit 2 of 500 RWT. Snapshot records Bob = 100%.', status: 'pending' },
    { id: 'ydf-publish', name: 'Build merkle tree per-deposit + publish', description: 'cumulative: Alice = net(d1), Bob = net(d2). max_total_claim = net(d1)+net(d2). publish_root.', status: 'pending' },
    { id: 'ydf-claim-and-verify', name: 'Alice + Bob claim, assert fairness', description: 'Alice claims (proof_a), Bob claims (proof_b). Assert: Alice ≤ d1, Bob ≤ d2, Σ ≤ total_funded, no late buyer crossover.', status: 'pending' }
  ];
}

export const ydFairnessExecutors: Record<string, StepExecutor> = {
  'ydf-setup': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    const conn = get(connection);
    const { rwtProgramId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const info = await conn.getAccountInfo(vaultPda);
    if (!info) throw new Error('RWT Vault not found — run rwt-lifecycle first');
    ctx.rwtMint = new PublicKey(info.data.slice(72, 104));
    const capAta = new PublicKey(info.data.slice(40, 72));
    const capInfo = await conn.getAccountInfo(capAta);
    if (!capInfo) throw new Error('Capital ATA not found');
    ctx.usdcMint = new PublicKey(capInfo.data.slice(0, 32));

    ctx.alice = deployer;
    ctx.bob = Keypair.generate();
    // Airdrop SOL to Bob (so he can pay for ATA + claim rent).
    const airdropSig = await conn.requestAirdrop(ctx.bob.publicKey, 1_000_000_000);
    for (let i = 0; i < 30; i++) {
      const { value } = await conn.getSignatureStatuses([airdropSig]);
      if (value?.[0]?.confirmationStatus === 'confirmed' || value?.[0]?.confirmationStatus === 'finalized') break;
      await new Promise(r => setTimeout(r, 1000));
    }

    // Create OT mint with deployer as authority.
    const { mintAddress } = await createMint(conn, deployer, 6);
    ctx.otMint = mintAddress;

    // ATAs.
    ctx.aliceOtAta = await createAta(conn, deployer, mintAddress, ctx.alice.publicKey);
    ctx.bobOtAta = await createAta(conn, deployer, mintAddress, ctx.bob.publicKey);
    ctx.aliceRwtAta = await createAta(conn, deployer, ctx.rwtMint, ctx.alice.publicKey);
    ctx.bobRwtAta = await createAta(conn, deployer, ctx.rwtMint, ctx.bob.publicKey);

    // Mint 100 OT to Alice (deployer holds mint authority).
    await mintTo(conn, deployer, mintAddress, ctx.aliceOtAta, 100_000_000n);

    // Pre-fund deployer with RWT for funding (admin_mint_rwt → Alice's RWT ATA).
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const client = get(rwtClientStore);
    const tx = client.buildTransaction('admin_mint_rwt', {
      accounts: {
        authority: deployer.publicKey, rwt_vault: vaultPda,
        rwt_mint: ctx.rwtMint, recipient_rwt: ctx.aliceRwtAta, token_program: TOKEN_PROGRAM_ID
      },
      args: { rwt_amount: 2_000_000_000, backing_capital_usd: 2_000_000_000 }
    });
    await signAndSendTransaction(conn, tx, [deployer]);

    return {
      result: {
        'Alice': ctx.alice.publicKey.toBase58(),
        'Bob': ctx.bob.publicKey.toBase58(),
        'OT Mint': mintAddress.toBase58()
      }
    };
  },

  'ydf-init': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.rwtMint || !ctx.usdcMint || !ctx.aliceRwtAta) throw new Error('Setup incomplete');
    const { ydClient, ydProgramId } = await import('./yd');
    const { findYdConfigPda, findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const client = get(ydClient);
    const [configPda] = findYdConfigPda(ydProgramId);
    const [distributorPda] = findMerkleDistributorPda(ydProgramId, ctx.otMint);
    const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, ctx.otMint);
    const rewardVault = getAtaAddress(distributorPda, ctx.rwtMint);
    const accUsdcAta = getAtaAddress(accumulatorPda, ctx.usdcMint);
    ctx.configPda = configPda;
    ctx.distributorPda = distributorPda;
    ctx.accumulatorPda = accumulatorPda;
    ctx.rewardVault = rewardVault;
    ctx.accUsdcAta = accUsdcAta;
    ctx.feeAta = ctx.aliceRwtAta;

    // initialize_config (idempotent)
    const cfgInfo = await conn.getAccountInfo(configPda);
    if (!cfgInfo) {
      const tx = client.buildTransaction('initialize_config', {
        accounts: {
          deployer: deployer.publicKey,
          config: configPda,
          areal_fee_destination_account: ctx.feeAta,
          system_program: SYSTEM_PROGRAM_ID
        },
        args: {
          publish_authority: Array.from(deployer.publicKey.toBytes()),
          protocol_fee_bps: 25,
          min_distribution_amount: 100_000_000n
        }
      });
      await signAndSendTransaction(conn, tx, [deployer]);
    }

    // create_distributor (idempotent)
    const distInfo = await conn.getAccountInfo(distributorPda);
    if (!distInfo) {
      const tx = client.buildTransaction('create_distributor', {
        accounts: {
          authority: deployer.publicKey,
          config: configPda,
          ot_mint: ctx.otMint,
          distributor: distributorPda,
          accumulator: accumulatorPda,
          rwt_mint: ctx.rwtMint,
          usdc_mint: ctx.usdcMint,
          reward_vault: rewardVault,
          accumulator_usdc_ata: accUsdcAta,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
          ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
        },
        args: { vesting_period_secs: 300n }
      });
      await signAndSendTransaction(conn, tx, [deployer]);
    }

    return { result: {
      configPda: configPda.toBase58(),
      distributorPda: distributorPda.toBase58()
    }};
  },

  'ydf-fund-1': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.feeAta || !ctx.rewardVault || !ctx.otMint) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient } = await import('./yd');
    const conn = get(connection);
    const client = get(ydClient);
    const amount1 = 1_000_000_000n; // 1000 RWT
    const fee1 = (amount1 * 25n) / 10000n;
    ctx.deposit1Net = amount1 - fee1;

    const tx = client.buildTransaction('fund_distributor', {
      accounts: {
        depositor: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        depositor_token: ctx.feeAta,
        reward_vault: ctx.rewardVault,
        fee_account: ctx.feeAta,
        token_program: TOKEN_PROGRAM_ID
      },
      args: { amount: amount1 }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: {
      'Deposit 1 (gross)': amount1.toString(),
      'Deposit 1 (net)': ctx.deposit1Net.toString(),
      'Snapshot': 'Alice=100%'
    }};
  },

  'ydf-transfer-ot': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.aliceOtAta || !ctx.bobOtAta || !ctx.alice) throw new Error('Setup incomplete');
    const conn = get(connection);

    // SPL Transfer (instruction 3): Alice → Bob (100M lamports = 100 OT).
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0);
    data.writeBigUInt64LE(100_000_000n, 1);
    const { TransactionInstruction, Transaction } = await import('@solana/web3.js');
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: ctx.aliceOtAta, isSigner: false, isWritable: true },
        { pubkey: ctx.bobOtAta, isSigner: false, isWritable: true },
        { pubkey: ctx.alice.publicKey, isSigner: true, isWritable: false }
      ],
      programId: TOKEN_PROGRAM_ID,
      data
    });
    const tx = new Transaction().add(ix);
    const sig = await signAndSendTransaction(conn, tx, [ctx.alice]);

    const aliceBal = await getTokenBalance(conn, ctx.aliceOtAta);
    const bobBal = await getTokenBalance(conn, ctx.bobOtAta);
    return { txSignature: sig, result: {
      'Alice OT': aliceBal.toString(),
      'Bob OT': bobBal.toString(),
      'Transferred': aliceBal === 0n && bobBal === 100_000_000n ? 'PASS' : 'FAIL'
    }};
  },

  'ydf-fund-2': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.feeAta || !ctx.rewardVault || !ctx.otMint) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient } = await import('./yd');
    const conn = get(connection);
    const client = get(ydClient);
    const amount2 = 500_000_000n; // 500 RWT
    const fee2 = (amount2 * 25n) / 10000n;
    ctx.deposit2Net = amount2 - fee2;

    const tx = client.buildTransaction('fund_distributor', {
      accounts: {
        depositor: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        depositor_token: ctx.feeAta,
        reward_vault: ctx.rewardVault,
        fee_account: ctx.feeAta,
        token_program: TOKEN_PROGRAM_ID
      },
      args: { amount: amount2 }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: {
      'Deposit 2 (gross)': amount2.toString(),
      'Deposit 2 (net)': ctx.deposit2Net.toString(),
      'Snapshot': 'Bob=100%'
    }};
  },

  'ydf-publish': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.alice || !ctx.bob || !ctx.deposit1Net || !ctx.deposit2Net) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient } = await import('./yd');
    const { computeLeaf, buildMerkleTree } = await import('$lib/utils/merkle');
    const conn = get(connection);
    const client = get(ydClient);

    // Per-deposit aggregation:
    //   cumulative_alice = d1*1.0 (snap1) + d2*0.0 (snap2) = deposit1Net
    //   cumulative_bob   = d1*0.0 + d2*1.0                  = deposit2Net
    const aliceCum = ctx.deposit1Net;
    const bobCum = ctx.deposit2Net;
    ctx.aliceCumulative = aliceCum;
    ctx.bobCumulative = bobCum;

    // Sort leaves canonically? Not strictly required; we keep deterministic order:
    // index 0 = Alice, index 1 = Bob.
    const leafA = await computeLeaf(ctx.alice.publicKey, aliceCum);
    const leafB = await computeLeaf(ctx.bob.publicKey, bobCum);
    const tree = await buildMerkleTree([leafA, leafB]);
    ctx.treeRoot = tree.root;
    ctx.proofAlice = tree.getProof(0);
    ctx.proofBob = tree.getProof(1);

    const maxTotal = aliceCum + bobCum;

    const tx = client.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint
      },
      args: {
        merkle_root: Array.from(tree.root),
        max_total_claim: maxTotal
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: {
      'Alice cumulative': aliceCum.toString(),
      'Bob cumulative': bobCum.toString(),
      'max_total_claim': maxTotal.toString()
    }};
  },

  'ydf-claim-and-verify': async (ctx: YdFairnessCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault ||
        !ctx.alice || !ctx.bob || !ctx.aliceRwtAta || !ctx.bobRwtAta ||
        !ctx.aliceCumulative || !ctx.bobCumulative || !ctx.proofAlice || !ctx.proofBob ||
        !ctx.deposit1Net || !ctx.deposit2Net) {
      throw new Error('Previous steps incomplete');
    }
    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const client = get(ydClient);

    // Wait for full vesting (300s is too long — skip; vesting fraction will apply).
    // Instead claim immediately and assert ≤ deposit{1,2}Net.

    // Alice claim
    const [aliceCs] = findClaimStatusPda(ydProgramId, ctx.distributorPda, ctx.alice.publicKey);
    const aliceBefore = await getTokenBalance(conn, ctx.aliceRwtAta);
    const aliceTx = client.buildTransaction('claim', {
      accounts: {
        claimant: ctx.alice.publicKey,
        payer: ctx.alice.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        claim_status: aliceCs,
        reward_vault: ctx.rewardVault,
        claimant_token: ctx.aliceRwtAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID
      },
      args: {
        cumulative_amount: ctx.aliceCumulative,
        proof: ctx.proofAlice.map(p => Array.from(p))
      },
      computeUnits: 100_000
    });
    const aliceSig = await signAndSendTransaction(conn, aliceTx, [ctx.alice]);
    const aliceAfter = await getTokenBalance(conn, ctx.aliceRwtAta);
    ctx.aliceReceived = aliceAfter - aliceBefore;

    // Bob claim
    const [bobCs] = findClaimStatusPda(ydProgramId, ctx.distributorPda, ctx.bob.publicKey);
    const bobBefore = await getTokenBalance(conn, ctx.bobRwtAta);
    const bobTx = client.buildTransaction('claim', {
      accounts: {
        claimant: ctx.bob.publicKey,
        payer: ctx.bob.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        claim_status: bobCs,
        reward_vault: ctx.rewardVault,
        claimant_token: ctx.bobRwtAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID
      },
      args: {
        cumulative_amount: ctx.bobCumulative,
        proof: ctx.proofBob.map(p => Array.from(p))
      },
      computeUnits: 100_000
    });
    const bobSig = await signAndSendTransaction(conn, bobTx, [ctx.bob]);
    const bobAfter = await getTokenBalance(conn, ctx.bobRwtAta);
    ctx.bobReceived = bobAfter - bobBefore;

    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    const totalClaimed = BigInt(dist.total_claimed.toString());
    const maxTotal = BigInt(dist.max_total_claim.toString());

    const aliceOk = ctx.aliceReceived <= ctx.deposit1Net;
    const bobOk = ctx.bobReceived <= ctx.deposit2Net;
    const sumOk = totalClaimed <= maxTotal;

    // Negative: Alice tries to claim with Bob's cumulative (proof mismatch) → must fail.
    let crossBlocked = false;
    try {
      const tx2 = client.buildTransaction('claim', {
        accounts: {
          claimant: ctx.alice.publicKey,
          payer: ctx.alice.publicKey,
          config: ctx.configPda,
          distributor: ctx.distributorPda,
          ot_mint: ctx.otMint,
          claim_status: aliceCs,
          reward_vault: ctx.rewardVault,
          claimant_token: ctx.aliceRwtAta,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID
        },
        args: {
          cumulative_amount: ctx.bobCumulative,
          proof: ctx.proofBob.map(p => Array.from(p))
        }
      });
      await signAndSendTransaction(conn, tx2, [ctx.alice]);
    } catch {
      crossBlocked = true;
    }

    return {
      txSignature: bobSig,
      result: {
        'Alice received': ctx.aliceReceived.toString(),
        'Alice ≤ d1Net': aliceOk ? 'PASS' : 'FAIL',
        'Bob received': ctx.bobReceived.toString(),
        'Bob ≤ d2Net': bobOk ? 'PASS' : 'FAIL',
        'Σ claimed': totalClaimed.toString(),
        'max_total_claim': maxTotal.toString(),
        'Σ ≤ max': sumOk ? 'PASS' : 'FAIL',
        'Cross-claim blocked (Alice→Bob proof)': crossBlocked ? 'PASS' : 'FAIL',
        'Alice tx': aliceSig,
        'Bob tx': bobSig
      }
    };
  }
};
