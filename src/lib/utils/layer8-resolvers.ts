/**
 * Layer 8 resolver chains.
 *
 * Pure async functions that read on-chain account state via a `Connection`
 * and assemble the full account-set required by each Layer 8 manual TX
 * builder (`buildConvertToRwtIx`, `buildRwtClaimYieldIx`, `buildDexCompoundIx`,
 * `buildOtTreasuryClaimIx`, `buildWithdrawLiquidityHoldingIx`).
 *
 * Resolvers are split out from page components so they can be unit-tested
 * with a mocked `getAccountInfo`/`fetch` surface without needing a Solana
 * test validator. They throw `Error` with a clear message on missing /
 * malformed state — the modal surfaces these errors before the user pays
 * the TX fee.
 *
 * Layer 9 Substep 11 (Layer 8 D1 manual TX live wire). All account orderings
 * pinned to the Rust handlers in:
 *   - contracts/yield-distribution/src/instructions/{convert_to_rwt,withdraw_liquidity_holding,claim}.rs
 *   - contracts/rwt-engine/src/instructions/claim_yield.rs
 *   - contracts/native-dex/src/instructions/compound_yield.rs
 *   - contracts/ownership-token/src/instructions/claim_yd_for_treasury.rs
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  readDistributionConfig,
  readMerkleDistributor,
  readRwtVault,
  readRwtDistributionConfig,
  type DistributionConfigState,
  type MerkleDistributorState,
  type RwtVaultState,
  type RwtDistributionConfigState,
} from '$lib/api/layer8';
import {
  findAta,
  findClaimStatusPda,
  findLiquidityHoldingPda,
  findLiquidityNexusPda,
  findMerkleDistributorPda,
  findOtTreasuryPda,
  findPoolStatePda,
  findRwtDistConfigPda,
  findRwtVaultPda,
  findYdAccumulatorPda,
  findYdConfigPda,
} from '$lib/utils/pda';

/**
 * Program-ID bundle the resolvers depend on. Caller passes program IDs from
 * the existing svelte stores (yd / rwt / dex / ot).
 */
export interface Layer8Programs {
  ydProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  dexProgramId: PublicKey;
  otProgramId: PublicKey;
}

// ----------------------------------------------------------------------------
// Helper: pick the (in, out) vault pair on the master RWT/USDC pool.
// ----------------------------------------------------------------------------

export interface PoolDirection {
  /** Pool's vault on the input side (USDC for the convert flow). */
  vaultIn: PublicKey;
  /** Pool's vault on the output side (RWT for the convert flow). */
  vaultOut: PublicKey;
  /** True when USDC == token_a (swap A→B), false otherwise. */
  aToB: boolean;
}

/**
 * Determine the (in, out) vault assignment for a USDC→RWT swap on the master
 * RWT/USDC pool.
 *
 * The on-chain handler (`convert_to_rwt.rs:296-299`) computes
 * `a_to_b = pool.token_a == USDC`. We mirror the same logic here so the
 * dashboard always supplies the correct `dex_pool_vault_in` / `vault_out`
 * pair regardless of token-mint canonical ordering.
 *
 * Throws when neither pool side is USDC (the pool can't host a USDC→RWT swap).
 */
export function selectMasterPoolDirection(
  pool: { tokenAMint: string; tokenBMint: string; vaultA: string; vaultB: string },
  usdcMint: PublicKey,
): PoolDirection {
  const usdc = usdcMint.toBase58();
  if (pool.tokenAMint === usdc) {
    return {
      vaultIn: new PublicKey(pool.vaultA),
      vaultOut: new PublicKey(pool.vaultB),
      aToB: true,
    };
  }
  if (pool.tokenBMint === usdc) {
    return {
      vaultIn: new PublicKey(pool.vaultB),
      vaultOut: new PublicKey(pool.vaultA),
      aToB: false,
    };
  }
  throw new Error(
    `Master pool has no USDC side (token_a=${pool.tokenAMint}, token_b=${pool.tokenBMint})`,
  );
}

// ----------------------------------------------------------------------------
// Resolver 1: convert_to_rwt account set
// ----------------------------------------------------------------------------

