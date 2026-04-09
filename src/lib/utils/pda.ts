import { PublicKey } from '@solana/web3.js';

/**
 * Well-known program IDs
 */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Known USDC mints per cluster
 */
export const USDC_MINTS: Record<string, PublicKey> = {
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
};

/**
 * Derive OtConfig PDA
 */
export function findOtConfigPda(otMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ot_config'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive RevenueAccount PDA
 */
export function findRevenueAccountPda(otMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('revenue'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive RevenueConfig PDA
 */
export function findRevenueConfigPda(otMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('revenue_config'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive OtGovernance PDA
 */
export function findOtGovernancePda(otMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ot_governance'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive OtTreasury PDA
 */
export function findOtTreasuryPda(otMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ot_treasury'), otMint.toBuffer()],
    programId
  );
}

/**
 * Derive Associated Token Account address
 */
export function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}
