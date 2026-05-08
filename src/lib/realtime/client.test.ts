/**
 * Phase 12.3.3 — realtime client (writable-store ref-counted wrapper) tests.
 *
 * The wrapper sits between the dashboard's stores and `@areal/sdk/realtime`.
 * It owns ref-counting per room, a 5s grace window before unsubscribe, a
 * 5s grace before disconnect when refCount drops to zero, deterministic
 * resubscribe on cluster switch, and an exposed `staleRooms` Svelte store.
 *
 * These tests exercise the invariants the architect locked for the
 * dashboard wiring. They use an injected fake `io()` factory so no real
 * socket is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import {
  realtimeClient,
  __setIoFactoryForTests,
  __resetForTests,
  __getStateForTests,
} from './client';
import { network } from '$lib/stores/network';
import { Rooms } from '@areal/sdk/realtime';

// ---------------------------------------------------------------------------
// Fake socket.io-client `io()` factory
// ---------------------------------------------------------------------------

interface FakeSocket {
  connected: boolean;
  url: string;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emits: Array<{ channel: string; args: unknown[] }>;
  /** Sequence of pending subscribe acks queued via `emit('subscribe', …, cb)`. */
  subscribeAcks: Array<{ room: string; cb: (ack: unknown) => void }>;
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  off: (channel: string, listener?: (...args: unknown[]) => void) => unknown;
  emit: (channel: string, ...args: unknown[]) => unknown;
  disconnect: () => unknown;
  /** Test helper — invoke a server emit. */
  serverEmit: (channel: string, payload: unknown) => void;
  /** Test helper — synchronously ack the most-recent pending subscribe ok. */
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
      // socket.io-client's `subscribe` emit shape: (channel, payload, cb).
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
  // Simulate connect on next microtask so `client.connected` flip happens
  // after `connect()` returns, mirroring real socket.io-client behaviour.
  queueMicrotask(() => {
    fs.connected = true;
    fs.serverEmit('connect', undefined);
  });
  return fs;
};

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  allFakeSockets = [];
  __resetForTests();
  __setIoFactoryForTests(ioFactory as Parameters<typeof __setIoFactoryForTests>[0]);
  // Pin cluster to a deterministic value.
  network.setCluster('localnet');
});

afterEach(() => {
  __resetForTests();
  vi.useRealTimers();
});