export interface ConvertAccountSet {
  config: PublicKey;
  distributor: PublicKey;
  otMint: PublicKey;
  accumulator: PublicKey;
  accumulatorUsdcAta: PublicKey;
  accumulatorRwtAta: PublicKey;
  feeAccount: PublicKey;
  rewardVault: PublicKey;
  rwtMint: PublicKey;
  dexConfig: PublicKey;
  poolState: PublicKey;
  dexPoolVaultIn: PublicKey;
  dexPoolVaultOut: PublicKey;
  dexArealFeeAccount: PublicKey;
  rwtVault: PublicKey;
  rwtCapitalAcc: PublicKey;
  rwtDaoFeeAccount: PublicKey;
  /** Direction recorded for caller's reference / event display. */
  aToB: boolean;
  /** Min-distribution gate from DistributionConfig (callers must enforce). */
  minDistributionAmount: bigint;
}

/**
 * Resolve every dynamic account for `YD::convert_to_rwt` (22-account ix).
 *
 * Order of operations:
 *   1. Read YD `DistributionConfig` → `arealFeeDestination` (= fee_account).
 *   2. Read `MerkleDistributor` → `rewardVault`.
 *   3. Read `RwtVault` → `rwtMint`, `capitalAccumulatorAta`, `arealFeeDestination`
 *      (= rwtDaoFeeAccount per SD-22 dual-role).
 *   4. Read DEX `PoolState` (caller pre-fetched via `dexStore.refreshPool`)
 *      and pick (vaultIn, vaultOut, aToB) using {@link selectMasterPoolDirection}.
 *   5. Derive Accumulator USDC + RWT ATAs.
 *
 * @param dexConfig          DEX config PDA (caller pre-derived).
 * @param dexArealFeeAccount DEX areal-fee destination (from DexConfig).
 * @param masterPool         Pre-fetched master RWT/USDC pool state (token_a/b mints + vaults).
 * @throws on any missing / un-initialized state, or a non-USDC master pool.
 */
export async function resolveConvertAccounts(
  connection: Connection,
  programs: Layer8Programs,
  otMint: PublicKey,
  usdcMint: PublicKey,
  rwtUsdcPool: PublicKey,
  dexConfig: PublicKey,
  dexArealFeeAccount: PublicKey,
  masterPool: { tokenAMint: string; tokenBMint: string; vaultA: string; vaultB: string },
): Promise<ConvertAccountSet> {
  const { ydProgramId, rwtEngineProgramId } = programs;

  // 1. YD config — fee destination is `areal_fee_destination` (RWT ATA).
  const [ydConfigPda] = findYdConfigPda(ydProgramId);
  const ydConfig = await readDistributionConfig(connection, ydConfigPda);
  if (!ydConfig) {
    throw new Error('YD DistributionConfig not initialized — run YD setup first');
  }

  // 2. MerkleDistributor — supplies reward_vault.
  const [distributorPda] = findMerkleDistributorPda(ydProgramId, otMint);
  const distributor = await readMerkleDistributor(connection, distributorPda);
  if (!distributor) {
    throw new Error(`MerkleDistributor for OT ${otMint.toBase58()} not initialized`);
  }

  // 3. RwtVault — supplies rwt_mint, capital_accumulator_ata, dao_fee_account.
  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);
  const rwtVault = await readRwtVault(connection, rwtVaultPda);
  if (!rwtVault) {
    throw new Error('RwtVault not initialized — run RWT Engine setup first');
  }

  // 4. Master pool direction.
  const direction = selectMasterPoolDirection(masterPool, usdcMint);

  // 5. Accumulator + ATAs.
  const [accumulatorPda] = findYdAccumulatorPda(ydProgramId, otMint);
  const accumulatorUsdcAta = findAta(accumulatorPda, usdcMint);
  const accumulatorRwtAta = findAta(accumulatorPda, new PublicKey(rwtVault.rwtMint));

  return {
    config: ydConfigPda,
    distributor: distributorPda,
    otMint,
    accumulator: accumulatorPda,
    accumulatorUsdcAta,
    accumulatorRwtAta,
    feeAccount: new PublicKey(ydConfig.arealFeeDestination),
    rewardVault: new PublicKey(distributor.rewardVault),
    rwtMint: new PublicKey(rwtVault.rwtMint),
    dexConfig,
    poolState: rwtUsdcPool,
    dexPoolVaultIn: direction.vaultIn,
    dexPoolVaultOut: direction.vaultOut,
    dexArealFeeAccount,
    rwtVault: rwtVaultPda,
    rwtCapitalAcc: new PublicKey(rwtVault.capitalAccumulatorAta),
    // SD-22: dao_fee_account == areal_fee_destination on the contract layout.
    rwtDaoFeeAccount: new PublicKey(rwtVault.arealFeeDestination),
    aToB: direction.aToB,
    minDistributionAmount: ydConfig.minDistributionAmount,
  };
}

