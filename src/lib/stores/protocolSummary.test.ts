/**
 * Phase 12.3.3 — protocolSummary store tests.
 *
 * The store mirrors `systemOverview.ts` (classic Svelte writable, ref-counted
 * start/stop, single-flight refresh) but binds to backend `/markets/summary`
 * REST + the `protocol_summary_tick` realtime event with a 60s REST poll
 * fallback when the SDK flags the room as stale.
 *
 * These tests inject a fake socket factory so the underlying
 * `realtimeClient` opens against a controllable transport, and stub
 * `globalThis.fetch` for the REST seed/refresh path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import { protocolSummary } from './protocolSummary';
import {
  __setIoFactoryForTests,
  __resetForTests,
  realtimeClient,
} from '$lib/realtime/client';
import { network } from '$lib/stores/network';

// ---------------------------------------------------------------------------
// Fake socket plumbing (shared with realtime/client.test.ts shape)
// ---------------------------------------------------------------------------

interface FakeSocket {
  connected: boolean;
  url: string;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emits: Array<{ channel: string; args: unknown[] }>;
  subscribeAcks: Array<{ room: string; cb: (ack: unknown) => void }>;
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  off: (channel: string, listener?: (...args: unknown[]) => void) => unknown;
  emit: (channel: string, ...args: unknown[]) => unknown;
  disconnect: () => unknown;
  serverEmit: (channel: string, payload: unknown) => void;
  ackOk: () => void;
}

let allFakeSockets: FakeSocket[] = [];

function makeFakeSocket(url: string): FakeSocket {
  const fs: FakeSocket = {
    connected: false,
    url,
    listeners: new Map(),
    emits: [],
    subscribeAcks: [],
    on(channel, listener) {
      const arr = fs.listeners.get(channel) ?? [];
      arr.push(listener);
      fs.listeners.set(channel, arr);
      return fs;
    },
    off(channel, listener) {
      const arr = fs.listeners.get(channel);
      if (!arr) return fs;
      if (listener) {
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
      } else {
        fs.listeners.set(channel, []);
      }
      return fs;
    },
    emit(channel, ...args) {
      fs.emits.push({ channel, args });
      if (channel === 'subscribe') {
        const payload = args[0] as { room: string };
        const cb = args[1] as (ack: unknown) => void;
        if (typeof cb === 'function' && payload && typeof payload.room === 'string') {
          fs.subscribeAcks.push({ room: payload.room, cb });
        }
      }
      return fs;
    },
    disconnect() {
      fs.connected = false;
      fs.serverEmit('disconnect', undefined);
      return fs;
    },
    serverEmit(channel, payload) {
      const listeners = fs.listeners.get(channel) ?? [];
      for (const l of listeners) l(payload);
    },
    ackOk() {
      const ack = fs.subscribeAcks.shift();
      if (!ack) throw new Error('No pending subscribe to ack');
      ack.cb({ ok: true });
    },
  };
  return fs;
}

const ioFactory = (url: string) => {
  const fs = makeFakeSocket(url);
  allFakeSockets.push(fs);
  queueMicrotask(() => {
    fs.connected = true;
    fs.serverEmit('connect', undefined);
  });
  return fs;
};

// ---------------------------------------------------------------------------
// REST mock helpers
// ---------------------------------------------------------------------------

function makeSummaryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totalTvlUsd: 1_000_000,
    volume24hUsd: 250_000,
    txCount24h: 1_234,
    activeWallets24h: 42,
    poolCount: 7,
    cumulativeDistributorCount: 9,
    blockTime: 1_700_000_000,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFetchResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  allFakeSockets = [];
  __resetForTests();
  __setIoFactoryForTests(ioFactory as Parameters<typeof __setIoFactoryForTests>[0]);
  network.setCluster('localnet');
  // Default fetch — return a baseline summary.
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(makeFetchResponse(makeSummaryPayload()));
});

afterEach(() => {
  // Best-effort: drop any lingering refcount so subsequent tests start
  // from a clean store. Calling stop() while refCount=0 is a no-op.
  for (let i = 0; i < 10; i++) protocolSummary.stop();
  __resetForTests();
  vi.useRealTimers();
  fetchSpy.mockRestore();
});

function startTracked(): void {
  protocolSummary.start();
}
function stopTracked(): void {
  protocolSummary.stop();
}

async function flushAsync(): Promise<void> {
  // Drain microtasks repeatedly so any chained awaits inside the SDK
  // (fetch → res.json → state update) get to run under fake timers.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  for (const fs of allFakeSockets) {
    while (fs.subscribeAcks.length > 0) fs.ackOk();
  }
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('protocolSummary.start', () => {
  it('issues REST seed + subscribes to protocol room', async () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    startTracked();
    await flushAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('/markets/summary');

    const subEmits = allFakeSockets[0]!.emits
      .filter((e) => e.channel === 'subscribe')
      .map((e) => (e.args[0] as { room: string }).room);
    expect(subEmits).toEqual(['protocol']);

    const state = get(protocolSummary);
    expect(state.summary?.totalTvlUsd).toBe(1_000_000);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    stopTracked();
  });
});

describe('protocolSummary — tick patch', () => {
  it('updates state.summary from protocol_summary_tick payload', async () => {
    startTracked();
    await flushAsync();

    const fs = allFakeSockets[0]!;
    fs.serverEmit('protocol_summary_tick', {
      totalTvlUsd: 999_999,
      volume24hUsd: 12_345,
      txCount24h: 1,
      activeWallets24h: 1,
      poolCount: 1,
      cumulativeDistributorCount: 1,
      blockTime: 2_000_000_000,
    });
    await flushAsync();

    const state = get(protocolSummary);
    expect(state.summary?.totalTvlUsd).toBe(999_999);
    expect(state.summary?.volume24hUsd).toBe(12_345);
    expect(state.lastUpdatedMs).not.toBeNull();
    stopTracked();
  });
});

describe('protocolSummary — stale starts REST poll', () => {
  it('starts 60s poll on stale; first tick fires REST', async () => {
    startTracked();
    await flushAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Trigger stale via socket disconnect — SDK marks every subscribed
    // room stale on disconnect.
    const fs = allFakeSockets[0]!;
    fs.serverEmit('disconnect', undefined);
    await flushAsync();

    expect(get(protocolSummary).isStale).toBe(true);
    // Stale handler fires an immediate REST refresh.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 60s later — another REST tick.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    stopTracked();
  });
});

describe('protocolSummary — live clears poll', () => {
  it('clears interval when the room transitions back to live', async () => {
    startTracked();
    await flushAsync();

    const fs = allFakeSockets[0]!;
    fs.serverEmit('disconnect', undefined);
    await flushAsync();
    const callsAfterStale = fetchSpy.mock.calls.length;

    // Reconnect: emit `connect` and then a live `protocol_summary_tick`.
    fs.connected = true;
    fs.serverEmit('connect', undefined);
    fs.serverEmit('protocol_summary_tick', {
      totalTvlUsd: 1,
      volume24hUsd: 1,
      txCount24h: 1,
      activeWallets24h: 1,
      poolCount: 1,
      cumulativeDistributorCount: 1,
      blockTime: 1,
    });
    await flushAsync();

    expect(get(protocolSummary).isStale).toBe(false);

    // 60s of timer advance must NOT trigger any further REST calls.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsync();
    expect(fetchSpy.mock.calls.length).toBe(callsAfterStale);

    stopTracked();
  });
});

describe('protocolSummary.stop', () => {
  it('releases room handle, detaches listener, clears interval', async () => {
    startTracked();
    await flushAsync();
    expect(allFakeSockets.length).toBe(1);

    // Cause a stale-poll to start so we can verify it gets cleared.
    const fs = allFakeSockets[0]!;
    fs.serverEmit('disconnect', undefined);
    await flushAsync();
    const callsBeforeStop = fetchSpy.mock.calls.length;

    stopTracked();
    // Tick listener detached and stale-poll cleared — no further fetches.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushAsync();
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeStop);

    // Room is no longer in the active set after the grace window.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(get(realtimeClient.staleRooms).has('protocol')).toBe(false);
  });
});

describe('protocolSummary — cluster switch', () => {
  it('refetches under the new cluster (token bumps)', async () => {
    startTracked();
    await flushAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    network.setCluster('devnet');
    await flushAsync();

    // Cluster switch triggered a fresh REST seed.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    stopTracked();
  });
});

describe('protocolSummary — late-response guard', () => {
  it('discards REST response captured before a cluster switch', async () => {
    // Make the first fetch slow so we can fire a cluster switch mid-flight.
    let resolveFirst: ((res: Response) => void) | null = null;
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    fetchSpy.mockReturnValueOnce(firstPromise);

    startTracked();
    await flushAsync();
    // The realtime room is up; first REST is still pending.
    expect(get(protocolSummary).summary).toBeNull();
    expect(get(protocolSummary).loading).toBe(true);

    // Flip cluster mid-flight. Wrapper bumps token; new REST kicks off.
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse(makeSummaryPayload({ totalTvlUsd: 222 })),
    );
    network.setCluster('devnet');
    await flushAsync();

    // The new (post-switch) summary lands.
    expect(get(protocolSummary).summary?.totalTvlUsd).toBe(222);

    // Now resolve the obsolete first REST — it must be discarded.
    resolveFirst!(makeFetchResponse(makeSummaryPayload({ totalTvlUsd: 111 })));
    await flushAsync();

    // State remains the post-switch value, not the late 111.
    expect(get(protocolSummary).summary?.totalTvlUsd).toBe(222);

    stopTracked();
  });
});
