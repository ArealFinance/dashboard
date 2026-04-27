/**
 * Tests for the Layer 9 API client (Liquidity Nexus).
 *
 * Coverage:
 *   - Discriminator parity for all 9 ix builders (sha256("global:<name>")).
 *   - Args round-trip (encode → byte-positions verified).
 *   - Account-list ordering snapshots for each ix.
 *   - LiquidityNexus reader layout (50-byte body + kill-switch derivation).
 *   - LpPosition reader layout (121-byte body).
 *   - Event-discriminator parity for all 6 events.
 *   - Event body round-trip parsing.
 *   - M-1 USDC-side derivation under both A=USDC and B=USDC pools.
 *   - `computeClaimable` math (Q64.64 truncation).
 *   - `fetchNexusManagerHealth` happy + error paths.
 */
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  __test__,
  buildInitializeNexusIx,
  buildUpdateNexusManagerIx,
  buildNexusSwapIx,
  buildNexusAddLiquidityIx,
  buildNexusRemoveLiquidityIx,
  buildNexusDepositIx,
  buildNexusWithdrawProfitsIx,
  buildNexusClaimRewardsIx,
  buildClaimLpFeesIx,
  computeClaimable,
  discInitializeNexus,
  discUpdateNexusManager,
  discNexusSwap,
  discNexusAddLiquidity,
  discNexusRemoveLiquidity,
  discNexusDeposit,
  discNexusWithdrawProfits,
  discNexusClaimRewards,
  discClaimLpFees,
  fetchNexusManagerHealth,
  readLiquidityNexus,
  readLpPosition,
  resolveUsdcSide,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_KIND_RWT,
  TOKEN_KIND_USDC,
  NEXUS_DEPOSIT_SOURCE_DIRECT,
  NEXUS_MANAGER_KILL_SWITCH_BASE58,
} from '../layer9';

const { eventDiscriminator, parseProgramDataLog } = __test__;
const pk = (): PublicKey => Keypair.generate().publicKey;

// Helper: encode a Uint8Array as base64 (Node + browser).
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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

function u64Le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function i64Le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
}

function u128Le(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  const low = v & 0xffffffffffffffffn;
  const high = (v >> 64n) & 0xffffffffffffffffn;
  view.setBigUint64(0, low, true);
  view.setBigUint64(8, high, true);
  return out;
}

function nodeIxDisc(name: string): Uint8Array {
  const h = createHash('sha256').update(`global:${name}`).digest();
  return new Uint8Array(h.subarray(0, 8));
}

function nodeEventDisc(name: string): Uint8Array {
  const h = createHash('sha256').update(`event:${name}`).digest();
  return new Uint8Array(h.subarray(0, 8));
}

// ---------------------------------------------------------------------------
// Discriminator parity (ix)
// ---------------------------------------------------------------------------

describe('ix discriminators match canonical sha256("global:<name>")', () => {
  it.each([
    ['initialize_nexus', discInitializeNexus],
    ['update_nexus_manager', discUpdateNexusManager],
    ['nexus_swap', discNexusSwap],
    ['nexus_add_liquidity', discNexusAddLiquidity],
    ['nexus_remove_liquidity', discNexusRemoveLiquidity],
    ['nexus_deposit', discNexusDeposit],
    ['nexus_withdraw_profits', discNexusWithdrawProfits],
    ['nexus_claim_rewards', discNexusClaimRewards],
    ['claim_lp_fees', discClaimLpFees],
  ] as const)('%s', async (name, getter) => {
    expect(Array.from(await getter())).toEqual(Array.from(nodeIxDisc(name)));
  });
});

// ---------------------------------------------------------------------------
// initialize_nexus
// ---------------------------------------------------------------------------