// ----------------------------------------------------------------------------
// Resolver 2: RWT::claim_yield account set
// ----------------------------------------------------------------------------

export interface RwtClaimAccountSet {
  rwtVault: PublicKey;
  distConfig: PublicKey;
  rwtClaimAta: PublicKey;
  liquidityDest: PublicKey;
  protocolRevenueDest: PublicKey;
  ydConfig: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;
  /** Vesting fields surfaced for SD-24 progress display. */
  vesting: {
    lockedVested: bigint;
    maxTotalClaim: bigint;
    totalFunded: bigint;
    totalClaimed: bigint;
  };
  /** Distributor's current merkle-root epoch — sec M-2 staleness gate. */
  distributorEpoch: bigint;
  /** Already-claimed cumulative on this distributor for the rwtVault claimant (caller pre-fetches via getAccountInfo on claimStatus). Always 0 here — caller computes if needed. */
  claimantBytes: Uint8Array;
}

/**
 * Resolve the 13-account set for `RWT::claim_yield`.
 *
 * Distinct from compound/treasury: claimant = RwtVault PDA, claim_status keys
 * (distributor, rwt_vault). Caller fetches the proof separately via
 * `fetchMerkleProof` and feeds (cumulativeAmount, proof) to the builder.
 */
export async function resolveRwtClaimAccounts(
  connection: Connection,
  programs: Layer8Programs,
  otMint: PublicKey,
): Promise<RwtClaimAccountSet> {
  const { ydProgramId, rwtEngineProgramId } = programs;

  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);
  const rwtVault = await readRwtVault(connection, rwtVaultPda);
  if (!rwtVault) {
    throw new Error('RwtVault not initialized — run RWT Engine setup first');
  }

  const [distConfigPda] = findRwtDistConfigPda(rwtEngineProgramId);
  const distConfig = await readRwtDistributionConfig(connection, distConfigPda);
  if (!distConfig) {
    throw new Error('RWT DistributionConfig not initialized');
  }

  const rwtClaimAta = findAta(rwtVaultPda, new PublicKey(rwtVault.rwtMint));

  const [ydConfigPda] = findYdConfigPda(ydProgramId);
  const [ydDistributorPda] = findMerkleDistributorPda(ydProgramId, otMint);
  const ydDistributor = await readMerkleDistributor(connection, ydDistributorPda);
  if (!ydDistributor) {
    throw new Error(`MerkleDistributor for OT ${otMint.toBase58()} not initialized`);
  }

  const [ydClaimStatusPda] = findClaimStatusPda(
    ydProgramId,
    ydDistributorPda,
    rwtVaultPda,
  );

  return {
    rwtVault: rwtVaultPda,
    distConfig: distConfigPda,
    rwtClaimAta,
    liquidityDest: new PublicKey(distConfig.liquidityDestination),
    protocolRevenueDest: new PublicKey(distConfig.protocolRevenueDestination),
    ydConfig: ydConfigPda,
    ydDistributor: ydDistributorPda,
    ydClaimStatus: ydClaimStatusPda,
    ydRewardVault: new PublicKey(ydDistributor.rewardVault),
    vesting: {
      lockedVested: ydDistributor.lockedVested,
      maxTotalClaim: ydDistributor.maxTotalClaim,
      totalFunded: ydDistributor.totalFunded,
      totalClaimed: ydDistributor.totalClaimed,
    },
    distributorEpoch: ydDistributor.epoch,
    claimantBytes: rwtVaultPda.toBytes(),
  };
}

// ----------------------------------------------------------------------------
// Resolver 3: DEX::compound_yield account set
// ----------------------------------------------------------------------------

