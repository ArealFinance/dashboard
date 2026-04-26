/**
 * Browser-side Layer 8 instruction builders.
 *
 * Mirrors the Node-only helpers in
 * `bots/convert-and-fund-crank/src/convert.ts` and
 * `bots/yield-claim-crank/src/claim-builders.ts` — but without the
 * `node:crypto` import (Web Crypto SubtleCrypto + Uint8Array buffers
 * everywhere).
 *
 * Each builder returns one or more `TransactionInstruction`s so the dashboard
 * can wrap them in a wallet-signed transaction via `sendWalletTransaction`.
 *
 * Account orderings are taken verbatim from the on-chain handlers and pinned
 * in unit tests against the discriminator constants.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { hexToBytes } from '$lib/utils/merkle';

export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

// -----------------------------------------------------------------------------
// Discriminators (sha256("global:<ix>")[..8]) computed lazily
// -----------------------------------------------------------------------------

const discCache = new Map<string, Uint8Array>();

async function discriminator(name: string): Promise<Uint8Array> {
  const existing = discCache.get(name);
  if (existing) return existing;
  const data = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const out = new Uint8Array(hash).subarray(0, 8);
  discCache.set(name, out);
  return out;
}

export const discConvertToRwt = (): Promise<Uint8Array> =>
  discriminator('convert_to_rwt');
export const discRwtClaimYield = (): Promise<Uint8Array> =>
  discriminator('claim_yield');
export const discDexCompoundYield = (): Promise<Uint8Array> =>
  discriminator('compound_yield');
export const discOtClaimYdForTreasury = (): Promise<Uint8Array> =>
  discriminator('claim_yd_for_treasury');
export const discInitLiquidityHolding = (): Promise<Uint8Array> =>
  discriminator('initialize_liquidity_holding');
export const discWithdrawLiquidityHolding = (): Promise<Uint8Array> =>
  discriminator('withdraw_liquidity_holding');

function writeU64LE(buf: Uint8Array, off: number, value: bigint): void {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  view.setBigUint64(0, value, true);
}

function writeU32LE(buf: Uint8Array, off: number, value: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 4);
  view.setUint32(0, value, true);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// -----------------------------------------------------------------------------
// CU budget helpers
// -----------------------------------------------------------------------------

/** Build the standard 2-ix CU prefix used by all Layer 8 actions. */
export function buildComputeBudgetIxs(
  units: number,
  microLamports: number,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

// -----------------------------------------------------------------------------
// YD::convert_to_rwt
// -----------------------------------------------------------------------------

export interface BuildConvertToRwtArgs {
  ydProgramId: PublicKey;
  dexProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  signer: PublicKey;

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

  usdcAmount: bigint;
  minRwtOut: bigint;
  swapFirst: boolean;
}

/**
 * Build `YD::convert_to_rwt` ix. 22 accounts; data = disc(8) + u64(8) + u64(8) + u8(1).
 * Account order matches `contracts/yield-distribution/src/instructions/convert_to_rwt.rs:81`.
 */
export async function buildConvertToRwtIx(
  args: BuildConvertToRwtArgs,
): Promise<TransactionInstruction> {
  const disc = await discConvertToRwt();
  const data = new Uint8Array(8 + 8 + 8 + 1);
  data.set(disc, 0);
  writeU64LE(data, 8, args.usdcAmount);
  writeU64LE(data, 16, args.minRwtOut);
  data[24] = args.swapFirst ? 1 : 0;

  return new TransactionInstruction({
    programId: args.ydProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.config, isSigner: false, isWritable: false },
      { pubkey: args.distributor, isSigner: false, isWritable: true },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.accumulator, isSigner: false, isWritable: false },
      { pubkey: args.accumulatorUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.accumulatorRwtAta, isSigner: false, isWritable: true },
      { pubkey: args.feeAccount, isSigner: false, isWritable: true },
      { pubkey: args.rewardVault, isSigner: false, isWritable: true },
      { pubkey: args.rwtMint, isSigner: false, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.dexPoolVaultIn, isSigner: false, isWritable: true },
      { pubkey: args.dexPoolVaultOut, isSigner: false, isWritable: true },
      { pubkey: args.dexArealFeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.rwtVault, isSigner: false, isWritable: true },
      { pubkey: args.rwtCapitalAcc, isSigner: false, isWritable: true },
      { pubkey: args.rwtDaoFeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.dexProgramId, isSigner: false, isWritable: false },
      { pubkey: args.rwtEngineProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// -----------------------------------------------------------------------------
// Shared claim arg encoder
// -----------------------------------------------------------------------------

/**
 * Encode the variable-length args body shared across the 3 claim wrappers
 * (RWT::claim_yield, DEX::compound_yield, OT::claim_yd_for_treasury):
 *   [cumulative_amount(u64 LE) | proof_len(u32 LE) | proof_bytes(32 * N)]
 */
export function encodeClaimArgs(
  cumulativeAmount: bigint,
  proofNodes: Uint8Array[],
): Uint8Array {
  const out = new Uint8Array(8 + 4 + 32 * proofNodes.length);
  writeU64LE(out, 0, cumulativeAmount);
  writeU32LE(out, 8, proofNodes.length);
  let off = 12;
  for (const node of proofNodes) {
    if (node.length !== 32)
      throw new Error(`Proof node has length ${node.length}, expected 32`);
    out.set(node, off);
    off += 32;
  }
  return out;
}

/** Convert proof from publisher's hex-encoded form into raw byte arrays. */
export function decodeProof(proofHex: string[]): Uint8Array[] {
  return proofHex.map(hexToBytes);
}

// -----------------------------------------------------------------------------
// RWT::claim_yield
// -----------------------------------------------------------------------------

export interface BuildRwtClaimArgs {
  rwtEngineProgramId: PublicKey;
  ydProgramId: PublicKey;
  signer: PublicKey;
  rwtVault: PublicKey;
  distConfig: PublicKey;
  rwtClaimAta: PublicKey;
  liquidityDest: PublicKey;
  protocolRevenueDest: PublicKey;
  ydConfig: PublicKey;
  otMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Uint8Array[];
}

export async function buildRwtClaimYieldIx(
  args: BuildRwtClaimArgs,
): Promise<TransactionInstruction> {
  const disc = await discRwtClaimYield();
  const body = encodeClaimArgs(args.cumulativeAmount, args.proof);
  const data = concatBytes(disc, body);

  return new TransactionInstruction({
    programId: args.rwtEngineProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.rwtVault, isSigner: false, isWritable: true },
      { pubkey: args.distConfig, isSigner: false, isWritable: false },
      { pubkey: args.rwtClaimAta, isSigner: false, isWritable: true },
      { pubkey: args.liquidityDest, isSigner: false, isWritable: true },
      { pubkey: args.protocolRevenueDest, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// -----------------------------------------------------------------------------
// DEX::compound_yield
// -----------------------------------------------------------------------------

export interface BuildDexCompoundArgs {
  dexProgramId: PublicKey;
  ydProgramId: PublicKey;
  signer: PublicKey;
  poolState: PublicKey;
  targetVault: PublicKey;
  ydConfig: PublicKey;
  otMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Uint8Array[];
}

export async function buildDexCompoundIx(
  args: BuildDexCompoundArgs,
): Promise<TransactionInstruction> {
  const disc = await discDexCompoundYield();
  const body = encodeClaimArgs(args.cumulativeAmount, args.proof);
  const data = concatBytes(disc, body);

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.targetVault, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// -----------------------------------------------------------------------------
// OT::claim_yd_for_treasury
// -----------------------------------------------------------------------------

export interface BuildOtTreasuryClaimArgs {
  otProgramId: PublicKey;
  ydProgramId: PublicKey;
  signer: PublicKey;
  otMint: PublicKey;
  otTreasury: PublicKey;
  treasuryRwtAta: PublicKey;
  ydConfig: PublicKey;
  ydOtMint: PublicKey;
  ydDistributor: PublicKey;
  ydClaimStatus: PublicKey;
  ydRewardVault: PublicKey;

  cumulativeAmount: bigint;
  proof: Uint8Array[];
}

export async function buildOtTreasuryClaimIx(
  args: BuildOtTreasuryClaimArgs,
): Promise<TransactionInstruction> {
  const disc = await discOtClaimYdForTreasury();
  const body = encodeClaimArgs(args.cumulativeAmount, args.proof);
  const data = concatBytes(disc, body);

  return new TransactionInstruction({
    programId: args.otProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.otMint, isSigner: false, isWritable: false },
      { pubkey: args.otTreasury, isSigner: false, isWritable: false },
      { pubkey: args.treasuryRwtAta, isSigner: false, isWritable: true },
      { pubkey: args.ydConfig, isSigner: false, isWritable: false },
      { pubkey: args.ydOtMint, isSigner: false, isWritable: false },
      { pubkey: args.ydDistributor, isSigner: false, isWritable: true },
      { pubkey: args.ydClaimStatus, isSigner: false, isWritable: true },
      { pubkey: args.ydRewardVault, isSigner: false, isWritable: true },
      { pubkey: args.ydProgramId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// -----------------------------------------------------------------------------
// YD::initialize_liquidity_holding (one-time, permissionless)
// -----------------------------------------------------------------------------

export interface BuildInitializeLiquidityHoldingArgs {
  ydProgramId: PublicKey;
  payer: PublicKey;
  liquidityHolding: PublicKey;
  liquidityHoldingAta: PublicKey;
  rwtMint: PublicKey;
  associatedTokenProgram: PublicKey;
}

/**
 * Build `YD::initialize_liquidity_holding`. Single-shot init for the singleton
 * LiquidityHolding PDA + RWT ATA (per D11.1, D14).
 */
export async function buildInitializeLiquidityHoldingIx(
  args: BuildInitializeLiquidityHoldingArgs,
): Promise<TransactionInstruction> {
  const disc = await discInitLiquidityHolding();
  // Args body is empty for init.
  return new TransactionInstruction({
    programId: args.ydProgramId,
    data: Buffer.from(disc),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.liquidityHolding, isSigner: false, isWritable: true },
      { pubkey: args.liquidityHoldingAta, isSigner: false, isWritable: true },
      { pubkey: args.rwtMint, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}
