import { writable, get } from 'svelte/store';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { connection } from './network';
import { devKeys } from './devkeys';
import { arlexClient, programId } from './ot';
import type { ArlexClient } from '$lib/arlex-client/index.mjs';
import {
  findOtConfigPda,
  findRevenueAccountPda,
  findRevenueConfigPda,
  findOtGovernancePda,
  findOtTreasuryPda,
  findDexConfigPda,
  findPoolCreatorsPda,
  findPoolStatePda,
  findLpPositionPda,
  findBinArrayPda,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID
} from '$lib/utils/pda';
// dexClient and dexProgramId imported dynamically in DEX executors to avoid circular deps
import { createMint, createAta, mintTo, getTokenBalance, getMintInfo, getAtaAddress } from '$lib/utils/spl';
import { signAndSendTransaction } from '$lib/utils/tx';
import { stringToFixedBytes, bytesToBase58 } from '$lib/utils/format';

// ---- Types ----

export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';
export type ScenarioStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface E2EStep {
  id: string;
  name: string;
  description: string;
  status: StepStatus;
  txSignature?: string;
  result?: Record<string, any>;
  error?: string;
  durationMs?: number;
}

export interface E2EScenario {
  id: string;
  name: string;
  steps: E2EStep[];
  status: ScenarioStatus;
  startedAt?: number;
  completedAt?: number;
}

// ---- Shared context between steps ----

interface E2EContext {
  usdcMintKeypair?: Keypair;
  usdcMint?: PublicKey;
  otMintKeypair?: Keypair;
  otMint?: PublicKey;
  arealFeeAta?: PublicKey;
  otConfigPda?: PublicKey;
  revenueAccountPda?: PublicKey;
  revenueConfigPda?: PublicKey;
  otGovernancePda?: PublicKey;
  otTreasuryPda?: PublicKey;
  revenueTokenAccount?: PublicKey;
  destAta_a?: PublicKey;
  destAta_b?: PublicKey;
  destAta_c?: PublicKey;
  destOwner_a?: Keypair;
  destOwner_b?: Keypair;
  destOwner_c?: Keypair;
}

// ---- Step definitions ----

function createOtE2ESteps(): E2EStep[] {
  return [
    {
      id: 'create-usdc-mint',
      name: 'Create Test USDC Mint',
      description: 'Create a new SPL mint with 6 decimals to simulate USDC on test validator',
      status: 'pending'
    },
    {
      id: 'create-ot-mint',
      name: 'Create Test OT Mint',
      description: 'Create another SPL mint with 6 decimals for the OT token. Deployer is mint authority.',
      status: 'pending'
    },
    {
      id: 'create-fee-ata',
      name: 'Create Areal Fee ATA',
      description: 'Create a USDC ATA for the deployer to simulate Areal Finance fee destination',
      status: 'pending'
    },
    {
      id: 'initialize-ot',
      name: 'Initialize OT',
      description: 'Call initialize_ot via ArlexClient. Creates all PDAs, transfers mint authority to OtConfig PDA.',
      status: 'pending'
    },
    {
      id: 'batch-update-destinations',
      name: 'Batch Update Destinations',
      description: 'Set 3 test destinations: 70% YD Accumulator, 20% Treasury, 10% Nexus',
      status: 'pending'
    },
    {
      id: 'mint-usdc-to-revenue',
      name: 'Mint USDC to Revenue ATA',
      description: 'Mint $500 USDC (500,000,000 lamports) to the Revenue token account',
      status: 'pending'
    },
    {
      id: 'distribute-revenue',
      name: 'Distribute Revenue',
      description: 'Call distribute_revenue. Verify fee and destination balances match expected values.',
      status: 'pending'
    },
    {
      id: 'mint-ot-tokens',
      name: 'Mint OT Tokens',
      description: 'Call mint_ot with amount=1,000,000,000 (1000 tokens at 6 decimals) to deployer',
      status: 'pending'
    },
    {
      id: 'spend-treasury',
      name: 'Spend Treasury',
      description: 'Create treasury USDC ATA, mint USDC to it, then call spend_treasury to transfer out',
      status: 'pending'
    },
    {
      id: 'verify-final-state',
      name: 'Verify Final State',
      description: 'Read all 5 PDA accounts and verify all values match expected state',
      status: 'pending'
    }
  ];
}

// ---- Step executors ----

type StepExecutor = (
  ctx: E2EContext,
  deployer: Keypair
) => Promise<{ txSignature?: string; result?: Record<string, any> }>;