export interface DexCompoundAccountSet {
  poolState: PublicKey;
  /** RWT side of the pool (`vault_a` if token_a == RWT, else `vault_b`). */
  targetVault: PublicKey;
  ydConfig: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;
  vesting: {
    lockedVested: bigint;
    maxTotalClaim: bigint;
    totalFunded: bigint;
    totalClaimed: bigint;
  };
  /** Distributor's current merkle-root epoch — sec M-2 staleness gate. */
  distributorEpoch: bigint;
}

/**
 * Resolve the 11-account set for `DEX::compound_yield`.
 *
 * Auto-detects the RWT side of the pool: target_vault = vault_a if token_a is
 * RWT, else vault_b. Throws if neither side is RWT (caller forwarded a
 * non-RWT pool to the wrapper).
 *
 * Substep 11 LOW-2: the resolver now self-reads RwtVault to derive the RWT
 * mint internally. Previous signature required callers to pre-fetch + pass
 * `rwtMint`, which duplicated the read at every call site (and made it easy
 * to pass a stale mint if the vault rotated). Self-read keeps the resolver
 * the single owner of "what is RWT for this cluster?".
 */
export async function resolveDexCompoundAccounts(
  connection: Connection,
  programs: Layer8Programs,
  otMint: PublicKey,
  pool: { pda: string; tokenAMint: string; tokenBMint: string; vaultA: string; vaultB: string },
): Promise<DexCompoundAccountSet> {
  const { ydProgramId, rwtEngineProgramId } = programs;

  // LOW-2: self-read RwtVault to derive RWT mint.
  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);
  const rwtVault = await readRwtVault(connection, rwtVaultPda);
  if (!rwtVault) {
    throw new Error('RwtVault not initialized — RWT mint required to pick pool side');
  }
  const rwtMint = new PublicKey(rwtVault.rwtMint);

  const rwt = rwtMint.toBase58();
  let targetVault: PublicKey;
  if (pool.tokenAMint === rwt) {
    targetVault = new PublicKey(pool.vaultA);
  } else if (pool.tokenBMint === rwt) {
    targetVault = new PublicKey(pool.vaultB);
  } else {
    throw new Error(
      `Pool ${pool.pda} has no RWT side — compound_yield requires an RWT/* pool`,
    );
  }

  const poolPda = new PublicKey(pool.pda);
  const [ydConfigPda] = findYdConfigPda(ydProgramId);
  const [ydDistributorPda] = findMerkleDistributorPda(ydProgramId, otMint);
  const ydDistributor = await readMerkleDistributor(connection, ydDistributorPda);
  if (!ydDistributor) {
    throw new Error(`MerkleDistributor for OT ${otMint.toBase58()} not initialized`);
  }
  const [ydClaimStatusPda] = findClaimStatusPda(
    ydProgramId,
    ydDistributorPda,
    poolPda,
  );

  return {
    poolState: poolPda,
    targetVault,
    ydConfig: ydConfigPda,
    ydDistributor: ydDistributorPda,
    ydClaimStatus: ydClaimStatusPda,
    ydRewardVault: new PublicKey(ydDistributor.rewardVault),
    vesting: {
      lockedVested: ydDistributor.lockedVested,
      maxTotalClaim: ydDistributor.maxTotalClaim,
      totalFunded: ydDistributor.totalFunded,
      totalClaimed: ydDistributor.totalClaimed,
    },
    distributorEpoch: ydDistributor.epoch,
  };
}

// ----------------------------------------------------------------------------
// Resolver 4: OT::claim_yd_for_treasury account set
// ----------------------------------------------------------------------------

export interface OtTreasuryClaimAccountSet {
  otMint: PublicKey;
  otTreasury: PublicKey;
  treasuryRwtAta: PublicKey;
  ydConfig: PublicKey;
  ydOtMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;
  vesting: {
    lockedVested: bigint;
    maxTotalClaim: bigint;
    totalFunded: bigint;
    totalClaimed: bigint;
  };
  /** Distributor's current merkle-root epoch — sec M-2 staleness gate. */
  distributorEpoch: bigint;
}

/**
 * Resolve the 12-account set for `OT::claim_yd_for_treasury`.
 *
 * The OT pulls yield from a YD distributor identified by `ydOtMint`
 * (typically the SAME OT mint, but distinct fields keep the dual-key
 * possibility open for future wrapper distributors).
 *
 * Substep 11 LOW-2: self-reads RwtVault internally — see
 * resolveDexCompoundAccounts for rationale.
 */