/** Resolve the queued `connect` microtask and any subscribe acks. */
async function flushAsync(): Promise<void> {
  // Drain microtasks (the SDK opens the socket synchronously and our
  // wrapper's `await ensureConnected()` resolves immediately, but the
  // post-`connect` socket-emit + subscribe → ack sequence needs queued
  // microtasks to drain).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // Auto-ack any pending subscribes so subscribe-promises resolve.
  for (const fs of allFakeSockets) {
    while (fs.subscribeAcks.length > 0) fs.ackOk();
  }
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('realtimeClient.useRoom — ref-count basic', () => {
  it('first arrival opens socket; last departure schedules unsubscribe', async () => {
    expect(__getStateForTests().hasClient).toBe(false);

    const a = realtimeClient.useRoom(Rooms.protocol);
    await flushAsync();

    expect(__getStateForTests().hasClient).toBe(true);
    expect(__getStateForTests().rooms.get('protocol')).toBe(1);

    const b = realtimeClient.useRoom(Rooms.protocol);
    expect(__getStateForTests().rooms.get('protocol')).toBe(2);

    a.off();
    expect(__getStateForTests().rooms.get('protocol')).toBe(1);

    b.off();
    // Room ref hits zero — unsubscribe is scheduled, not immediate.
    expect(__getStateForTests().rooms.has('protocol')).toBe(false);
    // Socket still alive during the grace window.
    expect(__getStateForTests().hasClient).toBe(true);

    // Advance past the 5s room grace AND the 5s disconnect grace.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(__getStateForTests().hasClient).toBe(false);
  });
});

describe('realtimeClient.useRoom — grace cancellation', () => {
  it('cancels pending unsubscribe if a new useRoom arrives in the grace window', async () => {
    const a = realtimeClient.useRoom(Rooms.protocol);
    await flushAsync();
    a.off();

    // Within the 5s grace, a fresh consumer arrives — must cancel teardown.
    await vi.advanceTimersByTimeAsync(2_000);
    const b = realtimeClient.useRoom(Rooms.protocol);
    expect(__getStateForTests().rooms.get('protocol')).toBe(1);

    // Advance past the original grace deadline — socket must still be up.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(__getStateForTests().hasClient).toBe(true);

    b.off();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(__getStateForTests().hasClient).toBe(false);
  });
});

describe('realtimeClient — cluster switch re-subscribes in insertion order', () => {
  it('disconnects old socket, opens new one, re-emits subscribe per room in insertion order', async () => {
    const protoHandle = realtimeClient.useRoom(Rooms.protocol);
    await flushAsync();
    const poolRoom = Rooms.pool('11111111111111111111111111111111');
    const poolHandle = realtimeClient.useRoom(poolRoom);
    await flushAsync();

    expect(allFakeSockets.length).toBe(1);
    const socket1 = allFakeSockets[0];
    const subscribeRooms1 = socket1.emits
      .filter((e) => e.channel === 'subscribe')
      .map((e) => (e.args[0] as { room: string }).room);
    expect(subscribeRooms1).toEqual(['protocol', poolRoom]);

    const tokenBefore = __getStateForTests().connectionToken;

    network.setCluster('devnet');
    await flushAsync();

    // New socket opened
    expect(allFakeSockets.length).toBe(2);
    const socket2 = allFakeSockets[1];
    // Connection token was bumped (teardown + reconnect).
    expect(__getStateForTests().connectionToken).toBeGreaterThan(tokenBefore);

    // Both rooms re-subscribed on the new socket in insertion order.
    const subscribeRooms2 = socket2.emits
      .filter((e) => e.channel === 'subscribe')
      .map((e) => (e.args[0] as { room: string }).room);
    expect(subscribeRooms2).toEqual(['protocol', poolRoom]);

    protoHandle.off();
    poolHandle.off();
  });
});

describe('realtimeClient — late ack guard', () => {
  it('does not surface error if ack settles after cluster switch invalidated the token', async () => {
    realtimeClient.useRoom(Rooms.protocol);
    await Promise.resolve();
    await Promise.resolve();

    const fs1 = allFakeSockets[0];
    // Pull the pending subscribe but don't ack yet.
    const pending = fs1.subscribeAcks.shift();
    expect(pending).toBeDefined();

    // Cluster switch — bumps token.
    network.setCluster('devnet');
    await flushAsync();

    // Now resolve the old ack with a *failure* — wrapper must not surface
    // it (token doesn't match).
    pending!.cb({ ok: false, error: 'unknown_room' });
    await Promise.resolve();
    await Promise.resolve();

    // No connect error surfaced — ack was for an obsolete cluster.
    expect(get(realtimeClient.lastConnectError)).toBeNull();
  });
});

describe('realtimeClient — stale lifecycle exposure', () => {
  it('SDK stale event populates staleRooms; live event clears it', async () => {
    realtimeClient.useRoom(Rooms.protocol);
    await flushAsync();

    const fs = allFakeSockets[0];
    expect(get(realtimeClient.staleRooms).has('protocol')).toBe(false);

    fs.serverEmit('disconnect', undefined);
    await Promise.resolve();
    // Disconnect emits stale for every subscribed room.
    expect(get(realtimeClient.staleRooms).has('protocol')).toBe(true);

    // Simulate a live event by sending a `protocol_summary_tick` payload —
    // SDK's `noteEvent` clears staleRooms and emits 'live'.
    fs.serverEmit('protocol_summary_tick', {
      totalTvlUsd: 1,
      volume24hUsd: 1,
      txCount24h: 1,
      activeWallets24h: 1,
      poolCount: 1,
      cumulativeDistributorCount: 1,
      blockTime: 1,
    });
    await Promise.resolve();

    expect(get(realtimeClient.staleRooms).has('protocol')).toBe(false);
  });
});

describe('realtimeClient — disconnect after refCount=0 + grace', () => {
  it('does NOT disconnect before grace; DOES disconnect after', async () => {
    const handle = realtimeClient.useRoom(Rooms.protocol);
    await flushAsync();
    expect(__getStateForTests().hasClient).toBe(true);

    handle.off();

    // 4s in — still alive (room grace not yet elapsed).
    await vi.advanceTimersByTimeAsync(4_000);
    expect(__getStateForTests().hasClient).toBe(true);

    // Cross the 5s room grace → unsubscribe fires + schedules disconnect.
    await vi.advanceTimersByTimeAsync(2_000);
    // Room grace elapsed but disconnect grace just started — still alive.
    expect(__getStateForTests().hasClient).toBe(true);

    // After the disconnect grace too — torn down.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(__getStateForTests().hasClient).toBe(false);
  });
});
