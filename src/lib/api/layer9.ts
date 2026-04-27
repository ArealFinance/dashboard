/**
 * Layer 9 API client (Liquidity Nexus)
 * =====================================
 *
 * Browser-side TypeScript client for the Layer 9 Liquidity Nexus subsystem
 * exposed by the Native DEX program. Mirrors `layer8.ts` shape:
 *
 *   - `TransactionInstruction` builders (10 handlers — minus the internal
 *     `nexus_record_deposit` which is CPI-only and intentionally NOT
 *     exposed; see comment below).
 *   - On-chain account readers (`LiquidityNexus`, `LpPosition`).
 *   - Event parsers for the 6 Layer 9 events.
 *   - Heartbeat helper for the Nexus Manager bot.
 *
 * Discriminators:
 *   - Instructions: `sha256("global:<snake_name>")[..8]` (Anchor / Arlex
 *     convention). Computed lazily via Web Crypto, cached per-name.
 *   - Events: `sha256("event:<EventName>")[..8]`.
 *
 * Account-list orderings are taken verbatim from the on-chain handlers in
 * `contracts/native-dex/src/instructions/`. The unit test suite pins each
 * handler's discriminator and account-list shape so a refactor cannot
 * silently regress wire-compat.
 *
 * # USDC mint resolution (M-1) — display hint, not a builder switch
 *
 * `resolveUsdcSide(tokenAMint, tokenBMint, usdcMint)` returns 'a' / 'b' /
 * null and is used **only for UI display** (banner: "USDC is on side B"
 * etc.). The ix builders themselves are mint-agnostic: callers pass the
 * already-resolved Nexus-owned ATAs for `nexusTokenA` / `nexusTokenB` (or
 * `nexusTokenIn` / `nexusTokenOut` for swap), and the same builder works
 * for both A=USDC and B=USDC pools without branching. The closure of
 * Substep 8's M-1 hardcode is the ATA-agnostic builder shape, NOT a
 * conditional inside the builder.
 *
 * # MAINNET-REPLACE
 *
 * `PUBLIC_USDC_MINT` is set per deployment. Devnet uses
 * `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (placeholder); mainnet
 * release MUST replace via env var. No mint is hard-coded in this module.
 */
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
  TransactionInstruction,
} from '@solana/web3.js';
import { bytesToBase58 } from '$lib/utils/format';

// -----------------------------------------------------------------------------
// Discriminator helpers
// -----------------------------------------------------------------------------

/**
 * Compute Anchor-style instruction discriminator
 * (`sha256("global:<snake_name>")[..8]`). Lazy + cached.
 */
