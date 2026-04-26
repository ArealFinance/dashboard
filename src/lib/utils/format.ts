import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Format a raw token amount to human-readable with decimals
 */
export function formatAmount(rawAmount: bigint | number, decimals: number): string {
  const amount = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;

  if (fraction === 0n) return whole.toLocaleString();

  const fracStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr}`;
}

/**
 * Format USDC amount (6 decimals)
 */
export function formatUsdc(rawAmount: bigint | number): string {
  return `$${formatAmount(rawAmount, 6)}`;
}

/**
 * Truncate an address for display: "DYw8...NSKK"
 */
export function formatAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Convert a [u8; 32] byte array to base58 string (PublicKey)
 */
export function bytesToBase58(bytes: Uint8Array | Buffer | number[]): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return bs58.encode(buf);
}

/**
 * Convert a base58 string to [u8; 32] byte array
 */
export function base58ToBytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes();
}

/**
 * Parse a decimal-formatted amount string into a BigInt of the given precision.
 *
 * Example: parseDecimal("1.5", 6) === 1_500_000n
 *          parseDecimal("0.0000001", 6) === 0n  (truncates, never rounds up)
 *          parseDecimal("", 6) === 0n
 *
 * Avoids floating-point multiplication (`Number(s) * 10**n`) which silently
 * loses precision for large numbers or high decimals (M-11).
 */
export function parseDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  // Accept optional leading sign
  const match = trimmed.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match) return 0n;
  const [, sign, intPart, fracPartRaw = ''] = match;
  // Truncate fractional part to `decimals` digits; pad with zeros if shorter
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, '0');
  const combined = (intPart || '0') + fracPart;
  // Strip leading zeros except single zero
  const normalized = combined.replace(/^0+(?=\d)/, '') || '0';
  const magnitude = BigInt(normalized);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Trim null bytes from a fixed-size UTF-8 byte array (e.g., [u8; 32] labels)
 */
export function trimNullBytes(bytes: Uint8Array | Buffer | number[]): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Find the first null byte
  let end = buf.length;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder('utf-8').decode(buf.subarray(0, end));
}

/**
 * Encode a string into a fixed-size [u8; N] array, padded with null bytes
 */
export function stringToFixedBytes(str: string, size: number): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  const result = new Uint8Array(size);
  result.set(encoded.subarray(0, size));
  return result;
}

/**
 * Check if a [u8; 32] is all zeros
 */
export function isZeroAddress(bytes: Uint8Array | Buffer | number[]): boolean {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return buf.every(b => b === 0);
}

/**
 * Validate a base58 Solana address
 */
export function isValidAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Format a Unix timestamp as human-readable date
 */
export function formatTimestamp(ts: bigint | number): string {
  const ms = typeof ts === 'bigint' ? Number(ts) * 1000 : ts * 1000;
  if (ms === 0) return 'Never';
  return new Date(ms).toLocaleString();
}

/**
 * Format a cooldown remaining duration
 */
export function formatCooldown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'Ready';

  const days = Math.floor(secondsRemaining / 86400);
  const hours = Math.floor((secondsRemaining % 86400) / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  const secs = Math.floor(secondsRemaining % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 && days === 0) parts.push(`${secs}s`);

  return parts.join(' ') || 'Ready';
}

/**
 * Resolve the localnet RPC URL from PUBLIC_LOCALNET_RPC_URL env, falling back
 * to the standard Solana test-validator endpoint. Mirrors the same lookup
 * performed in `stores/network.ts` so explorer links use the same RPC the
 * dashboard talks to.
 */
function resolveLocalnetRpcUrl(): string {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const raw = (import.meta.env as ImportMetaEnv).PUBLIC_LOCALNET_RPC_URL;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return 'http://127.0.0.1:8899';
}

/**
 * Get the explorer URL for a transaction or address
 */
export function explorerUrl(
  value: string,
  type: 'tx' | 'address' | 'account' = 'address',
  cluster: string = 'devnet'
): string {
  const base = 'https://explorer.solana.com';
  let clusterParam = '';
  if (cluster === 'localnet') {
    const customUrl = encodeURIComponent(resolveLocalnetRpcUrl());
    clusterParam = `?cluster=custom&customUrl=${customUrl}`;
  } else if (cluster !== 'mainnet-beta') {
    clusterParam = `?cluster=${cluster}`;
  }
  return `${base}/${type}/${value}${clusterParam}`;
}
