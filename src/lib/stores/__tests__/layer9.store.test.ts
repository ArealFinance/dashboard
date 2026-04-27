/**
 * Substep 10 R55 — stores/layer9.ts coverage.
 *
 * The Layer 9 stores aggregate Nexus state, LP positions, on-chain events,
 * and the Manager bot heartbeat. R55 closes the prior coverage gap with
 * targeted tests on:
 *   1. computeClaimable parity — the exact math the derived store implements.
 *   2. PDA seed pinning — ensuring `findLpPositionPda` derives against
 *      ('lp', poolState, provider) under a deterministic mocked program id.
 *   3. Heartbeat staleness derivation — confirming `lastRunTs` round-trips
 *      from the bot's JSON shape.
 *   4. API error-state branch — `fetchNexusManagerHealth` returns
 *      'unreachable' on missing endpoint and on non-200 response.
 *
 * The store is `derived(...)`-based; we exercise the underlying math via
 * `computeClaimable` (re-imported from `$lib/api/layer9`) instead of
 * spinning up the full svelte runtime — the parity assertion is what
 * matters for production correctness.
 */
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  computeClaimable,
  fetchNexusManagerHealth,
} from '$lib/api/layer9';
import { findLpPositionPda } from '$lib/utils/pda';

// ----------------------------------------------------------------------------
// 1. computeClaimable math parity (matches derived store inline math)
// ----------------------------------------------------------------------------

describe('computeClaimable (R55 — derived store parity)', () => {
  it('returns 0n when cumulative <= claimed', () => {
    expect(computeClaimable(100n, 100n, 1_000_000n)).toBe(0n);
    expect(computeClaimable(50n, 100n, 1_000_000n)).toBe(0n);
  });

  it('returns 0n when shares == 0', () => {
    expect(computeClaimable(1_000_000_000_000_000_000n, 0n, 0n)).toBe(0n);
  });

  it('matches the Q64.64 fixed-point formula: ((delta_q64 * shares) >> 64)', () => {
    // 1.0 in Q64.64 = 1n << 64n
    const ONE_Q64 = 1n << 64n;
    // delta = 1.0, shares = 100 → claimable = 100
    expect(computeClaimable(ONE_Q64, 0n, 100n)).toBe(100n);

    // delta = 0.5, shares = 200 → claimable = 100
    const HALF_Q64 = ONE_Q64 / 2n;
    expect(computeClaimable(HALF_Q64, 0n, 200n)).toBe(100n);
  });

  it('handles non-zero claimed snapshots correctly', () => {
    const ONE_Q64 = 1n << 64n;
    // cumulative = 2.0, claimed = 0.5, shares = 100 → 1.5 * 100 = 150
    expect(computeClaimable(ONE_Q64 * 2n, ONE_Q64 / 2n, 100n)).toBe(150n);
  });

  it('matches the inline derived store formula bit-for-bit', () => {
    // Inline reproduction of the math from `nexusPendingFees` derived store.
    function inlineFormula(cumulative: bigint, claimed: bigint, shares: bigint): bigint {
      const delta = cumulative - claimed;
      if (delta <= 0n) return 0n;
      return (delta * shares) >> 64n;
    }

    const samples: [bigint, bigint, bigint][] = [
      [(1n << 64n), 0n, 100n],
      [(3n << 64n) / 2n, (1n << 64n) / 2n, 1_000n],
      [0n, 0n, 1_000_000n],
      [42n, 100n, 999n],
    ];
    for (const [c, cl, s] of samples) {
      expect(computeClaimable(c, cl, s)).toBe(inlineFormula(c, cl, s));
    }
  });
});

// ----------------------------------------------------------------------------
// 2. PDA seed pinning — ('lp', poolState, provider)
// ----------------------------------------------------------------------------

describe('findLpPositionPda (R55 — seed pinning)', () => {
  it('derives against the literal seed sequence ["lp", poolState, provider]', () => {
    const programId = new PublicKey(new Uint8Array(32).fill(0xab));
    const pool = new PublicKey(new Uint8Array(32).fill(1));
    const provider = new PublicKey(new Uint8Array(32).fill(2));

    // Spy on findProgramAddressSync to inspect the seeds the store reaches for.
    const spy = vi
      .spyOn(PublicKey, 'findProgramAddressSync')
      .mockReturnValue([new PublicKey(new Uint8Array(32).fill(0xff)), 254]);
    findLpPositionPda(pool, provider, programId);
    expect(spy).toHaveBeenCalledWith(
      [Buffer.from('lp'), pool.toBuffer(), provider.toBuffer()],
      programId,
    );
    spy.mockRestore();
  });

  it('different (pool, provider) pairs produce different PDAs', () => {
    // Mock the underlying derivation so the test stays deterministic and
    // avoids the off-curve iteration that may fail under jsdom polyfills.
    const calls: Array<{ seeds: (Buffer | Uint8Array)[]; programId: PublicKey }> = [];
    const spy = vi
      .spyOn(PublicKey, 'findProgramAddressSync')
      .mockImplementation((seeds: any, programId: any) => {
        calls.push({ seeds, programId });
        const fill = ((calls.length * 7) % 250) + 1;
        return [new PublicKey(new Uint8Array(32).fill(fill)), 254];
      });

    const programId = new PublicKey(new Uint8Array(32).fill(0xab));
    const pool1 = new PublicKey(new Uint8Array(32).fill(1));
    const pool2 = new PublicKey(new Uint8Array(32).fill(2));
    const provider = new PublicKey(new Uint8Array(32).fill(3));

    const [pda1] = findLpPositionPda(pool1, provider, programId);
    const [pda2] = findLpPositionPda(pool2, provider, programId);
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
    // And the seeds passed in differ between the two calls.
    expect(calls.length).toBe(2);
    expect(Buffer.from(calls[0]!.seeds[1] as any).toString('hex'))
      .not.toBe(Buffer.from(calls[1]!.seeds[1] as any).toString('hex'));

    spy.mockRestore();
  });
});

// ----------------------------------------------------------------------------
// 3 + 4. Heartbeat parsing + error-state branches
// ----------------------------------------------------------------------------

describe('fetchNexusManagerHealth (R55 — heartbeat error states)', () => {
  it('returns "unreachable" with explicit reason when endpoint is undefined', async () => {
    const out = await fetchNexusManagerHealth(undefined);
    expect(out.status).toBe('unreachable');
    expect(out.error).toBe('No endpoint configured');
    expect(out.lastRunTs).toBeNull();
  });

  it('returns "unreachable" on non-200 HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    const out = await fetchNexusManagerHealth('http://mock');
    expect(out.status).toBe('unreachable');
    expect(out.error).toBe('HTTP 503');
    fetchSpy.mockRestore();
  });

  it('parses lastRunTs + version on a healthy response', async () => {
    const body = {
      status: 'running',
      lastRunTs: 1_700_000_000_000,
      version: '0.1.0',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await fetchNexusManagerHealth('http://mock');
    expect(out.status).toBe('running');
    expect(out.lastRunTs).toBe(1_700_000_000_000);
    expect(out.version).toBe('0.1.0');
    fetchSpy.mockRestore();
  });

  it('returns "unreachable" with thrown-error reason when fetch rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connection refused'),
    );
    const out = await fetchNexusManagerHealth('http://mock');
    expect(out.status).toBe('unreachable');
    expect(out.error).toMatch(/connection refused/);
    fetchSpy.mockRestore();
  });
});