const ixDiscCache = new Map<string, Uint8Array>();
async function ixDiscriminator(snakeName: string): Promise<Uint8Array> {
  const existing = ixDiscCache.get(snakeName);
  if (existing) return existing;
  const data = new TextEncoder().encode(`global:${snakeName}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const out = new Uint8Array(hash).subarray(0, 8);
  ixDiscCache.set(snakeName, out);
  return out;
}

/**
 * Compute Anchor-style event discriminator
 * (`sha256("event:<EventName>")[..8]`). Lazy + cached.
 */
const eventDiscCache = new Map<string, Uint8Array>();
async function eventDiscriminator(name: string): Promise<Uint8Array> {
  const existing = eventDiscCache.get(name);
  if (existing) return existing;
  const data = new TextEncoder().encode(`event:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const out = new Uint8Array(hash).subarray(0, 8);
  eventDiscCache.set(name, out);
  return out;
}

// Convenience exports — callers (and tests) re-derive without recomputing.
export const discInitializeNexus = (): Promise<Uint8Array> =>
  ixDiscriminator('initialize_nexus');
export const discUpdateNexusManager = (): Promise<Uint8Array> =>
  ixDiscriminator('update_nexus_manager');
export const discNexusSwap = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_swap');
export const discNexusAddLiquidity = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_add_liquidity');
export const discNexusRemoveLiquidity = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_remove_liquidity');
export const discNexusDeposit = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_deposit');
export const discNexusWithdrawProfits = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_withdraw_profits');
export const discNexusClaimRewards = (): Promise<Uint8Array> =>
  ixDiscriminator('nexus_claim_rewards');
export const discClaimLpFees = (): Promise<Uint8Array> =>
  ixDiscriminator('claim_lp_fees');

// NOTE: `nexus_record_deposit` is intentionally NOT exposed as an ix builder
// here. Per Layer 9 §4.9 / D25, that handler is invoked via CPI from the
// Yield Distribution program's `withdraw_liquidity_holding` only — direct
// invocation by an external signer is rejected on-chain by the framework's
// program-id signer check. Surfacing a builder would mislead operators
// into building reverting transactions; keep the handler internal.

// -----------------------------------------------------------------------------
// Constants (program-side)
// -----------------------------------------------------------------------------

/** SPL Token program ID. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/** System program ID. */
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Token-kind tags — mirror `contracts/native-dex/src/constants.rs`. */
export const TOKEN_KIND_USDC = 0;
export const TOKEN_KIND_RWT = 1;

/** Source-kind tags emitted in `NexusDeposited.source_kind`. */
export const NEXUS_DEPOSIT_SOURCE_DIRECT = 0;
export const NEXUS_DEPOSIT_SOURCE_LIQUIDITY_HOLDING = 1;

/** Manager kill-switch sentinel — the all-zero pubkey (D22). */
export const NEXUS_MANAGER_KILL_SWITCH_BASE58 = '11111111111111111111111111111111';

// -----------------------------------------------------------------------------
// Codec helpers
// -----------------------------------------------------------------------------

function writeU64LE(buf: Uint8Array, off: number, value: bigint): void {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  view.setBigUint64(0, value, true);
}

function writeU128LE(buf: Uint8Array, off: number, value: bigint): void {
  // Pack low 64 bits first (LE), then high 64 bits.
  const low = value & 0xffffffffffffffffn;
  const high = (value >> 64n) & 0xffffffffffffffffn;
  const view = new DataView(buf.buffer, buf.byteOffset + off, 16);
  view.setBigUint64(0, low, true);
  view.setBigUint64(8, high, true);
}

function readU64LE(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return view.getBigUint64(0, true);
}

function readU128LE(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 16);
  const low = view.getBigUint64(0, true);
  const high = view.getBigUint64(8, true);
  return (high << 64n) | low;
}

function readI64LE(buf: Uint8Array, off: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return view.getBigInt64(0, true);
}

function readPubkey(buf: Uint8Array, off: number): string {
  return bytesToBase58(buf.subarray(off, off + 32));
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
// Instruction builders
// -----------------------------------------------------------------------------
//
// Each builder mirrors the on-chain Accounts struct from
// `contracts/native-dex/src/instructions/<ix>.rs`. Account ordering matches
// the on-chain `#[derive(Accounts)]` field order — handlers index by
// position, NOT name, so order is load-bearing. Pinned by unit tests.
// -----------------------------------------------------------------------------

// --- initialize_nexus (Authority) ---

export interface BuildInitializeNexusArgs {
  dexProgramId: PublicKey;
  authority: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  /** Initial Manager wallet (32-byte pubkey). May be the zero kill-switch. */
  manager: Uint8Array;
}

/**
 * Build `initialize_nexus`. Layer 9 §4.1.
 * Args: `[manager: [u8; 32]]` (32 bytes after disc).
 * Accounts: `authority(s,m), dex_config, liquidity_nexus(init), system_program`.
 */
export async function buildInitializeNexusIx(
  args: BuildInitializeNexusArgs,
): Promise<TransactionInstruction> {
  if (args.manager.length !== 32) {
    throw new Error(
      `manager must be 32 bytes, got ${args.manager.length}`,
    );
  }
  const disc = await discInitializeNexus();
  const data = concatBytes(disc, args.manager);

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- update_nexus_manager (Authority) ---

export interface BuildUpdateNexusManagerArgs {
  dexProgramId: PublicKey;
  authority: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  /**
   * New Manager pubkey (32 bytes). Pass the zero pubkey to engage the
   * kill-switch (D22) — every Manager-gated ix will then revert until
   * Authority rotates to a non-zero key.
   */
  newManager: Uint8Array;
}

/**
 * Build `update_nexus_manager`. Layer 9 §4.8.
 * Args: `[new_manager: [u8; 32]]` (32 bytes after disc).
 * Accounts: `authority(s), dex_config, liquidity_nexus(m)`.
 *
 * D22 kill-switch: the on-chain handler accepts `new_manager == [0u8; 32]`
 * unconditionally. UI should surface a confirm modal in that path.
 */
export async function buildUpdateNexusManagerIx(
  args: BuildUpdateNexusManagerArgs,
): Promise<TransactionInstruction> {
  if (args.newManager.length !== 32) {
    throw new Error(
      `newManager must be 32 bytes, got ${args.newManager.length}`,
    );
  }
  const disc = await discUpdateNexusManager();
  const data = concatBytes(disc, args.newManager);

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
    ],
  });
}

