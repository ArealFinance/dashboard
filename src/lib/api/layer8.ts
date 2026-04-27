/**
 * Layer 8 API client
 * ===================
 *
 * Parses Layer 8 events emitted by the four contracts (YD, RWT Engine,
 * Native DEX, Ownership Token) from confirmed transaction logs and exposes
 * typed accessors for the dashboard.
 *
 * Events covered (Layer 8 architecture §6):
 *   - StreamConverted          (YD::convert_to_rwt)
 *   - YieldDistributed         (RWT::claim_yield)
 *   - LiquidityHoldingFunded   (RWT::claim_yield, conditional)
 *   - CompoundYieldExecuted    (DEX::compound_yield)
 *   - TreasuryYieldClaimed     (OT::claim_yd_for_treasury)
 *   - LiquidityHoldingInitialized / LiquidityHoldingWithdrawn (YD)
 *
 * Event discriminators are sha256("event:<EventName>")[..8] (Anchor / Arlex
 * convention). Each event body is base64-encoded inside `Program log: ...`
 * lines (`emit!` macro). We compute the discriminators eagerly per kind and
 * scan tx logs for matching `Program data:` lines (the standard way Anchor
 * encodes events).
 *
 * NOTE: This module reads on-chain logs; no off-chain storage required.
 * For performance, callers should pass a recent signature window
 * (`limit`, `before`).
 */
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { bytesToBase58 } from '$lib/utils/format';

// -----------------------------------------------------------------------------
// Discriminator computation
// -----------------------------------------------------------------------------

/**
 * Compute Anchor-style event discriminator (first 8 bytes of
 * `sha256("event:<Name>")`).
 *
 * Uses Web Crypto for browser compatibility — the dashboard runs SSR-disabled
 * (`ssr=false`), so `crypto.subtle` is always available.
 */
