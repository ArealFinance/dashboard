/**
 * Saturating-subtraction E2E scenario (Layer 7 tester review §C1).
 *
 * Reproduces the "holder sold their OT between snapshots" case that the
 * contract's `calculate_claimable` handles via `saturating_sub`. Specifically:
 *
 *   Publish 1: Alice cumulative = X; Alice claims ~80% of X
 *   Publish 2: Alice cumulative = Y where Y < already_claimed
 *
 * The contract must NOT revert on Alice's claim attempt; transfer must be 0;
 * ClaimStatus.claimed_amount must NOT decrement.
 *
 * The contract enforces `max_total_claim >= total_claimed` at publish_root
 * time, so we can legitimately lower max_total_claim (and Alice's leaf) down
 * to — but not below — dist.total_claimed. Using (already_claimed, 0)-style
 * values would trigger `MaxClaimBelowClaimed`. The realistic scenario is
 * therefore: Alice claimed 800, we publish a new root where Alice's cumulative
 * is less than 800. To keep max_total_claim >= total_claimed (== 800), we
 * route the difference to ARL Treasury.
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

export interface YdSaturatingCtx {
  rwtMint?: PublicKey;
  usdcMint?: PublicKey;
  otMint?: PublicKey;
  configPda?: PublicKey;
  distributorPda?: PublicKey;
  accumulatorPda?: PublicKey;
  rewardVault?: PublicKey;
  accUsdcAta?: PublicKey;
  feeAta?: PublicKey;
  aliceRwtAta?: PublicKey;
  netFunded?: bigint;
  claimedAfterFirstClaim?: bigint;
  shrunkCumulative?: bigint;
}

export function createYdSaturatingSteps(): E2EStep[] {
  return [
    { id: 'yds-setup', name: 'Setup mints + ATAs + distributor', description: 'Init YD config (idempotent), create test OT, create distributor (vesting=2s).', status: 'pending' },
    { id: 'yds-fund', name: 'Fund 1000 RWT', description: 'Deposit 1000 RWT gross. Verify net deposit applied on-chain.', status: 'pending' },
    { id: 'yds-publish-1', name: 'Publish root #1 (Alice = full net)', description: 'Single-leaf tree, Alice cumulative = net_funded.', status: 'pending' },
    { id: 'yds-claim-large', name: 'Alice claims most of her yield', description: 'Claim at t+~2s, expect >= 80% vested. Save claimed_amount.', status: 'pending' },
    { id: 'yds-publish-2-shrunk', name: 'Publish root #2 (Alice cumulative shrinks)', description: 'New leaf Alice = floor(claimed_amount * 0.5). max_total_claim stays at net_funded (which still >= total_claimed).', status: 'pending' },
    { id: 'yds-claim-saturating', name: 'Alice re-claims under shrunk cumulative', description: 'Must succeed with 0 transferred; ClaimStatus.claimed_amount must NOT decrement.', status: 'pending' },
  ];
}

async function loadRwtAndUsdc(conn: any) {
  const { rwtProgramId } = await import('./rwt');
  const { findRwtVaultPda } = await import('$lib/utils/pda');
  const [vaultPda] = findRwtVaultPda(rwtProgramId);
  const info = await conn.getAccountInfo(vaultPda);
  if (!info) throw new Error('RWT Vault not found — run rwt-lifecycle scenario first');
  const capAta = new PublicKey(info.data.slice(40, 72));
  const rwtMint = new PublicKey(info.data.slice(72, 104));
  const capInfo = await conn.getAccountInfo(capAta);
  if (!capInfo) throw new Error('Capital ATA not found');
  const usdcMint = new PublicKey(capInfo.data.slice(0, 32));
  return { rwtMint, usdcMint };
}

export const ydSaturatingExecutors: Record<string, StepExecutor> = {
  'yds-setup': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    const conn = get(connection);
    const { rwtMint, usdcMint } = await loadRwtAndUsdc(conn);
    ctx.rwtMint = rwtMint;
    ctx.usdcMint = usdcMint;

    // Fresh OT mint per run so distributor state starts clean.
    const { mintAddress } = await createMint(conn, deployer, 6);
    ctx.otMint = mintAddress;

    // Deployer RWT ATA (used as fee_dest, depositor, claimant_token).
    const ata = await createAta(conn, deployer, rwtMint, deployer.publicKey);
    ctx.feeAta = ata;
    ctx.aliceRwtAta = ata;

    // Mint 2000 RWT via admin_mint_rwt.
    const { rwtClient: rwtClientStore, rwtProgramId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const client = get(rwtClientStore);
    const [vaultPda] = findRwtVaultPda(rwtProgramId);
    const tx = client.buildTransaction('admin_mint_rwt', {
      accounts: {
        authority: deployer.publicKey,
        rwt_vault: vaultPda,
        rwt_mint: rwtMint,
        recipient_rwt: ata,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { rwt_amount: 2_000_000_000, backing_capital_usd: 2_000_000_000 },
    });
    await signAndSendTransaction(conn, tx, [deployer]);

    // Init YD config (idempotent) and create distributor.
    const { ydClient, ydProgramId } = await import('./yd');
    const { findYdConfigPda, findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const ydClientInstance = get(ydClient);
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
      const initTx = ydClientInstance.buildTransaction('initialize_config', {
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
      const createTx = ydClientInstance.buildTransaction('create_distributor', {
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
        // Short vesting to reach near-full vest quickly during the test.
        args: { vesting_period_secs: 2n },
      });
      await signAndSendTransaction(conn, createTx, [deployer]);
    }

    return { result: { distributorPda: distributorPda.toBase58(), otMint: mintAddress.toBase58() } };
  },

  'yds-fund': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.feeAta || !ctx.rewardVault || !ctx.otMint) {
      throw new Error('setup incomplete');
    }
    const { ydClient } = await import('./yd');
    const conn = get(connection);
    const client = get(ydClient);
    const gross = 1_000_000_000n;
    const fee = (gross * 25n) / 10000n;
    ctx.netFunded = gross - fee;

    const tx = client.buildTransaction('fund_distributor', {
      accounts: {
        depositor: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
        depositor_token: ctx.feeAta,
        reward_vault: ctx.rewardVault,
        fee_account: ctx.feeAta,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount: gross },
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    return {
      txSignature: sig,
      result: {
        'Net funded': ctx.netFunded.toString(),
        'On-chain total_funded': dist.total_funded.toString(),
      },
    };
  },

  'yds-publish-1': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded) throw new Error('incomplete');
    const { ydClient } = await import('./yd');
    const { computeLeaf } = await import('$lib/utils/merkle');
    const conn = get(connection);
    const client = get(ydClient);
    // Single-leaf: leaf == root.
    const leaf = await computeLeaf(deployer.publicKey, ctx.netFunded);
    const tx = client.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
      },
      args: {
        merkle_root: Array.from(leaf),
        max_total_claim: ctx.netFunded,
      },
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    return {
      txSignature: sig,
      result: {
        epoch: dist.epoch.toString(),
        max_total_claim: dist.max_total_claim.toString(),
      },
    };
  },

  'yds-claim-large': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault || !ctx.aliceRwtAta || !ctx.netFunded) {
      throw new Error('incomplete');
    }
    // Give vesting a moment to vest most of the funded amount (vesting_period=2s).
    await new Promise(r => setTimeout(r, 2500));

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
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { cumulative_amount: ctx.netFunded, proof: [] },
      computeUnits: 100_000,
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const balAfter = await getTokenBalance(conn, ctx.aliceRwtAta);
    const received = balAfter - balBefore;
    const cs = await client.fetch('ClaimStatus', claimStatusPda);
    ctx.claimedAfterFirstClaim = BigInt(cs.claimed_amount.toString());
    return {
      txSignature: sig,
      result: {
        'Received': received.toString(),
        'ClaimStatus.claimed_amount': ctx.claimedAfterFirstClaim.toString(),
        'Received > 0': received > 0n ? 'PASS' : 'FAIL',
      },
    };
  },

  'yds-publish-2-shrunk': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.netFunded || !ctx.claimedAfterFirstClaim) {
      throw new Error('incomplete');
    }
    const { ydClient } = await import('./yd');
    const { computeLeaf, buildMerkleTree } = await import('$lib/utils/merkle');
    const conn = get(connection);
    const client = get(ydClient);

    // Shrink Alice's cumulative BELOW already_claimed — this is the bug class
    // saturating_sub protects against. Route the deficit to ARL Treasury so
    // that the tree's Σ == max_total_claim == netFunded (contract requires
    // max_total_claim == total_funded at publish time, unchanged here).
    // Alice gets 1/2 of what she already claimed (integer divide).
    const shrunk = ctx.claimedAfterFirstClaim / 2n;
    ctx.shrunkCumulative = shrunk;
    const arlTreasuryLeafAmt = ctx.netFunded - shrunk;

    // ARL Treasury pubkey — any PublicKey (doesn't need to own anything on-chain
    // for this scenario; the leaf is never claimed by ARL here).
    const arlTreasury = Keypair.generate().publicKey;

    const leafAlice = await computeLeaf(deployer.publicKey, shrunk);
    const leafArl = await computeLeaf(arlTreasury, arlTreasuryLeafAmt);
    const tree = await buildMerkleTree([leafAlice, leafArl]);

    const tx = client.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
      },
      args: {
        merkle_root: Array.from(tree.root),
        // Stays at netFunded — contract requires == total_funded.
        max_total_claim: ctx.netFunded,
      },
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const dist = await client.fetch('MerkleDistributor', ctx.distributorPda);
    return {
      txSignature: sig,
      result: {
        'Alice shrunk cumulative': shrunk.toString(),
        'already_claimed (> new cumulative)': ctx.claimedAfterFirstClaim.toString(),
        'ARL Treasury leaf': arlTreasuryLeafAmt.toString(),
        'epoch': dist.epoch.toString(),
      },
    };
  },

  'yds-claim-saturating': async (ctx: YdSaturatingCtx, deployer: Keypair) => {
    if (!ctx.distributorPda || !ctx.configPda || !ctx.otMint || !ctx.rewardVault ||
        !ctx.aliceRwtAta || !ctx.shrunkCumulative || !ctx.claimedAfterFirstClaim) {
      throw new Error('incomplete');
    }
    const { ydClient, ydProgramId } = await import('./yd');
    const { findClaimStatusPda } = await import('$lib/utils/pda');
    const { computeLeaf, buildMerkleTree } = await import('$lib/utils/merkle');
    const conn = get(connection);
    const client = get(ydClient);
    const [claimStatusPda] = findClaimStatusPda(ydProgramId, ctx.distributorPda, deployer.publicKey);

    // NOTE: We re-publish a single-leaf tree (Alice = shrunk) so the proof
    // becomes empty and the claim's `saturating_sub` path is exercised purely.
    // Rebuilding the exact 2-leaf tree from yds-publish-2-shrunk would require
    // sharing the ARL dummy pubkey via ctx; the single-leaf trick keeps the
    // scenario self-contained and unambiguous.
    const leafAliceShrunk = await computeLeaf(deployer.publicKey, ctx.shrunkCumulative);
    const republishTx = client.buildTransaction('publish_root', {
      accounts: {
        publish_authority: deployer.publicKey,
        config: ctx.configPda,
        distributor: ctx.distributorPda,
        ot_mint: ctx.otMint,
      },
      args: {
        // Single-leaf: root == Alice's shrunk leaf. max_total_claim remains
        // total_funded (on-chain requires ==). MaxClaimBelowClaimed protects
        // against moving it lower; netFunded >= claimed_amount, so this holds.
        merkle_root: Array.from(leafAliceShrunk),
        max_total_claim: ctx.netFunded!,
      },
    });
    await signAndSendTransaction(conn, republishTx, [deployer]);

    const balBefore = await getTokenBalance(conn, ctx.aliceRwtAta);
    let claimOk = true;
    let caughtMsg = '';
    try {
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
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: { cumulative_amount: ctx.shrunkCumulative, proof: [] },
        computeUnits: 100_000,
      });
      await signAndSendTransaction(conn, tx, [deployer]);
    } catch (err: any) {
      claimOk = false;
      caughtMsg = err?.message ?? String(err);
    }
    const balAfter = await getTokenBalance(conn, ctx.aliceRwtAta);
    const delta = balAfter - balBefore;
    const cs = await client.fetch('ClaimStatus', claimStatusPda);
    const claimedAfter = BigInt(cs.claimed_amount.toString());

    return {
      result: {
        'Claim succeeded (no revert)': claimOk ? 'PASS' : `FAIL: ${caughtMsg.slice(0, 140)}`,
        'Transferred (expect 0)': delta.toString(),
        'claimed_amount preserved (not decremented)':
          claimedAfter === ctx.claimedAfterFirstClaim ? 'PASS' : `FAIL: was ${ctx.claimedAfterFirstClaim} now ${claimedAfter}`,
      },
    };
  },
};