export async function resolveTreasuryClaimAccounts(
  connection: Connection,
  programs: Layer8Programs,
  otMint: PublicKey,
  ydOtMint: PublicKey,
): Promise<OtTreasuryClaimAccountSet> {
  const { ydProgramId, rwtEngineProgramId, otProgramId } = programs;

  // LOW-2: self-read RwtVault to derive RWT mint.
  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);
  const rwtVault = await readRwtVault(connection, rwtVaultPda);
  if (!rwtVault) {
    throw new Error('RwtVault not initialized — RWT mint required for treasury ATA');
  }
  const rwtMint = new PublicKey(rwtVault.rwtMint);

  const [otTreasuryPda] = findOtTreasuryPda(otMint, otProgramId);
  const treasuryRwtAta = findAta(otTreasuryPda, rwtMint);

  const [ydConfigPda] = findYdConfigPda(ydProgramId);
  const [ydDistributorPda] = findMerkleDistributorPda(ydProgramId, ydOtMint);
  const ydDistributor = await readMerkleDistributor(connection, ydDistributorPda);
  if (!ydDistributor) {
    throw new Error(
      `MerkleDistributor for YD OT mint ${ydOtMint.toBase58()} not initialized`,
    );
  }
  const [ydClaimStatusPda] = findClaimStatusPda(
    ydProgramId,
    ydDistributorPda,
    otTreasuryPda,
  );

  return {
    otMint,
    otTreasury: otTreasuryPda,
    treasuryRwtAta,
    ydConfig: ydConfigPda,
    ydOtMint,
    ydDistributor: ydDistributorPda,
    ydClaimStatus: ydClaimStatusPda,
    ydRewardVault: new PublicKey(ydDistributor.rewardVault),
    vesting: {
      lockedVested: ydDistributor.lockedVested,
      maxTotalClaim: ydDistributor.maxTotalClaim,
      totalFunded: ydDistributor.totalFunded,
      totalClaimed: ydDistributor.totalClaimed,
    },
    distributorEpoch: ydDistributor.epoch,
  };
}

// ----------------------------------------------------------------------------
// Resolver 5: YD::withdraw_liquidity_holding account set
// ----------------------------------------------------------------------------

export interface WithdrawLiquidityHoldingAccountSet {
  config: PublicKey;
  liquidityHolding: PublicKey;
  liquidityHoldingAta: PublicKey;
  nexusTokenAta: PublicKey;
  liquidityNexus: PublicKey;
  dexProgram: PublicKey;
  /** SD-18 advisory: the on-chain authority pinned by DistributionConfig. */
  expectedAuthority: PublicKey;
}

/**
 * Resolve the 9-account set for `YD::withdraw_liquidity_holding`.
 *
 * Reads YD config (for authority pin + areal fee dest) and RwtVault (for
 * RWT mint) to derive the source/destination ATAs. Caller compares
 * `wallet.publicKey` against `expectedAuthority` for the SD-18 advisory
 * lock-icon hint; on-chain `has_one = authority` enforces.
 */
export async function resolveWithdrawLiquidityHoldingAccounts(
  connection: Connection,
  programs: Layer8Programs,
): Promise<WithdrawLiquidityHoldingAccountSet> {
  const { ydProgramId, rwtEngineProgramId, dexProgramId } = programs;

  const [ydConfigPda] = findYdConfigPda(ydProgramId);
  const ydConfig = await readDistributionConfig(connection, ydConfigPda);
  if (!ydConfig) {
    throw new Error('YD DistributionConfig not initialized');
  }

  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);
  const rwtVault = await readRwtVault(connection, rwtVaultPda);
  if (!rwtVault) {
    throw new Error('RwtVault not initialized — RWT mint is required to derive ATAs');
  }
  const rwtMint = new PublicKey(rwtVault.rwtMint);

  const [liquidityHoldingPda] = findLiquidityHoldingPda(ydProgramId);
  const liquidityHoldingAta = findAta(liquidityHoldingPda, rwtMint);

  const [liquidityNexusPda] = findLiquidityNexusPda(dexProgramId);
  const nexusTokenAta = findAta(liquidityNexusPda, rwtMint);

  return {
    config: ydConfigPda,
    liquidityHolding: liquidityHoldingPda,
    liquidityHoldingAta,
    nexusTokenAta,
    liquidityNexus: liquidityNexusPda,
    dexProgram: dexProgramId,
    expectedAuthority: new PublicKey(ydConfig.authority),
  };
}

