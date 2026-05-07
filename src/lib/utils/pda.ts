import { PublicKey } from '@solana/web3.js';
import { SPL_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@areal/sdk/network';

/**
 * Dashboard-local PDA helpers.
 *
 * Phase 4 R3 — most PDA derivers and constants have been moved to the SDK.
 * What remains here:
 *
 *   1. `USDC_MINTS` — kept as a dashboard-local map because the dashboard's
 *      cluster type is `'localnet' | 'devnet' | 'mainnet-beta'` while the
 *      SDK uses `'mainnet'`. Migration is tracked separately and bridged
 *      via a cluster adapter (see B.3c).
 *   2. `findAta` — the SDK has `findAssociatedTokenAddressPda` returning
 *      `[PublicKey, number]`, while dashboard code expects a single
 *      `PublicKey`. Kept as a thin wrapper for back-compat.
 */

/**
 * Known USDC mints per cluster.
 */
export const USDC_MINTS: Record<string, PublicKey> = {
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
};

/**
 * Derive Associated Token Account address.
 * Returns just the PublicKey (the bump is rarely needed at call sites).
 */
export function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}
