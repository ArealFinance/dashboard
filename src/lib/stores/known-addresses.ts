import type { Cluster } from './network';

/**
 * Known address entry with human-readable metadata
 */
export interface KnownAddress {
  address: string;
  label: string;
  type: 'program' | 'mint' | 'ata' | 'system';
  module?: string;
}

/**
 * Well-known Solana system programs
 */
const SYSTEM_ADDRESSES: KnownAddress[] = [
  { address: '11111111111111111111111111111111', label: 'System Program', type: 'program', module: 'solana' },
  { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', label: 'SPL Token Program', type: 'program', module: 'solana' },
  { address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', label: 'Associated Token Program', type: 'program', module: 'solana' },
  { address: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', label: 'SPL Token-2022', type: 'program', module: 'solana' },
  { address: 'SysvarRent111111111111111111111111111111111', label: 'Rent Sysvar', type: 'system', module: 'solana' },
  { address: 'SysvarC1ock11111111111111111111111111111111', label: 'Clock Sysvar', type: 'system', module: 'solana' },
  { address: 'ComputeBudget111111111111111111111111111111', label: 'Compute Budget Program', type: 'program', module: 'solana' },
  { address: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', label: 'Metaplex Token Metadata', type: 'program', module: 'metaplex' },
];

/**
 * Cluster-specific known addresses (mints, ATAs, etc.)
 */
const CLUSTER_ADDRESSES: Record<Cluster, KnownAddress[]> = {
  'localnet': [
    { address: 'So11111111111111111111111111111111111111112', label: 'Wrapped SOL', type: 'mint', module: 'spl' },
  ],
  'devnet': [
    { address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', label: 'USDC', type: 'mint', module: 'spl' },
    { address: 'So11111111111111111111111111111111111111112', label: 'Wrapped SOL', type: 'mint', module: 'spl' },
  ],
  'mainnet-beta': [
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', label: 'USDC', type: 'mint', module: 'spl' },
    { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', label: 'USDT', type: 'mint', module: 'spl' },
    { address: 'So11111111111111111111111111111111111111112', label: 'Wrapped SOL', type: 'mint', module: 'spl' },
  ]
};

/**
 * Get all known addresses for a given cluster
 */
export function getKnownAddresses(cluster: Cluster): Map<string, KnownAddress> {
  const map = new Map<string, KnownAddress>();

  for (const addr of SYSTEM_ADDRESSES) {
    map.set(addr.address, addr);
  }

  const clusterAddrs = CLUSTER_ADDRESSES[cluster] ?? [];
  for (const addr of clusterAddrs) {
    map.set(addr.address, addr);
  }

  return map;
}

/**
 * Check if an address is a known system/infrastructure address
 */
export function isKnownAddress(address: string, cluster: Cluster): boolean {
  const known = getKnownAddresses(cluster);
  return known.has(address);
}

/**
 * Look up a known address by its string representation
 */
export function lookupKnownAddress(address: string, cluster: Cluster): KnownAddress | undefined {
  const known = getKnownAddresses(cluster);
  return known.get(address);
}