// ----------------------------------------------------------------------------
// Helper: resolve the master RWT/USDC pool PDA.
// ----------------------------------------------------------------------------

/**
 * Resolve the master RWT/USDC pool PDA.
 *
 * SD-21 / D5 plan: read `PUBLIC_RWT_USDC_POOL` env var when set; fall back
 * to deriving the pool PDA from the canonical (RWT, USDC) seed pair.
 *
 * Mainnet behavior: callers SHOULD pass the env var; the auto-derive path
 * still works because pool seeds are deterministic, but having an explicit
 * override is safer for cluster-specific master-pool wiring.
 *
 * @param envOverride PUBLIC_RWT_USDC_POOL value (or undefined).
 * @param rwtMint     RWT mint pubkey.
 * @param usdcMint    USDC mint pubkey.
 * @param dexProgramId DEX program id.
 * @param network     Cluster the dashboard is configured for. On mainnet the
 *                    env override is REQUIRED — silent canonical-PDA fallback
 *                    would risk targeting a non-deployed master pool.
 */
export function resolveRwtUsdcMasterPool(
  envOverride: string | undefined,
  rwtMint: PublicKey,
  usdcMint: PublicKey,
  dexProgramId: PublicKey,
  network?: string,
): PublicKey {
  if (envOverride && envOverride.trim().length > 0) {
    try {
      return new PublicKey(envOverride.trim());
    } catch {
      throw new Error(
        `PUBLIC_RWT_USDC_POOL is set but not a valid base58 pubkey: ${envOverride}`,
      );
    }
  }
  // Mainnet branch: canonical-PDA fallback is unsafe — the deployed master
  // pool may differ from the canonically-derived address (e.g. after a
  // redeploy). Force operators to set the env explicitly.
  if (network === 'mainnet') {
    throw new Error(
      'PUBLIC_RWT_USDC_POOL is required on mainnet — set it to the deployed master-pool PDA. See .env.example.',
    );
  }
  // Devnet / staging: canonical token order — pubkey-bytes lexicographic ascending.
  const a = rwtMint.toBuffer();
  const b = usdcMint.toBuffer();
  const cmp = Buffer.compare(a, b);
  const [tokenA, tokenB] = cmp <= 0 ? [rwtMint, usdcMint] : [usdcMint, rwtMint];
  const [poolPda] = findPoolStatePda(tokenA, tokenB, dexProgramId);
  return poolPda;
}

// ----------------------------------------------------------------------------
// Helper: read ClaimStatus.cumulative for already-claimed gating.
// ----------------------------------------------------------------------------

/**
 * Read the `claimed_amount` field from a `ClaimStatus` PDA. Returns 0n if the
 * PDA does not exist (no prior claim).
 *
 * `ClaimStatus` layout (`yield-distribution/state.rs`):
 *   discriminator [8] | claimant [32] | distributor [32] | claimed_amount u64 | bump u8
 * = 8 + 73 = 81 bytes. claimed_amount lives at body-offset 64 (after the two
 * pubkeys).
 */
export async function readClaimStatusCumulative(
  connection: Connection,
  claimStatusPda: PublicKey,
): Promise<bigint> {
  let info;
  try {
    info = await connection.getAccountInfo(claimStatusPda, 'confirmed');
  } catch {
    return 0n;
  }
  if (!info) return 0n;
  // 8 (disc) + 64 (two pubkeys) + 8 (u64) = 80 bytes minimum.
  if (info.data.length < 80) return 0n;
  const view = new DataView(
    info.data.buffer,
    info.data.byteOffset + 8 + 64,
    8,
  );
  return view.getBigUint64(0, true);
}

// ----------------------------------------------------------------------------
// Re-export commonly-pulled types for convenience.
// ----------------------------------------------------------------------------

export type {
  DistributionConfigState,
  MerkleDistributorState,
  RwtVaultState,
  RwtDistributionConfigState,
};