describe('buildInitializeNexusIx', () => {
  const args = {
    dexProgramId: pk(),
    authority: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    manager: new Uint8Array(32).fill(0xab),
  };

  it('encodes 4 accounts in the documented order', async () => {
    const ix = await buildInitializeNexusIx(args);
    expect(ix.keys.length).toBe(4);
    expect(ix.keys[0].pubkey.equals(args.authority)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
  });

  it('encodes data: disc(8) + manager(32) = 40 bytes', async () => {
    const ix = await buildInitializeNexusIx(args);
    expect(ix.data.length).toBe(40);
    const data = new Uint8Array(ix.data);
    expect(Array.from(data.subarray(0, 8))).toEqual(
      Array.from(await discInitializeNexus()),
    );
    expect(Array.from(data.subarray(8, 40))).toEqual(Array.from(args.manager));
  });

  it('rejects non-32-byte manager', async () => {
    await expect(
      buildInitializeNexusIx({ ...args, manager: new Uint8Array(31) }),
    ).rejects.toThrow(/32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// update_nexus_manager (kill-switch acceptance)
// ---------------------------------------------------------------------------

describe('buildUpdateNexusManagerIx', () => {
  const args = {
    dexProgramId: pk(),
    authority: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    newManager: new Uint8Array(32).fill(0x11),
  };

  it('encodes 3 accounts in the documented order', async () => {
    const ix = await buildUpdateNexusManagerIx(args);
    expect(ix.keys.length).toBe(3);
    expect(ix.keys[0].pubkey.equals(args.authority)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
  });

  it('encodes data: disc(8) + new_manager(32)', async () => {
    const ix = await buildUpdateNexusManagerIx(args);
    expect(ix.data.length).toBe(40);
    const data = new Uint8Array(ix.data);
    expect(Array.from(data.subarray(8, 40))).toEqual(Array.from(args.newManager));
  });

  it('accepts zero pubkey as kill-switch sentinel (D22)', async () => {
    const killArgs = { ...args, newManager: new Uint8Array(32) /* all zeros */ };
    const ix = await buildUpdateNexusManagerIx(killArgs);
    const data = new Uint8Array(ix.data);
    // Bytes 8..40 must be all zero.
    for (let i = 8; i < 40; i++) expect(data[i]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nexus_swap
// ---------------------------------------------------------------------------

describe('buildNexusSwapIx', () => {
  const args = {
    dexProgramId: pk(),
    manager: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    poolState: pk(),
    nexusTokenIn: pk(),
    nexusTokenOut: pk(),
    vaultIn: pk(),
    vaultOut: pk(),
    arealFeeAccount: pk(),
    amountIn: 1_000_000n,
    minAmountOut: 950_000n,
    aToB: true,
  };

  it('encodes 10 accounts in the documented order', async () => {
    const ix = await buildNexusSwapIx(args);
    expect(ix.keys.length).toBe(10);
    expect(ix.keys[0].pubkey.equals(args.manager)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.poolState)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.nexusTokenIn)).toBe(true);
    expect(ix.keys[5].pubkey.equals(args.nexusTokenOut)).toBe(true);
    expect(ix.keys[6].pubkey.equals(args.vaultIn)).toBe(true);
    expect(ix.keys[7].pubkey.equals(args.vaultOut)).toBe(true);
    expect(ix.keys[8].pubkey.equals(args.arealFeeAccount)).toBe(true);
    expect(ix.keys[9].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('encodes data: disc(8) + amount_in(8) + min_out(8) + a_to_b(1) = 25 bytes', async () => {
    const ix = await buildNexusSwapIx(args);
    expect(ix.data.length).toBe(25);
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(1_000_000n);
    expect(view.getBigUint64(16, true)).toBe(950_000n);
    expect(data[24]).toBe(1);
  });

  it('encodes a_to_b=false as 0', async () => {
    const ix = await buildNexusSwapIx({ ...args, aToB: false });
    const data = new Uint8Array(ix.data);
    expect(data[24]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nexus_add_liquidity
// ---------------------------------------------------------------------------

describe('buildNexusAddLiquidityIx', () => {
  const args = {
    dexProgramId: pk(),
    manager: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    poolState: pk(),
    lpPosition: pk(),
    nexusTokenA: pk(),
    nexusTokenB: pk(),
    vaultA: pk(),
    vaultB: pk(),
    amountA: 1_000n,
    amountB: 2_000n,
    minShares: 100n,
  };

  it('encodes 11 accounts in the documented order', async () => {
    const ix = await buildNexusAddLiquidityIx(args);
    expect(ix.keys.length).toBe(11);
    expect(ix.keys[0].pubkey.equals(args.manager)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true); // manager pays rent
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.poolState)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.lpPosition)).toBe(true);
    expect(ix.keys[5].pubkey.equals(args.nexusTokenA)).toBe(true);
    expect(ix.keys[6].pubkey.equals(args.nexusTokenB)).toBe(true);
    expect(ix.keys[7].pubkey.equals(args.vaultA)).toBe(true);
    expect(ix.keys[8].pubkey.equals(args.vaultB)).toBe(true);
    expect(ix.keys[9].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[10].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('encodes data: disc(8) + amount_a(8) + amount_b(8) + min_shares(16) = 40 bytes', async () => {
    const ix = await buildNexusAddLiquidityIx(args);
    expect(ix.data.length).toBe(40);
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(1_000n);
    expect(view.getBigUint64(16, true)).toBe(2_000n);
    // Low half of u128 at 24..32 == 100, high half at 32..40 == 0.
    expect(view.getBigUint64(24, true)).toBe(100n);
    expect(view.getBigUint64(32, true)).toBe(0n);
  });

  it('round-trips a large min_shares u128 value', async () => {
    const big = (1n << 100n) | 7n;
    const ix = await buildNexusAddLiquidityIx({ ...args, minShares: big });
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const low = view.getBigUint64(24, true);
    const high = view.getBigUint64(32, true);
    expect((high << 64n) | low).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// nexus_remove_liquidity
// ---------------------------------------------------------------------------

describe('buildNexusRemoveLiquidityIx', () => {
  const args = {
    dexProgramId: pk(),
    manager: pk(),
    liquidityNexus: pk(),
    poolState: pk(),
    lpPosition: pk(),
    nexusTokenA: pk(),
    nexusTokenB: pk(),
    vaultA: pk(),
    vaultB: pk(),
    sharesToBurn: 500n,
  };

  it('encodes 9 accounts in the documented order', async () => {
    const ix = await buildNexusRemoveLiquidityIx(args);
    expect(ix.keys.length).toBe(9);
    expect(ix.keys[0].pubkey.equals(args.manager)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.poolState)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.lpPosition)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.nexusTokenA)).toBe(true);
    expect(ix.keys[5].pubkey.equals(args.nexusTokenB)).toBe(true);
    expect(ix.keys[6].pubkey.equals(args.vaultA)).toBe(true);
    expect(ix.keys[7].pubkey.equals(args.vaultB)).toBe(true);
    expect(ix.keys[8].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('encodes data: disc(8) + shares_to_burn(16) = 24 bytes', async () => {
    const ix = await buildNexusRemoveLiquidityIx(args);
    expect(ix.data.length).toBe(24);
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(500n);
    expect(view.getBigUint64(16, true)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// nexus_deposit
// ---------------------------------------------------------------------------

describe('buildNexusDepositIx', () => {
  const args = {
    dexProgramId: pk(),
    depositor: pk(),
    liquidityNexus: pk(),
    depositorTokenAta: pk(),
    nexusTokenAta: pk(),
    amount: 1_000_000n,
    tokenKind: TOKEN_KIND_USDC,
  };

  it('encodes 5 accounts (4 named + token_program in remaining)', async () => {
    const ix = await buildNexusDepositIx(args);
    expect(ix.keys.length).toBe(5);
    expect(ix.keys[0].pubkey.equals(args.depositor)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.depositorTokenAta)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.nexusTokenAta)).toBe(true);
    // remaining_accounts — token_program at slot 4.
    expect(ix.keys[4].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[4].isSigner).toBe(false);
    expect(ix.keys[4].isWritable).toBe(false);
  });

  it('encodes data: disc(8) + amount(8) + token_kind(1) = 17 bytes', async () => {
    const ix = await buildNexusDepositIx(args);
    expect(ix.data.length).toBe(17);
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(1_000_000n);
    expect(data[16]).toBe(TOKEN_KIND_USDC);
  });

  it('encodes RWT kind as 1', async () => {
    const ix = await buildNexusDepositIx({ ...args, tokenKind: TOKEN_KIND_RWT });
    const data = new Uint8Array(ix.data);
    expect(data[16]).toBe(TOKEN_KIND_RWT);
  });

  it('rejects unknown token_kind', async () => {
    await expect(
      buildNexusDepositIx({ ...args, tokenKind: 9 }),
    ).rejects.toThrow(/tokenKind/);
  });
});

// ---------------------------------------------------------------------------
// nexus_withdraw_profits
// ---------------------------------------------------------------------------

describe('buildNexusWithdrawProfitsIx', () => {
  const args = {
    dexProgramId: pk(),
    authority: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    nexusTokenAta: pk(),
    recipientTokenAta: pk(),
    amount: 5_000n,
    tokenKind: TOKEN_KIND_RWT,
  };

  it('encodes 6 accounts (5 named + token_program in remaining)', async () => {
    const ix = await buildNexusWithdrawProfitsIx(args);
    expect(ix.keys.length).toBe(6);
    expect(ix.keys[0].pubkey.equals(args.authority)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.nexusTokenAta)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.recipientTokenAta)).toBe(true);
    expect(ix.keys[5].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('encodes data: disc(8) + amount(8) + token_kind(1) = 17 bytes', async () => {
    const ix = await buildNexusWithdrawProfitsIx(args);
    expect(ix.data.length).toBe(17);
    const data = new Uint8Array(ix.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(5_000n);
    expect(data[16]).toBe(TOKEN_KIND_RWT);
  });
});

// ---------------------------------------------------------------------------
// nexus_claim_rewards
// ---------------------------------------------------------------------------

describe('buildNexusClaimRewardsIx', () => {
  const args = {
    dexProgramId: pk(),
    authority: pk(),
    dexConfig: pk(),
    liquidityNexus: pk(),
    poolState: pk(),
    lpPosition: pk(),
    poolVaultA: pk(),
    poolVaultB: pk(),
    nexusTokenAAta: pk(),
    nexusTokenBAta: pk(),
  };

  it('encodes exactly 9 accounts and NO token_program', async () => {
    const ix = await buildNexusClaimRewardsIx(args);
    expect(ix.keys.length).toBe(9);
    expect(ix.keys[0].pubkey.equals(args.authority)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.dexConfig)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.poolState)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.lpPosition)).toBe(true);
    expect(ix.keys[5].pubkey.equals(args.poolVaultA)).toBe(true);
    expect(ix.keys[6].pubkey.equals(args.poolVaultB)).toBe(true);
    expect(ix.keys[7].pubkey.equals(args.nexusTokenAAta)).toBe(true);
    expect(ix.keys[8].pubkey.equals(args.nexusTokenBAta)).toBe(true);
    // Critical: no SPL_TOKEN_PROGRAM_ID in the account list (handler quirk).
    for (const k of ix.keys) {
      expect(k.pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(false);
    }
  });

  it('encodes data: disc(8) only — 8 bytes', async () => {
    const ix = await buildNexusClaimRewardsIx(args);
    expect(ix.data.length).toBe(8);
    expect(Array.from(ix.data)).toEqual(Array.from(await discNexusClaimRewards()));
  });
});

// ---------------------------------------------------------------------------
// claim_lp_fees (user-facing)
// ---------------------------------------------------------------------------

describe('buildClaimLpFeesIx', () => {
  const args = {
    dexProgramId: pk(),
    recipient: pk(),
    poolState: pk(),
    lpPosition: pk(),
    poolVaultA: pk(),
    poolVaultB: pk(),
    recipientTokenAAta: pk(),
    recipientTokenBAta: pk(),
  };

  it('encodes 8 accounts in the documented order', async () => {
    const ix = await buildClaimLpFeesIx(args);
    expect(ix.keys.length).toBe(8);
    expect(ix.keys[0].pubkey.equals(args.recipient)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.poolState)).toBe(true);
    expect(ix.keys[2].pubkey.equals(args.lpPosition)).toBe(true);
    expect(ix.keys[3].pubkey.equals(args.poolVaultA)).toBe(true);
    expect(ix.keys[4].pubkey.equals(args.poolVaultB)).toBe(true);
    expect(ix.keys[5].pubkey.equals(args.recipientTokenAAta)).toBe(true);
    expect(ix.keys[6].pubkey.equals(args.recipientTokenBAta)).toBe(true);
    expect(ix.keys[7].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('encodes data: disc(8) only', async () => {
    const ix = await buildClaimLpFeesIx(args);
    expect(ix.data.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// USDC-side derivation (M-1)
// ---------------------------------------------------------------------------

describe('resolveUsdcSide', () => {
  it('detects USDC on side A', () => {
    const usdc = pk();
    const rwt = pk();
    expect(resolveUsdcSide(usdc, rwt, usdc)).toBe('a');
  });

  it('detects USDC on side B', () => {
    const usdc = pk();
    const rwt = pk();
    expect(resolveUsdcSide(rwt, usdc, usdc)).toBe('b');
  });

  it('returns null when neither side is USDC', () => {
    const a = pk();
    const b = pk();
    const usdc = pk();
    expect(resolveUsdcSide(a, b, usdc)).toBeNull();
  });

  // End-to-end M-1 closure: the *caller* uses resolveUsdcSide to map the
  // pool-side mints to nexus-owned ATAs, then feeds the resolved ATAs
  // into the builder. The builder is mint-agnostic — these two tests
  // pin that the resolved (callerSide → ATA) mapping flows through to
  // the correct slot in `keys[]`. Catches a regression where a future
  // refactor accidentally re-introduces the side-A hardcode.

  function resolveSwapIns(
    aMint: PublicKey,
    bMint: PublicKey,
    usdcMint: PublicKey,
    nexusUsdcAta: PublicKey,
    nexusRwtAta: PublicKey,
    aToB: boolean,
  ): { tokenIn: PublicKey; tokenOut: PublicKey } {
    const usdcSide = resolveUsdcSide(aMint, bMint, usdcMint);
    if (usdcSide === null) throw new Error('non-canonical pool');
    // tokenIn = side-A when aToB, side-B when !aToB; map mint→ATA via usdcSide.
    const aIsUsdc = usdcSide === 'a';
    const tokenA = aIsUsdc ? nexusUsdcAta : nexusRwtAta;
    const tokenB = aIsUsdc ? nexusRwtAta : nexusUsdcAta;
    return aToB ? { tokenIn: tokenA, tokenOut: tokenB } : { tokenIn: tokenB, tokenOut: tokenA };
  }

  it('USDC-on-A pool: A→B swap routes nexusUsdcAta into nexusTokenIn slot', async () => {
    const usdc = pk();
    const rwt = pk();
    const nexusUsdcAta = pk();
    const nexusRwtAta = pk();
    const { tokenIn, tokenOut } = resolveSwapIns(usdc, rwt, usdc, nexusUsdcAta, nexusRwtAta, true);
    const ix = await buildNexusSwapIx({
      dexProgramId: pk(),
      manager: pk(),
      dexConfig: pk(),
      liquidityNexus: pk(),
      poolState: pk(),
      nexusTokenIn: tokenIn,
      nexusTokenOut: tokenOut,
      vaultIn: pk(),
      vaultOut: pk(),
      arealFeeAccount: pk(),
      amountIn: 100n,
      minAmountOut: 95n,
      aToB: true,
    });
    expect(ix.keys[4].pubkey.equals(nexusUsdcAta)).toBe(true);
    expect(ix.keys[5].pubkey.equals(nexusRwtAta)).toBe(true);
  });

  it('USDC-on-B pool: A→B swap routes nexusRwtAta into nexusTokenIn slot (no side-A hardcode)', async () => {
    const usdc = pk();
    const rwt = pk();
    const nexusUsdcAta = pk();
    const nexusRwtAta = pk();
    // Pool layout: A=RWT, B=USDC. aToB=true means tokenIn=A=RWT.
    const { tokenIn, tokenOut } = resolveSwapIns(rwt, usdc, usdc, nexusUsdcAta, nexusRwtAta, true);
    const ix = await buildNexusSwapIx({
      dexProgramId: pk(),
      manager: pk(),
      dexConfig: pk(),
      liquidityNexus: pk(),
      poolState: pk(),
      nexusTokenIn: tokenIn,
      nexusTokenOut: tokenOut,
      vaultIn: pk(),
      vaultOut: pk(),
      arealFeeAccount: pk(),
      amountIn: 100n,
      minAmountOut: 95n,
      aToB: true,
    });
    // Side flipped vs USDC-on-A case — would fail under a side-A hardcode.
    expect(ix.keys[4].pubkey.equals(nexusRwtAta)).toBe(true);
    expect(ix.keys[5].pubkey.equals(nexusUsdcAta)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeClaimable (Q64.64 math)
// ---------------------------------------------------------------------------

describe('computeClaimable', () => {
  it('returns 0 when snapshot equals cumulative', () => {
    const cumulative = 5n << 64n;
    expect(computeClaimable(cumulative, cumulative, 1_000n)).toBe(0n);
  });

  it('returns 0 when snapshot above cumulative (defensive)', () => {
    expect(computeClaimable(1n << 64n, 5n << 64n, 1_000n)).toBe(0n);
  });

  it('matches on-chain: (10 << 64) * 1_000 >> 64 == 10_000', () => {
    const delta = 10n << 64n;
    expect(computeClaimable(delta, 0n, 1_000n)).toBe(10_000n);
  });

  it('truncates Q64.64 fractional', () => {
    // Half-share should truncate to 0 when there is no integer part.
    const halfShare = 1n << 63n;
    expect(computeClaimable(halfShare, 0n, 1n)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// readLiquidityNexus (50-byte body + kill-switch)
// ---------------------------------------------------------------------------

describe('readLiquidityNexus', () => {
  function makeNexusAccountInfo(
    manager: Uint8Array,
    usdc: bigint,
    rwt: bigint,
    isActive: boolean,
    bump: number,
  ): { data: Buffer } {
    const body = new Uint8Array(50);
    body.set(manager, 0);
    new DataView(body.buffer).setBigUint64(32, usdc, true);
    new DataView(body.buffer).setBigUint64(40, rwt, true);
    body[48] = isActive ? 1 : 0;
    body[49] = bump;
    // 8-byte discriminator placeholder.
    const full = concatBytes(new Uint8Array(8), body);
    return { data: Buffer.from(full) };
  }

  it('parses non-kill-switch state', async () => {
    const pda = pk();
    const manager = new Uint8Array(32).fill(0xab);
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue(
        makeNexusAccountInfo(manager, 1_000n, 2_000n, true, 0xfd),
      ),
    } as unknown as Connection;
    const state = await readLiquidityNexus(conn, pda);
    expect(state).not.toBeNull();
    expect(state!.totalDepositedUsdc).toBe(1_000n);
    expect(state!.totalDepositedRwt).toBe(2_000n);
    expect(state!.isActive).toBe(true);
    expect(state!.bump).toBe(0xfd);
    expect(state!.killSwitchEngaged).toBe(false);
    expect(state!.pda).toBe(pda.toBase58());
  });

  it('flags kill-switch when manager is the zero pubkey', async () => {
    const pda = pk();
    const manager = new Uint8Array(32); // all zeros
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue(
        makeNexusAccountInfo(manager, 0n, 0n, true, 0xfe),
      ),
    } as unknown as Connection;
    const state = await readLiquidityNexus(conn, pda);
    expect(state).not.toBeNull();
    expect(state!.killSwitchEngaged).toBe(true);
    expect(state!.manager).toBe(NEXUS_MANAGER_KILL_SWITCH_BASE58);
  });

  it('returns null when account is missing', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as unknown as Connection;
    expect(await readLiquidityNexus(conn, pk())).toBeNull();
  });

  it('returns null on RPC failure', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as unknown as Connection;
    expect(await readLiquidityNexus(conn, pk())).toBeNull();
  });

  it('returns null when account is too short', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(20) }),
    } as unknown as Connection;
    expect(await readLiquidityNexus(conn, pk())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readLpPosition (121-byte body)
// ---------------------------------------------------------------------------

describe('readLpPosition', () => {
  it('parses the documented 121-byte layout', async () => {
    const pool = pk();
    const owner = pk();
    const body = new Uint8Array(121);
    body.set(pool.toBytes(), 0);
    body.set(owner.toBytes(), 32);
    // shares u128 = 1_000
    body.set(u128Le(1_000n), 64);
    // last_update_ts i64
    body.set(i64Le(1_700_000_000n), 80);
    body[88] = 0xff; // bump
    body.set(u128Le(7n << 64n), 89);
    body.set(u128Le(11n << 64n), 105);
    const data = Buffer.from(concatBytes(new Uint8Array(8), body));
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data }),
    } as unknown as Connection;
    const lp = await readLpPosition(conn, pk());
    expect(lp).not.toBeNull();
    expect(lp!.pool).toBe(pool.toBase58());
    expect(lp!.owner).toBe(owner.toBase58());
    expect(lp!.shares).toBe(1_000n);
    expect(lp!.lastUpdateTs).toBe(1_700_000_000n);
    expect(lp!.bump).toBe(0xff);
    expect(lp!.feesClaimedPerShareA).toBe(7n << 64n);
    expect(lp!.feesClaimedPerShareB).toBe(11n << 64n);
  });

  it('returns null on short account', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(50) }),
    } as unknown as Connection;
    expect(await readLpPosition(conn, pk())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Event discriminator parity
// ---------------------------------------------------------------------------

describe('event discriminators match canonical sha256("event:<Name>")', () => {
  it.each([
    'NexusInitialized',
    'NexusDeposited',
    'NexusProfitsWithdrawn',
    'NexusRewardsClaimed',
    'NexusManagerUpdated',
    'LpFeesClaimed',
  ] as const)('%s', async (name) => {
    expect(Array.from(await eventDiscriminator(name))).toEqual(
      Array.from(nodeEventDisc(name)),
    );
  });
});

// ---------------------------------------------------------------------------
// Event body parsing
// ---------------------------------------------------------------------------

describe('parseProgramDataLog — Layer 9 events', () => {
  const baseEvent = {
    kind: 'NexusInitialized' as const,
    signature: 'sig9',
    slot: 100,
    blockTime: 1_700_000_000,
  };

  it('parses NexusInitialized (40 bytes)', async () => {
    const disc = await eventDiscriminator('NexusInitialized');
    const manager = pk().toBytes();
    const body = concatBytes(manager, i64Le(1_700_000_001n));
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('NexusInitialized');
    if (ev?.kind === 'NexusInitialized') {
      expect(ev.timestamp).toBe(1_700_000_001n);
    }
  });

  it('parses NexusDeposited (57 bytes)', async () => {
    const disc = await eventDiscriminator('NexusDeposited');
    const tokenMint = pk().toBytes();
    const body = concatBytes(
      tokenMint,
      u64Le(1_000_000n),
      u64Le(5_000_000n),
      new Uint8Array([NEXUS_DEPOSIT_SOURCE_DIRECT]),
      i64Le(1_700_000_002n),
    );
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('NexusDeposited');
    if (ev?.kind === 'NexusDeposited') {
      expect(ev.amount).toBe(1_000_000n);
      expect(ev.newTotalDeposited).toBe(5_000_000n);
      expect(ev.sourceKind).toBe(NEXUS_DEPOSIT_SOURCE_DIRECT);
      expect(ev.timestamp).toBe(1_700_000_002n);
    }
  });

  it('parses NexusProfitsWithdrawn (88 bytes)', async () => {
    const disc = await eventDiscriminator('NexusProfitsWithdrawn');
    const tokenMint = pk().toBytes();
    const treasury = pk().toBytes();
    const body = concatBytes(
      tokenMint,
      u64Le(2_500n),
      u64Le(7_500n),
      treasury,
      i64Le(1_700_000_003n),
    );
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('NexusProfitsWithdrawn');
    if (ev?.kind === 'NexusProfitsWithdrawn') {
      expect(ev.amount).toBe(2_500n);
      expect(ev.remainingProfit).toBe(7_500n);
      expect(ev.timestamp).toBe(1_700_000_003n);
    }
  });

  it('parses NexusRewardsClaimed (48 bytes)', async () => {
    const disc = await eventDiscriminator('NexusRewardsClaimed');
    const dst = pk().toBytes();
    const body = concatBytes(u64Le(999n), dst, i64Le(1_700_000_004n));
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('NexusRewardsClaimed');
    if (ev?.kind === 'NexusRewardsClaimed') {
      expect(ev.amount).toBe(999n);
      expect(ev.timestamp).toBe(1_700_000_004n);
    }
  });

  it('parses NexusManagerUpdated (72 bytes) including kill-switch', async () => {
    const disc = await eventDiscriminator('NexusManagerUpdated');
    const oldM = pk().toBytes();
    const newM = new Uint8Array(32); // kill-switch
    const body = concatBytes(oldM, newM, i64Le(1_700_000_005n));
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('NexusManagerUpdated');
    if (ev?.kind === 'NexusManagerUpdated') {
      expect(ev.newManager).toBe(NEXUS_MANAGER_KILL_SWITCH_BASE58);
    }
  });

  it('parses LpFeesClaimed (88 bytes)', async () => {
    const disc = await eventDiscriminator('LpFeesClaimed');
    const recipient = pk().toBytes();
    const pool = pk().toBytes();
    const body = concatBytes(
      recipient,
      pool,
      u64Le(123n),
      u64Le(456n),
      i64Le(1_700_000_006n),
    );
    const line = `Program data: ${bytesToBase64(concatBytes(disc, body))}`;
    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev?.kind).toBe('LpFeesClaimed');
    if (ev?.kind === 'LpFeesClaimed') {
      expect(ev.claimableA).toBe(123n);
      expect(ev.claimableB).toBe(456n);
    }
  });

  it('returns null for truncated event bodies', async () => {
    const disc = await eventDiscriminator('NexusInitialized');
    const line = `Program data: ${bytesToBase64(concatBytes(disc, new Uint8Array(10)))}`;
    expect(await parseProgramDataLog(line, baseEvent)).toBeNull();
  });

  it('returns null for unknown discriminators', async () => {
    const data = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    const line = `Program data: ${bytesToBase64(data)}`;
    expect(await parseProgramDataLog(line, baseEvent)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Nexus Manager bot heartbeat
// ---------------------------------------------------------------------------

describe('fetchNexusManagerHealth', () => {
  it('returns unreachable when no endpoint configured', async () => {
    const result = await fetchNexusManagerHealth(undefined);
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('No endpoint configured');
  });

  it('returns unreachable on HTTP error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);
    const result = await fetchNexusManagerHealth('https://example.test');
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('HTTP 503');
    fetchSpy.mockRestore();
  });

  it('parses valid heartbeat response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'running',
        lastRunTs: 1_700_000_007,
        version: '0.1.0',
      }),
    } as unknown as Response);
    const result = await fetchNexusManagerHealth('https://example.test');
    expect(result.status).toBe('running');
    expect(result.lastRunTs).toBe(1_700_000_007);
    expect(result.version).toBe('0.1.0');
    fetchSpy.mockRestore();
  });
});
