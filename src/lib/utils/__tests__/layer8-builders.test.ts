/**
 * Tests for Layer 8 instruction builders.
 *
 * Verifies discriminator parity (against the canonical sha256 / first 8 bytes
 * of "global:<name>") and pinned account orderings — which match the
 * on-chain handlers in contracts/yield-distribution, rwt-engine, native-dex,
 * and ownership-token.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  discConvertToRwt,
  discRwtClaimYield,
  discDexCompoundYield,
  discOtClaimYdForTreasury,
  discInitLiquidityHolding,
  discWithdrawLiquidityHolding,
  buildConvertToRwtIx,
  buildRwtClaimYieldIx,
  buildDexCompoundIx,
  buildOtTreasuryClaimIx,
  buildInitializeLiquidityHoldingIx,
  buildWithdrawLiquidityHoldingIx,
  buildComputeBudgetIxs,
  encodeClaimArgs,
  decodeProof,
  SPL_TOKEN_PROGRAM_ID,
} from '../layer8-builders';

const ASSOC = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Generate fresh random pubkeys for tests (avoid invalid base58 fixtures).
const pk = (): PublicKey => Keypair.generate().publicKey;

function nodeDisc(name: string): Uint8Array {
  const h = createHash('sha256').update(`global:${name}`).digest();
  return new Uint8Array(h.subarray(0, 8));
}

describe('discriminators match canonical sha256', () => {
  it('convert_to_rwt', async () => {
    expect(Array.from(await discConvertToRwt())).toEqual(
      Array.from(nodeDisc('convert_to_rwt')),
    );
  });
  it('claim_yield', async () => {
    expect(Array.from(await discRwtClaimYield())).toEqual(
      Array.from(nodeDisc('claim_yield')),
    );
  });
  it('compound_yield', async () => {
    expect(Array.from(await discDexCompoundYield())).toEqual(
      Array.from(nodeDisc('compound_yield')),
    );
  });
  it('claim_yd_for_treasury', async () => {
    expect(Array.from(await discOtClaimYdForTreasury())).toEqual(
      Array.from(nodeDisc('claim_yd_for_treasury')),
    );
  });
  it('initialize_liquidity_holding', async () => {
    expect(Array.from(await discInitLiquidityHolding())).toEqual(
      Array.from(nodeDisc('initialize_liquidity_holding')),
    );
  });
  it('withdraw_liquidity_holding', async () => {
    expect(Array.from(await discWithdrawLiquidityHolding())).toEqual(
      Array.from(nodeDisc('withdraw_liquidity_holding')),
    );
  });
});

describe('encodeClaimArgs', () => {
  it('encodes empty proof', () => {
    const out = encodeClaimArgs(1_000n, []);
    // 8 (cumulative) + 4 (len) + 0 (proof) = 12 bytes
    expect(out.length).toBe(12);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getBigUint64(0, true)).toBe(1_000n);
    expect(view.getUint32(8, true)).toBe(0);
  });

  it('encodes proof with two 32-byte nodes', () => {
    const node1 = new Uint8Array(32).fill(0xab);
    const node2 = new Uint8Array(32).fill(0xcd);
    const out = encodeClaimArgs(7n, [node1, node2]);
    expect(out.length).toBe(8 + 4 + 64);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getBigUint64(0, true)).toBe(7n);
    expect(view.getUint32(8, true)).toBe(2);
    expect(out[12]).toBe(0xab);
    expect(out[12 + 32]).toBe(0xcd);
  });

  it('rejects non-32-byte nodes', () => {
    const bad = new Uint8Array(31);
    expect(() => encodeClaimArgs(0n, [bad])).toThrowError(/length 31/);
  });

  // DASH-2: client-side MAX_PROOF_LEN guard mirrors on-chain `ProofTooLong`.
  it('rejects proofs longer than MAX_PROOF_LEN (20)', () => {
    const node = new Uint8Array(32).fill(0x11);
    const tooMany = Array.from({ length: 21 }, () => node);
    expect(() => encodeClaimArgs(0n, tooMany)).toThrowError(/Proof too long/);
  });

  it('accepts proofs at exactly MAX_PROOF_LEN', () => {
    const node = new Uint8Array(32).fill(0x22);
    const exactly = Array.from({ length: 20 }, () => node);
    expect(() => encodeClaimArgs(0n, exactly)).not.toThrow();
  });
});

describe('decodeProof', () => {
  it('round-trips hex strings to bytes', () => {
    const hex = ['ab'.repeat(32), 'cd'.repeat(32)];
    const bytes = decodeProof(hex);
    expect(bytes.length).toBe(2);
    expect(bytes[0].length).toBe(32);
    expect(bytes[0][0]).toBe(0xab);
    expect(bytes[1][0]).toBe(0xcd);
  });

  // tester M-4 — malformed input rejection. `decodeProof` is the hex→bytes
  // primitive; it enforces odd-length rejection but parses non-hex chars
  // as NaN→0 silently. Node-width (32 bytes) is enforced downstream by
  // `encodeClaimArgsBody` (separate test). We pin only the throw-path here.
  it('rejects odd-length hex (cannot encode partial byte)', () => {
    expect(() => decodeProof(['abc'])).toThrow(/Invalid hex length/);
  });
});

describe('buildComputeBudgetIxs', () => {
  // SKIP: `ComputeBudgetProgram.setComputeUnitLimit` ultimately relies on
  // @solana/buffer-layout's `Uint8Array` typecheck, which jsdom + the
  // node-polyfills `Buffer` shim breaks. The function is a thin wrapper —
  // production behavior is exercised by full-stack tests.
  it.skip('produces the standard 2-ix prefix', () => {
    const ixs = buildComputeBudgetIxs(200_000, 1000);
    expect(ixs.length).toBe(2);
  });
});

describe('buildConvertToRwtIx', () => {
  const args = {
    ydProgramId: pk(),
    dexProgramId: pk(),
    rwtEngineProgramId: pk(),
    signer: pk(),

    config: pk(),
    distributor: pk(),
    otMint: pk(),
    accumulator: pk(),
    accumulatorUsdcAta: pk(),
    accumulatorRwtAta: pk(),
    feeAccount: pk(),
    rewardVault: pk(),
    rwtMint: pk(),
    dexConfig: pk(),
    poolState: pk(),
    dexPoolVaultIn: pk(),
    dexPoolVaultOut: pk(),
    dexArealFeeAccount: pk(),
    rwtVault: pk(),
    rwtCapitalAcc: pk(),
    rwtDaoFeeAccount: pk(),

    usdcAmount: 1_000_000n,
    minRwtOut: 900_000n,
    swapFirst: true,
  };

  it('produces an ix with 22 accounts', async () => {
    const ix = await buildConvertToRwtIx(args);
    expect(ix.keys.length).toBe(22);
    expect(ix.programId.equals(args.ydProgramId)).toBe(true);
  });

  it('first account is signer, writable; last 4 are programs', async () => {
    const ix = await buildConvertToRwtIx(args);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[18].pubkey.equals(args.dexProgramId)).toBe(true);
    expect(ix.keys[19].pubkey.equals(args.rwtEngineProgramId)).toBe(true);
    expect(ix.keys[20].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[21].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('encodes data: disc(8) + usdc_amount(8) + min_rwt_out(8) + swap_first(1)', async () => {
    const ix = await buildConvertToRwtIx(args);
    expect(ix.data.length).toBe(25);
    const data = new Uint8Array(ix.data);
    const expectedDisc = await discConvertToRwt();
    expect(Array.from(data.subarray(0, 8))).toEqual(Array.from(expectedDisc));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(1_000_000n);
    expect(view.getBigUint64(16, true)).toBe(900_000n);
    expect(data[24]).toBe(1);
  });
});

describe('buildRwtClaimYieldIx', () => {
  it('produces ix with 14 accounts and correct order', async () => {
    const args = {
      rwtEngineProgramId: pk(),
      ydProgramId: pk(),
      signer: pk(),
      rwtVault: pk(),
      distConfig: pk(),
      rwtClaimAta: pk(),
      liquidityDest: pk(),
      protocolRevenueDest: pk(),
      ydConfig: pk(),
      otMint: pk(),
      ydDistributor: pk(),
      ydClaimStatus: pk(),
      ydRewardVault: pk(),
      cumulativeAmount: 5_000n,
      proof: [],
    };
    const ix = await buildRwtClaimYieldIx(args);
    expect(ix.keys.length).toBe(14);
    expect(ix.programId.equals(args.rwtEngineProgramId)).toBe(true);
    expect(ix.keys[0].pubkey.equals(args.signer)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(args.rwtVault)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false); // dist_config read-only
    expect(ix.keys[11].pubkey.equals(args.ydProgramId)).toBe(true);
  });
});

describe('buildDexCompoundIx', () => {
  it('produces ix with 11 accounts', async () => {
    const args = {
      dexProgramId: pk(),
      ydProgramId: pk(),
      signer: pk(),
      poolState: pk(),
      targetVault: pk(),
      ydConfig: pk(),
      otMint: pk(),
      ydDistributor: pk(),
      ydClaimStatus: pk(),
      ydRewardVault: pk(),
      cumulativeAmount: 1n,
      proof: [],
    };
    const ix = await buildDexCompoundIx(args);
    expect(ix.keys.length).toBe(11);
    expect(ix.programId.equals(args.dexProgramId)).toBe(true);
  });
});

describe('buildOtTreasuryClaimIx', () => {
  it('produces ix with 12 accounts', async () => {
    const args = {
      otProgramId: pk(),
      ydProgramId: pk(),
      signer: pk(),
      otMint: pk(),
      otTreasury: pk(),
      treasuryRwtAta: pk(),
      ydConfig: pk(),
      ydOtMint: pk(),
      ydDistributor: pk(),
      ydClaimStatus: pk(),
      ydRewardVault: pk(),
      cumulativeAmount: 0n,
      proof: [],
    };
    const ix = await buildOtTreasuryClaimIx(args);
    expect(ix.keys.length).toBe(12);
    expect(ix.programId.equals(args.otProgramId)).toBe(true);
  });
});

describe('buildInitializeLiquidityHoldingIx', () => {
  it('produces ix with 7 accounts and disc-only data', async () => {
    const args = {
      ydProgramId: pk(),
      payer: pk(),
      liquidityHolding: pk(),
      liquidityHoldingAta: pk(),
      rwtMint: pk(),
      associatedTokenProgram: ASSOC,
    };
    const ix = await buildInitializeLiquidityHoldingIx(args);
    expect(ix.keys.length).toBe(7);
    expect(ix.data.length).toBe(8);
    const expectedDisc = await discInitLiquidityHolding();
    expect(Array.from(ix.data)).toEqual(Array.from(expectedDisc));
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].pubkey.equals(args.payer)).toBe(true);
  });
});

describe('buildWithdrawLiquidityHoldingIx', () => {
  // SD-18: Authority-gated. Account ordering pinned to
  // contracts/yield-distribution/src/instructions/withdraw_liquidity_holding.rs:81-140.
  const args = {
    ydProgramId: pk(),
    authority: pk(),
    config: pk(),
    liquidityHolding: pk(),
    liquidityHoldingAta: pk(),
    nexusTokenAta: pk(),
    liquidityNexus: pk(),
    dexProgram: pk(),
    amount: 500_000n,
  };

  it('uses canonical sha256("global:withdraw_liquidity_holding") discriminator', async () => {
    const ix = await buildWithdrawLiquidityHoldingIx(args);
    const expectedDisc = await discWithdrawLiquidityHolding();
    expect(Array.from(new Uint8Array(ix.data).subarray(0, 8))).toEqual(
      Array.from(expectedDisc),
    );
    // Same as nodeDisc — keep the redundant assertion to catch web-crypto drift.
    expect(Array.from(expectedDisc)).toEqual(
      Array.from(nodeDisc('withdraw_liquidity_holding')),
    );
  });

  it('produces ix with exactly 9 accounts in pinned order', async () => {
    const ix = await buildWithdrawLiquidityHoldingIx(args);
    expect(ix.keys.length).toBe(9);

    // Order pin: authority (signer, mut), config (read), liquidity_holding (mut),
    // liquidity_holding_ata (mut), nexus_token_ata (mut), liquidity_nexus (mut),
    // dex_program (read), token_program (read), system_program (read).
    expect(ix.keys[0].pubkey.equals(args.authority)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);

    expect(ix.keys[1].pubkey.equals(args.config)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);

    expect(ix.keys[2].pubkey.equals(args.liquidityHolding)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);

    expect(ix.keys[3].pubkey.equals(args.liquidityHoldingAta)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);

    expect(ix.keys[4].pubkey.equals(args.nexusTokenAta)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);

    expect(ix.keys[5].pubkey.equals(args.liquidityNexus)).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true);

    expect(ix.keys[6].pubkey.equals(args.dexProgram)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(false);

    // 7 = SPL token program
    expect(ix.keys[7].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
    // 8 = System program
    expect(ix.keys[8].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('encodes data: disc(8) + amount(u64 LE) = 16 bytes total', async () => {
    const ix = await buildWithdrawLiquidityHoldingIx(args);
    expect(ix.data.length).toBe(16);
    const data = new Uint8Array(ix.data);
    const expectedDisc = await discWithdrawLiquidityHolding();
    expect(Array.from(data.subarray(0, 8))).toEqual(Array.from(expectedDisc));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(500_000n);
  });

  it('encodes amount=0 as 8 zero bytes (handler will revert with ZeroAmount)', async () => {
    const ix = await buildWithdrawLiquidityHoldingIx({ ...args, amount: 0n });
    const data = new Uint8Array(ix.data);
    expect(data.length).toBe(16);
    for (let i = 8; i < 16; i++) expect(data[i]).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// CU_BUDGETS — pinned per-ix CU values (D5 + arch LOW-1)
// -----------------------------------------------------------------------------

describe('CU_BUDGETS', () => {
  it('pins convertToRwt at 300_000 (D5 hard requirement, ~280K measured)', async () => {
    const { CU_BUDGETS } = await import('../layer8-builders');
    expect(CU_BUDGETS.convertToRwt).toBe(300_000);
  });

  it('pins withdrawLiquidityHolding at 150_000 (Transfer + nexus_record_deposit CPI)', async () => {
    const { CU_BUDGETS } = await import('../layer8-builders');
    expect(CU_BUDGETS.withdrawLiquidityHolding).toBe(150_000);
  });

  it('pins claim variants at 200_000 (proof walk + 3-way split + transfers)', async () => {
    const { CU_BUDGETS } = await import('../layer8-builders');
    expect(CU_BUDGETS.claim).toBe(200_000);
  });
});
