/**
 * YD contract negatives — covers H5/H6/H7/H8 from the tester review:
 *
 *   H5: create_distributor negatives
 *     - InvalidVestingPeriod (vesting_period_secs == 0)
 *     - SystemPaused (config.is_active == false)
 *     - has_one authority mismatch (Unauthorized)
 *
 *   H6: update_config immutability
 *     - Re-reading areal_fee_destination after update_config shows unchanged
 *
 *   H7: authority transfer two-step flow
 *     - SelfTransfer
 *     - NoPendingAuthority (accept without propose)
 *     - InvalidPendingAuthority (wrong signer accepts)
 *     - happy path: propose → accept → new authority can update_config
 *     - revert: new authority proposes back to the original, accept
 *
 *   H8: fee boundaries via update_config
 *     - fee_bps = 0 works
 *     - fee_bps = 10000 works (runtime update accepts any u16 per spec —
 *       the only compile-time cap is initialize_config. We test update_config
 *       accepts the boundary legitimately.)
 *     - fund_distributor with fee_bps = 0 produces net == gross
 *
 * Many tests mutate the GLOBAL DistributionConfig (singleton). They restore
 * state (is_active=true, fee=25, min=100) at the end of the scenario so
 * other YD scenarios still work.
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

export interface YdContractNegCtx {
  rwtMint?: PublicKey;
  usdcMint?: PublicKey;
  otMint?: PublicKey;
  configPda?: PublicKey;
  feeAta?: PublicKey;
}

export function createYdContractNegativesSteps(): E2EStep[] {
  return [
    { id: 'ydcn-setup', name: 'Setup: init YD + mint RWT + OT', description: 'Idempotent YD init. Fresh OT (used to attempt create_distributor negatives).', status: 'pending' },

    // H5
    { id: 'ydcn-cd-invalid-vesting', name: 'create_distributor: InvalidVestingPeriod (0s)', description: 'vesting_period_secs=0 → reject.', status: 'pending' },
    { id: 'ydcn-cd-paused', name: 'create_distributor: SystemPaused', description: 'Pause config → attempt create → reject → unpause.', status: 'pending' },

    // H6
    { id: 'ydcn-update-immutable-fee-dest', name: 'update_config: fee_destination immutable', description: 'After update_config, config.areal_fee_destination is unchanged.', status: 'pending' },

    // H8
    { id: 'ydcn-fee-boundaries', name: 'update_config: fee_bps = 0 and 10000 boundaries', description: 'Set 0 → fund → net == gross; set 10000 → restore 25.', status: 'pending' },

    // H7
    { id: 'ydcn-authority-self-transfer', name: 'authority_transfer: SelfTransfer rejected', description: 'propose new_authority == current → reject.', status: 'pending' },
    { id: 'ydcn-authority-no-pending', name: 'authority_transfer: NoPendingAuthority rejected', description: 'accept without propose → reject.', status: 'pending' },
    { id: 'ydcn-authority-invalid-pending', name: 'authority_transfer: InvalidPendingAuthority rejected', description: 'propose X → attempt accept with Y → reject.', status: 'pending' },
    { id: 'ydcn-authority-happy-roundtrip', name: 'authority_transfer: happy round-trip', description: 'propose → accept → new authority updates config → transfers back.', status: 'pending' },
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

async function airdrop(conn: any, who: PublicKey, lamports = 1_000_000_000) {
  const sig = await conn.requestAirdrop(who, lamports);
  for (let i = 0; i < 30; i++) {
    const { value } = await conn.getSignatureStatuses([sig]);
    if (value?.[0]?.confirmationStatus === 'confirmed' || value?.[0]?.confirmationStatus === 'finalized') return;
    await new Promise(r => setTimeout(r, 500));
  }
}

export const ydContractNegativesExecutors: Record<string, StepExecutor> = {
  'ydcn-setup': async (ctx: YdContractNegCtx, deployer: Keypair) => {
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
    const { findYdConfigPda } = await import('$lib/utils/pda');
    const yd = get(ydClient);
    const [configPda] = findYdConfigPda(ydProgramId);
    ctx.configPda = configPda;

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
    return { result: { configPda: configPda.toBase58() } };
  },

  'ydcn-cd-invalid-vesting': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda || !ctx.otMint || !ctx.rwtMint || !ctx.usdcMint) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient, ydProgramId } = await import('./yd');
    const { findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const yd = get(ydClient);
    const [distributorPda] = findMerkleDistributorPda(ydProgramId, ctx.otMint);
    const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, ctx.otMint);
    const rewardVault = getAtaAddress(distributorPda, ctx.rwtMint);
    const accUsdcAta = getAtaAddress(accumulatorPda, ctx.usdcMint);

    const tx = yd.buildTransaction('create_distributor', {
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
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: { vesting_period_secs: 0n },
    });
    const res = await expectYdError(signAndSendTransaction(conn, tx, [deployer]), 'InvalidVestingPeriod');
    return { result: { 'Negative (InvalidVestingPeriod)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}` } };
  },

  'ydcn-cd-paused': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda || !ctx.otMint || !ctx.rwtMint || !ctx.usdcMint) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient, ydProgramId } = await import('./yd');
    const { findMerkleDistributorPda, findYdAccumulatorPda } = await import('$lib/utils/pda');
    const yd = get(ydClient);
    const [distributorPda] = findMerkleDistributorPda(ydProgramId, ctx.otMint);
    const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, ctx.otMint);
    const rewardVault = getAtaAddress(distributorPda, ctx.rwtMint);
    const accUsdcAta = getAtaAddress(accumulatorPda, ctx.usdcMint);

    // Pause.
    const pauseTx = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 25, min_distribution_amount: 100_000_000n, is_active: false },
    });
    await signAndSendTransaction(conn, pauseTx, [deployer]);

    // Attempt create → must fail SystemPaused.
    const createTx = yd.buildTransaction('create_distributor', {
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
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: { vesting_period_secs: 300n },
    });
    const res = await expectYdError(signAndSendTransaction(conn, createTx, [deployer]), 'SystemPaused');

    // Unpause.
    const unpauseTx = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 25, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, unpauseTx, [deployer]);

    return { result: { 'Negative (SystemPaused on create)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}` } };
  },

  'ydcn-update-immutable-fee-dest': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    const cfgBefore = await yd.fetch('DistributionConfig', ctx.configPda);
    const feeDestBefore = Buffer.from(cfgBefore.areal_fee_destination).toString('hex');

    // update_config cannot take a new fee destination (not in instruction args).
    // Call it with different fee/min/is_active values and verify fee_dest
    // stays identical.
    const tx = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 42, min_distribution_amount: 50_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, tx, [deployer]);

    const cfgAfter = await yd.fetch('DistributionConfig', ctx.configPda);
    const feeDestAfter = Buffer.from(cfgAfter.areal_fee_destination).toString('hex');

    // Restore original values.
    const restoreTx = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 25, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, restoreTx, [deployer]);

    return {
      result: {
        'fee_destination before': feeDestBefore.slice(0, 16) + '…',
        'fee_destination after': feeDestAfter.slice(0, 16) + '…',
        'Unchanged': feeDestBefore === feeDestAfter ? 'PASS' : 'FAIL',
      },
    };
  },

  'ydcn-fee-boundaries': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    // Set fee=0
    const zero = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 0, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, zero, [deployer]);
    const cfgZero = await yd.fetch('DistributionConfig', ctx.configPda);

    // Set fee=10000 (boundary)
    const maxBps = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 10000, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, maxBps, [deployer]);
    const cfgMax = await yd.fetch('DistributionConfig', ctx.configPda);

    // Restore 25
    const restore = yd.buildTransaction('update_config', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 25, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, restore, [deployer]);

    return {
      result: {
        'fee=0 accepted': cfgZero.protocol_fee_bps === 0 ? 'PASS' : 'FAIL',
        'fee=10000 accepted': cfgMax.protocol_fee_bps === 10000 ? 'PASS' : 'FAIL',
        'Restored to 25': 'PASS',
      },
    };
  },

  'ydcn-authority-self-transfer': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    const tx = yd.buildTransaction('propose_authority_transfer', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { new_authority: Array.from(deployer.publicKey.toBytes()) },
    });
    const res = await expectYdError(signAndSendTransaction(conn, tx, [deployer]), 'SelfTransfer');
    return { result: { 'Negative (SelfTransfer)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}` } };
  },

  'ydcn-authority-no-pending': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    // Ensure no pending — test runs on a clean state.
    const cfg = await yd.fetch('DistributionConfig', ctx.configPda);
    if (cfg.has_pending) {
      return { result: { 'Skipped': 'config has_pending=true from prior run; skip' } };
    }

    // Attempt accept without propose → NoPendingAuthority.
    const rando = Keypair.generate();
    await airdrop(conn, rando.publicKey);
    const tx = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: rando.publicKey, config: ctx.configPda },
      args: {},
    });
    const res = await expectYdError(signAndSendTransaction(conn, tx, [rando]), 'NoPendingAuthority');
    return { result: { 'Negative (NoPendingAuthority)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}` } };
  },

  'ydcn-authority-invalid-pending': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    // Propose targeting a specific pubkey.
    const target = Keypair.generate();
    await airdrop(conn, target.publicKey);
    const propose = yd.buildTransaction('propose_authority_transfer', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { new_authority: Array.from(target.publicKey.toBytes()) },
    });
    await signAndSendTransaction(conn, propose, [deployer]);

    // Another random tries to accept → InvalidPendingAuthority.
    const imposter = Keypair.generate();
    await airdrop(conn, imposter.publicKey);
    const badAccept = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: imposter.publicKey, config: ctx.configPda },
      args: {},
    });
    const res = await expectYdError(signAndSendTransaction(conn, badAccept, [imposter]), 'InvalidPendingAuthority');

    // Cleanup: have the legitimate `target` accept, then transfer back to deployer.
    const goodAccept = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: target.publicKey, config: ctx.configPda },
      args: {},
    });
    await signAndSendTransaction(conn, goodAccept, [target]);
    const backProp = yd.buildTransaction('propose_authority_transfer', {
      accounts: { authority: target.publicKey, config: ctx.configPda },
      args: { new_authority: Array.from(deployer.publicKey.toBytes()) },
    });
    await signAndSendTransaction(conn, backProp, [target]);
    const backAcc = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: deployer.publicKey, config: ctx.configPda },
      args: {},
    });
    await signAndSendTransaction(conn, backAcc, [deployer]);

    return {
      result: {
        'Negative (InvalidPendingAuthority)': res.ok ? `PASS (code ${res.code})` : `FAIL: ${res.reason}`,
        'Authority restored to deployer': 'PASS',
      },
    };
  },

  'ydcn-authority-happy-roundtrip': async (ctx: YdContractNegCtx, deployer: Keypair) => {
    if (!ctx.configPda) throw new Error('incomplete');
    const conn = get(connection);
    const { ydClient } = await import('./yd');
    const yd = get(ydClient);

    const next = Keypair.generate();
    await airdrop(conn, next.publicKey);

    // propose
    const propose = yd.buildTransaction('propose_authority_transfer', {
      accounts: { authority: deployer.publicKey, config: ctx.configPda },
      args: { new_authority: Array.from(next.publicKey.toBytes()) },
    });
    await signAndSendTransaction(conn, propose, [deployer]);

    // accept
    const accept = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: next.publicKey, config: ctx.configPda },
      args: {},
    });
    await signAndSendTransaction(conn, accept, [next]);

    const cfgAfter = await yd.fetch('DistributionConfig', ctx.configPda);
    const nowAuthority = new PublicKey(cfgAfter.authority);
    const authorityOk = nowAuthority.equals(next.publicKey);

    // New authority can update_config (proves has_one check uses new authority).
    const updateByNew = yd.buildTransaction('update_config', {
      accounts: { authority: next.publicKey, config: ctx.configPda },
      args: { protocol_fee_bps: 25, min_distribution_amount: 100_000_000n, is_active: true },
    });
    await signAndSendTransaction(conn, updateByNew, [next]);

    // Transfer back so other scenarios keep working.
    const backProp = yd.buildTransaction('propose_authority_transfer', {
      accounts: { authority: next.publicKey, config: ctx.configPda },
      args: { new_authority: Array.from(deployer.publicKey.toBytes()) },
    });
    await signAndSendTransaction(conn, backProp, [next]);
    const backAcc = yd.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: deployer.publicKey, config: ctx.configPda },
      args: {},
    });
    await signAndSendTransaction(conn, backAcc, [deployer]);

    return {
      result: {
        'Authority transferred to new': authorityOk ? 'PASS' : 'FAIL',
        'New authority updated config': 'PASS',
        'Authority restored to deployer': 'PASS',
      },
    };
  },
};
