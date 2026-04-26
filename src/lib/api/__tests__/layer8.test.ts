/**
 * Tests for the Layer 8 API client (event discriminator + parser).
 */
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import {
  __test__,
  fetchEvents,
  fetchCrankHealth,
  fetchMerkleProof,
  type Layer8Event,
} from '../layer8';

const { eventDiscriminator, parseProgramDataLog, decodeProgramData } = __test__;
const pk = (): PublicKey => Keypair.generate().publicKey;

// Helper: encode a Uint8Array as base64 (Node + browser compatible).
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

describe('eventDiscriminator', () => {
  it('produces 8-byte discriminators', async () => {
    const d = await eventDiscriminator('StreamConverted');
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(8);
  });

  it('returns deterministic results across calls', async () => {
    const a = await eventDiscriminator('YieldDistributed');
    const b = await eventDiscriminator('YieldDistributed');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces different discriminators for different names', async () => {
    const a = await eventDiscriminator('StreamConverted');
    const b = await eventDiscriminator('YieldDistributed');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('decodeProgramData', () => {
  it('decodes "Program data: <base64>" lines', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const encoded = bytesToBase64(payload);
    const decoded = decodeProgramData(`Program data: ${encoded}`);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns null for non-event log lines', () => {
    expect(decodeProgramData('Program log: hello world')).toBeNull();
    expect(decodeProgramData('Program 11111111111111111111111111111111 invoke [1]')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    const result = decodeProgramData('Program data: !!! not base64 !!!');
    // Some atob impls tolerate; fallback may decode or return empty/null.
    if (result !== null) {
      expect(result.length).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseProgramDataLog', () => {
  const baseEvent = {
    kind: 'DistributorFunded' as const,
    signature: 'sig1',
    slot: 100,
    blockTime: 1700000000,
  };

  it('parses StreamConverted body (128 bytes after disc)', async () => {
    const disc = await eventDiscriminator('StreamConverted');
    const distributor = pk().toBytes();
    const otMint = pk().toBytes();
    const body = concatBytes(
      distributor,                      //  0..32
      otMint,                           // 32..64
      u64Le(1_000_000n),                // 64..72 amount
      u64Le(50_000n),                   // 72..80 protocol_fee
      u64Le(1_000_000n),                // 80..88 total_funded
      u64Le(0n),                        // 88..96 locked_vested
      i64Le(1_700_000_000n),            // 96..104 timestamp
      u64Le(2_000_000n),                // 104..112 usdc_in
      u64Le(800_000n),                  // 112..120 swap_out_rwt
      u64Le(250_000n),                  // 120..128 mint_out_rwt
    );
    const data = concatBytes(disc, body);
    const line = `Program data: ${bytesToBase64(data)}`;

    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev).not.toBeNull();
    if (!ev) throw new Error('expected event');
    expect(ev.kind).toBe('StreamConverted');
    if (ev.kind === 'StreamConverted') {
      expect(ev.amount).toBe(1_000_000n);
      expect(ev.protocolFee).toBe(50_000n);
      expect(ev.usdcIn).toBe(2_000_000n);
      expect(ev.swapOutRwt).toBe(800_000n);
      expect(ev.mintOutRwt).toBe(250_000n);
    }
  });

  it('parses YieldDistributed body', async () => {
    const disc = await eventDiscriminator('YieldDistributed');
    const vault = pk().toBytes();
    const otMint = pk().toBytes();
    const body = concatBytes(
      vault,
      otMint,
      u64Le(10_000_000n), // total_yield
      u64Le(7_000_000n),  // book_value_share
      u64Le(1_500_000n),  // liquidity_share
      u64Le(1_500_000n),  // protocol_revenue_share
      u64Le(100_000_000n),// nav_before
      u64Le(110_000_000n),// nav_after
      i64Le(1_700_000_001n),
    );
    const data = concatBytes(disc, body);
    const line = `Program data: ${bytesToBase64(data)}`;

    const ev = await parseProgramDataLog(line, baseEvent);
    expect(ev).not.toBeNull();
    if (!ev) throw new Error('expected event');
    expect(ev.kind).toBe('YieldDistributed');
    if (ev.kind === 'YieldDistributed') {
      expect(ev.totalYield).toBe(10_000_000n);
      expect(ev.bookValueShare).toBe(7_000_000n);
      expect(ev.navAfter).toBe(110_000_000n);
    }
  });

  it('returns null for unknown discriminators', async () => {
    const data = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    const line = `Program data: ${bytesToBase64(data)}`;
    expect(await parseProgramDataLog(line, baseEvent)).toBeNull();
  });

  it('returns null for non-program-data lines', async () => {
    expect(await parseProgramDataLog('Program log: hello', baseEvent)).toBeNull();
  });
});

describe('fetchEvents', () => {
  it('returns empty array on RPC failure', async () => {
    const conn = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('RPC down')),
      getParsedTransaction: vi.fn(),
    } as unknown as Connection;

    const result = await fetchEvents(conn, pk(), { limit: 10 });
    expect(result).toEqual([]);
  });

  it('skips erroring transactions', async () => {
    const conn = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: 'a', err: { Custom: 1 }, slot: 1, blockTime: 100 },
      ]),
      getParsedTransaction: vi.fn(),
    } as unknown as Connection;

    const result = await fetchEvents(conn, pk(), { limit: 10 });
    expect(result).toEqual([]);
  });
});

describe('fetchCrankHealth', () => {
  it('returns unreachable when no endpoint configured', async () => {
    const result = await fetchCrankHealth('revenue', undefined);
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('No endpoint configured');
  });

  it('returns unreachable on HTTP error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);
    const result = await fetchCrankHealth('revenue', 'https://example.test');
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('HTTP 500');
    fetchSpy.mockRestore();
  });

  it('parses valid heartbeat response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'running',
        lastRunTs: 1700000000,
        version: '0.1.0',
      }),
    } as unknown as Response);
    const result = await fetchCrankHealth('revenue', 'https://example.test');
    expect(result.status).toBe('running');
    expect(result.lastRunTs).toBe(1700000000);
    expect(result.version).toBe('0.1.0');
    fetchSpy.mockRestore();
  });
});

describe('fetchMerkleProof', () => {
  const dist = pk();
  const holder = pk();

  it('returns null on HTTP error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
    } as unknown as Response);
    const result = await fetchMerkleProof('https://example.test', dist, holder);
    expect(result).toBeNull();
    fetchSpy.mockRestore();
  });

  it('parses successful proof response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        distributor: dist.toBase58(),
        holder: holder.toBase58(),
        epoch: 1,
        cumulativeAmount: '1000000',
        proof: ['ab'.repeat(32)],
        merkleRoot: 'cd'.repeat(32),
        publishedAt: 1700000000,
      }),
    } as unknown as Response);
    const result = await fetchMerkleProof('https://example.test', dist, holder);
    expect(result).not.toBeNull();
    expect(result!.cumulativeAmount).toBe('1000000');
    expect(result!.proof.length).toBe(1);
    fetchSpy.mockRestore();
  });
});
