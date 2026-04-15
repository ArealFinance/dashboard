import { PublicKey } from '@solana/web3.js';
import { lookupKnownAddress } from '$lib/stores/known-addresses';
import { PROTOCOL_PROGRAMS } from '$lib/stores/protocol';
import {
  findOtConfigPda, findRevenueAccountPda, findRevenueConfigPda,
  findOtGovernancePda, findOtTreasuryPda, findAta,
  findFutarchyConfigPda,
  findDexConfigPda, findPoolCreatorsPda,
  USDC_MINTS
} from '$lib/utils/pda';
import { formatAddress, bytesToBase58, trimNullBytes } from '$lib/utils/format';
import type { OtState } from '$lib/stores/ot';
import type { Cluster } from '$lib/stores/network';

/**
 * Result of resolving an on-chain address to a human-readable label
 */
export interface ResolvedAddress {
  label: string;
  type: 'program' | 'pda' | 'ata' | 'wallet' | 'unknown';
  module?: string;
  link?: string;
  status?: 'active' | 'pending';
}

/**
 * Resolve an on-chain address to a human-readable label.
 *
 * Resolution order:
 * 1. Known system/infrastructure addresses (SPL Token, System Program, USDC, etc.)
 * 2. Areal protocol program IDs
 * 3. OT PDA addresses (config, revenue, governance, treasury, ATAs)
 * 4. OT destination labels (from RevenueConfig)
 * 5. Fallback: truncated base58
 */
export function resolveAddress(
  address: string,
  cluster: Cluster,
  context?: {
    otState?: OtState;
    otProgramId?: PublicKey;
  }
): ResolvedAddress {
  // 1. Known addresses (system programs, mints, etc.)
  const known = lookupKnownAddress(address, cluster);
  if (known) {
    return {
      label: known.label,
      type: known.type === 'program' || known.type === 'system' ? 'program' : 'ata',
      module: known.module
    };
  }

  // 2. Areal protocol program IDs
  for (const program of PROTOCOL_PROGRAMS) {
    if (program.programId && program.programId === address) {
      return {
        label: `${program.name} Program`,
        type: 'program',
        module: program.id,
        link: `/${program.id}`,
        status: program.status === 'deployed' ? 'active' : 'pending'
      };
    }
  }

  // 3. OT PDA resolution (if context provided)
  if (context?.otState && context?.otProgramId) {
    const otResolved = resolveOtPda(address, context.otState, context.otProgramId, cluster);
    if (otResolved) return otResolved;
  }

  // 4. Check OT destination labels
  if (context?.otState?.revenueConfig) {
    const destResolved = resolveDestinationAddress(address, context.otState);
    if (destResolved) return destResolved;
  }

  // 5. DEX PDA resolution
  const dexResolved = resolveDexPda(address);
  if (dexResolved) return dexResolved;

  // 6. Fallback
  return {
    label: formatAddress(address, 4),
    type: 'unknown'
  };
}

/**
 * Resolve an address against OT PDA patterns
 */
function resolveOtPda(
  address: string,
  otState: OtState,
  programId: PublicKey,
  cluster: Cluster
): ResolvedAddress | null {
  const mint = otState.mint;
  const mintShort = formatAddress(mint.toBase58(), 4);

  try {
    // OtConfig PDA
    const [otConfigPda] = findOtConfigPda(mint, programId);
    if (otConfigPda.toBase58() === address) {
      return { label: `OtConfig [${mintShort}]`, type: 'pda', module: 'ot' };
    }

    // RevenueAccount PDA
    const [revenuePda] = findRevenueAccountPda(mint, programId);
    if (revenuePda.toBase58() === address) {
      return { label: `Revenue Account [${mintShort}]`, type: 'pda', module: 'ot' };
    }

    // RevenueConfig PDA
    const [revenueConfigPda] = findRevenueConfigPda(mint, programId);
    if (revenueConfigPda.toBase58() === address) {
      return { label: `Revenue Config [${mintShort}]`, type: 'pda', module: 'ot' };
    }

    // OtGovernance PDA
    const [governancePda] = findOtGovernancePda(mint, programId);
    if (governancePda.toBase58() === address) {
      return { label: `OT Governance [${mintShort}]`, type: 'pda', module: 'ot' };
    }

    // OtTreasury PDA
    const [treasuryPda] = findOtTreasuryPda(mint, programId);
    if (treasuryPda.toBase58() === address) {
      return { label: `OT Treasury [${mintShort}]`, type: 'pda', module: 'ot' };
    }

    // Revenue USDC ATA
    const usdcMint = USDC_MINTS[cluster];
    if (usdcMint) {
      const revenueAta = findAta(revenuePda, usdcMint);
      if (revenueAta.toBase58() === address) {
        return { label: `Revenue USDC ATA [${mintShort}]`, type: 'ata', module: 'ot' };
      }

      // Treasury USDC ATA
      const treasuryAta = findAta(treasuryPda, usdcMint);
      if (treasuryAta.toBase58() === address) {
        return { label: `Treasury USDC ATA [${mintShort}]`, type: 'ata', module: 'ot' };
      }
    }
  } catch {
    // PDA derivation failed — not a match
  }

  return null;
}

/**
 * Check if address matches any destination in RevenueConfig and return its label
 */
function resolveDestinationAddress(address: string, otState: OtState): ResolvedAddress | null {
  const rcfg = otState.revenueConfig;
  if (!rcfg) return null;

  // Check fee destination
  try {
    const feeAddr = bytesToBase58(rcfg.areal_fee_destination);
    if (feeAddr === address) {
      return { label: 'Areal Fee Destination', type: 'ata', module: 'ot', status: 'active' };
    }
  } catch { /* ignore */ }

  // Check active destinations
  for (let i = 0; i < rcfg.active_count; i++) {
    const dest = rcfg.destinations[i];
    try {
      const destAddr = bytesToBase58(dest.address);
      if (destAddr === address) {
        const label = trimNullBytes(dest.label);
        return {
          label: label || `Destination #${i + 1}`,
          type: 'ata',
          module: 'ot',
          status: 'active'
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Resolve an address against DEX PDA patterns (singletons only — pools need mint context)
 */
function resolveDexPda(address: string): ResolvedAddress | null {
  try {
    const { dexProgramId } = require('$lib/stores/dex');
    const [configPda] = findDexConfigPda(dexProgramId);
    if (configPda.toBase58() === address) {
      return { label: 'DexConfig', type: 'pda', module: 'dex' };
    }
    const [creatorsPda] = findPoolCreatorsPda(dexProgramId);
    if (creatorsPda.toBase58() === address) {
      return { label: 'PoolCreators', type: 'pda', module: 'dex' };
    }
  } catch {
    // DEX module not available
  }
  return null;
}

/**
 * Resolve authority address to detect if it's a Futarchy governance PDA.
 */
export function resolveAuthorityType(
  authorityAddress: string,
  otMint: PublicKey
): { type: 'wallet' | 'futarchy' | 'unknown'; label: string } {
  try {
    // Check if authority is the Futarchy config PDA for this OT mint
    const { futarchyProgramId } = require('$lib/stores/futarchy');
    const [futarchyConfigPda] = findFutarchyConfigPda(otMint, futarchyProgramId);
    if (futarchyConfigPda.toBase58() === authorityAddress) {
      return {
        type: 'futarchy',
        label: 'Futarchy Governance PDA'
      };
    }
  } catch {
    // Futarchy module not available
  }
  return {
    type: 'wallet',
    label: 'Wallet (direct authority)'
  };
}
