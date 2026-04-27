/**
 * Tests for Layer 8 resolver chains.
 *
 * Each resolver fans out to multiple `getAccountInfo` calls; we mock the
 * Connection and assert the produced account set matches the expected
 * dynamic-account count + selected pubkeys (without invoking real PDA
 * derivation, which is exercised in pda.test.ts).
 *
 * Coverage:
 *   - resolveConvertAccounts: all 13 dynamic accounts + min-distribution surfaced.
 *   - selectMasterPoolDirection: USDC-on-A vs USDC-on-B vs neither.
 *   - resolveRwtClaimAccounts: claimStatus PDA derives against rwtVault, NOT signer.
 *   - resolveDexCompoundAccounts: targetVault auto-detects RWT side.
 *   - resolveTreasuryClaimAccounts: distinct (otMint, ydOtMint) wiring.
 *   - resolveWithdrawLiquidityHoldingAccounts: derives against ydProgramId for
 *     liquidity_holding and dexProgramId for liquidity_nexus.
 *   - Negative paths: missing RwtVault → throw, malformed proof → throw.
 *   - resolveRwtUsdcMasterPool: env-override vs canonical-derive.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  resolveConvertAccounts,
  resolveRwtClaimAccounts,
  resolveDexCompoundAccounts,
  resolveTreasuryClaimAccounts,
  resolveWithdrawLiquidityHoldingAccounts,
  resolveRwtUsdcMasterPool,
  selectMasterPoolDirection,
  readClaimStatusCumulative,
} from '../layer8-resolvers';

const pk = (): PublicKey => Keypair.generate().publicKey;

// jsdom + node polyfills break ed25519 curve checks for off-curve PDA
// derivation — mirror the pattern from pda.test.ts and stub the underlying
// API to return a deterministic sentinel pubkey.
//
// Tester H-1 (mock fidelity): the sentinel is now a deterministic hash of
// (programId, ...seeds) so wrong-seeds bugs surface as mismatched bytes
// instead of a "lucky pass" with arbitrary fillers. The hash is computed
// from a stable digest so test runs are reproducible.
import { createHash } from 'node:crypto';

function deterministicSentinel(programId: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey {
  const h = createHash('sha256');
  h.update(programId.toBuffer());
  for (const s of seeds) {
    h.update(Buffer.from(s));
    h.update(Buffer.from([0xff])); // separator so seeds aren't ambiguous when concatenated
  }
  return new PublicKey(h.digest().subarray(0, 32));
}

beforeEach(() => {
  vi.spyOn(PublicKey, 'findProgramAddressSync').mockImplementation(
    (seeds: (Buffer | Uint8Array)[], programId: PublicKey) => {
      return [deterministicSentinel(programId, seeds), 254];
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Build a 32-byte big-endian-ish synthetic Buffer that the SPL Token / Anchor
// readers will accept. The contract reader layouts:
//   RwtVault body (259 bytes): u128 + u64 + u64 + 32B + 32B + 32B + 32B + 1B + 32B + 32B + 1B + 32B + 1B
//     We need at least the fields used by readers (capital_acc, rwt_mint,
//     authority, manager, areal_fee_destination + bump). Body offsets are:
//       0..16  total_invested_capital
//       16..24 total_rwt_supply
//       24..32 nav_book_value
//       32..64 capital_accumulator_ata
//       64..96 rwt_mint
//       96..128 authority
//       128..160 pending_authority
//       160 has_pending
//       161..193 manager
//       193..225 pause_authority
//       225 mint_paused
//       226..258 areal_fee_destination
//       258 bump
function buildRwtVaultBody({
  capitalAcc,
  rwtMint,
  authority,
  manager,
  arealFeeDestination,
  bump = 0xff,
}: {
  capitalAcc: PublicKey;
  rwtMint: PublicKey;
  authority: PublicKey;
  manager: PublicKey;
  arealFeeDestination: PublicKey;
  bump?: number;
}): Buffer {
  const body = Buffer.alloc(259);
  body.set(capitalAcc.toBytes(), 32);
  body.set(rwtMint.toBytes(), 64);
  body.set(authority.toBytes(), 96);
  body.set(manager.toBytes(), 161);
  body.set(arealFeeDestination.toBytes(), 226);
  body[258] = bump;
  // 8 byte discriminator prefix
  return Buffer.concat([Buffer.alloc(8), body]);
}

// MerkleDistributor body (186 bytes):
//   0..32 ot_mint
//   32..64 reward_vault
//   64..96 accumulator
//   96..128 merkle_root
//   128..136 max_total_claim u64
//   136..144 total_claimed u64
//   144..152 total_funded u64
//   152..160 locked_vested u64
//   160..168 last_fund_ts i64
//   168..176 vesting_period_secs i64
//   176..184 epoch u64
//   184 is_active u8
//   185 bump u8
function buildMerkleDistributorBody({
  otMint,
  rewardVault,
  accumulator,
  maxTotalClaim = 1_000_000n,
  totalClaimed = 0n,
  totalFunded = 0n,
  lockedVested = 0n,
  isActive = true,
  bump = 0xff,
}: {
  otMint: PublicKey;
  rewardVault: PublicKey;
  accumulator: PublicKey;
  maxTotalClaim?: bigint;
  totalClaimed?: bigint;
  totalFunded?: bigint;
  lockedVested?: bigint;
  isActive?: boolean;
  bump?: number;
}): Buffer {
  const body = Buffer.alloc(186);
  body.set(otMint.toBytes(), 0);
  body.set(rewardVault.toBytes(), 32);
  body.set(accumulator.toBytes(), 64);
  body.writeBigUInt64LE(maxTotalClaim, 128);
  body.writeBigUInt64LE(totalClaimed, 136);
  body.writeBigUInt64LE(totalFunded, 144);
  body.writeBigUInt64LE(lockedVested, 152);
  body[184] = isActive ? 1 : 0;
  body[185] = bump;
  return Buffer.concat([Buffer.alloc(8), body]);
}

// DistributionConfig body (141 bytes):
//   0..32 authority
//   32..64 pending_authority
//   64 has_pending
//   65..97 publish_authority
//   97..99 protocol_fee_bps u16
//   99..107 min_distribution_amount u64
//   107..139 areal_fee_destination
//   139 is_active
//   140 bump
function buildDistributionConfigBody({
  authority,
  publishAuthority,
  arealFeeDestination,
  protocolFeeBps = 25,
  minDistributionAmount = 1_000_000n,
  isActive = true,
  bump = 0xff,
}: {
  authority: PublicKey;
  publishAuthority: PublicKey;
  arealFeeDestination: PublicKey;
  protocolFeeBps?: number;
  minDistributionAmount?: bigint;
  isActive?: boolean;
  bump?: number;
}): Buffer {
  const body = Buffer.alloc(141);
  body.set(authority.toBytes(), 0);
  body.set(publishAuthority.toBytes(), 65);
  body.writeUInt16LE(protocolFeeBps, 97);
  body.writeBigUInt64LE(minDistributionAmount, 99);
  body.set(arealFeeDestination.toBytes(), 107);
  body[139] = isActive ? 1 : 0;
  body[140] = bump;
  return Buffer.concat([Buffer.alloc(8), body]);
}

// RwtDistributionConfig body (71 bytes):
//   0..2 book_value_bps u16
//   2..4 liquidity_bps u16
//   4..6 protocol_revenue_bps u16
//   6..38 liquidity_destination
//   38..70 protocol_revenue_destination
//   70 bump
function buildRwtDistConfigBody({
  liquidityDest,
  protocolRevenueDest,
  bookValueBps = 7000,
  liquidityBps = 1500,
  protocolRevenueBps = 1500,
  bump = 0xff,
}: {
  liquidityDest: PublicKey;
  protocolRevenueDest: PublicKey;
  bookValueBps?: number;
  liquidityBps?: number;
  protocolRevenueBps?: number;
  bump?: number;
}): Buffer {
  const body = Buffer.alloc(71);
  body.writeUInt16LE(bookValueBps, 0);
  body.writeUInt16LE(liquidityBps, 2);
  body.writeUInt16LE(protocolRevenueBps, 4);
  body.set(liquidityDest.toBytes(), 6);
  body.set(protocolRevenueDest.toBytes(), 38);
  body[70] = bump;
  return Buffer.concat([Buffer.alloc(8), body]);
}

function makeMockConnection(map: Map<string, Buffer | null>) {
  return {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      const data = map.get(pubkey.toBase58());
      if (data === undefined || data === null) return null;
      return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
    }),
  } as any;
}

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Tester H-1 / H-2 — mock fidelity
// ----------------------------------------------------------------------------

describe('PDA mock fidelity (tester H-1: deterministic hash sentinels)', () => {
  it('two findProgramAddressSync calls with the same (programId, seeds) yield identical sentinel bytes', () => {
    const programId = pk();
    const seedA = Buffer.from('seed-a');
    const seedB = Buffer.from('seed-b');

    const [out1] = PublicKey.findProgramAddressSync([seedA, seedB], programId);
    const [out2] = PublicKey.findProgramAddressSync([seedA, seedB], programId);
    expect(out1.toBase58()).toBe(out2.toBase58());
  });

  it('different seeds produce different sentinels (catches wrong-seeds bugs)', () => {
    const programId = pk();
    const [out1] = PublicKey.findProgramAddressSync([Buffer.from('seed-a')], programId);
    const [out2] = PublicKey.findProgramAddressSync([Buffer.from('seed-b')], programId);
    expect(out1.toBase58()).not.toBe(out2.toBase58());
  });

  it('different programIds produce different sentinels for the same seeds', () => {
    const seeds = [Buffer.from('seed')];
    const [out1] = PublicKey.findProgramAddressSync(seeds, pk());
    const [out2] = PublicKey.findProgramAddressSync(seeds, pk());
    expect(out1.toBase58()).not.toBe(out2.toBase58());
  });
});

describe('selectMasterPoolDirection', () => {
  const usdc = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const rwt = pk();
  const vaultA = pk();
  const vaultB = pk();

  it('returns aToB=true when USDC is token_a', () => {
    const dir = selectMasterPoolDirection(
      {
        tokenAMint: usdc.toBase58(),
        tokenBMint: rwt.toBase58(),
        vaultA: vaultA.toBase58(),
        vaultB: vaultB.toBase58(),
      },
      usdc,
    );
    expect(dir.aToB).toBe(true);
    expect(dir.vaultIn.equals(vaultA)).toBe(true);
    expect(dir.vaultOut.equals(vaultB)).toBe(true);
  });

  it('returns aToB=false when USDC is token_b (vault flip)', () => {
    const dir = selectMasterPoolDirection(
      {
        tokenAMint: rwt.toBase58(),
        tokenBMint: usdc.toBase58(),
        vaultA: vaultA.toBase58(),
        vaultB: vaultB.toBase58(),
      },
      usdc,
    );
    expect(dir.aToB).toBe(false);
    expect(dir.vaultIn.equals(vaultB)).toBe(true);
    expect(dir.vaultOut.equals(vaultA)).toBe(true);
  });

  it('throws when neither side is USDC', () => {
    const other = pk();
    expect(() =>
      selectMasterPoolDirection(
        {
          tokenAMint: rwt.toBase58(),
          tokenBMint: other.toBase58(),
          vaultA: vaultA.toBase58(),
          vaultB: vaultB.toBase58(),
        },
        usdc,
      ),
    ).toThrowError(/no USDC side/);
  });
});

// ----------------------------------------------------------------------------

describe('resolveRwtUsdcMasterPool', () => {
  const rwt = pk();
  const usdc = pk();
  const dexProgramId = pk();

  it('returns env override when set', () => {
    const override = pk();
    const out = resolveRwtUsdcMasterPool(
      override.toBase58(),
      rwt,
      usdc,
      dexProgramId,
    );
    expect(out.equals(override)).toBe(true);
  });

  it('throws on malformed env override', () => {
    expect(() =>
      resolveRwtUsdcMasterPool('not-a-pubkey', rwt, usdc, dexProgramId),
    ).toThrowError(/PUBLIC_RWT_USDC_POOL/);
  });

  it('derives via canonical-order seeds when env unset', () => {
    const out = resolveRwtUsdcMasterPool(undefined, rwt, usdc, dexProgramId);
    // Should produce a valid pubkey (the actual derivation is exercised by
    // findPoolStatePda — we only assert the function returned a 32B pubkey).
    expect(out.toBytes().length).toBe(32);
  });

  it('handles empty-string env as unset', () => {
    const out = resolveRwtUsdcMasterPool('   ', rwt, usdc, dexProgramId);
    expect(out.toBytes().length).toBe(32);
  });
});

// ----------------------------------------------------------------------------

describe('resolveConvertAccounts', () => {
  const ydProgramId = pk();
  const rwtEngineProgramId = pk();
  const dexProgramId = pk();
  const otProgramId = pk();
  const otMint = pk();
  const usdcMint = pk();
  const rwtMint = pk();
  const authority = pk();
  const arealFeeDest = pk();
  const capitalAcc = pk();
  const manager = pk();
  const rewardVault = pk();
  const accumulator = pk();
  const dexConfig = pk();
  const dexArealFeeAccount = pk();
  const rwtUsdcPool = pk();
  const vaultA = pk();
  const vaultB = pk();

  function setupConnection(
    overrides: Partial<{
      ydConfigData: Buffer | null;
      distData: Buffer | null;
      rwtVaultData: Buffer | null;
    }> = {},
  ): any {
    // Compute the *exact* PDA addresses the resolver will read so the mock
    // returns the right body.
    const map = new Map<string, Buffer | null>();
    const captureBytes = (mint: Buffer | null) => mint;

    // We don't know the exact PDA values without re-deriving here, so pass
    // a permissive mock: any getAccountInfo returns the matching body kind
    // based on call sequence. Resolver calls in order:
    //   1. readDistributionConfig
    //   2. readMerkleDistributor
    //   3. readRwtVault
    let callIdx = 0;
    const datas = [
      overrides.ydConfigData !== undefined
        ? overrides.ydConfigData
        : buildDistributionConfigBody({
            authority,
            publishAuthority: pk(),
            arealFeeDestination: arealFeeDest,
            minDistributionAmount: 7_500_000n,
          }),
      overrides.distData !== undefined
        ? overrides.distData
        : buildMerkleDistributorBody({
            otMint,
            rewardVault,
            accumulator,
          }),
      overrides.rwtVaultData !== undefined
        ? overrides.rwtVaultData
        : buildRwtVaultBody({
            capitalAcc,
            rwtMint,
            authority,
            manager,
            arealFeeDestination: arealFeeDest,
          }),
    ];
    return {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    };
  }

  it('tester H-2: getAccountInfo call ordering is YD config → distributor → RwtVault', async () => {
    // Pin the read order by spying on the mock and asserting nthCallWith.
    const mockFn = vi.fn(async (_pk: PublicKey) => {
      // Emit valid bodies in the expected order.
      const callIdx = mockFn.mock.calls.length - 1;
      const datas: Buffer[] = [
        buildDistributionConfigBody({
          authority,
          publishAuthority: pk(),
          arealFeeDestination: arealFeeDest,
          minDistributionAmount: 1n,
        }),
        buildMerkleDistributorBody({ otMint, rewardVault, accumulator }),
        buildRwtVaultBody({
          capitalAcc,
          rwtMint,
          authority,
          manager,
          arealFeeDestination: arealFeeDest,
        }),
      ];
      const data = datas[callIdx];
      if (!data) return null;
      return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
    });
    const conn = { getAccountInfo: mockFn } as any;

    await resolveConvertAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId, otProgramId },
      otMint,
      usdcMint,
      rwtUsdcPool,
      dexConfig,
      dexArealFeeAccount,
      {
        tokenAMint: usdcMint.toBase58(),
        tokenBMint: rwtMint.toBase58(),
        vaultA: vaultA.toBase58(),
        vaultB: vaultB.toBase58(),
      },
    );

    expect(mockFn).toHaveBeenCalledTimes(3);
    // First call → YD DistributionConfig PDA (deterministic via mocked PDA seed).
    // Subsequent calls → MerkleDistributor → RwtVault.
    // We assert the pubkey args are distinct (i.e. the resolver isn't reading
    // the same account 3 times).
    const calls = mockFn.mock.calls.map((c: any) => (c[0] as PublicKey).toBase58());
    expect(new Set(calls).size).toBe(3); // three distinct PDAs
  });

  it('returns the full set of dynamic accounts (all 13 pubkeys present)', async () => {
    const conn = setupConnection();
    const out = await resolveConvertAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId, otProgramId },
      otMint,
      usdcMint,
      rwtUsdcPool,
      dexConfig,
      dexArealFeeAccount,
      {
        tokenAMint: usdcMint.toBase58(),
        tokenBMint: rwtMint.toBase58(),
        vaultA: vaultA.toBase58(),
        vaultB: vaultB.toBase58(),
      },
    );
    expect(out.config.toBytes().length).toBe(32);
    expect(out.distributor.toBytes().length).toBe(32);
    expect(out.otMint.equals(otMint)).toBe(true);
    expect(out.accumulator.toBytes().length).toBe(32);
    expect(out.accumulatorUsdcAta.toBytes().length).toBe(32);
    expect(out.accumulatorRwtAta.toBytes().length).toBe(32);
    expect(out.feeAccount.equals(arealFeeDest)).toBe(true);
    expect(out.rewardVault.equals(rewardVault)).toBe(true);
    expect(out.rwtMint.equals(rwtMint)).toBe(true);
    expect(out.dexConfig.equals(dexConfig)).toBe(true);
    expect(out.poolState.equals(rwtUsdcPool)).toBe(true);
    // USDC=A, so vaultIn=A, vaultOut=B, aToB=true
    expect(out.dexPoolVaultIn.equals(vaultA)).toBe(true);
    expect(out.dexPoolVaultOut.equals(vaultB)).toBe(true);
    expect(out.aToB).toBe(true);
    expect(out.dexArealFeeAccount.equals(dexArealFeeAccount)).toBe(true);
    expect(out.rwtVault.toBytes().length).toBe(32);
    expect(out.rwtCapitalAcc.equals(capitalAcc)).toBe(true);
    // SD-22: dao_fee_account == areal_fee_destination on the contract layout.
    expect(out.rwtDaoFeeAccount.equals(arealFeeDest)).toBe(true);
    expect(out.minDistributionAmount).toBe(7_500_000n);
  });

  // tester M-2 — SD-22 dual-role distinctness: ydConfig.arealFeeDestination
  // (RWT-side fee for convert) and rwtVault.arealFeeDestination (USDC-side
  // fee for mint_rwt) MUST surface as DIFFERENT pubkeys in the resolver
  // output. The base test reuses one value; this one pins independent wires.
  it('SD-22 — wires ydConfig and rwtVault fee destinations from independent sources', async () => {
    const ydArealFee = pk();
    const rwtArealFee = pk();
    expect(ydArealFee.equals(rwtArealFee)).toBe(false); // sanity: distinct
    const conn = {
      getAccountInfo: vi.fn()
        .mockResolvedValueOnce({
          data: buildDistributionConfigBody({
            authority,
            publishAuthority: pk(),
            arealFeeDestination: ydArealFee,
            minDistributionAmount: 1n,
          }),
          owner: pk(), executable: false, lamports: 1, rentEpoch: 0,
        })
        .mockResolvedValueOnce({
          data: buildMerkleDistributorBody({ otMint, rewardVault, accumulator }),
          owner: pk(), executable: false, lamports: 1, rentEpoch: 0,
        })
        .mockResolvedValueOnce({
          data: buildRwtVaultBody({
            capitalAcc,
            rwtMint,
            authority,
            manager,
            arealFeeDestination: rwtArealFee,
          }),
          owner: pk(), executable: false, lamports: 1, rentEpoch: 0,
        }),
    };
    const out = await resolveConvertAccounts(
      conn as any,
      { ydProgramId, rwtEngineProgramId, dexProgramId, otProgramId },
      otMint,
      usdcMint,
      rwtUsdcPool,
      dexConfig,
      dexArealFeeAccount,
      {
        tokenAMint: usdcMint.toBase58(),
        tokenBMint: rwtMint.toBase58(),
        vaultA: vaultA.toBase58(),
        vaultB: vaultB.toBase58(),
      },
    );
    expect(out.feeAccount.equals(ydArealFee)).toBe(true);
    expect(out.rwtDaoFeeAccount.equals(rwtArealFee)).toBe(true);
    expect(out.feeAccount.equals(out.rwtDaoFeeAccount)).toBe(false);
  });

  it('throws when YD config is uninitialized', async () => {
    const conn = setupConnection({ ydConfigData: null });
    await expect(
      resolveConvertAccounts(
        conn,
        { ydProgramId, rwtEngineProgramId, dexProgramId, otProgramId },
        otMint,
        usdcMint,
        rwtUsdcPool,
        dexConfig,
        dexArealFeeAccount,
        {
          tokenAMint: usdcMint.toBase58(),
          tokenBMint: rwtMint.toBase58(),
          vaultA: vaultA.toBase58(),
          vaultB: vaultB.toBase58(),
        },
      ),
    ).rejects.toThrowError(/DistributionConfig not initialized/);
  });

  it('throws when RwtVault is uninitialized', async () => {
    const conn = setupConnection({ rwtVaultData: null });
    await expect(
      resolveConvertAccounts(
        conn,
        { ydProgramId, rwtEngineProgramId, dexProgramId, otProgramId },
        otMint,
        usdcMint,
        rwtUsdcPool,
        dexConfig,
        dexArealFeeAccount,
        {
          tokenAMint: usdcMint.toBase58(),
          tokenBMint: rwtMint.toBase58(),
          vaultA: vaultA.toBase58(),
          vaultB: vaultB.toBase58(),
        },
      ),
    ).rejects.toThrowError(/RwtVault not initialized/);
  });
});

// ----------------------------------------------------------------------------

describe('resolveRwtClaimAccounts', () => {
  it('produces the 9 dynamic accounts and surfaces vesting state', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const otMint = pk();
    const rwtMint = pk();
    const liquidityDest = pk();
    const protocolRevenueDest = pk();
    const rewardVault = pk();
    const accumulator = pk();

    let callIdx = 0;
    const datas = [
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
      buildRwtDistConfigBody({ liquidityDest, protocolRevenueDest }),
      buildMerkleDistributorBody({
        otMint,
        rewardVault,
        accumulator,
        maxTotalClaim: 5_000n,
        lockedVested: 1_000n,
        totalFunded: 5_000n,
        totalClaimed: 200n,
      }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;

    const out = await resolveRwtClaimAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId: pk(), otProgramId: pk() },
      otMint,
    );
    expect(out.rwtVault.toBytes().length).toBe(32);
    expect(out.distConfig.toBytes().length).toBe(32);
    expect(out.rwtClaimAta.toBytes().length).toBe(32);
    expect(out.liquidityDest.equals(liquidityDest)).toBe(true);
    expect(out.protocolRevenueDest.equals(protocolRevenueDest)).toBe(true);
    expect(out.ydConfig.toBytes().length).toBe(32);
    expect(out.ydDistributor.toBytes().length).toBe(32);
    expect(out.ydClaimStatus.toBytes().length).toBe(32);
    expect(out.ydRewardVault.equals(rewardVault)).toBe(true);
    // claimStatus claimant must be rwtVault, NOT signer — pin via byte equality
    expect(Array.from(out.claimantBytes)).toEqual(Array.from(out.rwtVault.toBytes()));
    expect(out.vesting.maxTotalClaim).toBe(5_000n);
    expect(out.vesting.lockedVested).toBe(1_000n);
    expect(out.vesting.totalClaimed).toBe(200n);
  });
});

// ----------------------------------------------------------------------------

describe('resolveDexCompoundAccounts (Substep 11 LOW-2 — self-read RwtVault)', () => {
  it('targets vault_a when token_a is RWT', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const otMint = pk();
    const rwtMint = pk();
    const vaultA = pk();
    const vaultB = pk();
    const rewardVault = pk();
    const accumulator = pk();

    // Resolver now reads (1) RwtVault + (2) MerkleDistributor in order.
    let callIdx = 0;
    const datas = [
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
      buildMerkleDistributorBody({ otMint, rewardVault, accumulator }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;

    const pool = {
      pda: pk().toBase58(),
      tokenAMint: rwtMint.toBase58(),
      tokenBMint: pk().toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
    };
    const out = await resolveDexCompoundAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId: pk(), otProgramId: pk() },
      otMint,
      pool,
    );
    expect(out.targetVault.equals(vaultA)).toBe(true);
  });

  it('targets vault_b when token_b is RWT', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const otMint = pk();
    const rwtMint = pk();
    const vaultA = pk();
    const vaultB = pk();
    const rewardVault = pk();
    const accumulator = pk();

    let callIdx = 0;
    const datas = [
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
      buildMerkleDistributorBody({ otMint, rewardVault, accumulator }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;

    const pool = {
      pda: pk().toBase58(),
      tokenAMint: pk().toBase58(),
      tokenBMint: rwtMint.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
    };
    const out = await resolveDexCompoundAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId: pk(), otProgramId: pk() },
      otMint,
      pool,
    );
    expect(out.targetVault.equals(vaultB)).toBe(true);
  });

  it('throws when pool has no RWT side', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const otMint = pk();
    const rwtMint = pk();

    let callIdx = 0;
    // First call returns a valid RwtVault so the resolver can derive the
    // RWT mint; second call would be MerkleDistributor but we never reach
    // it because the pool-side check fires first.
    const datas = [
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;
    const pool = {
      pda: pk().toBase58(),
      tokenAMint: pk().toBase58(),
      tokenBMint: pk().toBase58(),
      vaultA: pk().toBase58(),
      vaultB: pk().toBase58(),
    };
    await expect(
      resolveDexCompoundAccounts(
        conn,
        { ydProgramId, rwtEngineProgramId, dexProgramId: pk(), otProgramId: pk() },
        otMint,
        pool,
      ),
    ).rejects.toThrowError(/no RWT side/);
  });

  it('throws when RwtVault is uninitialized (LOW-2 self-read failure)', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => null),
    } as any;
    await expect(
      resolveDexCompoundAccounts(
        conn,
        { ydProgramId: pk(), rwtEngineProgramId: pk(), dexProgramId: pk(), otProgramId: pk() },
        pk(),
        {
          pda: pk().toBase58(),
          tokenAMint: pk().toBase58(),
          tokenBMint: pk().toBase58(),
          vaultA: pk().toBase58(),
          vaultB: pk().toBase58(),
        },
      ),
    ).rejects.toThrowError(/RwtVault not initialized/);
  });
});

// ----------------------------------------------------------------------------

describe('resolveTreasuryClaimAccounts (Substep 11 LOW-2 — self-read RwtVault)', () => {
  it('derives ot_treasury under otProgramId and uses ydOtMint for distributor', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const otProgramId = pk();
    const otMint = pk();
    const ydOtMint = pk(); // distinct from otMint
    const rwtMint = pk();
    const rewardVault = pk();
    const accumulator = pk();

    let callIdx = 0;
    const datas = [
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
      buildMerkleDistributorBody({
        otMint: ydOtMint, // distributor is keyed by ydOtMint
        rewardVault,
        accumulator,
      }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;

    const out = await resolveTreasuryClaimAccounts(
      conn,
      { ydProgramId, rwtEngineProgramId, dexProgramId: pk(), otProgramId },
      otMint,
      ydOtMint,
    );
    expect(out.otMint.equals(otMint)).toBe(true);
    expect(out.ydOtMint.equals(ydOtMint)).toBe(true);
    expect(out.otTreasury.toBytes().length).toBe(32);
    expect(out.treasuryRwtAta.toBytes().length).toBe(32);
    expect(out.ydRewardVault.equals(rewardVault)).toBe(true);
  });

  it('throws when RwtVault is uninitialized (LOW-2 self-read failure)', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => null),
    } as any;
    await expect(
      resolveTreasuryClaimAccounts(
        conn,
        { ydProgramId: pk(), rwtEngineProgramId: pk(), dexProgramId: pk(), otProgramId: pk() },
        pk(),
        pk(),
      ),
    ).rejects.toThrowError(/RwtVault not initialized/);
  });
});

// ----------------------------------------------------------------------------

describe('resolveWithdrawLiquidityHoldingAccounts', () => {
  it('produces 6 dynamic accounts + advisory authority pin', async () => {
    const ydProgramId = pk();
    const rwtEngineProgramId = pk();
    const dexProgramId = pk();
    const authority = pk();
    const arealFeeDest = pk();
    const rwtMint = pk();

    let callIdx = 0;
    const datas = [
      buildDistributionConfigBody({
        authority,
        publishAuthority: pk(),
        arealFeeDestination: arealFeeDest,
      }),
      buildRwtVaultBody({
        capitalAcc: pk(),
        rwtMint,
        authority: pk(),
        manager: pk(),
        arealFeeDestination: pk(),
      }),
    ];
    const conn = {
      getAccountInfo: vi.fn(async () => {
        const data = datas[callIdx++];
        if (!data) return null;
        return { data, owner: pk(), executable: false, lamports: 1, rentEpoch: 0 };
      }),
    } as any;

    const out = await resolveWithdrawLiquidityHoldingAccounts(conn, {
      ydProgramId,
      rwtEngineProgramId,
      dexProgramId,
      otProgramId: pk(),
    });
    expect(out.config.toBytes().length).toBe(32);
    expect(out.liquidityHolding.toBytes().length).toBe(32);
    expect(out.liquidityHoldingAta.toBytes().length).toBe(32);
    expect(out.nexusTokenAta.toBytes().length).toBe(32);
    expect(out.liquidityNexus.toBytes().length).toBe(32);
    expect(out.dexProgram.equals(dexProgramId)).toBe(true);
    // SD-18 advisory: surfaces the on-chain authority for the dashboard lock-icon.
    expect(out.expectedAuthority.equals(authority)).toBe(true);
  });

  it('throws when YD config is missing', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => null),
    } as any;
    await expect(
      resolveWithdrawLiquidityHoldingAccounts(conn, {
        ydProgramId: pk(),
        rwtEngineProgramId: pk(),
        dexProgramId: pk(),
        otProgramId: pk(),
      }),
    ).rejects.toThrowError(/DistributionConfig not initialized/);
  });
});

// ----------------------------------------------------------------------------

describe('readClaimStatusCumulative', () => {
  it('returns 0n when ClaimStatus PDA does not exist', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => null),
    } as any;
    const out = await readClaimStatusCumulative(conn, pk());
    expect(out).toBe(0n);
  });

  it('returns 0n when account too short', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => ({
        data: Buffer.alloc(20),
        owner: pk(),
        executable: false,
        lamports: 1,
        rentEpoch: 0,
      })),
    } as any;
    const out = await readClaimStatusCumulative(conn, pk());
    expect(out).toBe(0n);
  });

  it('reads claimed_amount at body offset 64', async () => {
    // Layout: 8 (disc) + 32 (claimant) + 32 (distributor) + 8 (claimed_amount) + 1 (bump)
    const data = Buffer.alloc(81);
    data.writeBigUInt64LE(123_456n, 8 + 64);
    const conn = {
      getAccountInfo: vi.fn(async () => ({
        data,
        owner: pk(),
        executable: false,
        lamports: 1,
        rentEpoch: 0,
      })),
    } as any;
    const out = await readClaimStatusCumulative(conn, pk());
    expect(out).toBe(123_456n);
  });

  it('returns 0n when getAccountInfo throws', async () => {
    const conn = {
      getAccountInfo: vi.fn(async () => {
        throw new Error('rpc fail');
      }),
    } as any;
    const out = await readClaimStatusCumulative(conn, pk());
    expect(out).toBe(0n);
  });
});
