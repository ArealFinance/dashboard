/**
 * Tests for PDA derivation helpers — focused on the new
 * `findLiquidityHoldingPda` helper added for Layer 8 (D11.1 singleton).
 *
 * NOTE: We assert on the helper's wiring (seed string + arity) without invoking
 * the underlying `PublicKey.findProgramAddressSync`, because some test
 * environments break ed25519 curve checks under jsdom + node polyfills.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { findLiquidityHoldingPda } from '../pda';

describe('findLiquidityHoldingPda', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes only programId (singleton — no per-OT seed)', () => {
    expect(findLiquidityHoldingPda.length).toBe(1);
  });

  it('forwards exactly the "liq_holding" seed and the program id', () => {
    const sentinelKey = new PublicKey(new Uint8Array(32).fill(7));
    const findSpy = vi
      .spyOn(PublicKey, 'findProgramAddressSync')
      .mockImplementation(() => [sentinelKey, 254]);
    const programId = new PublicKey(new Uint8Array(32).fill(3));

    const [pda, bump] = findLiquidityHoldingPda(programId);
    expect(pda).toBe(sentinelKey);
    expect(bump).toBe(254);

    expect(findSpy).toHaveBeenCalledTimes(1);
    const [seeds, programArg] = findSpy.mock.calls[0];
    expect(seeds.length).toBe(1);
    expect(Array.from(seeds[0])).toEqual(
      Array.from(new TextEncoder().encode('liq_holding')),
    );
    expect(programArg).toBe(programId);
  });
});