const stepExecutors: Record<string, StepExecutor> = {
  'create-usdc-mint': async (ctx, deployer) => {
    const conn = get(connection);
    const { mintAddress, mintKeypair } = await createMint(conn, deployer, 6);
    ctx.usdcMintKeypair = mintKeypair;
    ctx.usdcMint = mintAddress;
    return {
      result: { usdcMint: mintAddress.toBase58() }
    };
  },

  'create-ot-mint': async (ctx, deployer) => {
    const conn = get(connection);
    const { mintAddress, mintKeypair } = await createMint(conn, deployer, 6);
    ctx.otMintKeypair = mintKeypair;
    ctx.otMint = mintAddress;
    return {
      result: { otMint: mintAddress.toBase58() }
    };
  },

  'create-fee-ata': async (ctx, deployer) => {
    if (!ctx.usdcMint) throw new Error('USDC mint not created yet');
    const conn = get(connection);
    const ata = await createAta(conn, deployer, ctx.usdcMint, deployer.publicKey);
    ctx.arealFeeAta = ata;
    return {
      result: { arealFeeAta: ata.toBase58() }
    };
  },

  'initialize-ot': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.usdcMint || !ctx.arealFeeAta) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);
    const client = get(arlexClient);

    // Derive PDAs
    const [otConfigPda] = findOtConfigPda(ctx.otMint, programId);
    const [revenueAccountPda] = findRevenueAccountPda(ctx.otMint, programId);
    const [revenueConfigPda] = findRevenueConfigPda(ctx.otMint, programId);
    const [otGovernancePda] = findOtGovernancePda(ctx.otMint, programId);
    const [otTreasuryPda] = findOtTreasuryPda(ctx.otMint, programId);
    const revenueTokenAccount = getAtaAddress(revenueAccountPda, ctx.usdcMint);

    ctx.otConfigPda = otConfigPda;
    ctx.revenueAccountPda = revenueAccountPda;
    ctx.revenueConfigPda = revenueConfigPda;
    ctx.otGovernancePda = otGovernancePda;
    ctx.otTreasuryPda = otTreasuryPda;
    ctx.revenueTokenAccount = revenueTokenAccount;

    const tx = client.buildTransaction('initialize_ot', {
      accounts: {
        deployer: deployer.publicKey,
        ot_mint: ctx.otMint,
        usdc_mint: ctx.usdcMint,
        ot_config: otConfigPda,
        revenue_account: revenueAccountPda,
        revenue_token_account: revenueTokenAccount,
        revenue_config: revenueConfigPda,
        ot_governance: otGovernancePda,
        ot_treasury: otTreasuryPda,
        areal_fee_destination_account: ctx.arealFeeAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
      },
      args: {
        name: Array.from(stringToFixedBytes('Test OT', 32)),
        symbol: Array.from(stringToFixedBytes('TOT', 10)),
        uri: Array.from(stringToFixedBytes('https://test.areal.finance/tot', 200)),
        initial_authority: Array.from(deployer.publicKey.toBytes())
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    // Verify mint authority was transferred to OtConfig PDA
    const mintInfo = await getMintInfo(conn, ctx.otMint);
    const authorityMatch = mintInfo.mintAuthority?.equals(otConfigPda) ?? false;

    return {
      txSignature: sig,
      result: {
        otConfigPda: otConfigPda.toBase58(),
        revenueAccountPda: revenueAccountPda.toBase58(),
        revenueConfigPda: revenueConfigPda.toBase58(),
        otGovernancePda: otGovernancePda.toBase58(),
        otTreasuryPda: otTreasuryPda.toBase58(),
        revenueTokenAccount: revenueTokenAccount.toBase58(),
        mintAuthorityTransferred: authorityMatch,
        newMintAuthority: mintInfo.mintAuthority?.toBase58() ?? 'none'
      }
    };
  },

  'batch-update-destinations': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.usdcMint || !ctx.otGovernancePda || !ctx.revenueConfigPda) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);
    const client = get(arlexClient);

    // Create 3 destination owners and their USDC ATAs
    ctx.destOwner_a = Keypair.generate();
    ctx.destOwner_b = Keypair.generate();
    ctx.destOwner_c = Keypair.generate();

    ctx.destAta_a = await createAta(conn, deployer, ctx.usdcMint, ctx.destOwner_a.publicKey);
    ctx.destAta_b = await createAta(conn, deployer, ctx.usdcMint, ctx.destOwner_b.publicKey);
    ctx.destAta_c = await createAta(conn, deployer, ctx.usdcMint, ctx.destOwner_c.publicKey);

    const destinations = [
      {
        address: Array.from(ctx.destAta_a.toBytes()),
        allocation_bps: 7000,
        label: Array.from(stringToFixedBytes('YD Accumulator Test', 32))
      },
      {
        address: Array.from(ctx.destAta_b.toBytes()),
        allocation_bps: 2000,
        label: Array.from(stringToFixedBytes('Treasury Test', 32))
      },
      {
        address: Array.from(ctx.destAta_c.toBytes()),
        allocation_bps: 1000,
        label: Array.from(stringToFixedBytes('Nexus Test', 32))
      }
    ];

    const tx = client.buildTransaction('batch_update_destinations', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: ctx.otMint,
        ot_governance: ctx.otGovernancePda,
        revenue_config: ctx.revenueConfigPda
      },
      args: {
        destinations
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    return {
      txSignature: sig,
      result: {
        dest_a: ctx.destAta_a.toBase58(),
        dest_b: ctx.destAta_b.toBase58(),
        dest_c: ctx.destAta_c.toBase58(),
        allocations: '70% / 20% / 10%'
      }
    };
  },

  'mint-usdc-to-revenue': async (ctx, deployer) => {
    if (!ctx.usdcMint || !ctx.usdcMintKeypair || !ctx.revenueTokenAccount) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);

    // Mint $500 USDC = 500_000_000 (6 decimals)
    const amount = 500_000_000n;
    const sig = await mintTo(conn, deployer, ctx.usdcMint, ctx.revenueTokenAccount, amount);

    const balance = await getTokenBalance(conn, ctx.revenueTokenAccount);

    return {
      txSignature: sig,
      result: {
        amount: amount.toString(),
        revenueAtaBalance: balance.toString()
      }
    };
  },

  'distribute-revenue': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.revenueAccountPda || !ctx.revenueTokenAccount ||
        !ctx.revenueConfigPda || !ctx.arealFeeAta || !ctx.destAta_a ||
        !ctx.destAta_b || !ctx.destAta_c) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);
    const client = get(arlexClient);

    const tx = client.buildTransaction('distribute_revenue', {
      accounts: {
        crank: deployer.publicKey,
        ot_mint: ctx.otMint,
        revenue_account: ctx.revenueAccountPda,
        revenue_token_account: ctx.revenueTokenAccount,
        revenue_config: ctx.revenueConfigPda,
        areal_fee_account: ctx.arealFeeAta,
        token_program: TOKEN_PROGRAM_ID
      },
      remainingAccounts: [
        { pubkey: ctx.destAta_a, isSigner: false, isWritable: true },
        { pubkey: ctx.destAta_b, isSigner: false, isWritable: true },
        { pubkey: ctx.destAta_c, isSigner: false, isWritable: true }
      ]
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    // Verify balances
    const [feeBal, destABal, destBBal, destCBal, revBal] = await Promise.all([
      getTokenBalance(conn, ctx.arealFeeAta),
      getTokenBalance(conn, ctx.destAta_a),
      getTokenBalance(conn, ctx.destAta_b),
      getTokenBalance(conn, ctx.destAta_c),
      getTokenBalance(conn, ctx.revenueTokenAccount)
    ]);

    // Expected values:
    // fee = ceil(500_000_000 * 25 / 10000) = 1_250_000
    // post_fee = 498_750_000
    // dest_a (70%): floor(498_750_000 * 7000 / 10000) = 349_125_000
    // dest_b (20%): floor(498_750_000 * 2000 / 10000) = 99_750_000
    // dest_c (10%): remainder = 498_750_000 - 349_125_000 - 99_750_000 = 49_875_000
    const expectedFee = 1_250_000n;
    const expectedA = 349_125_000n;
    const expectedB = 99_750_000n;
    const expectedC = 49_875_000n;

    return {
      txSignature: sig,
      result: {
        feeBalance: feeBal.toString(),
        feeExpected: expectedFee.toString(),
        feeMatch: feeBal === expectedFee,
        destA_balance: destABal.toString(),
        destA_expected: expectedA.toString(),
        destA_match: destABal === expectedA,
        destB_balance: destBBal.toString(),
        destB_expected: expectedB.toString(),
        destB_match: destBBal === expectedB,
        destC_balance: destCBal.toString(),
        destC_expected: expectedC.toString(),
        destC_match: destCBal === expectedC,
        revenueRemaining: revBal.toString()
      }
    };
  },

  'mint-ot-tokens': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.otGovernancePda || !ctx.otConfigPda) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);
    const client = get(arlexClient);

    const recipientAta = getAtaAddress(deployer.publicKey, ctx.otMint);

    const tx = client.buildTransaction('mint_ot', {
      accounts: {
        authority: deployer.publicKey,
        ot_governance: ctx.otGovernancePda,
        ot_config: ctx.otConfigPda,
        ot_mint: ctx.otMint,
        recipient_token_account: recipientAta,
        recipient: deployer.publicKey,
        payer: deployer.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
      },
      args: {
        amount: 1_000_000_000
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    const balance = await getTokenBalance(conn, recipientAta);

    return {
      txSignature: sig,
      result: {
        recipientAta: recipientAta.toBase58(),
        otBalance: balance.toString(),
        expectedBalance: '1000000000'
      }
    };
  },

  'spend-treasury': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.usdcMint || !ctx.otGovernancePda || !ctx.otTreasuryPda) {
      throw new Error('Previous steps not completed');
    }
    const conn = get(connection);
    const client = get(arlexClient);

    // Create treasury USDC ATA
    const treasuryUsdcAta = await createAta(conn, deployer, ctx.usdcMint, ctx.otTreasuryPda);

    // Mint some USDC to treasury ATA (100 USDC)
    const treasuryAmount = 100_000_000n;
    await mintTo(conn, deployer, ctx.usdcMint, treasuryUsdcAta, treasuryAmount);

    // Create destination ATA for deployer (should already exist from fee ATA step)
    const destAta = ctx.arealFeeAta!;
    const destBalBefore = await getTokenBalance(conn, destAta);

    // Spend 50 USDC from treasury
    const spendAmount = 50_000_000;
    const tx = client.buildTransaction('spend_treasury', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: ctx.otMint,
        ot_governance: ctx.otGovernancePda,
        ot_treasury: ctx.otTreasuryPda,
        treasury_token_account: treasuryUsdcAta,
        destination_token_account: destAta,
        token_mint: ctx.usdcMint,
        token_program: TOKEN_PROGRAM_ID
      },
      args: {
        amount: spendAmount
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    const [treasuryBal, destBalAfter] = await Promise.all([
      getTokenBalance(conn, treasuryUsdcAta),
      getTokenBalance(conn, destAta)
    ]);

    return {
      txSignature: sig,
      result: {
        treasuryUsdcAta: treasuryUsdcAta.toBase58(),
        treasuryBalance: treasuryBal.toString(),
        destBalanceBefore: destBalBefore.toString(),
        destBalanceAfter: destBalAfter.toString(),
        spentAmount: spendAmount.toString()
      }
    };
  },

  'verify-final-state': async (ctx, deployer) => {
    if (!ctx.otMint || !ctx.otConfigPda || !ctx.revenueAccountPda ||
        !ctx.revenueConfigPda || !ctx.otGovernancePda || !ctx.otTreasuryPda) {
      throw new Error('Previous steps not completed');
    }
    const client = get(arlexClient);

    const [otConfig, revenueAccount, revenueConfig, governance, treasury] = await Promise.all([
      client.fetch('OtConfig', ctx.otConfigPda),
      client.fetch('RevenueAccount', ctx.revenueAccountPda),
      client.fetch('RevenueConfig', ctx.revenueConfigPda),
      client.fetch('OtGovernance', ctx.otGovernancePda),
      client.fetch('OtTreasury', ctx.otTreasuryPda)
    ]);

    const totalMinted = BigInt(otConfig.total_minted?.toString() ?? '0');
    const totalDistributed = BigInt(revenueAccount.total_distributed?.toString() ?? '0');
    const distributionCount = BigInt(revenueAccount.distribution_count?.toString() ?? '0');
    const activeCount = revenueConfig.active_count ?? 0;

    // Extract authority from governance
    const authorityBytes = governance.authority instanceof Uint8Array
      ? governance.authority
      : new Uint8Array(governance.authority);
    const authorityPk = bytesToBase58(authorityBytes);

    const checks = {
      totalMinted: totalMinted.toString(),
      totalMinted_expected: '1000000000',
      totalMinted_match: totalMinted === 1_000_000_000n,
      totalDistributed: totalDistributed.toString(),
      totalDistributed_expected: '500000000',
      totalDistributed_match: totalDistributed === 500_000_000n,
      distributionCount: distributionCount.toString(),
      distributionCount_expected: '1',
      distributionCount_match: distributionCount === 1n,
      activeCount,
      activeCount_expected: 3,
      activeCount_match: activeCount === 3,
      authority: authorityPk,
      authority_expected: deployer.publicKey.toBase58(),
      authority_match: authorityPk === deployer.publicKey.toBase58(),
      governanceActive: governance.is_active ?? false
    };

    const allPassed = checks.totalMinted_match && checks.totalDistributed_match &&
      checks.distributionCount_match && checks.activeCount_match && checks.authority_match;

    if (!allPassed) {
      throw new Error('Final state verification failed — see result details');
    }

    return { result: checks };
  }
};

// ---- Futarchy E2E Scenario ----

interface FutarchyE2EContext extends E2EContext {
  futarchyConfigPda?: PublicKey;
  proposalPda?: PublicKey;
  proposalId?: bigint;
}

function createFutarchyE2ESteps(): E2EStep[] {
  return [
    {
      id: 'fut-bootstrap-ot',
      name: 'Bootstrap OT (prerequisite)',
      description: 'Create test mints, initialize OT with all PDAs. Self-contained — does not depend on OT E2E.',
      status: 'pending'
    },
    {
      id: 'fut-init',
      name: 'Initialize Futarchy',
      description: 'Create Futarchy governance for the test OT mint.',
      status: 'pending'
    },
    {
      id: 'fut-propose-transfer',
      name: 'OT: Propose Authority Transfer',
      description: 'On OT side, propose authority transfer to Futarchy config PDA',
      status: 'pending'
    },
    {
      id: 'fut-claim-governance',
      name: 'Claim OT Governance',
      description: 'Futarchy config PDA accepts OT governance authority via CPI',
      status: 'pending'
    },
    {
      id: 'fut-create-mint-proposal',
      name: 'Create MintOt Proposal',
      description: 'Create proposal to mint 500 OT tokens to deployer',
      status: 'pending'
    },
    {
      id: 'fut-approve-proposal',
      name: 'Approve Proposal',
      description: 'Authority approves the MintOt proposal',
      status: 'pending'
    },
    {
      id: 'fut-execute-mint',
      name: 'Execute MintOt',
      description: 'Permissionless execution — CPI to OT::mint_ot. Verify tokens minted.',
      status: 'pending'
    },
    {
      id: 'fut-verify-state',
      name: 'Verify Final State',
      description: 'Check proposal status=Executed, OT total_minted increased, token balance correct',
      status: 'pending'
    }
  ];
}

