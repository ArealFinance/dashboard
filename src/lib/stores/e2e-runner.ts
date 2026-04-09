import { writable, get } from 'svelte/store';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { connection } from './network';
import { devKeys } from './devkeys';
import { arlexClient, programId } from './ot';
import {
  findOtConfigPda,
  findRevenueAccountPda,
  findRevenueConfigPda,
  findOtGovernancePda,
  findOtTreasuryPda,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID
} from '$lib/utils/pda';
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

    const sig = await client.execute('initialize_ot', {
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
    }, deployer);

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

    const sig = await client.execute('batch_update_destinations', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: ctx.otMint,
        ot_governance: ctx.otGovernancePda,
        revenue_config: ctx.revenueConfigPda
      },
      args: {
        destinations
      }
    }, deployer);

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

    const sig = await client.execute('distribute_revenue', {
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
    }, deployer);

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

    const sig = await client.execute('mint_ot', {
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
    }, deployer);

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
    const sig = await client.execute('spend_treasury', {
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
    }, deployer);

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

// ---- Store ----

function createE2ERunnerStore() {
  const scenario = writable<E2EScenario>({
    id: 'ot-lifecycle',
    name: 'OT Full Lifecycle',
    steps: createOtE2ESteps(),
    status: 'idle'
  });

  return {
    subscribe: scenario.subscribe,

    reset() {
      scenario.set({
        id: 'ot-lifecycle',
        name: 'OT Full Lifecycle',
        steps: createOtE2ESteps(),
        status: 'idle'
      });
    },

    async runAll() {
      const deployer = devKeys.getActiveKeypair();
      if (!deployer) {
        throw new Error('No active dev keypair. Generate or import one first.');
      }

      const ctx: E2EContext = {};

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

        // Mark as running
        scenario.update(s => {
          const newSteps = [...s.steps];
          newSteps[i] = { ...newSteps[i], status: 'running' };
          return { ...s, steps: newSteps };
        });

        const stepId = steps[i].id;
        const executor = stepExecutors[stepId];
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
