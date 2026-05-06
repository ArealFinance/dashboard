import { PublicKey } from '@solana/web3.js';

/**
 * Dashboard-local PDA helpers and program-ID constants.
 *
 * Phase 4 R3 — most PDA derivers have been moved to `@areal/sdk/pda`.
 * What remains here:
 *
 *   1. Well-known program IDs (TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
 *      ASSOCIATED_TOKEN_PROGRAM_ID, USDC_MINTS) — these are constants
 *      consumed widely by stores and route components. The SDK exposes
 *      similar via `@areal/sdk` (root) under slightly different names
 *      (e.g. SPL_TOKEN_PROGRAM_ID); call sites can be migrated piecemeal.
 *   2. `findAta` — the SDK has `findAssociatedTokenAddressPda` returning
 *      `[PublicKey, number]`, while dashboard code expects a single
 *      `PublicKey`. Kept as a thin wrapper for back-compat.
 *   3. `findMerkleDistributorPda`, `findYdAccumulatorPda`,
 *      `findClaimStatusPda` — kept here because the dashboard's historical
 *      parameter order (`programId`-first) differs from the SDK's
 *      `otMint`/`distributor`-first order. Migrating ~25 call sites to the
 *      SDK signature is a follow-up cleanup; until then this file holds
 *      the legacy signature so behavior is preserved.
 */

/**
 * Well-known program IDs.
 */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Known USDC mints per cluster.
 */
export const USDC_MINTS: Record<string, PublicKey> = {
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
};

/**
 * Derive MerkleDistributor PDA.
 * Seeds: ["merkle_dist", ot_mint]
 *
 * Legacy parameter order — matches the dashboard's historical signature.
 * The SDK's `findMerkleDistributorPda` takes (otMint, programId) instead;
 * a follow-up will migrate call sites and remove this wrapper.
 */
export function findMerkleDistributorPda(
  programId: PublicKey,
  otMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_dist'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive YD Accumulator PDA.
 * Seeds: ["accumulator", ot_mint]
 *
 * Legacy parameter order — see findMerkleDistributorPda above.
 */
export function findYdAccumulatorPda(
  programId: PublicKey,
  otMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('accumulator'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive ClaimStatus PDA.
 * Seeds: ["claim_status", distributor, claimant]
 *
 * Legacy parameter order — see findMerkleDistributorPda above.
 */
export function findClaimStatusPda(
  programId: PublicKey,
  distributor: PublicKey,
  claimant: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim_status'), distributor.toBuffer(), claimant.toBuffer()],
    programId
  );
}

/**
 * Derive Associated Token Account address.
 * Returns just the PublicKey (the bump is rarely needed at call sites).
 */
export function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}