// --- nexus_swap (Manager) ---

export interface BuildNexusSwapArgs {
  dexProgramId: PublicKey;
  manager: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  poolState: PublicKey;
  /** Nexus-owned ATA holding the input token. */
  nexusTokenIn: PublicKey;
  /** Nexus-owned ATA receiving the output token. */
  nexusTokenOut: PublicKey;
  /** Pool vault matching `pool.vault_a/b` per `aToB` flag. */
  vaultIn: PublicKey;
  vaultOut: PublicKey;
  /** Areal Finance protocol fee destination (RWT ATA). */
  arealFeeAccount: PublicKey;

  amountIn: bigint;
  minAmountOut: bigint;
  aToB: boolean;
}

/**
 * Build `nexus_swap`. Layer 9 §4.3.
 * Args: `[amount_in: u64, min_amount_out: u64, a_to_b: bool]` (17 bytes).
 * Accounts (10):
 *   manager(s), dex_config, liquidity_nexus(m), pool_state(m),
 *   nexus_token_in(m), nexus_token_out(m), vault_in(m), vault_out(m),
 *   areal_fee_account(m), token_program.
 */
export async function buildNexusSwapIx(
  args: BuildNexusSwapArgs,
): Promise<TransactionInstruction> {
  const disc = await discNexusSwap();
  const data = new Uint8Array(8 + 8 + 8 + 1);
  data.set(disc, 0);
  writeU64LE(data, 8, args.amountIn);
  writeU64LE(data, 16, args.minAmountOut);
  data[24] = args.aToB ? 1 : 0;

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.manager, isSigner: true, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenIn, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenOut, isSigner: false, isWritable: true },
      { pubkey: args.vaultIn, isSigner: false, isWritable: true },
      { pubkey: args.vaultOut, isSigner: false, isWritable: true },
      { pubkey: args.arealFeeAccount, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- nexus_add_liquidity (Manager) ---

export interface BuildNexusAddLiquidityArgs {
  dexProgramId: PublicKey;
  manager: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  poolState: PublicKey;
  /** Nexus's LpPosition PDA (`["lp", pool_state, liquidity_nexus]`). */
  lpPosition: PublicKey;
  nexusTokenA: PublicKey;
  nexusTokenB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;

  amountA: bigint;
  amountB: bigint;
  minShares: bigint;
}

/**
 * Build `nexus_add_liquidity`. Layer 9 §4.4.
 * Args: `[amount_a: u64, amount_b: u64, min_shares: u128]` (32 bytes).
 * Accounts (11):
 *   manager(s,m), dex_config, liquidity_nexus(m), pool_state(m),
 *   lp_position(m), nexus_token_a(m), nexus_token_b(m), vault_a(m),
 *   vault_b(m), token_program, system_program.
 */
export async function buildNexusAddLiquidityIx(
  args: BuildNexusAddLiquidityArgs,
): Promise<TransactionInstruction> {
  const disc = await discNexusAddLiquidity();
  const data = new Uint8Array(8 + 8 + 8 + 16);
  data.set(disc, 0);
  writeU64LE(data, 8, args.amountA);
  writeU64LE(data, 16, args.amountB);
  writeU128LE(data, 24, args.minShares);

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.manager, isSigner: true, isWritable: true },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.lpPosition, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenA, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenB, isSigner: false, isWritable: true },
      { pubkey: args.vaultA, isSigner: false, isWritable: true },
      { pubkey: args.vaultB, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- nexus_remove_liquidity (Manager) ---

export interface BuildNexusRemoveLiquidityArgs {
  dexProgramId: PublicKey;
  manager: PublicKey;
  liquidityNexus: PublicKey;
  poolState: PublicKey;
  lpPosition: PublicKey;
  nexusTokenA: PublicKey;
  nexusTokenB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;

  sharesToBurn: bigint;
}

/**
 * Build `nexus_remove_liquidity`. Layer 9 §4.5.
 * Args: `[shares_to_burn: u128]` (16 bytes).
 * Accounts (9):
 *   manager(s), liquidity_nexus(m), pool_state(m), lp_position(m),
 *   nexus_token_a(m), nexus_token_b(m), vault_a(m), vault_b(m),
 *   token_program.
 */
export async function buildNexusRemoveLiquidityIx(
  args: BuildNexusRemoveLiquidityArgs,
): Promise<TransactionInstruction> {
  const disc = await discNexusRemoveLiquidity();
  const data = new Uint8Array(8 + 16);
  data.set(disc, 0);
  writeU128LE(data, 8, args.sharesToBurn);

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.manager, isSigner: true, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.lpPosition, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenA, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenB, isSigner: false, isWritable: true },
      { pubkey: args.vaultA, isSigner: false, isWritable: true },
      { pubkey: args.vaultB, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- nexus_deposit (Permissionless) ---

export interface BuildNexusDepositArgs {
  dexProgramId: PublicKey;
  depositor: PublicKey;
  liquidityNexus: PublicKey;
  /** Source ATA owned by the depositor wallet. */
  depositorTokenAta: PublicKey;
  /** Destination ATA owned by the Nexus PDA at the SPL level. */
  nexusTokenAta: PublicKey;

  amount: bigint;
  /** TOKEN_KIND_USDC (0) or TOKEN_KIND_RWT (1). */
  tokenKind: number;
}

/**
 * Build `nexus_deposit`. Layer 9 §4.2.
 * Args: `[amount: u64, token_kind: u8]` (9 bytes).
 *
 * Accounts (4 named + 1 in remainingAccounts):
 *   depositor(s,m), liquidity_nexus(m), depositor_token_ata(m),
 *   nexus_token_ata(m), [token_program in remainingAccounts].
 *
 * Token-program is passed via `remainingAccounts` because the on-chain
 * Accounts struct intentionally omits a named field for it (BPF stack-frame
 * budget — pinocchio_token hardcodes the program ID, runtime needs the
 * account loaded but the dispatcher saves a slot by not naming it).
 */
export async function buildNexusDepositIx(
  args: BuildNexusDepositArgs,
): Promise<TransactionInstruction> {
  if (args.tokenKind !== TOKEN_KIND_USDC && args.tokenKind !== TOKEN_KIND_RWT) {
    throw new Error(
      `tokenKind must be TOKEN_KIND_USDC (0) or TOKEN_KIND_RWT (1), got ${args.tokenKind}`,
    );
  }
  const disc = await discNexusDeposit();
  const data = new Uint8Array(8 + 8 + 1);
  data.set(disc, 0);
  writeU64LE(data, 8, args.amount);
  data[16] = args.tokenKind & 0xff;

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.depositorTokenAta, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenAta, isSigner: false, isWritable: true },
      // remaining_accounts — token_program (see header note).
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- nexus_withdraw_profits (Authority) ---

export interface BuildNexusWithdrawProfitsArgs {
  dexProgramId: PublicKey;
  authority: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  /** Nexus-owned source ATA. */
  nexusTokenAta: PublicKey;
  /** Treasury recipient ATA (matching mint). */
  recipientTokenAta: PublicKey;

  amount: bigint;
  tokenKind: number;
}

/**
 * Build `nexus_withdraw_profits`. Layer 9 §4.6.
 * Args: `[amount: u64, token_kind: u8]` (9 bytes).
 *
 * Accounts (5 named + 1 in remainingAccounts):
 *   authority(s), dex_config, liquidity_nexus(m), nexus_token_ata(m),
 *   recipient_token_ata(m), [token_program in remainingAccounts].
 *
 * Same BPF stack-frame rationale as `nexus_deposit` — token_program goes
 * via remainingAccounts (see handler header note).
 */
export async function buildNexusWithdrawProfitsIx(
  args: BuildNexusWithdrawProfitsArgs,
): Promise<TransactionInstruction> {
  if (args.tokenKind !== TOKEN_KIND_USDC && args.tokenKind !== TOKEN_KIND_RWT) {
    throw new Error(
      `tokenKind must be TOKEN_KIND_USDC (0) or TOKEN_KIND_RWT (1), got ${args.tokenKind}`,
    );
  }
  const disc = await discNexusWithdrawProfits();
  const data = new Uint8Array(8 + 8 + 1);
  data.set(disc, 0);
  writeU64LE(data, 8, args.amount);
  data[16] = args.tokenKind & 0xff;

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenAta, isSigner: false, isWritable: true },
      { pubkey: args.recipientTokenAta, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// --- nexus_claim_rewards (Authority) ---

export interface BuildNexusClaimRewardsArgs {
  dexProgramId: PublicKey;
  authority: PublicKey;
  dexConfig: PublicKey;
  liquidityNexus: PublicKey;
  poolState: PublicKey;
  lpPosition: PublicKey;
  poolVaultA: PublicKey;
  poolVaultB: PublicKey;
  nexusTokenAAta: PublicKey;
  nexusTokenBAta: PublicKey;
}

/**
 * Build `nexus_claim_rewards`. Layer 9 §4.7.
 * Args: none (just the 8-byte discriminator).
 *
 * Accounts (9 named, NO token_program):
 *   authority(s), dex_config, liquidity_nexus(m), pool_state(m),
 *   lp_position(m), pool_vault_a(m), pool_vault_b(m), nexus_token_a_ata(m),
 *   nexus_token_b_ata(m).
 *
 * Per the on-chain handler quirk (see `nexus_claim_rewards.rs:107-114`),
 * the `token_program` slot in `ClaimLpFeesAccountsView` is wired to
 * `liquidity_nexus` — pinocchio_token never reads it at runtime.
 */
export async function buildNexusClaimRewardsIx(
  args: BuildNexusClaimRewardsArgs,
): Promise<TransactionInstruction> {
  const disc = await discNexusClaimRewards();

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(disc),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.dexConfig, isSigner: false, isWritable: false },
      { pubkey: args.liquidityNexus, isSigner: false, isWritable: true },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.lpPosition, isSigner: false, isWritable: true },
      { pubkey: args.poolVaultA, isSigner: false, isWritable: true },
      { pubkey: args.poolVaultB, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenAAta, isSigner: false, isWritable: true },
      { pubkey: args.nexusTokenBAta, isSigner: false, isWritable: true },
    ],
  });
}

