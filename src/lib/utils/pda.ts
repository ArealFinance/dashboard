import { PublicKey } from '@solana/web3.js';

/**
 * Dashboard-local helpers — what remains here after Phase 4 R3.
 *
 *   `USDC_MINTS` — kept as a dashboard-local map because the dashboard's
 *   cluster type is `'localnet' | 'devnet' | 'mainnet-beta'` while the
 *   SDK uses `'mainnet'`. Migration is tracked separately and bridged
 *   via a cluster adapter (see B.3c).
 */

/**
 * Known USDC mints per cluster.
 */
export const USDC_MINTS: Record<string, PublicKey> = {
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
};