async function eventDiscriminator(name: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`event:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash).subarray(0, 8);
}

// All Layer 8 event kinds (full architectural list).
export type Layer8EventKind =
  | 'StreamConverted'
  | 'YieldDistributed'
  | 'LiquidityHoldingFunded'
  | 'CompoundYieldExecuted'
  | 'TreasuryYieldClaimed'
  | 'LiquidityHoldingInitialized'
  | 'DistributorFunded';

const EVENT_NAMES: Layer8EventKind[] = [
  'StreamConverted',
  'YieldDistributed',
  'LiquidityHoldingFunded',
  'CompoundYieldExecuted',
  'TreasuryYieldClaimed',
  'LiquidityHoldingInitialized',
  'DistributorFunded',
];

// Memoized discriminator → kind reverse map.
let discCache: Map<string, Layer8EventKind> | null = null;
async function getDiscMap(): Promise<Map<string, Layer8EventKind>> {
  if (discCache) return discCache;
  const out = new Map<string, Layer8EventKind>();
  for (const name of EVENT_NAMES) {
    const d = await eventDiscriminator(name);
    out.set(bytesToHex8(d), name);
  }
  discCache = out;
  return discCache;
}

function bytesToHex8(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// -----------------------------------------------------------------------------
// Event types — narrow shapes parsed from log bodies
// -----------------------------------------------------------------------------

export interface BaseEvent {
  kind: Layer8EventKind;
  /** Tx signature carrying the event. */
  signature: string;
  /** Slot of the confirming transaction. */
  slot: number;
  /** Block time (Unix seconds) — null when RPC didn't return one. */
  blockTime: number | null;
}

/** Layer 8 §6.1: StreamConverted (128 bytes). */
export interface StreamConvertedEvent extends BaseEvent {
  kind: 'StreamConverted';
  distributor: string;
  otMint: string;
  amount: bigint;
  protocolFee: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  timestamp: bigint;
  usdcIn: bigint;
  swapOutRwt: bigint;
  mintOutRwt: bigint;
}

/** Layer 8 §6.2: YieldDistributed (120 bytes). */
export interface YieldDistributedEvent extends BaseEvent {
  kind: 'YieldDistributed';
  vault: string;
  otMint: string;
  totalYield: bigint;
  bookValueShare: bigint;
  liquidityShare: bigint;
  protocolRevenueShare: bigint;
  navBefore: bigint;
  navAfter: bigint;
  timestamp: bigint;
}

/** Layer 8 §6.5: LiquidityHoldingFunded (80 bytes). */
export interface LiquidityHoldingFundedEvent extends BaseEvent {
  kind: 'LiquidityHoldingFunded';
  liquidityHolding: string;
  otMint: string;
  amount: bigint;
  timestamp: bigint;
}

/** Layer 8 §6.3: CompoundYieldExecuted (89 bytes). */
export interface CompoundYieldExecutedEvent extends BaseEvent {
  kind: 'CompoundYieldExecuted';
  pool: string;
  otMint: string;
  rwtClaimed: bigint;
  rwtSide: number;
  reserveAfter: bigint;
  timestamp: bigint;
}

/** Layer 8 §6.4: TreasuryYieldClaimed (80 bytes). */
export interface TreasuryYieldClaimedEvent extends BaseEvent {
  kind: 'TreasuryYieldClaimed';
  otMint: string;
  ydOtMint: string;
  amount: bigint;
  timestamp: bigint;
}

/** Layer 8 §6.6: LiquidityHoldingInitialized (104 bytes — 32+32+32+8). */
export interface LiquidityHoldingInitializedEvent extends BaseEvent {
  kind: 'LiquidityHoldingInitialized';
  liquidityHolding: string;
  liquidityHoldingAta: string;
  payer: string;
  timestamp: bigint;
}

/** Layer 7 distributor-funded event (still relevant in feed). */
export interface DistributorFundedEvent extends BaseEvent {
  kind: 'DistributorFunded';
  otMint: string;
  amount: bigint;
  protocolFee: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  timestamp: bigint;
}

export type Layer8Event =
  | StreamConvertedEvent
  | YieldDistributedEvent
  | LiquidityHoldingFundedEvent
  | CompoundYieldExecutedEvent
  | TreasuryYieldClaimedEvent
  | LiquidityHoldingInitializedEvent
  | DistributorFundedEvent;

// -----------------------------------------------------------------------------
// Body parsers
// -----------------------------------------------------------------------------

function readU64LE(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return view.getBigUint64(0, true);
}

function readI64LE(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return view.getBigInt64(0, true);
}

function readPubkey(buf: Uint8Array, off: number): string {
  return bytesToBase58(buf.subarray(off, off + 32));
}

function decodeProgramData(line: string): Uint8Array | null {
  // Anchor emits events as `Program data: <base64>`.
  const prefix = 'Program data: ';
  const idx = line.indexOf(prefix);
  if (idx === -1) return null;
  const b64 = line.slice(idx + prefix.length).trim();
  try {
    if (typeof atob !== 'undefined') {
      const binStr = atob(b64);
      const out = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
      return out;
    }
    // Node fallback (vitest).
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function parseStreamConverted(
  body: Uint8Array,
  base: BaseEvent,
): StreamConvertedEvent | null {
  if (body.length < 128) return null;
  return {
    ...base,
    kind: 'StreamConverted',
    distributor: readPubkey(body, 0),
    otMint: readPubkey(body, 32),
    amount: readU64LE(body, 64),
    protocolFee: readU64LE(body, 72),
    totalFunded: readU64LE(body, 80),
    lockedVested: readU64LE(body, 88),
    timestamp: readI64LE(body, 96),
    usdcIn: readU64LE(body, 104),
    swapOutRwt: readU64LE(body, 112),
    mintOutRwt: readU64LE(body, 120),
  };
}

function parseYieldDistributed(
  body: Uint8Array,
  base: BaseEvent,
): YieldDistributedEvent | null {
  if (body.length < 120) return null;
  return {
    ...base,
    kind: 'YieldDistributed',
    vault: readPubkey(body, 0),
    otMint: readPubkey(body, 32),
    totalYield: readU64LE(body, 64),
    bookValueShare: readU64LE(body, 72),
    liquidityShare: readU64LE(body, 80),
    protocolRevenueShare: readU64LE(body, 88),
    navBefore: readU64LE(body, 96),
    navAfter: readU64LE(body, 104),
    timestamp: readI64LE(body, 112),
  };
}

function parseLiquidityHoldingFunded(
  body: Uint8Array,
  base: BaseEvent,
): LiquidityHoldingFundedEvent | null {
  if (body.length < 80) return null;
  return {
    ...base,
    kind: 'LiquidityHoldingFunded',
    liquidityHolding: readPubkey(body, 0),
    otMint: readPubkey(body, 32),
    amount: readU64LE(body, 64),
    timestamp: readI64LE(body, 72),
  };
}

function parseCompoundYieldExecuted(
  body: Uint8Array,
  base: BaseEvent,
): CompoundYieldExecutedEvent | null {
  if (body.length < 89) return null;
  return {
    ...base,
    kind: 'CompoundYieldExecuted',
    pool: readPubkey(body, 0),
    otMint: readPubkey(body, 32),
    rwtClaimed: readU64LE(body, 64),
    rwtSide: body[72],
    reserveAfter: readU64LE(body, 73),
    timestamp: readI64LE(body, 81),
  };
}

function parseTreasuryYieldClaimed(
  body: Uint8Array,
  base: BaseEvent,
): TreasuryYieldClaimedEvent | null {
  if (body.length < 80) return null;
  return {
    ...base,
    kind: 'TreasuryYieldClaimed',
    otMint: readPubkey(body, 0),
    ydOtMint: readPubkey(body, 32),
    amount: readU64LE(body, 64),
    timestamp: readI64LE(body, 72),
  };
}

function parseLiquidityHoldingInitialized(
  body: Uint8Array,
  base: BaseEvent,
): LiquidityHoldingInitializedEvent | null {
  if (body.length < 104) return null;
  return {
    ...base,
    kind: 'LiquidityHoldingInitialized',
    liquidityHolding: readPubkey(body, 0),
    liquidityHoldingAta: readPubkey(body, 32),
    payer: readPubkey(body, 64),
    timestamp: readI64LE(body, 96),
  };
}

function parseDistributorFunded(
  body: Uint8Array,
  base: BaseEvent,
): DistributorFundedEvent | null {
  if (body.length < 64) return null;
  return {
    ...base,
    kind: 'DistributorFunded',
    otMint: readPubkey(body, 0),
    amount: readU64LE(body, 32),
    protocolFee: readU64LE(body, 40),
    totalFunded: readU64LE(body, 48),
    lockedVested: readU64LE(body, 56),
    timestamp: body.length >= 72 ? readI64LE(body, 64) : 0n,
  };
}

/**
 * Parse a single `Program data:` log into a typed event, or null if the
 * discriminator doesn't match any known Layer 8 kind.
 */
async function parseProgramDataLog(
  line: string,
  base: BaseEvent,
): Promise<Layer8Event | null> {
  const data = decodeProgramData(line);
  if (!data || data.length < 8) return null;
  const discMap = await getDiscMap();
  const kind = discMap.get(bytesToHex8(data.subarray(0, 8)));
  if (!kind) return null;
  const body = data.subarray(8);
  switch (kind) {
    case 'StreamConverted':
      return parseStreamConverted(body, { ...base, kind });
    case 'YieldDistributed':
      return parseYieldDistributed(body, { ...base, kind });
    case 'LiquidityHoldingFunded':
      return parseLiquidityHoldingFunded(body, { ...base, kind });
    case 'CompoundYieldExecuted':
      return parseCompoundYieldExecuted(body, { ...base, kind });
    case 'TreasuryYieldClaimed':
      return parseTreasuryYieldClaimed(body, { ...base, kind });
    case 'LiquidityHoldingInitialized':
      return parseLiquidityHoldingInitialized(body, { ...base, kind });
    case 'DistributorFunded':
      return parseDistributorFunded(body, { ...base, kind });
  }
}

// Exported for unit tests.
export const __test__ = {
  eventDiscriminator,
  parseProgramDataLog,
  decodeProgramData,
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface FetchEventsOptions {
  /** Max signatures to scan. Default 50. */
  limit?: number;
  /** Restrict to a specific event kind. */
  kind?: Layer8EventKind;
  /** Minimum block time (Unix seconds) — events older are skipped. */
  sinceUnixSeconds?: number;
}

/**
 * Scan recent transactions for a program account and parse Layer 8 events.
 *
 * Caller passes the program ID (or any account that participates in the
 * relevant ix — typically the program itself or a high-traffic PDA).
 * Returns events in newest-first order.
 */
export async function fetchEvents(
  connection: Connection,
  watchAddress: PublicKey,
  options: FetchEventsOptions = {},
): Promise<Layer8Event[]> {
  const limit = options.limit ?? 50;
  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await connection.getSignaturesForAddress(watchAddress, { limit });
  } catch {
    return [];
  }

  const out: Layer8Event[] = [];
  for (const sig of sigs) {
    if (sig.err) continue;
    if (
      options.sinceUnixSeconds !== undefined &&
      sig.blockTime !== null &&
      sig.blockTime !== undefined &&
      sig.blockTime < options.sinceUnixSeconds
    ) {
      continue;
    }
    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await connection.getParsedTransaction(sig.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      continue;
    }
    const logs = tx?.meta?.logMessages ?? [];
    const base: BaseEvent = {
      kind: 'DistributorFunded', // overwritten by parser
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? null,
    };
    for (const line of logs) {
      const ev = await parseProgramDataLog(line, base);
      if (!ev) continue;
      if (options.kind && ev.kind !== options.kind) continue;
      out.push(ev);
    }
  }
  return out;
}

/**
 * Convenience wrapper: type-narrowed result for `StreamConverted` events
 * filtered (optionally) by OT mint.
 */
export async function fetchStreamConvertedEvents(
  connection: Connection,
  ydProgramId: PublicKey,
  otMint?: PublicKey,
  options: Omit<FetchEventsOptions, 'kind'> = {},
): Promise<StreamConvertedEvent[]> {
  const events = await fetchEvents(connection, ydProgramId, {
    ...options,
    kind: 'StreamConverted',
  });
  const otMintStr = otMint?.toBase58();
  return events
    .filter((e): e is StreamConvertedEvent => e.kind === 'StreamConverted')
    .filter((e) => !otMintStr || e.otMint === otMintStr);
}

export async function fetchYieldDistributedEvents(
  connection: Connection,
  rwtEngineProgramId: PublicKey,
  otMint?: PublicKey,
  options: Omit<FetchEventsOptions, 'kind'> = {},
): Promise<YieldDistributedEvent[]> {
  const events = await fetchEvents(connection, rwtEngineProgramId, {
    ...options,
    kind: 'YieldDistributed',
  });
  const otMintStr = otMint?.toBase58();
  return events
    .filter((e): e is YieldDistributedEvent => e.kind === 'YieldDistributed')
    .filter((e) => !otMintStr || e.otMint === otMintStr);
}

export async function fetchCompoundYieldEvents(
  connection: Connection,
  dexProgramId: PublicKey,
  options: Omit<FetchEventsOptions, 'kind'> = {},
): Promise<CompoundYieldExecutedEvent[]> {
  const events = await fetchEvents(connection, dexProgramId, {
    ...options,
    kind: 'CompoundYieldExecuted',
  });
  return events.filter(
    (e): e is CompoundYieldExecutedEvent => e.kind === 'CompoundYieldExecuted',
  );
}

export async function fetchTreasuryYieldEvents(
  connection: Connection,
  otProgramId: PublicKey,
  options: Omit<FetchEventsOptions, 'kind'> = {},
): Promise<TreasuryYieldClaimedEvent[]> {
  const events = await fetchEvents(connection, otProgramId, {
    ...options,
    kind: 'TreasuryYieldClaimed',
  });
  return events.filter(
    (e): e is TreasuryYieldClaimedEvent => e.kind === 'TreasuryYieldClaimed',
  );
}

// -----------------------------------------------------------------------------
// On-chain account readers (IDL-aware; pinned to contract state.rs layouts)
// -----------------------------------------------------------------------------

/**
 * Parsed RwtVault state. Layout pinned to
 * `contracts/rwt-engine/src/state.rs::RwtVault` (267 bytes total = 8 disc +
 * 259 body). If the contract struct changes, this reader and the bot's
 * counterpart in `bots/convert-and-fund-crank/src/readers.ts` must change
 * together.
 */
export interface RwtVaultState {
  totalInvestedCapital: bigint;
  totalRwtSupply: bigint;
  navBookValue: bigint;
  capitalAccumulatorAta: string;
  rwtMint: string;
  authority: string;
  manager: string;
  /**
   * Areal DAO fee destination. Doubles as the `dao_fee_account` slot referenced
   * by `convert_to_rwt` and `mint_rwt` — the contract has a single field with
   * two semantic names (`vault.areal_fee_destination` is the storage; the
   * `mint_rwt` instruction context names the corresponding account
   * `dao_fee_account` and validates `addr == vault.areal_fee_destination`).
   *
   * SD-22 plan called for adding a separate `daoFeeAccount` field; the
   * contract source of truth (rwt-engine/src/state.rs:25) ships them as one
   * field. Surfacing both names would diverge from the on-chain layout — we
   * keep the single field and document the dual role here.
   *
   * Pinned to byte 226 of the RwtVault account body (offset 226..258 = 32B).
   */
  arealFeeDestination: string;
  bump: number;
}

/**
 * Alias accessor for the `dao_fee_account` semantic name used by
 * `convert_to_rwt` callers. SD-22: the underlying field is
 * `arealFeeDestination` per contract layout — see RwtVaultState JSDoc.
 */
export function getRwtDaoFeeAccount(vault: RwtVaultState): string {
  return vault.arealFeeDestination;
}

/**
 * Read and parse the singleton `RwtVault` PDA. Returns null if the PDA hasn't
 * been initialized.
 *
 * Body layout (offsets after 8-byte discriminator):
 *   0..16   total_invested_capital (u128 LE)
 *   16..24  total_rwt_supply        (u64  LE)
 *   24..32  nav_book_value          (u64  LE)
 *   32..64  capital_accumulator_ata ([u8;32])
 *   64..96  rwt_mint                ([u8;32])
 *   96..128 authority               ([u8;32])
 *   128..160 pending_authority      ([u8;32])
 *   160     has_pending             (bool)
 *   161..193 manager                ([u8;32])
 *   193..225 pause_authority        ([u8;32])
 *   225     mint_paused             (bool)
 *   226..258 areal_fee_destination  ([u8;32])
 *   258     bump                    (u8)
 */
export async function readRwtVault(
  connection: Connection,
  pda: PublicKey,
): Promise<RwtVaultState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  if (info.data.length < 8 + 259) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    totalInvestedCapital: view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n),
    totalRwtSupply: view.getBigUint64(16, true),
    navBookValue: view.getBigUint64(24, true),
    capitalAccumulatorAta: readPubkey(body, 32),
    rwtMint: readPubkey(body, 64),
    authority: readPubkey(body, 96),
    manager: readPubkey(body, 161),
    arealFeeDestination: readPubkey(body, 226),
    bump: body[258],
  };
}

/**
 * Parsed `RwtDistributionConfig` singleton.
 * Layout pinned to `contracts/rwt-engine/src/state.rs::RwtDistributionConfig`
 * (79 bytes total = 8 disc + 71 body):
 *   0..2    book_value_bps              (u16 LE)
 *   2..4    liquidity_bps               (u16 LE)
 *   4..6    protocol_revenue_bps        (u16 LE)
 *   6..38   liquidity_destination       ([u8;32])
 *   38..70  protocol_revenue_destination([u8;32])
 *   70      bump                        (u8)
 */
export interface RwtDistributionConfigState {
  bookValueBps: number;
  liquidityBps: number;
  protocolRevenueBps: number;
  liquidityDestination: string;
  protocolRevenueDestination: string;
  bump: number;
}

export async function readRwtDistributionConfig(
  connection: Connection,
  pda: PublicKey,
): Promise<RwtDistributionConfigState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  if (info.data.length < 8 + 71) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    bookValueBps: view.getUint16(0, true),
    liquidityBps: view.getUint16(2, true),
    protocolRevenueBps: view.getUint16(4, true),
    liquidityDestination: readPubkey(body, 6),
    protocolRevenueDestination: readPubkey(body, 38),
    bump: body[70],
  };
}

/**
 * Parsed `MerkleDistributor` state (per-OT).
 * Layout pinned to `contracts/yield-distribution/src/state.rs::MerkleDistributor`
 * (194 bytes total = 8 disc + 186 body).
 */
export interface MerkleDistributorState {
  otMint: string;
  rewardVault: string;
  accumulator: string;
  merkleRoot: Uint8Array;
  maxTotalClaim: bigint;
  totalClaimed: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  lastFundTs: bigint;
  vestingPeriodSecs: bigint;
  epoch: bigint;
  isActive: boolean;
  bump: number;
}

export async function readMerkleDistributor(
  connection: Connection,
  pda: PublicKey,
): Promise<MerkleDistributorState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  if (info.data.length < 8 + 186) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    otMint: readPubkey(body, 0),
    rewardVault: readPubkey(body, 32),
    accumulator: readPubkey(body, 64),
    merkleRoot: body.slice(96, 128),
    maxTotalClaim: view.getBigUint64(128, true),
    totalClaimed: view.getBigUint64(136, true),
    totalFunded: view.getBigUint64(144, true),
    lockedVested: view.getBigUint64(152, true),
    lastFundTs: view.getBigInt64(160, true),
    vestingPeriodSecs: view.getBigInt64(168, true),
    epoch: view.getBigUint64(176, true),
    isActive: body[184] !== 0,
    bump: body[185],
  };
}

/**
 * Parsed YD `DistributionConfig` singleton.
 * Layout pinned to `contracts/yield-distribution/src/state.rs::DistributionConfig`
 * (149 bytes total = 8 disc + 141 body).
 */
export interface DistributionConfigState {
  authority: string;
  publishAuthority: string;
  protocolFeeBps: number;
  minDistributionAmount: bigint;
  arealFeeDestination: string;
  isActive: boolean;
  bump: number;
}

export async function readDistributionConfig(
  connection: Connection,
  pda: PublicKey,
): Promise<DistributionConfigState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  if (info.data.length < 8 + 141) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    authority: readPubkey(body, 0),
    // pending_authority at 32..64, has_pending at 64
    publishAuthority: readPubkey(body, 65),
    protocolFeeBps: view.getUint16(97, true),
    minDistributionAmount: view.getBigUint64(99, true),
    arealFeeDestination: readPubkey(body, 107),
    isActive: body[139] !== 0,
    bump: body[140],
  };
}

// -----------------------------------------------------------------------------
// LiquidityHolding state reader
// -----------------------------------------------------------------------------

export interface LiquidityHoldingState {
  pda: string;
  initialized: boolean;
  bump: number;
  totalReceived: bigint;
  totalWithdrawn: bigint;
  lastFundedSlot: bigint;
}

/**
 * Read the singleton LiquidityHolding PDA state (Layer 8 §2.1, D11.1).
 * Layout pinned at 58 bytes data + 8 disc:
 *   bump u8 | initialized u8 | total_received u64 | total_withdrawn u64
 *   | last_funded_slot u64 | _reserved [u8;32]
 * Returns null when the PDA hasn't been initialized.
 */
export async function readLiquidityHoldingState(
  connection: Connection,
  pda: PublicKey,
): Promise<LiquidityHoldingState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  // 8 (disc) + 58 (data) = 66 bytes minimum
  if (info.data.length < 66) return null;
  const data = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pda: pda.toBase58(),
    bump: data[0],
    initialized: data[1] !== 0,
    totalReceived: view.getBigUint64(2, true),
    totalWithdrawn: view.getBigUint64(10, true),
    lastFundedSlot: view.getBigUint64(18, true),
  };
}

// -----------------------------------------------------------------------------
// Crank heartbeat (HTTP)
// -----------------------------------------------------------------------------

export type CrankName = 'revenue' | 'convert-and-fund' | 'yield-claim';
export type CrankStatus = 'running' | 'stopped' | 'unreachable';

export interface CrankHealth {
  name: CrankName;
  status: CrankStatus;
  lastRunTs: number | null;
  version: string | null;
  error: string | null;
  /** Last raw payload, useful for debug. */
  raw?: Record<string, unknown>;
}

/**
 * Fetch heartbeat from a crank's HTTP endpoint.
 *
 * Per architecture §11.1, each crank exposes
 * `GET /heartbeat → { lastRunTs, status, version }`. Endpoints are read from
 * env vars (`PUBLIC_CRANK_<NAME>_URL`); if missing, the call returns
 * `unreachable`. NEVER hardcode local URLs.
 */
export async function fetchCrankHealth(
  name: CrankName,
  endpointUrl: string | undefined,
): Promise<CrankHealth> {
  if (!endpointUrl) {
    return {
      name,
      status: 'unreachable',
      lastRunTs: null,
      version: null,
      error: 'No endpoint configured',
    };
  }
  try {
    const res = await fetch(`${endpointUrl}/heartbeat`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        name,
        status: 'unreachable',
        lastRunTs: null,
        version: null,
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const lastRunTsRaw = json.lastRunTs;
    const status = (json.status as CrankStatus) ?? 'stopped';
    return {
      name,
      status,
      lastRunTs: typeof lastRunTsRaw === 'number' ? lastRunTsRaw : null,
      version: typeof json.version === 'string' ? json.version : null,
      error: null,
      raw: json,
    };
  } catch (err) {
    return {
      name,
      status: 'unreachable',
      lastRunTs: null,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// Merkle proof fetcher (proof-store HTTP)
// -----------------------------------------------------------------------------

export interface MerkleProof {
  distributor: string;
  epoch: number;
  holder: string;
  cumulativeAmount: string; // bigint as decimal string
  proof: string[]; // hex
  merkleRoot: string; // hex
  publishedAt: number;
}

/**
 * Fetch a published Merkle proof from the merkle-publisher proof-store HTTP
 * endpoint.
 *
 * The publisher exposes `GET /proofs/<distributor>/<holder>` returning
 * `HolderProof` (see `bots/merkle-publisher/src/types.ts`).
 */
export async function fetchMerkleProof(
  proofStoreUrl: string,
  distributor: PublicKey,
  holder: PublicKey,
): Promise<MerkleProof | null> {
  try {
    const res = await fetch(
      `${proofStoreUrl}/proofs/${distributor.toBase58()}/${holder.toBase58()}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as MerkleProof;
    return json;
  } catch {
    return null;
  }
}