// --- claim_lp_fees (Permissionless / user-facing) ---

export interface BuildClaimLpFeesArgs {
  dexProgramId: PublicKey;
  recipient: PublicKey;
  poolState: PublicKey;
  lpPosition: PublicKey;
  poolVaultA: PublicKey;
  poolVaultB: PublicKey;
  recipientTokenAAta: PublicKey;
  recipientTokenBAta: PublicKey;
}

/**
 * Build `claim_lp_fees`. Layer 9 D28 — user-facing companion to
 * `nexus_claim_rewards`. Recipient is the LpPosition.owner (Tx signer).
 *
 * Args: none.
 * Accounts (8):
 *   recipient(s), pool_state(m), lp_position(m), pool_vault_a(m),
 *   pool_vault_b(m), recipient_token_a_ata(m), recipient_token_b_ata(m),
 *   token_program.
 */
export async function buildClaimLpFeesIx(
  args: BuildClaimLpFeesArgs,
): Promise<TransactionInstruction> {
  const disc = await discClaimLpFees();

  return new TransactionInstruction({
    programId: args.dexProgramId,
    data: Buffer.from(disc),
    keys: [
      { pubkey: args.recipient, isSigner: true, isWritable: false },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.lpPosition, isSigner: false, isWritable: true },
      { pubkey: args.poolVaultA, isSigner: false, isWritable: true },
      { pubkey: args.poolVaultB, isSigner: false, isWritable: true },
      { pubkey: args.recipientTokenAAta, isSigner: false, isWritable: true },
      { pubkey: args.recipientTokenBAta, isSigner: false, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

// -----------------------------------------------------------------------------
// USDC-side helper (M-1)
// -----------------------------------------------------------------------------

/**
 * Resolve which side (A or B) of a pool is USDC by comparing pool mints
 * to the configured USDC mint. Returns `'a'` if `tokenAMint == usdcMint`,
 * `'b'` if `tokenBMint == usdcMint`, or `null` if neither side is USDC.
 *
 * Callers use this to wire the correct Nexus-owned ATA into
 * `nexus_swap` / `nexus_add_liquidity` — the on-chain pool field order
 * is opaque from the call site, so the dashboard derives it.
 */
export function resolveUsdcSide(
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  usdcMint: PublicKey,
): 'a' | 'b' | null {
  if (tokenAMint.equals(usdcMint)) return 'a';
  if (tokenBMint.equals(usdcMint)) return 'b';
  return null;
}

// -----------------------------------------------------------------------------
// Account readers
// -----------------------------------------------------------------------------

/**
 * Parsed `LiquidityNexus` state. Layout pinned to
 * `contracts/native-dex/src/state.rs::LiquidityNexus` (50 bytes data).
 *
 * Body offsets (after 8-byte discriminator):
 *   0..32   manager                ([u8; 32])
 *   32..40  total_deposited_usdc   (u64 LE)
 *   40..48  total_deposited_rwt    (u64 LE)
 *   48      is_active              (u8 / bool)
 *   49      bump                   (u8)
 */
export interface LiquidityNexusState {
  pda: string;
  manager: string;
  /** True iff `manager == [0u8; 32]` — D22 kill-switch is engaged. */
  killSwitchEngaged: boolean;
  /**
   * Cumulative USDC deposited (monotonically non-decreasing).
   * Acts as principal floor for `nexus_withdraw_profits` (USDC kind).
   */
  totalDepositedUsdc: bigint;
  totalDepositedRwt: bigint;
  isActive: boolean;
  bump: number;
}

export async function readLiquidityNexus(
  connection: Connection,
  pda: PublicKey,
): Promise<LiquidityNexusState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  // 8 (disc) + 50 (data) = 58 bytes minimum.
  if (info.data.length < 58) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  const manager = readPubkey(body, 0);
  return {
    pda: pda.toBase58(),
    manager,
    killSwitchEngaged: manager === NEXUS_MANAGER_KILL_SWITCH_BASE58,
    totalDepositedUsdc: readU64LE(body, 32),
    totalDepositedRwt: readU64LE(body, 40),
    isActive: body[48] !== 0,
    bump: body[49],
  };
}

/**
 * Parsed `LpPosition` state (Layer 9 D28 layout — 121 bytes data).
 *
 * Body offsets (after 8-byte discriminator):
 *   0..32   pool                       ([u8; 32])
 *   32..64  owner                      ([u8; 32])
 *   64..80  shares                     (u128 LE)
 *   80..88  last_update_ts             (i64 LE)
 *   88      bump                       (u8)
 *   89..105 fees_claimed_per_share_a   (u128 Q64.64 LE)
 *   105..121 fees_claimed_per_share_b  (u128 Q64.64 LE)
 */
export interface LpPositionState {
  pda: string;
  pool: string;
  owner: string;
  shares: bigint;
  lastUpdateTs: bigint;
  bump: number;
  feesClaimedPerShareA: bigint;
  feesClaimedPerShareB: bigint;
}

export async function readLpPosition(
  connection: Connection,
  pda: PublicKey,
): Promise<LpPositionState | null> {
  let info;
  try {
    info = await connection.getAccountInfo(pda, 'confirmed');
  } catch {
    return null;
  }
  if (!info) return null;
  if (info.data.length < 8 + 121) return null;
  const body = new Uint8Array(
    info.data.buffer,
    info.data.byteOffset + 8,
    info.data.byteLength - 8,
  );
  return {
    pda: pda.toBase58(),
    pool: readPubkey(body, 0),
    owner: readPubkey(body, 32),
    shares: readU128LE(body, 64),
    lastUpdateTs: readI64LE(body, 80),
    bump: body[88],
    feesClaimedPerShareA: readU128LE(body, 89),
    feesClaimedPerShareB: readU128LE(body, 105),
  };
}

/**
 * Compute pending claimable fees for a given LpPosition against a pool's
 * current cumulative-fee accumulator. Mirrors the on-chain math:
 *
 *   delta_q64 = pool.cumulative_fees_per_share - lp.fees_claimed_per_share
 *   claimable = (delta_q64 * shares) >> 64
 *
 * Returns `0n` if the snapshot is at or above the cumulative (zero-pending,
 * no-op claim).
 */
export function computeClaimable(
  cumulativePerShareQ64: bigint,
  feesClaimedPerShareQ64: bigint,
  shares: bigint,
): bigint {
  if (cumulativePerShareQ64 <= feesClaimedPerShareQ64) return 0n;
  const delta = cumulativePerShareQ64 - feesClaimedPerShareQ64;
  return (delta * shares) >> 64n;
}

// -----------------------------------------------------------------------------
// Event types and parser
// -----------------------------------------------------------------------------

export type Layer9EventKind =
  | 'NexusInitialized'
  | 'NexusDeposited'
  | 'NexusProfitsWithdrawn'
  | 'NexusRewardsClaimed'
  | 'NexusManagerUpdated'
  | 'LpFeesClaimed';

const EVENT_NAMES: Layer9EventKind[] = [
  'NexusInitialized',
  'NexusDeposited',
  'NexusProfitsWithdrawn',
  'NexusRewardsClaimed',
  'NexusManagerUpdated',
  'LpFeesClaimed',
];

let eventDiscMap: Map<string, Layer9EventKind> | null = null;
async function getEventDiscMap(): Promise<Map<string, Layer9EventKind>> {
  if (eventDiscMap) return eventDiscMap;
  const out = new Map<string, Layer9EventKind>();
  for (const name of EVENT_NAMES) {
    const d = await eventDiscriminator(name);
    out.set(bytesToHex8(d), name);
  }
  eventDiscMap = out;
  return eventDiscMap;
}

function bytesToHex8(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export interface BaseEvent {
  kind: Layer9EventKind;
  signature: string;
  slot: number;
  blockTime: number | null;
}

/** `NexusInitialized` body: 32 + 8 = 40 bytes. */
export interface NexusInitializedEvent extends BaseEvent {
  kind: 'NexusInitialized';
  manager: string;
  timestamp: bigint;
}

/** `NexusDeposited` body: 32 + 8 + 8 + 1 + 8 = 57 bytes. */
export interface NexusDepositedEvent extends BaseEvent {
  kind: 'NexusDeposited';
  tokenMint: string;
  amount: bigint;
  newTotalDeposited: bigint;
  sourceKind: number;
  timestamp: bigint;
}

/** `NexusProfitsWithdrawn` body: 32 + 8 + 8 + 32 + 8 = 88 bytes. */
export interface NexusProfitsWithdrawnEvent extends BaseEvent {
  kind: 'NexusProfitsWithdrawn';
  tokenMint: string;
  amount: bigint;
  remainingProfit: bigint;
  treasuryDestination: string;
  timestamp: bigint;
}

/** `NexusRewardsClaimed` body: 8 + 32 + 8 = 48 bytes. */
export interface NexusRewardsClaimedEvent extends BaseEvent {
  kind: 'NexusRewardsClaimed';
  amount: bigint;
  treasuryDestination: string;
  timestamp: bigint;
}

/** `NexusManagerUpdated` body: 32 + 32 + 8 = 72 bytes. */
export interface NexusManagerUpdatedEvent extends BaseEvent {
  kind: 'NexusManagerUpdated';
  oldManager: string;
  newManager: string;
  timestamp: bigint;
}

/** `LpFeesClaimed` body: 32 + 32 + 8 + 8 + 8 = 88 bytes. */
export interface LpFeesClaimedEvent extends BaseEvent {
  kind: 'LpFeesClaimed';
  recipient: string;
  pool: string;
  claimableA: bigint;
  claimableB: bigint;
  timestamp: bigint;
}

export type Layer9Event =
  | NexusInitializedEvent
  | NexusDepositedEvent
  | NexusProfitsWithdrawnEvent
  | NexusRewardsClaimedEvent
  | NexusManagerUpdatedEvent
  | LpFeesClaimedEvent;

function decodeProgramData(line: string): Uint8Array | null {
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
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function parseNexusInitialized(
  body: Uint8Array,
  base: BaseEvent,
): NexusInitializedEvent | null {
  if (body.length < 40) return null;
  return {
    ...base,
    kind: 'NexusInitialized',
    manager: readPubkey(body, 0),
    timestamp: readI64LE(body, 32),
  };
}

function parseNexusDeposited(
  body: Uint8Array,
  base: BaseEvent,
): NexusDepositedEvent | null {
  if (body.length < 57) return null;
  return {
    ...base,
    kind: 'NexusDeposited',
    tokenMint: readPubkey(body, 0),
    amount: readU64LE(body, 32),
    newTotalDeposited: readU64LE(body, 40),
    sourceKind: body[48],
    timestamp: readI64LE(body, 49),
  };
}

function parseNexusProfitsWithdrawn(
  body: Uint8Array,
  base: BaseEvent,
): NexusProfitsWithdrawnEvent | null {
  if (body.length < 88) return null;
  return {
    ...base,
    kind: 'NexusProfitsWithdrawn',
    tokenMint: readPubkey(body, 0),
    amount: readU64LE(body, 32),
    remainingProfit: readU64LE(body, 40),
    treasuryDestination: readPubkey(body, 48),
    timestamp: readI64LE(body, 80),
  };
}

function parseNexusRewardsClaimed(
  body: Uint8Array,
  base: BaseEvent,
): NexusRewardsClaimedEvent | null {
  if (body.length < 48) return null;
  return {
    ...base,
    kind: 'NexusRewardsClaimed',
    amount: readU64LE(body, 0),
    treasuryDestination: readPubkey(body, 8),
    timestamp: readI64LE(body, 40),
  };
}

function parseNexusManagerUpdated(
  body: Uint8Array,
  base: BaseEvent,
): NexusManagerUpdatedEvent | null {
  if (body.length < 72) return null;
  return {
    ...base,
    kind: 'NexusManagerUpdated',
    oldManager: readPubkey(body, 0),
    newManager: readPubkey(body, 32),
    timestamp: readI64LE(body, 64),
  };
}

function parseLpFeesClaimed(
  body: Uint8Array,
  base: BaseEvent,
): LpFeesClaimedEvent | null {
  if (body.length < 88) return null;
  return {
    ...base,
    kind: 'LpFeesClaimed',
    recipient: readPubkey(body, 0),
    pool: readPubkey(body, 32),
    claimableA: readU64LE(body, 64),
    claimableB: readU64LE(body, 72),
    timestamp: readI64LE(body, 80),
  };
}

async function parseProgramDataLog(
  line: string,
  base: BaseEvent,
): Promise<Layer9Event | null> {
  const data = decodeProgramData(line);
  if (!data || data.length < 8) return null;
  const map = await getEventDiscMap();
  const kind = map.get(bytesToHex8(data.subarray(0, 8)));
  if (!kind) return null;
  const body = data.subarray(8);
  switch (kind) {
    case 'NexusInitialized':
      return parseNexusInitialized(body, { ...base, kind });
    case 'NexusDeposited':
      return parseNexusDeposited(body, { ...base, kind });
    case 'NexusProfitsWithdrawn':
      return parseNexusProfitsWithdrawn(body, { ...base, kind });
    case 'NexusRewardsClaimed':
      return parseNexusRewardsClaimed(body, { ...base, kind });
    case 'NexusManagerUpdated':
      return parseNexusManagerUpdated(body, { ...base, kind });
    case 'LpFeesClaimed':
      return parseLpFeesClaimed(body, { ...base, kind });
  }
}

export const __test__ = {
  ixDiscriminator,
  eventDiscriminator,
  parseProgramDataLog,
  decodeProgramData,
};

// -----------------------------------------------------------------------------
// Public event-fetch API
// -----------------------------------------------------------------------------

export interface FetchEventsOptions {
  limit?: number;
  kind?: Layer9EventKind;
  sinceUnixSeconds?: number;
}

/**
 * Scan recent transactions for the DEX program and parse Layer 9 events.
 * Returns newest-first.
 */
export async function fetchLayer9Events(
  connection: Connection,
  dexProgramId: PublicKey,
  options: FetchEventsOptions = {},
): Promise<Layer9Event[]> {
  const limit = options.limit ?? 50;
  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await connection.getSignaturesForAddress(dexProgramId, { limit });
  } catch {
    return [];
  }

  const out: Layer9Event[] = [];
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
      kind: 'NexusInitialized', // overwritten by parser
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

// -----------------------------------------------------------------------------
// Nexus Manager bot heartbeat
// -----------------------------------------------------------------------------

export type NexusBotStatus = 'running' | 'stopped' | 'unreachable';

export interface NexusManagerHealth {
  status: NexusBotStatus;
  lastRunTs: number | null;
  version: string | null;
  error: string | null;
  raw?: Record<string, unknown>;
}

/**
 * Fetch heartbeat from the Nexus Manager bot's HTTP endpoint
 * (`PUBLIC_NEXUS_MANAGER_BOT_URL`). Mirrors the Layer 8 crank heartbeat
 * shape for visual parity in the dashboard's bot panel.
 *
 * NEVER hardcode local URLs — endpoint is env-driven.
 */
export async function fetchNexusManagerHealth(
  endpointUrl: string | undefined,
): Promise<NexusManagerHealth> {
  if (!endpointUrl) {
    return {
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
        status: 'unreachable',
        lastRunTs: null,
        version: null,
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const lastRunTsRaw = json.lastRunTs;
    const status = (json.status as NexusBotStatus) ?? 'stopped';
    return {
      status,
      lastRunTs: typeof lastRunTsRaw === 'number' ? lastRunTsRaw : null,
      version: typeof json.version === 'string' ? json.version : null,
      error: null,
      raw: json,
    };
  } catch (err) {
    return {
      status: 'unreachable',
      lastRunTs: null,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