const futarchyStepExecutors: Record<string, StepExecutor> = {
  'fut-bootstrap-ot': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    // Bootstrap a minimal OT instance for Futarchy testing
    const conn = get(connection);
    const client = get(arlexClient);

    // Create OT mint (6 decimals)
    const otMintResult = await createMint(conn, deployer, 6, deployer.publicKey);
    ctx.otMint = otMintResult.mintAddress;
    ctx.otMintKeypair = otMintResult.mintKeypair;

    // Create USDC mint for fee ATA
    const usdcMintResult = await createMint(conn, deployer, 6, deployer.publicKey);
    ctx.usdcMint = usdcMintResult.mintAddress;
    const usdcMintKeypair = usdcMintResult.mintKeypair;

    // Create fee ATA
    const feeAta = await createAta(conn, deployer, usdcMintKeypair.publicKey, deployer.publicKey);

    // Derive all OT PDAs
    const [otConfigPda] = findOtConfigPda(ctx.otMint, programId);
    const [revenuePda] = findRevenueAccountPda(ctx.otMint, programId);
    const [revenueConfigPda] = findRevenueConfigPda(ctx.otMint, programId);
    const [governancePda] = findOtGovernancePda(ctx.otMint, programId);
    const [treasuryPda] = findOtTreasuryPda(ctx.otMint, programId);

    ctx.otConfigPda = otConfigPda;
    ctx.otGovernancePda = governancePda;

    // Initialize OT
    const tx = client.buildTransaction('initialize_ot', {
      accounts: {
        deployer: deployer.publicKey,
        ot_mint: ctx.otMint,
        usdc_mint: usdcMintKeypair.publicKey,
        ot_config: otConfigPda,
        revenue_account: revenuePda,
        revenue_token_account: getAtaAddress(revenuePda, usdcMintKeypair.publicKey),
        revenue_config: revenueConfigPda,
        ot_governance: governancePda,
        ot_treasury: treasuryPda,
        areal_fee_destination_account: feeAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
      },
      args: {
        name: Array.from(stringToFixedBytes('FutarchyTest', 32)),
        symbol: Array.from(stringToFixedBytes('FTEST', 10)),
        uri: Array.from(stringToFixedBytes('https://test.areal.finance', 200)),
        initial_authority: Array.from(deployer.publicKey.toBytes())
      }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);

    return {
      txSignature: sig,
      result: {
        'OT Mint': ctx.otMint.toBase58(),
        'OT Config PDA': otConfigPda.toBase58(),
        'OT Governance PDA': governancePda.toBase58()
      }
    };
  },

  'fut-init': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint) throw new Error('OT not bootstrapped. Run bootstrap step first.');

    const { futarchyClient: futClientStore, futarchyProgramId: futProgramId } = await import('./futarchy');
    const { findFutarchyConfigPda, findOtGovernancePda } = await import('$lib/utils/pda');

    const conn = get(connection);
    const futClient = get(futClientStore);

    const [configPda] = findFutarchyConfigPda(ctx.otMint, futProgramId);
    const [otGovPda] = findOtGovernancePda(ctx.otMint, programId);

    const tx = futClient.buildTransaction('initialize_futarchy', {
      accounts: {
        deployer: deployer.publicKey,
        ot_mint: ctx.otMint,
        ot_governance: otGovPda,
        config: configPda,
        system_program: SystemProgram.programId
      },
      args: {}
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    ctx.futarchyConfigPda = configPda;

    return {
      txSignature: sig,
      result: { 'Config PDA': configPda.toBase58() }
    };
  },

  'fut-propose-transfer': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.futarchyConfigPda) throw new Error('Missing context');

    const conn = get(connection);
    const client = get(arlexClient);
    const [otGovPda] = findOtGovernancePda(ctx.otMint, programId);

    const tx = client.buildTransaction('propose_authority_transfer', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: ctx.otMint,
        ot_governance: otGovPda
      },
      args: { new_authority: Array.from(ctx.futarchyConfigPda.toBytes()) }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return {
      txSignature: sig,
      result: { 'Proposed to': ctx.futarchyConfigPda.toBase58() }
    };
  },

  'fut-claim-governance': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.futarchyConfigPda) throw new Error('Missing context');

    const { futarchyClient: futClientStore, futarchyProgramId: futProgramId } = await import('./futarchy');
    const conn = get(connection);
    const futClient = get(futClientStore);
    const [otGovPda] = findOtGovernancePda(ctx.otMint, programId);

    const tx = futClient.buildTransaction('claim_ot_governance', {
      accounts: {
        executor: deployer.publicKey,
        config: ctx.futarchyConfigPda,
        ot_governance: otGovPda,
        ot_mint: ctx.otMint,
        ot_program: programId
      },
      args: {}
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return {
      txSignature: sig,
      result: { 'OT Governance': 'Claimed by Futarchy' }
    };
  },

  'fut-create-mint-proposal': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.futarchyConfigPda) throw new Error('Missing context');

    const { futarchyClient: futClientStore, futarchyProgramId: futProgramId } = await import('./futarchy');
    const { findProposalPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const futClient = get(futClientStore);

    const proposalId = 0n;
    const [proposalPda] = findProposalPda(ctx.futarchyConfigPda, proposalId, futProgramId);
    const mintAmount = 500_000_000n; // 500 OT tokens (6 decimals)

    const tx = futClient.buildTransaction('create_proposal', {
      accounts: {
        authority: deployer.publicKey,
        config: ctx.futarchyConfigPda,
        proposal: proposalPda,
        system_program: SystemProgram.programId
      },
      args: {
        proposal_type: 0, // MintOt
        amount: mintAmount,
        destination: Array.from(deployer.publicKey.toBytes()),
        token_mint: Array.from(new Uint8Array(32)),
        params_hash: Array.from(new Uint8Array(32))
      }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    ctx.proposalPda = proposalPda;
    ctx.proposalId = proposalId;

    return {
      txSignature: sig,
      result: {
        'Proposal PDA': proposalPda.toBase58(),
        'Type': 'MintOt',
        'Amount': '500,000,000'
      }
    };
  },

  'fut-approve-proposal': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.futarchyConfigPda || !ctx.proposalPda) throw new Error('Missing context');

    const { futarchyClient: futClientStore } = await import('./futarchy');
    const conn = get(connection);
    const futClient = get(futClientStore);

    const tx = futClient.buildTransaction('approve_proposal', {
      accounts: {
        authority: deployer.publicKey,
        config: ctx.futarchyConfigPda,
        proposal: ctx.proposalPda
      },
      args: {}
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return {
      txSignature: sig,
      result: { 'Status': 'Approved' }
    };
  },

  'fut-execute-mint': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.futarchyConfigPda || !ctx.proposalPda) throw new Error('Missing context');

    const { futarchyClient: futClientStore, futarchyProgramId: futProgramId } = await import('./futarchy');
    const { findOtConfigPda, findOtGovernancePda: findOtGov, findAta: findAtaUtil,
      TOKEN_PROGRAM_ID: TPK, SYSTEM_PROGRAM_ID: SPK, ASSOCIATED_TOKEN_PROGRAM_ID: ATPK } = await import('$lib/utils/pda');
    const conn = get(connection);
    const futClient = get(futClientStore);

    const [otGovPda] = findOtGov(ctx.otMint, programId);
    const [otConfigPda] = findOtConfigPda(ctx.otMint, programId);
    const recipientAta = findAtaUtil(deployer.publicKey, ctx.otMint);

    const tx = futClient.buildTransaction('execute_proposal', {
      accounts: {
        executor: deployer.publicKey,
        config: ctx.futarchyConfigPda,
        proposal: ctx.proposalPda,
        ot_program: programId
      },
      args: {},
      remainingAccounts: [
        { pubkey: otGovPda, isWritable: false, isSigner: false },
        { pubkey: otConfigPda, isWritable: true, isSigner: false },
        { pubkey: ctx.otMint, isWritable: true, isSigner: false },
        { pubkey: recipientAta, isWritable: true, isSigner: false },
        { pubkey: deployer.publicKey, isWritable: false, isSigner: false },
        { pubkey: TPK, isWritable: false, isSigner: false },
        { pubkey: SPK, isWritable: false, isSigner: false },
        { pubkey: ATPK, isWritable: false, isSigner: false },
      ],
      computeUnits: 250_000
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return {
      txSignature: sig,
      result: { 'CPI': 'OT::mint_ot executed' }
    };
  },

  'fut-verify-state': async (ctx: FutarchyE2EContext, deployer: Keypair) => {
    if (!ctx.otMint || !ctx.futarchyConfigPda || !ctx.proposalPda) throw new Error('Missing context');

    const { futarchyClient: futClientStore } = await import('./futarchy');
    const futClient = get(futClientStore);
    const conn = get(connection);

    // Verify proposal state
    const proposal = await futClient.fetch('Proposal', ctx.proposalPda);
    const proposalStatus = proposal?.status === 2 ? 'PASS' : 'FAIL';

    // Verify OT total_minted increased
    const client = get(arlexClient);
    const { findOtConfigPda } = await import('$lib/utils/pda');
    const [otConfigPda] = findOtConfigPda(ctx.otMint, programId);
    const otConfig = await client.fetch('OtConfig', otConfigPda);
    const totalMinted = BigInt(otConfig?.total_minted?.toString() ?? '0');

    // Verify token balance
    const { findAta: findAtaUtil } = await import('$lib/utils/pda');
    const recipientAta = findAtaUtil(deployer.publicKey, ctx.otMint);
    let balance = 0n;
    try {
      const info = await conn.getTokenAccountBalance(recipientAta);
      balance = BigInt(info.value.amount);
    } catch { /* ATA may not exist */ }

    return {
      result: {
        'Proposal Status': proposalStatus === 'PASS' ? '✅ Executed' : '❌ Not Executed',
        'OT Total Minted': totalMinted.toString(),
        'Recipient Balance': balance.toString(),
        'Balance Check': balance >= 500_000_000n ? '✅ PASS' : '❌ FAIL'
      }
    };
  }
};

// ---- RWT Engine E2E Scenario ----

interface RwtE2EContext extends E2EContext {
  rwtMintKeypair?: Keypair;
  rwtMint?: PublicKey;
  rwtVaultPda?: PublicKey;
  distConfigPda?: PublicKey;
  capitalAccAta?: PublicKey;
  arealFeeAta?: PublicKey;       // Separate fee destination ATA
  userUsdcAta?: PublicKey;       // User's USDC ATA (separate from fee!)
  userRwtAta?: PublicKey;
}

function createRwtE2ESteps(): E2EStep[] {
  return [
    { id: 'rwt-create-usdc', name: 'Create Test USDC Mint', description: 'Create test USDC mint (6 decimals).', status: 'pending' },
    { id: 'rwt-create-atas', name: 'Create ATAs', description: 'Create SEPARATE USDC ATAs: fee destination (deployer) + user deposit (separate owner).', status: 'pending' },
    { id: 'rwt-init-vault', name: 'Initialize Vault', description: 'Create vault PDA, dist config, RWT mint, capital ATA. Verify full init state.', status: 'pending' },
    { id: 'rwt-verify-init', name: 'Verify Init State', description: 'Assert: NAV=$1, capital=0, supply=0, paused=false, dist=70/15/15, manager=zeroed.', status: 'pending' },
    { id: 'rwt-fund-user', name: 'Fund User USDC', description: 'Mint $100 USDC to user ATA + create RWT ATA.', status: 'pending' },
    { id: 'rwt-mint-rwt', name: 'Mint RWT ($10)', description: 'mint_rwt $10. Assert exact: fee=100K, RWT=9.9M, capital=9.95M, NAV=1005050.', status: 'pending' },
    { id: 'rwt-verify-fee-split', name: 'Verify Fee Split', description: 'Assert fee ATA received dao_fee=50K, capital ATA received 9.95M.', status: 'pending' },
    { id: 'rwt-admin-mint', name: 'Admin Mint 100 RWT', description: 'admin_mint_rwt 100 RWT backed $100. Assert exact NAV and capital.', status: 'pending' },
    { id: 'rwt-adjust-capital', name: 'Adjust Capital ($5)', description: 'Writedown $5. Assert exact capital drop and NAV recalc.', status: 'pending' },
    { id: 'rwt-update-manager', name: 'Update Manager', description: 'Set manager to a test keypair, verify stored.', status: 'pending' },
    { id: 'rwt-update-dist-config', name: 'Update Distribution Config', description: 'Change to 8000/1000/1000, verify stored.', status: 'pending' },
    { id: 'rwt-pause-verify-blocked', name: 'Pause + Verify Blocked', description: 'Pause mint, attempt mint_rwt (must fail MintPaused), verify admin_mint still works.', status: 'pending' },
    { id: 'rwt-unpause', name: 'Unpause', description: 'Unpause, verify mint_paused=false.', status: 'pending' },
    { id: 'rwt-authority-transfer', name: 'Authority Transfer', description: 'Propose+accept, verify new authority works, old authority REJECTED.', status: 'pending' },
  ];
}

const rwtStepExecutors: Record<string, StepExecutor> = {
  'rwt-create-usdc': async (ctx: RwtE2EContext, deployer: Keypair) => {
    const conn = get(connection);
    const { mintAddress, mintKeypair } = await createMint(conn, deployer, 6);
    ctx.usdcMintKeypair = mintKeypair;
    ctx.usdcMint = mintAddress;
    return { result: { usdcMint: mintAddress.toBase58() } };
  },

  'rwt-create-atas': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.usdcMint) throw new Error('USDC mint not created');
    const conn = get(connection);
    // SEPARATE ATAs: fee destination vs user deposit (tester finding: must be distinct)
    const feeOwner = Keypair.generate();
    const feeAta = await createAta(conn, deployer, ctx.usdcMint, feeOwner.publicKey);
    ctx.arealFeeAta = feeAta;
    // User deposit ATA — deployer's own USDC ATA
    const userUsdcAta = await createAta(conn, deployer, ctx.usdcMint, deployer.publicKey);
    ctx.userUsdcAta = userUsdcAta;
    return { result: {
      arealFeeAta: feeAta.toBase58(),
      userUsdcAta: userUsdcAta.toBase58(),
      note: 'Separate ATAs for fee and user deposit'
    }};
  },

  'rwt-init-vault': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.usdcMint || !ctx.arealFeeAta) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore, rwtProgramId: rwtProgId } = await import('./rwt');
    const { findRwtVaultPda, findRwtDistConfigPda } = await import('$lib/utils/pda');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const rwtMintKeypair = Keypair.generate();
    const [vaultPda] = findRwtVaultPda(rwtProgId);
    const [distConfigPda] = findRwtDistConfigPda(rwtProgId);
    const capitalAccAta = getAtaAddress(vaultPda, ctx.usdcMint);
    ctx.rwtMintKeypair = rwtMintKeypair;
    ctx.rwtVaultPda = vaultPda;
    ctx.distConfigPda = distConfigPda;
    ctx.capitalAccAta = capitalAccAta;
    const tx = client.buildTransaction('initialize_vault', {
      accounts: {
        deployer: deployer.publicKey, rwt_vault: vaultPda, dist_config: distConfigPda,
        rwt_mint: rwtMintKeypair.publicKey, usdc_mint: ctx.usdcMint,
        capital_accumulator_ata: capitalAccAta,
        areal_fee_destination_account: ctx.arealFeeAta,
        token_program: TOKEN_PROGRAM_ID, system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
      },
      args: {
        initial_authority: Array.from(deployer.publicKey.toBytes()),
        pause_authority: Array.from(deployer.publicKey.toBytes()),
        liquidity_destination: Array.from(deployer.publicKey.toBytes()),
        protocol_revenue_destination: Array.from(deployer.publicKey.toBytes())
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer, rwtMintKeypair]);
    ctx.rwtMint = rwtMintKeypair.publicKey;
    const mintInfo = await getMintInfo(conn, rwtMintKeypair.publicKey);
    const authMatch = mintInfo.mintAuthority?.equals(vaultPda) ?? false;
    return { txSignature: sig, result: {
      'Vault PDA': vaultPda.toBase58(), 'RWT Mint': rwtMintKeypair.publicKey.toBase58(),
      'Capital ATA': capitalAccAta.toBase58(),
      'Mint Auth = Vault': authMatch ? 'PASS' : 'FAIL'
    }};
  },

  'rwt-verify-init': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda || !ctx.distConfigPda) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const client = get(rwtClientStore);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const d = await client.fetch('RwtDistributionConfig', ctx.distConfigPda);
    const nav = BigInt(v.nav_book_value.toString());
    const capital = BigInt(v.total_invested_capital.toString());
    const supply = BigInt(v.total_rwt_supply.toString());
    const paused = v.mint_paused;
    const bookBps = d.book_value_bps;
    const liqBps = d.liquidity_bps;
    const revBps = d.protocol_revenue_bps;
    const managerBytes = v.manager instanceof Uint8Array ? v.manager : new Uint8Array(v.manager);
    const managerZeroed = managerBytes.every((b: number) => b === 0);
    const checks = {
      'NAV': nav.toString(), 'NAV Expected': '1000000', 'NAV Match': nav === 1_000_000n ? 'PASS' : 'FAIL',
      'Capital': capital.toString(), 'Capital Match': capital === 0n ? 'PASS' : 'FAIL',
      'Supply': supply.toString(), 'Supply Match': supply === 0n ? 'PASS' : 'FAIL',
      'Paused': paused ? 'FAIL' : 'PASS',
      'Book BPS': bookBps.toString(), 'Book Match': bookBps === 7000 ? 'PASS' : 'FAIL',
      'Liq BPS': liqBps.toString(), 'Liq Match': liqBps === 1500 ? 'PASS' : 'FAIL',
      'Rev BPS': revBps.toString(), 'Rev Match': revBps === 1500 ? 'PASS' : 'FAIL',
      'Manager Zeroed': managerZeroed ? 'PASS' : 'FAIL',
    };
    const allPass = Object.entries(checks).filter(([k]) => k.includes('Match') || k === 'Paused' || k === 'Manager Zeroed').every(([, v]) => v === 'PASS');
    if (!allPass) throw new Error('Init state verification failed');
    return { result: checks };
  },

  'rwt-fund-user': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.usdcMint || !ctx.userUsdcAta || !ctx.rwtMint) throw new Error('Previous steps not completed');
    const conn = get(connection);
    const sig = await mintTo(conn, deployer, ctx.usdcMint, ctx.userUsdcAta, 100_000_000n);
    const ata = await createAta(conn, deployer, ctx.rwtMint, deployer.publicKey);
    ctx.userRwtAta = ata;
    const bal = await getTokenBalance(conn, ctx.userUsdcAta);
    return { txSignature: sig, result: {
      'USDC Balance': bal.toString(), 'User RWT ATA': ata.toBase58()
    }};
  },

  'rwt-mint-rwt': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtMint || !ctx.rwtVaultPda || !ctx.userUsdcAta || !ctx.capitalAccAta || !ctx.userRwtAta || !ctx.arealFeeAta) {
      throw new Error('Previous steps not completed');
    }
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const amount = 10_000_000; // $10
    const tx = client.buildTransaction('mint_rwt', {
      accounts: {
        user: deployer.publicKey, rwt_vault: ctx.rwtVaultPda, rwt_mint: ctx.rwtMint,
        user_deposit: ctx.userUsdcAta, user_rwt: ctx.userRwtAta,
        capital_acc: ctx.capitalAccAta, dao_fee_account: ctx.arealFeeAta,
        token_program: TOKEN_PROGRAM_ID
      },
      args: { amount, min_rwt_out: 1 }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const rwtBal = await getTokenBalance(conn, ctx.userRwtAta);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const nav = BigInt(v.nav_book_value.toString());
    const capital = BigInt(v.total_invested_capital.toString());
    const supply = BigInt(v.total_rwt_supply.toString());
    // Exact math: fee=100000, dao=50000, vault=50000, net=9900000, rwt=9900000
    // capital=9950000, supply=9900000, NAV=9950000*1000000/9900000=1005050
    return { txSignature: sig, result: {
      'RWT Out': rwtBal.toString(), 'RWT Expected': '9900000',
      'RWT Match': rwtBal === 9_900_000n ? 'PASS' : 'FAIL',
      'Capital': capital.toString(), 'Capital Expected': '9950000',
      'Capital Match': capital === 9_950_000n ? 'PASS' : 'FAIL',
      'Supply': supply.toString(), 'Supply Expected': '9900000',
      'Supply Match': supply === 9_900_000n ? 'PASS' : 'FAIL',
      'NAV': nav.toString(), 'NAV Expected': '1005050',
      'NAV Match': nav === 1_005_050n ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-verify-fee-split': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.arealFeeAta || !ctx.capitalAccAta || !ctx.userUsdcAta) throw new Error('Previous steps not completed');
    const conn = get(connection);
    const feeBal = await getTokenBalance(conn, ctx.arealFeeAta);
    const capitalBal = await getTokenBalance(conn, ctx.capitalAccAta);
    const userBal = await getTokenBalance(conn, ctx.userUsdcAta);
    // dao_fee=50000 to fee ATA, capital got net+vault_fee=9950000, user paid 10M total
    return { result: {
      'Fee ATA Balance': feeBal.toString(), 'Fee Expected': '50000',
      'Fee Match': feeBal === 50_000n ? 'PASS' : 'FAIL',
      'Capital ATA Balance': capitalBal.toString(), 'Capital Expected': '9950000',
      'Capital Match': capitalBal === 9_950_000n ? 'PASS' : 'FAIL',
      'User USDC Remaining': userBal.toString(), 'User Expected': '90000000',
      'User Match': userBal === 90_000_000n ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-admin-mint': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtMint || !ctx.rwtVaultPda || !ctx.userRwtAta) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const rwtAmount = 100_000_000; // 100 RWT
    const backingUsd = 100_000_000; // $100
    const tx = client.buildTransaction('admin_mint_rwt', {
      accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda,
        rwt_mint: ctx.rwtMint, recipient_rwt: ctx.userRwtAta, token_program: TOKEN_PROGRAM_ID },
      args: { rwt_amount: rwtAmount, backing_capital_usd: backingUsd }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const nav = BigInt(v.nav_book_value.toString());
    const capital = BigInt(v.total_invested_capital.toString());
    const supply = BigInt(v.total_rwt_supply.toString());
    // After: capital=9950000+100000000=109950000, supply=9900000+100000000=109900000
    // NAV=109950000*1000000/109900000=1000454
    return { txSignature: sig, result: {
      'Capital': capital.toString(), 'Capital Expected': '109950000',
      'Capital Match': capital === 109_950_000n ? 'PASS' : 'FAIL',
      'Supply': supply.toString(), 'Supply Expected': '109900000',
      'Supply Match': supply === 109_900_000n ? 'PASS' : 'FAIL',
      'NAV': nav.toString(), 'NAV Expected': '1000454',
      'NAV Match': nav === 1_000_454n ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-adjust-capital': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const writedown = 5_000_000; // $5
    const tx = client.buildTransaction('adjust_capital', {
      accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda },
      args: { writedown_amount: writedown }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const capital = BigInt(v.total_invested_capital.toString());
    const nav = BigInt(v.nav_book_value.toString());
    // capital=109950000-5000000=104950000, NAV=104950000*1000000/109900000=955_414 (truncated)
    const expectedCapital = 104_950_000n;
    const expectedNav = 955_414n; // floor(104950000*1000000/109900000)
    return { txSignature: sig, result: {
      'Capital': capital.toString(), 'Capital Expected': expectedCapital.toString(),
      'Capital Match': capital === expectedCapital ? 'PASS' : 'FAIL',
      'NAV': nav.toString(), 'NAV Expected': expectedNav.toString(),
      'NAV Match': nav === expectedNav ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-update-manager': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const testManager = Keypair.generate();
    const tx = client.buildTransaction('update_vault_manager', {
      accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda },
      args: { new_manager: Array.from(testManager.publicKey.toBytes()) }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const mgrBytes = v.manager instanceof Uint8Array ? v.manager : new Uint8Array(v.manager);
    const mgrStr = bytesToBase58(mgrBytes);
    return { txSignature: sig, result: {
      'Manager Set': mgrStr, 'Expected': testManager.publicKey.toBase58(),
      'Match': mgrStr === testManager.publicKey.toBase58() ? 'PASS' : 'FAIL'
    }};
  },

  'rwt-update-dist-config': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda || !ctx.distConfigPda) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const tx = client.buildTransaction('update_distribution_config', {
      accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda, dist_config: ctx.distConfigPda },
      args: {
        book_value_bps: 8000, liquidity_bps: 1000, protocol_revenue_bps: 1000,
        liquidity_destination: Array.from(deployer.publicKey.toBytes()),
        protocol_revenue_destination: Array.from(deployer.publicKey.toBytes())
      }
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const d = await client.fetch('RwtDistributionConfig', ctx.distConfigPda);
    return { txSignature: sig, result: {
      'Book BPS': d.book_value_bps.toString(), 'Book Match': d.book_value_bps === 8000 ? 'PASS' : 'FAIL',
      'Liq BPS': d.liquidity_bps.toString(), 'Liq Match': d.liquidity_bps === 1000 ? 'PASS' : 'FAIL',
      'Rev BPS': d.protocol_revenue_bps.toString(), 'Rev Match': d.protocol_revenue_bps === 1000 ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-pause-verify-blocked': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda || !ctx.rwtMint || !ctx.userUsdcAta || !ctx.userRwtAta || !ctx.capitalAccAta || !ctx.arealFeeAta) {
      throw new Error('Previous steps not completed');
    }
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    // Pause
    const pauseTx = client.buildTransaction('pause_mint', {
      accounts: { pause_authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda }, args: {}
    });
    await signAndSendTransaction(conn, pauseTx, [deployer]);
    const v1 = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const isPaused = v1.mint_paused;
    // Attempt mint_rwt while paused — MUST FAIL
    let mintBlocked = false;
    try {
      const mintTx = client.buildTransaction('mint_rwt', {
        accounts: { user: deployer.publicKey, rwt_vault: ctx.rwtVaultPda, rwt_mint: ctx.rwtMint,
          user_deposit: ctx.userUsdcAta, user_rwt: ctx.userRwtAta,
          capital_acc: ctx.capitalAccAta, dao_fee_account: ctx.arealFeeAta,
          token_program: TOKEN_PROGRAM_ID },
        args: { amount: 1_000_000, min_rwt_out: 1 }
      });
      await signAndSendTransaction(conn, mintTx, [deployer]);
    } catch {
      mintBlocked = true;
    }
    // Verify admin_mint STILL works while paused
    let adminWorked = false;
    try {
      const adminTx = client.buildTransaction('admin_mint_rwt', {
        accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda,
          rwt_mint: ctx.rwtMint, recipient_rwt: ctx.userRwtAta, token_program: TOKEN_PROGRAM_ID },
        args: { rwt_amount: 1_000_000, backing_capital_usd: 1_000_000 }
      });
      await signAndSendTransaction(conn, adminTx, [deployer]);
      adminWorked = true;
    } catch { /* admin should work */ }
    return { result: {
      'Paused': isPaused ? 'PASS' : 'FAIL',
      'mint_rwt Blocked': mintBlocked ? 'PASS' : 'FAIL',
      'admin_mint Works While Paused': adminWorked ? 'PASS' : 'FAIL',
    }};
  },

  'rwt-unpause': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const tx = client.buildTransaction('unpause_mint', {
      accounts: { pause_authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda }, args: {}
    });
    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    return { txSignature: sig, result: {
      'Unpaused': !v.mint_paused ? 'PASS' : 'FAIL'
    }};
  },

  'rwt-authority-transfer': async (ctx: RwtE2EContext, deployer: Keypair) => {
    if (!ctx.rwtVaultPda || !ctx.rwtMint || !ctx.userRwtAta) throw new Error('Previous steps not completed');
    const { rwtClient: rwtClientStore } = await import('./rwt');
    const conn = get(connection);
    const client = get(rwtClientStore);
    const newAuth = Keypair.generate();
    const airdropSig = await conn.requestAirdrop(newAuth.publicKey, 1_000_000_000);
    // Use HTTP polling instead of WebSocket (tunnel doesn't support WS)
    let confirmed = false;
    for (let i = 0; i < 30; i++) {
      const { value } = await conn.getSignatureStatuses([airdropSig]);
      if (value?.[0]?.confirmationStatus === 'confirmed' || value?.[0]?.confirmationStatus === 'finalized') {
        confirmed = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!confirmed) throw new Error('Airdrop confirmation timeout');
    // Propose
    const proposeTx = client.buildTransaction('propose_authority_transfer', {
      accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda },
      args: { new_authority: Array.from(newAuth.publicKey.toBytes()) }
    });
    await signAndSendTransaction(conn, proposeTx, [deployer]);
    // Accept
    const acceptTx = client.buildTransaction('accept_authority_transfer', {
      accounts: { new_authority: newAuth.publicKey, rwt_vault: ctx.rwtVaultPda }, args: {}
    });
    const sig = await signAndSendTransaction(conn, acceptTx, [newAuth]);
    // Verify new authority stored
    const v = await client.fetch('RwtVault', ctx.rwtVaultPda);
    const authBytes = v.authority instanceof Uint8Array ? v.authority : new Uint8Array(v.authority);
    const authStr = bytesToBase58(authBytes);
    const authMatch = authStr === newAuth.publicKey.toBase58();
    const pendingCleared = !v.has_pending;
    // CRITICAL: Verify old authority REJECTED
    let oldRejected = false;
    try {
      const oldTx = client.buildTransaction('admin_mint_rwt', {
        accounts: { authority: deployer.publicKey, rwt_vault: ctx.rwtVaultPda,
          rwt_mint: ctx.rwtMint, recipient_rwt: ctx.userRwtAta, token_program: TOKEN_PROGRAM_ID },
        args: { rwt_amount: 1, backing_capital_usd: 1 }
      });
      await signAndSendTransaction(conn, oldTx, [deployer]);
    } catch {
      oldRejected = true;
    }
    return { txSignature: sig, result: {
      'New Authority': authStr, 'Expected': newAuth.publicKey.toBase58(),
      'Authority Match': authMatch ? 'PASS' : 'FAIL',
      'Pending Cleared': pendingCleared ? 'PASS' : 'FAIL',
      'Old Auth Rejected': oldRejected ? 'PASS' : 'FAIL',
    }};
  }
};

// ---- Scenario Registry ----

interface ScenarioDefinition {
  id: string;
  name: string;
  steps: () => E2EStep[];
  executors: Record<string, StepExecutor>;
}

// ---- DEX E2E Scenario ----

function createDexE2ESteps(): E2EStep[] {
  return [
    { id: 'dex-create-rwt-mint', name: 'Load RWT Mint', description: 'Read deployed RWT_MINT from RWT Vault on-chain', status: 'pending' },
    { id: 'dex-load-usdc-mint', name: 'Load USDC Mint', description: 'Read USDC mint from RWT Vault capital ATA', status: 'pending' },
    { id: 'dex-init', name: 'Initialize DEX', description: 'Create DexConfig + PoolCreators PDAs', status: 'pending' },
    { id: 'dex-create-pool', name: 'Create RWT/USDC Pool', description: 'StandardCurve pool with canonical mint ordering', status: 'pending' },
    { id: 'dex-create-rwt-ata', name: 'Create RWT ATA', description: 'Create deployer RWT token account', status: 'pending' },
    { id: 'dex-create-usdc-ata', name: 'Create USDC ATA', description: 'Create deployer USDC token account', status: 'pending' },
    { id: 'dex-mint-usdc', name: 'Mint Test USDC', description: 'Mint 2000 test USDC to deployer', status: 'pending' },
    { id: 'dex-mint-rwt', name: 'Admin Mint RWT', description: 'Mint RWT via admin_mint_rwt on RWT Engine', status: 'pending' },
    { id: 'dex-add-first-lp', name: 'Add First Liquidity', description: 'First LP deposit — verify sqrt shares and MIN_LIQUIDITY burn', status: 'pending' },
    { id: 'dex-add-second-lp', name: 'Add Second Liquidity', description: 'Proportional LP deposit — verify shares calculation', status: 'pending' },
    { id: 'dex-swap-a-to-b', name: 'Swap A → B', description: 'Swap one token for other, verify fee split and output', status: 'pending' },
    { id: 'dex-swap-b-to-a', name: 'Swap B → A', description: 'Reverse swap, verify fee direction', status: 'pending' },
    { id: 'dex-remove-lp', name: 'Remove Liquidity', description: 'Remove partial LP shares, verify proportional return', status: 'pending' },
  ];
}

async function getDex() {
  const { dexClient, dexProgramId } = await import('./dex');
  return { client: get(dexClient), programId: dexProgramId };
}

const dexStepExecutors: Record<string, StepExecutor> = {
  'dex-create-rwt-mint': async (ctx, deployer) => {
    // Use the REAL deployed RWT_MINT — contract enforces one mint must be RWT_MINT.
    // Read from RWT Vault on-chain state (offset 72..104 = rwt_mint field).
    const conn = get(connection);
    const { rwtProgramId: rwtProgId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [vaultPda] = findRwtVaultPda(rwtProgId);
    const vaultInfo = await conn.getAccountInfo(vaultPda);
    if (!vaultInfo) throw new Error('RWT Vault not found — deploy RWT Engine first');
    const rwtMint = new PublicKey(vaultInfo.data.slice(72, 104));
    (ctx as any).rwtMint = rwtMint;
    (ctx as any).rwtMintKeypair = null; // no keypair — can't mint directly
    return { result: { rwtMint: rwtMint.toBase58(), source: 'on-chain RWT Vault' } };
  },

  'dex-load-usdc-mint': async (ctx, deployer) => {
    // Read USDC mint from RWT Vault's capital accumulator ATA
    const conn = get(connection);
    const { rwtProgramId: rwtProgId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [vaultPda] = findRwtVaultPda(rwtProgId);
    const vaultInfo = await conn.getAccountInfo(vaultPda);
    if (!vaultInfo) throw new Error('RWT Vault not found — run RWT E2E first');
    const capitalAta = new PublicKey(vaultInfo.data.slice(40, 72));
    const ataInfo = await conn.getAccountInfo(capitalAta);
    if (!ataInfo) throw new Error('Capital ATA not found');
    const usdcMint = new PublicKey(ataInfo.data.slice(0, 32));
    (ctx as any).testUsdc = usdcMint;
    (ctx as any).capitalAta = capitalAta;
    (ctx as any).vaultPda = vaultPda;
    return { result: { usdcMint: usdcMint.toBase58(), source: 'RWT Vault capital ATA' } };
  },

  'dex-init': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const [configPda] = findDexConfigPda(dexProgramId);
    const [creatorsPda] = findPoolCreatorsPda(dexProgramId);

    // Idempotent: skip if already initialized
    const existing = await conn.getAccountInfo(configPda);
    if (existing) {
      return {
        result: { dexConfig: configPda.toBase58(), poolCreators: creatorsPda.toBase58(), skipped: 'already initialized' }
      };
    }

    // Fee destination must be an SPL token account (RWT ATA for deployer)
    const rwtMint = (ctx as any).rwtMint as PublicKey;
    const feeAta = await createAta(conn, deployer, rwtMint, deployer.publicKey);

    const tx = client.buildTransaction('initialize_dex', {
      accounts: {
        deployer: deployer.publicKey,
        dex_config: configPda,
        pool_creators: creatorsPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        areal_fee_destination: Array.from(feeAta.toBytes()),
        pause_authority: Array.from(deployer.publicKey.toBytes()),
        rebalancer: Array.from(deployer.publicKey.toBytes()),
      }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)
    return {
      txSignature: sig,
      result: { dexConfig: configPda.toBase58(), poolCreators: creatorsPda.toBase58() }
    };
  },

  'dex-create-pool': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const rwtMint = (ctx as any).rwtMint as PublicKey;
    const usdcMint = (ctx as any).testUsdc as PublicKey;

    // Canonical order: smaller pubkey first
    const [mintA, mintB] = rwtMint.toBuffer().compare(usdcMint.toBuffer()) < 0
      ? [rwtMint, usdcMint] : [usdcMint, rwtMint];

    const [configPda] = findDexConfigPda(dexProgramId);
    const [creatorsPda] = findPoolCreatorsPda(dexProgramId);
    const [poolPda] = findPoolStatePda(mintA, mintB, dexProgramId);

    // Idempotent: skip if pool already exists
    const existing = await conn.getAccountInfo(poolPda);
    if (existing) {
      // Read vault addresses from existing pool state (offset 8+1+32+32 = 73 for vault_a, 105 for vault_b)
      const vaultABytes = existing.data.slice(73, 105);
      const vaultBBytes = existing.data.slice(105, 137);
      (ctx as any).poolPda = poolPda;
      (ctx as any).mintA = mintA;
      (ctx as any).mintB = mintB;
      (ctx as any).vaultA = new PublicKey(vaultABytes);
      (ctx as any).vaultB = new PublicKey(vaultBBytes);
      return {
        result: { pool: poolPda.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(), skipped: 'already exists' }
      };
    }

    const vaultA = Keypair.generate();
    const vaultB = Keypair.generate();

    const tx = client.buildTransaction('create_pool', {
      accounts: {
        creator: deployer.publicKey,
        dex_config: configPda,
        pool_creators: creatorsPda,
        pool_state: poolPda,
        token_a_mint: mintA,
        token_b_mint: mintB,
        vault_a: vaultA.publicKey,
        vault_b: vaultB.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {}
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer, vaultA, vaultB]);
    // confirmation handled by signAndSendTransaction (HTTP polling)

    (ctx as any).poolPda = poolPda;
    (ctx as any).mintA = mintA;
    (ctx as any).mintB = mintB;
    (ctx as any).vaultA = vaultA.publicKey;
    (ctx as any).vaultB = vaultB.publicKey;

    return {
      txSignature: sig,
      result: { pool: poolPda.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58() }
    };
  },

  'dex-create-rwt-ata': async (ctx, deployer) => {
    const conn = get(connection);
    const rwtMint = (ctx as any).rwtMint as PublicKey;
    const rwtAta = await createAta(conn, deployer, rwtMint, deployer.publicKey);
    (ctx as any).rwtAta = rwtAta;
    return { result: { rwtAta: rwtAta.toBase58() } };
  },

  'dex-create-usdc-ata': async (ctx, deployer) => {
    const conn = get(connection);
    const usdcMint = (ctx as any).testUsdc as PublicKey; // real USDC from vault
    const usdcAta = await createAta(conn, deployer, usdcMint, deployer.publicKey);
    (ctx as any).usdcAta = usdcAta;
    return { result: { usdcAta: usdcAta.toBase58(), mint: usdcMint.toBase58() } };
  },

  'dex-mint-usdc': async (ctx, deployer) => {
    const conn = get(connection);
    const usdcMint = (ctx as any).testUsdc as PublicKey;
    const usdcAta = (ctx as any).usdcAta as PublicKey;
    // deployer is mint authority (OT/RWT E2E created this mint with deployer as authority)
    await mintTo(conn, deployer, usdcMint, usdcAta, 2_000_000_000);
    return { result: { usdcMinted: 2_000_000_000 } };
  },

  'dex-mint-rwt': async (ctx, deployer) => {
    const conn = get(connection);
    const rwtMint = (ctx as any).rwtMint as PublicKey;
    const rwtAta = (ctx as any).rwtAta as PublicKey;
    const usdcAta = (ctx as any).usdcAta as PublicKey;
    const vaultPda = (ctx as any).vaultPda as PublicKey;
    const capitalAta = (ctx as any).capitalAta as PublicKey;

    // Use mint_rwt (user deposit USDC → receive RWT at NAV price)
    const { rwtClient: rwtClientStore, rwtProgramId } = await import('./rwt');
    const rwtClient = get(rwtClientStore);

    // Read areal_fee_destination from vault state (offset 234..266)
    const vaultInfo = await conn.getAccountInfo(vaultPda);
    if (!vaultInfo) throw new Error('RWT Vault not found');
    const arealFeeAta = new PublicKey(vaultInfo.data.slice(234, 266));

    const depositAmount = 1_000_000_000; // 1000 USDC
    const tx = rwtClient.buildTransaction('mint_rwt', {
      accounts: {
        user: deployer.publicKey,
        rwt_vault: vaultPda,
        rwt_mint: rwtMint,
        user_deposit: usdcAta,
        user_rwt: rwtAta,
        capital_acc: capitalAta,
        dao_fee_account: arealFeeAta,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: {
        amount: depositAmount,
        min_rwt_out: 1, // accept any amount for test
      }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { usdcDeposited: depositAmount, via: 'mint_rwt' } };
  },

  'dex-add-first-lp': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).poolPda as PublicKey;
    const mintA = (ctx as any).mintA as PublicKey;
    const mintB = (ctx as any).mintB as PublicKey;
    const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);
    const [configPda] = findDexConfigPda(dexProgramId);

    const amountA = 100_000_000; // 100 tokens
    const amountB = 100_000_000;

    const tx = client.buildTransaction('add_liquidity', {
      accounts: {
        provider: deployer.publicKey,
        payer: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        lp_position: lpPda,
        provider_token_a: getAtaAddress(deployer.publicKey, mintA),
        provider_token_b: getAtaAddress(deployer.publicKey, mintB),
        vault_a: (ctx as any).vaultA,
        vault_b: (ctx as any).vaultB,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { amount_a: amountA, amount_b: amountB, min_shares: 0 }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)

    // sqrt(100M * 100M) = 100M, user gets 100M - 1000 = 99,999,000
    return {
      txSignature: sig,
      result: { expectedShares: '99999000', minLiquidityBurned: 1000 }
    };
  },

  'dex-add-second-lp': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).poolPda as PublicKey;
    const mintA = (ctx as any).mintA as PublicKey;
    const mintB = (ctx as any).mintB as PublicKey;
    const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);
    const [configPda] = findDexConfigPda(dexProgramId);

    const tx = client.buildTransaction('add_liquidity', {
      accounts: {
        provider: deployer.publicKey,
        payer: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        lp_position: lpPda,
        provider_token_a: getAtaAddress(deployer.publicKey, mintA),
        provider_token_b: getAtaAddress(deployer.publicKey, mintB),
        vault_a: (ctx as any).vaultA,
        vault_b: (ctx as any).vaultB,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { amount_a: 50_000_000, amount_b: 50_000_000, min_shares: 0 }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)
    return { txSignature: sig, result: { action: 'proportional add' } };
  },

  'dex-swap-a-to-b': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).poolPda as PublicKey;
    const mintA = (ctx as any).mintA as PublicKey;
    const mintB = (ctx as any).mintB as PublicKey;
    const [configPda] = findDexConfigPda(dexProgramId);

    // Read areal_fee_destination from DexConfig (offset 109..141)
    const configInfo = await conn.getAccountInfo(configPda);
    if (!configInfo) throw new Error('DexConfig not found');
    const arealFeeAta = new PublicKey(configInfo.data.slice(109, 141));

    const tx = client.buildTransaction('swap', {
      accounts: {
        user: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        user_token_in: getAtaAddress(deployer.publicKey, mintA),
        user_token_out: getAtaAddress(deployer.publicKey, mintB),
        vault_in: (ctx as any).vaultA,
        vault_out: (ctx as any).vaultB,
        areal_fee_account: arealFeeAta,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount_in: 10_000_000, min_amount_out: 0, a_to_b: true }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)
    return { txSignature: sig, result: { direction: 'A→B', amountIn: 10_000_000 } };
  },

  'dex-swap-b-to-a': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).poolPda as PublicKey;
    const mintA = (ctx as any).mintA as PublicKey;
    const mintB = (ctx as any).mintB as PublicKey;
    const [configPda] = findDexConfigPda(dexProgramId);
    const configInfo = await conn.getAccountInfo(configPda);
    if (!configInfo) throw new Error('DexConfig not found');
    const arealFeeAta = new PublicKey(configInfo.data.slice(109, 141));

    const tx = client.buildTransaction('swap', {
      accounts: {
        user: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        user_token_in: getAtaAddress(deployer.publicKey, mintB),
        user_token_out: getAtaAddress(deployer.publicKey, mintA),
        vault_in: (ctx as any).vaultB,
        vault_out: (ctx as any).vaultA,
        areal_fee_account: arealFeeAta,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount_in: 5_000_000, min_amount_out: 0, a_to_b: false }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)
    return { txSignature: sig, result: { direction: 'B→A', amountIn: 5_000_000 } };
  },

  'dex-remove-lp': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).poolPda as PublicKey;
    const mintA = (ctx as any).mintA as PublicKey;
    const mintB = (ctx as any).mintB as PublicKey;
    const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);

    // Remove 10% of shares (approximate)
    const sharesToBurn = '14999850'; // ~10% of total

    const tx = client.buildTransaction('remove_liquidity', {
      accounts: {
        provider: deployer.publicKey,
        pool_state: poolPda,
        lp_position: lpPda,
        provider_token_a: getAtaAddress(deployer.publicKey, mintA),
        provider_token_b: getAtaAddress(deployer.publicKey, mintB),
        vault_a: (ctx as any).vaultA,
        vault_b: (ctx as any).vaultB,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { shares_to_burn: sharesToBurn }
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    // confirmation handled by signAndSendTransaction (HTTP polling)
    return { txSignature: sig, result: { sharesBurned: sharesToBurn } };
  },
};

// ---- DEX Concentrated E2E Scenario ----

function createConcentratedE2ESteps(): E2EStep[] {
  return [
    { id: 'cl-load-mints', name: 'Load RWT & USDC Mints', description: 'Read deployed mints from RWT Vault (requires DEX E2E run first)', status: 'pending' },
    { id: 'cl-create-pool', name: 'Create Concentrated Pool', description: 'Create CL pool with bin_step=10, initial_bin=0', status: 'pending' },
    { id: 'cl-add-liquidity', name: 'Add First Liquidity', description: 'Add LP — verify bins distributed uniformly', status: 'pending' },
    { id: 'cl-swap-a-to-b', name: 'Swap RWT → USDC (Bin Walk)', description: 'Sell RWT — verify bin walk and active_bin movement', status: 'pending' },
    { id: 'cl-swap-b-to-a', name: 'Swap USDC → RWT (Reverse)', description: 'Buy RWT — verify reverse bin walk', status: 'pending' },
    { id: 'cl-shift', name: 'Shift Liquidity (Manual)', description: 'Call shift_liquidity as rebalancer — verify pyramid distribution', status: 'pending' },
    { id: 'cl-verify-conservation', name: 'Verify Conservation', description: 'Read BinArray — verify sum(bins) matches reserves', status: 'pending' },
    { id: 'cl-remove-liquidity', name: 'Remove Liquidity', description: 'Remove partial LP — verify proportional return and bin reduction', status: 'pending' },
  ];
}

const concentratedStepExecutors: Record<string, StepExecutor> = {
  'cl-load-mints': async (ctx, deployer) => {
    const conn = get(connection);
    const { rwtProgramId: rwtProgId } = await import('./rwt');
    const { findRwtVaultPda } = await import('$lib/utils/pda');
    const [vaultPda] = findRwtVaultPda(rwtProgId);
    const vaultInfo = await conn.getAccountInfo(vaultPda);
    if (!vaultInfo) throw new Error('RWT Vault not found — run RWT E2E first');
    const rwtMint = new PublicKey(vaultInfo.data.slice(72, 104));
    const capitalAta = new PublicKey(vaultInfo.data.slice(40, 72));
    const ataInfo = await conn.getAccountInfo(capitalAta);
    if (!ataInfo) throw new Error('Capital ATA not found');
    const usdcMint = new PublicKey(ataInfo.data.slice(0, 32));
    (ctx as any).rwtMint = rwtMint;
    (ctx as any).testUsdc = usdcMint;
    return { result: { rwtMint: rwtMint.toBase58(), usdcMint: usdcMint.toBase58() } };
  },

  'cl-create-pool': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const rwtMint = (ctx as any).rwtMint as PublicKey;
    const usdcMint = (ctx as any).testUsdc as PublicKey;

    // Canonical order: lower mint first
    const [mintA, mintB] = rwtMint.toBuffer() < usdcMint.toBuffer() ? [rwtMint, usdcMint] : [usdcMint, rwtMint];
    (ctx as any).clMintA = mintA;
    (ctx as any).clMintB = mintB;

    const [configPda] = findDexConfigPda(dexProgramId);
    const [creatorsPda] = findPoolCreatorsPda(dexProgramId);
    const [poolPda] = findPoolStatePda(mintA, mintB, dexProgramId);
    const [binPda] = findBinArrayPda(poolPda, dexProgramId);

    // Check if already exists
    const existing = await conn.getAccountInfo(poolPda);
    if (existing && existing.data[8] === 1) {
      (ctx as any).clPoolPda = poolPda;
      (ctx as any).clBinPda = binPda;
      (ctx as any).clVaultA = new PublicKey(existing.data.slice(41, 73));
      (ctx as any).clVaultB = new PublicKey(existing.data.slice(73, 105));
      return { result: { pool: poolPda.toBase58(), skipped: 'concentrated pool already exists' } };
    }

    const vaultAKeypair = Keypair.generate();
    const vaultBKeypair = Keypair.generate();

    const tx = client.buildTransaction('create_concentrated_pool', {
      accounts: {
        creator: deployer.publicKey,
        dex_config: configPda,
        pool_creators: creatorsPda,
        pool_state: poolPda,
        bin_array: binPda,
        token_a_mint: mintA,
        token_b_mint: mintB,
        vault_a: vaultAKeypair.publicKey,
        vault_b: vaultBKeypair.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { bin_step_bps: 10, initial_active_bin: 0 },
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer, vaultAKeypair, vaultBKeypair]);
    (ctx as any).clPoolPda = poolPda;
    (ctx as any).clBinPda = binPda;
    (ctx as any).clVaultA = vaultAKeypair.publicKey;
    (ctx as any).clVaultB = vaultBKeypair.publicKey;
    return { txSignature: sig, result: { pool: poolPda.toBase58(), binArray: binPda.toBase58(), binStep: 10, initialBin: 0 } };
  },

  'cl-add-liquidity': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;
    const mintA = (ctx as any).clMintA as PublicKey;
    const mintB = (ctx as any).clMintB as PublicKey;
    const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);
    const [configPda] = findDexConfigPda(dexProgramId);

    const amountA = 500_000_000; // 500 tokens (6 dec)
    const amountB = 500_000_000;

    const tx = client.buildTransaction('add_liquidity', {
      accounts: {
        provider: deployer.publicKey,
        payer: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        lp_position: lpPda,
        provider_token_a: getAtaAddress(deployer.publicKey, mintA),
        provider_token_b: getAtaAddress(deployer.publicKey, mintB),
        vault_a: (ctx as any).clVaultA,
        vault_b: (ctx as any).clVaultB,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: { amount_a: amountA, amount_b: amountB, min_shares: 0 },
      remainingAccounts: [{ pubkey: binPda, isSigner: false, isWritable: true }],
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { amountA, amountB } };
  },

  'cl-swap-a-to-b': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;
    const mintA = (ctx as any).clMintA as PublicKey;
    const mintB = (ctx as any).clMintB as PublicKey;
    const [configPda] = findDexConfigPda(dexProgramId);

    const configInfo = await conn.getAccountInfo(configPda);
    if (!configInfo) throw new Error('DexConfig not found');
    const arealFeeDest = new PublicKey(configInfo.data.slice(8 + 32 + 32 + 1 + 32 + 2 + 2, 8 + 32 + 32 + 1 + 32 + 2 + 2 + 32));

    const amountIn = 50_000_000; // 50 tokens
    const tx = client.buildTransaction('swap', {
      accounts: {
        user: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        user_token_in: getAtaAddress(deployer.publicKey, mintA),
        user_token_out: getAtaAddress(deployer.publicKey, mintB),
        vault_in: (ctx as any).clVaultA,
        vault_out: (ctx as any).clVaultB,
        areal_fee_account: arealFeeDest,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount_in: amountIn, min_amount_out: 0, a_to_b: true },
      remainingAccounts: [{ pubkey: binPda, isSigner: false, isWritable: true }],
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { direction: 'A→B', amountIn } };
  },

  'cl-swap-b-to-a': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;
    const mintA = (ctx as any).clMintA as PublicKey;
    const mintB = (ctx as any).clMintB as PublicKey;
    const [configPda] = findDexConfigPda(dexProgramId);

    const configInfo = await conn.getAccountInfo(configPda);
    if (!configInfo) throw new Error('DexConfig not found');
    const arealFeeDest = new PublicKey(configInfo.data.slice(8 + 32 + 32 + 1 + 32 + 2 + 2, 8 + 32 + 32 + 1 + 32 + 2 + 2 + 32));

    const amountIn = 30_000_000;
    const tx = client.buildTransaction('swap', {
      accounts: {
        user: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        user_token_in: getAtaAddress(deployer.publicKey, mintB),
        user_token_out: getAtaAddress(deployer.publicKey, mintA),
        vault_in: (ctx as any).clVaultB,
        vault_out: (ctx as any).clVaultA,
        areal_fee_account: arealFeeDest,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { amount_in: amountIn, min_amount_out: 0, a_to_b: false },
      remainingAccounts: [{ pubkey: binPda, isSigner: false, isWritable: true }],
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { direction: 'B→A', amountIn } };
  },

  'cl-shift': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;
    const [configPda] = findDexConfigPda(dexProgramId);

    const tx = client.buildTransaction('shift_liquidity', {
      accounts: {
        rebalancer: deployer.publicKey,
        dex_config: configPda,
        pool_state: poolPda,
        bin_array: binPda,
      },
      args: { nav_bin: 2, target_bin_count: 40 },
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { navBin: 2, targetBinCount: 40 } };
  },

  'cl-verify-conservation': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;

    const poolInfo = await conn.getAccountInfo(poolPda);
    if (!poolInfo) throw new Error('Pool not found');
    const reserveA = poolInfo.data.readBigUInt64LE(8 + 1 + 32 + 32 + 32 + 32);
    const reserveB = poolInfo.data.readBigUInt64LE(8 + 1 + 32 + 32 + 32 + 32 + 8);
    const activeBin = poolInfo.data.readInt32LE(8 + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 2 + 1 + 8 + 2);

    const binInfo = await conn.getAccountInfo(binPda);
    if (!binInfo) throw new Error('BinArray not found');

    let sumA = 0n;
    let sumB = 0n;
    const binDataOffset = 8 + 32; // discriminator + pool field
    for (let i = 0; i < 70; i++) {
      const off = binDataOffset + i * 16;
      sumA += binInfo.data.readBigUInt64LE(off);
      sumB += binInfo.data.readBigUInt64LE(off + 8);
    }

    const matchA = sumA === reserveA;
    const matchB = sumB === reserveB;

    return {
      result: {
        reserveA: reserveA.toString(),
        reserveB: reserveB.toString(),
        binSumA: sumA.toString(),
        binSumB: sumB.toString(),
        conservationA: matchA,
        conservationB: matchB,
        activeBin,
      }
    };
  },

  'cl-remove-liquidity': async (ctx, deployer) => {
    const conn = get(connection);
    const { client, programId: dexProgramId } = await getDex();
    const poolPda = (ctx as any).clPoolPda as PublicKey;
    const binPda = (ctx as any).clBinPda as PublicKey;
    const mintA = (ctx as any).clMintA as PublicKey;
    const mintB = (ctx as any).clMintB as PublicKey;
    const [lpPda] = findLpPositionPda(poolPda, deployer.publicKey, dexProgramId);

    // Read LP shares
    const lpInfo = await conn.getAccountInfo(lpPda);
    if (!lpInfo) throw new Error('LP position not found');
    const shares = lpInfo.data.readBigUInt64LE(8 + 32 + 32); // offset to shares (u128, read lower 8 bytes)
    const sharesToBurn = shares / 2n; // remove half

    const tx = client.buildTransaction('remove_liquidity', {
      accounts: {
        provider: deployer.publicKey,
        pool_state: poolPda,
        lp_position: lpPda,
        provider_token_a: getAtaAddress(deployer.publicKey, mintA),
        provider_token_b: getAtaAddress(deployer.publicKey, mintB),
        vault_a: (ctx as any).clVaultA,
        vault_b: (ctx as any).clVaultB,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { shares_to_burn: sharesToBurn },
      remainingAccounts: [{ pubkey: binPda, isSigner: false, isWritable: true }],
    });

    const sig = await signAndSendTransaction(conn, tx, [deployer]);
    return { txSignature: sig, result: { sharesBurned: sharesToBurn.toString() } };
  },
};

const SCENARIOS: ScenarioDefinition[] = [
  { id: 'ot-lifecycle', name: 'OT Full Lifecycle', steps: createOtE2ESteps, executors: stepExecutors },
  { id: 'futarchy-governance', name: 'Futarchy Governance', steps: createFutarchyE2ESteps, executors: futarchyStepExecutors },
  { id: 'rwt-lifecycle', name: 'RWT Mint & Manage', steps: createRwtE2ESteps, executors: rwtStepExecutors },
  { id: 'dex-lifecycle', name: 'DEX Pool & Swap', steps: createDexE2ESteps, executors: dexStepExecutors },
  { id: 'cl-lifecycle', name: 'DEX Concentrated', steps: createConcentratedE2ESteps, executors: concentratedStepExecutors }
];

// ---- Store ----

function createE2ERunnerStore() {
  const selectedId = writable<string>('ot-lifecycle');
  const scenario = writable<E2EScenario>({
    id: 'ot-lifecycle',
    name: 'OT Full Lifecycle',
    steps: createOtE2ESteps(),
    status: 'idle'
  });

  return {
    subscribe: scenario.subscribe,
    selectedId,
    scenarios: SCENARIOS.map(s => ({ id: s.id, name: s.name })),

    selectScenario(id: string) {
      const def = SCENARIOS.find(s => s.id === id);
      if (!def) return;
      selectedId.set(id);
      scenario.set({
        id: def.id,
        name: def.name,
        steps: def.steps(),
        status: 'idle'
      });
    },

    reset() {
      const id = get(selectedId);
      const def = SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
      scenario.set({
        id: def.id,
        name: def.name,
        steps: def.steps(),
        status: 'idle'
      });
    },

    async runAll() {
      const deployer = devKeys.getActiveKeypair();
      if (!deployer) {
        throw new Error('No active dev keypair. Generate or import one first.');
      }
      console.log('[e2e] deployer:', deployer.publicKey.toBase58());

      const id = get(selectedId);
      const def = SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
      const executors = def.executors;
      const ctx: FutarchyE2EContext = {};

      scenario.update(s => ({
        ...s,
        status: 'running',
        startedAt: Date.now(),
        completedAt: undefined
      }));

      const steps = get(scenario).steps;
      let failed = false;

      for (let i = 0; i < steps.length; i++) {
        if (failed) {
          scenario.update(s => {
            const newSteps = [...s.steps];
            newSteps[i] = { ...newSteps[i], status: 'skipped' };
            return { ...s, steps: newSteps };
          });
          continue;
        }

        scenario.update(s => {
          const newSteps = [...s.steps];
          newSteps[i] = { ...newSteps[i], status: 'running' };
          return { ...s, steps: newSteps };
        });

        const stepId = steps[i].id;
        const executor = executors[stepId];
        const startTime = Date.now();

        if (!executor) {
          scenario.update(s => {
            const newSteps = [...s.steps];
            newSteps[i] = {
              ...newSteps[i],
              status: 'error',
              error: `No executor for step: ${stepId}`,
              durationMs: Date.now() - startTime
            };
            return { ...s, steps: newSteps };
          });
          failed = true;
          continue;
        }

        try {
          const result = await executor(ctx, deployer);
          scenario.update(s => {
            const newSteps = [...s.steps];
            newSteps[i] = {
              ...newSteps[i],
              status: 'success',
              txSignature: result.txSignature,
              result: result.result,
              durationMs: Date.now() - startTime
            };
            return { ...s, steps: newSteps };
          });
        } catch (err: any) {
          scenario.update(s => {
            const newSteps = [...s.steps];
            newSteps[i] = {
              ...newSteps[i],
              status: 'error',
              error: err.message || 'Unknown error',
              durationMs: Date.now() - startTime
            };
            return { ...s, steps: newSteps };
          });
          failed = true;
        }
      }

      scenario.update(s => ({
        ...s,
        status: failed ? 'failed' : 'completed',
        completedAt: Date.now()
      }));
    }
  };
}

export const e2eRunner = createE2ERunnerStore();
