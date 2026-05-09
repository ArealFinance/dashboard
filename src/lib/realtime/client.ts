/**
 * Ref-counted realtime client wrapper — Phase 12.3.3 (dashboard).
 *
 * Singleton facade over `@areal/sdk/realtime` that:
 *
 *   - Owns a single `RealtimeClient` per-cluster. Cluster switches (driven
 *     by `$network`) tear down the old socket, bump the connection token,
 *     and re-subscribe every `useRoom` consumer in insertion order so the
 *     UI does not lose state on a network flip.
 *
 *   - Exposes `useRoom(room)` for ref-counted subscribe/unsubscribe. The
 *     first arrival on a room emits a real `subscribe`; the last departure
 *     schedules a 5s grace `unsubscribe`. If a fresh consumer arrives in
 *     that grace window the unsubscribe is cancelled — mirrors React-Query's
 *     "stale window" pattern so route transitions don't churn the socket.
 *
 *   - Re-exports the SDK's stale-room set as a Svelte readable store so
 *     downstream stores can implement REST-poll fallback without coupling
 *     to socket.io internals (`staleAfterMs = 90_000` global per architect
 *     decision, locked above the protocol's 30s and pool's 60s tick
 *     cadences with safety margin).
 *
 *   - Bumps a `connectionToken` on every disconnect so async ack handlers
 *     captured before a teardown can compare and discard their result.
 *
 * Implementation detail: this module mirrors `systemOverview.ts` —
 * **classic Svelte writable stores**, not Svelte 5 runes — to stay
 * consistent with the rest of the dashboard's store layer.
 */
import { writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

import {
  connect,
  type ConnectOptions,
  type RealtimeClient,
  type RealtimeEventMap,
  type Room,
} from '@areal/sdk/realtime';
import { REALTIME_WS_URLS } from '@areal/sdk/network';

import { network, toSdkCluster, type Cluster } from '$lib/stores/network';

/**
 * Stale threshold (ms). Architect-locked at 90s — safe upper bound across
 * the 30s `protocol_summary_tick` cadence and 60s `pool_snapshot` cadence.
 */
const STALE_AFTER_MS = 90_000;

/**
 * Grace window before a refCount=0 room is unsubscribed. Lets fast route
 * transitions (which destroy then re-mount components within a tick) skip
 * a real unsubscribe round-trip.
 */
const ROOM_GRACE_MS = 5_000;

/** Optional env override of the WS URL — preempts the cluster-table lookup. */
function readEnvWsUrl(): string | null {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const raw = (import.meta.env as ImportMetaEnv).PUBLIC_REALTIME_WS_URL;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

function resolveWsUrl(cluster: Cluster): string | null {
  const envUrl = readEnvWsUrl();
  if (envUrl) return envUrl;
  const url = REALTIME_WS_URLS[toSdkCluster(cluster)];
  return url && url.length > 0 ? url : null;
}

/** Per-room handle returned by `useRoom`. */
export interface RoomHandle {
  off(): void;
}

interface ClientState {
  /** Underlying SDK client (single per cluster). */
  client: RealtimeClient | null;
  /** Cluster the current `client` was opened for. */
  cluster: Cluster | null;
  /** Bumped on every disconnect — used to invalidate captured ack tokens. */
  connectionToken: number;
  /** Insertion-ordered ref-count map, used for deterministic re-subscribe. */
  rooms: Map<Room, number>;
  /** Pending unsubscribe timers (per-room) — cancelled if a consumer returns. */
  pendingUnsub: Map<Room, ReturnType<typeof setTimeout>>;
  /** Pending teardown timer when refCount drops to zero across all rooms. */
  pendingDisconnect: ReturnType<typeof setTimeout> | null;
}

/** Public Svelte readouts. */
const connected = writable<boolean>(false);
const lastConnectError = writable<string | null>(null);
const staleRooms = writable<Set<Room>>(new Set());

/**
 * Test-only ConnectOptions overrides — production callers must NOT touch
 * this. The `__setIoFactoryForTests` setter lets unit tests inject a fake
 * `io()` factory without leaking it into the public surface.
 */
let testIoFactory: ConnectOptions['ioFactory'] | undefined;

const state: ClientState = {
  client: null,
  cluster: null,
  connectionToken: 0,
  rooms: new Map(),
  pendingUnsub: new Map(),
  pendingDisconnect: null,
};

/** Synthetic-event handlers wired per `client` instance. */
let detachStaleListener: (() => void) | null = null;
let detachLiveListener: (() => void) | null = null;
let detachConnectErrorListener: (() => void) | null = null;

/**
 * Listeners registered via the wrapper's `on()` API. We re-attach each
 * one to every fresh underlying client (cluster switch, reconnect) so
 * consumers don't need to re-register on every transport flip.
 */
/**
 * Type-erased pending listener record. The wrapper-set stores entries with
 * heterogeneous channel/listener generics — at the boundary of `on()` we
 * cast the consumer's `(payload: RealtimeEventMap[K]) => void` down to the
 * erased shape (`(payload: unknown) => void`) so the Set can hold them
 * uniformly. The cast is sound because: (a) the runtime payload type is
 * dictated by `channel`, not the listener's generic K; (b) the SDK delivers
 * a payload whose shape is exactly `RealtimeEventMap[channel]`; (c) the
 * listener is invoked only with that payload, so the consumer's generic
 * type is honoured at runtime. Replaces the prior `as unknown as` cast.
 */
type ErasedListener = (payload: unknown) => void;
interface PendingListener {
  channel: keyof RealtimeEventMap;
  listener: ErasedListener;
  /** Per-attach detach handle from the SDK client. */
  detach: (() => void) | null;
}
const wrapperListeners = new Set<PendingListener>();

function attachListenerToCurrentClient(entry: PendingListener): void {
  if (!state.client) return;
  // Already attached to this client?
  if (entry.detach) return;
  // Wrap the consumer listener so we can sync `connected` after every
  // payload arrival (replaces the per-second heartbeat poll). Cheap —
  // payload events fire at SDK cadence (30s protocol / 60s pool), not
  // hot-path frequency.
  const wrapped: ErasedListener = (payload) => {
    entry.listener(payload);
    syncConnected();
  };
  // SDK `client.on<K>` expects `(payload: RealtimeEventMap[K]) => void`.
  // Our erased wrapper accepts `unknown`, which is structurally assignable
  // to any concrete payload shape; cast at the boundary is type-only.
  entry.detach = state.client.on(
    entry.channel,
    wrapped as Parameters<typeof state.client.on<typeof entry.channel>>[1],
  );
}

function detachListenerFromCurrentClient(entry: PendingListener): void {
  entry.detach?.();
  entry.detach = null;
}

function reattachAllWrapperListeners(): void {
  for (const entry of wrapperListeners) attachListenerToCurrentClient(entry);
}

function detachAllWrapperListeners(): void {
  for (const entry of wrapperListeners) detachListenerFromCurrentClient(entry);
}

/**
 * Mirror the SDK client's `connected` flag into our writable store.
 *
 * Earlier this was driven by a 1Hz `setInterval` heartbeat — the architect
 * review (12.3.3) flagged that as anti-pattern: per-second polling in a
 * realtime client is exactly the failure-mode the realtime layer is meant
 * to remove. We now sync only on meaningful state transitions:
 *   - `attachSyntheticListeners` initial hook (covers `stale` / `live` /
 *     `connect_error` — each implies a state change)
 *   - every consumer-facing payload event (`pool_snapshot`,
 *     `protocol_summary_tick`, `transaction_indexed`)
 *   - explicit `disconnect` in `teardown()`
 *
 * The `connected` flag may lag reality by up to one event interval (~30s
 * for the `protocol` room) on the very first connect — acceptable because
 * no UI consumer relies on it for safety; widget loading-states cover the
 * cold-start window.
 */
function syncConnected(): void {
  connected.set(state.client?.connected ?? false);
}

function attachSyntheticListeners(client: RealtimeClient): void {
  detachStaleListener?.();
  detachLiveListener?.();
  detachConnectErrorListener?.();

  detachStaleListener = client.on('stale', (payload) => {
    staleRooms.update((s) => {
      if (s.has(payload.room)) return s;
      const next = new Set(s);
      next.add(payload.room);
      return next;
    });
    syncConnected();
  });

  detachLiveListener = client.on('live', (payload) => {
    staleRooms.update((s) => {
      if (!s.has(payload.room)) return s;
      const next = new Set(s);
      next.delete(payload.room);
      return next;
    });
    syncConnected();
  });

  detachConnectErrorListener = client.on('connect_error', (payload) => {
    lastConnectError.set(payload.message);
    syncConnected();
  });
}

function detachSyntheticListeners(): void {
  detachStaleListener?.();
  detachLiveListener?.();
  detachConnectErrorListener?.();
  detachStaleListener = null;
  detachLiveListener = null;
  detachConnectErrorListener = null;
}

/**
 * Open a fresh SDK client for the current cluster (if not yet open) and
 * resubscribe every consumer-room in insertion order.
 */
async function ensureConnected(cluster: Cluster): Promise<void> {
  if (!browser) return;
  if (state.client && state.cluster === cluster) return;

  // Different cluster — tear down old client first.
  if (state.client) {
    teardown();
  }

  const url = resolveWsUrl(cluster);
  if (!url) {
    lastConnectError.set(`No realtime WS URL for cluster ${cluster}`);
    return;
  }

  lastConnectError.set(null);
  staleRooms.set(new Set());

  const opts: ConnectOptions = {
    baseUrl: url,
    staleAfterMs: STALE_AFTER_MS,
  };
  if (testIoFactory) opts.ioFactory = testIoFactory;

  let client: RealtimeClient;
  try {
    client = connect(opts);
  } catch (e) {
    lastConnectError.set(e instanceof Error ? e.message : String(e));
    return;
  }

  state.client = client;
  state.cluster = cluster;
  state.connectionToken++;
  attachSyntheticListeners(client);
  reattachAllWrapperListeners();
  syncConnected();

  // Re-subscribe every active room in insertion order. Fire-and-forget —
  // ack failures surface via `lastConnectError` already.
  const tokenAtStart = state.connectionToken;
  for (const room of state.rooms.keys()) {
    void (async () => {
      try {
        await client.subscribe(room);
      } catch (e) {
        // Late-ack guard: if the cluster flipped mid-flight, the new
        // client owns the room; discard quietly.
        if (state.connectionToken !== tokenAtStart) return;
        lastConnectError.set(e instanceof Error ? e.message : String(e));
      }
    })();
  }
}

/**
 * Tear down the SDK client. Idempotent.
 */
function teardown(): void {
  if (state.pendingDisconnect) {
    clearTimeout(state.pendingDisconnect);
    state.pendingDisconnect = null;
  }
  for (const t of state.pendingUnsub.values()) clearTimeout(t);
  state.pendingUnsub.clear();

  detachSyntheticListeners();
  detachAllWrapperListeners();

  if (state.client) {
    try {
      state.client.disconnect();
    } catch {
      // ignore — disconnect() on a torn-down socket is fine
    }
  }
  state.client = null;
  state.cluster = null;
  state.connectionToken++;
  connected.set(false);
  staleRooms.set(new Set());
}

/**
 * Schedule a deferred disconnect once every room has 0 refs. Cancelled
 * automatically if a new `useRoom` arrives within the grace window.
 */
function scheduleDisconnectIfIdle(): void {
  if (state.rooms.size > 0) return;
  if (state.pendingDisconnect) return;
  state.pendingDisconnect = setTimeout(() => {
    state.pendingDisconnect = null;
    if (state.rooms.size === 0) teardown();
  }, ROOM_GRACE_MS);
}

function cancelPendingDisconnect(): void {
  if (state.pendingDisconnect) {
    clearTimeout(state.pendingDisconnect);
    state.pendingDisconnect = null;
  }
}

// -----------------------------------------------------------------------------
// Cluster subscription — drives reconnect on network flips
// -----------------------------------------------------------------------------

let unsubscribeNetwork: (() => void) | null = null;

function startNetworkSubscription(): void {
  if (!browser || unsubscribeNetwork) return;
  unsubscribeNetwork = network.subscribe((cluster) => {
    if (state.rooms.size === 0) {
      // No consumers yet — defer connection until first useRoom().
      // Drop the obsolete client if cluster diverges.
      if (state.client && state.cluster !== cluster) teardown();
      return;
    }
    void ensureConnected(cluster);
  });
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const realtimeClient = {
  /**
   * Subscribe to a room with ref-counted lifecycle. Returns a handle whose
   * `.off()` decrements the ref. The first arrival triggers a real
   * `subscribe`; the last departure schedules an unsubscribe after a 5s
   * grace window.
   */
  useRoom(room: Room): RoomHandle {
    if (!browser) {
      // SSR: caller still expects a handle so its onMount/onDestroy pairs
      // remain symmetric.
      return { off() {} };
    }

    startNetworkSubscription();
    cancelPendingDisconnect();

    const prev = state.rooms.get(room) ?? 0;
    state.rooms.set(room, prev + 1);

    // Cancel any pending unsubscribe for this room — fast remount race.
    // We capture whether a pending unsub timer was active BEFORE clearing it:
    // if `wasGraceCancelled` is true the server-side subscription is still
    // alive (we hadn't yet emitted unsubscribe), so we MUST NOT re-emit a
    // duplicate `subscribe` even though `prev === 0` — that would be an
    // idempotent server no-op, but a wasted roundtrip and a noisy ack log.
    // Mirrors the discipline in `app/src/lib/realtime/client.svelte.ts`.
    const pending = state.pendingUnsub.get(room);
    const wasGraceCancelled = pending !== undefined;
    if (pending) {
      clearTimeout(pending);
      state.pendingUnsub.delete(room);
    }

    const cluster = get(network);
    if (prev === 0 && !wasGraceCancelled) {
      // First arrival on this room: ensure socket is up. If a fresh socket
      // is opened by `ensureConnected`, it already re-subscribes every
      // room in `state.rooms` (which now includes this one) — so no extra
      // subscribe call is required. Only when the socket was *already*
      // open do we issue an explicit subscribe for the new room.
      void (async () => {
        const hadClient = state.client !== null && state.cluster === cluster;
        if (!hadClient) {
          await ensureConnected(cluster);
          // ensureConnected will (re)subscribe all rooms including this one.
          return;
        }
        const client = state.client;
        if (!client) return;
        const tokenAtStart = state.connectionToken;
        try {
          await client.subscribe(room);
        } catch (e) {
          if (state.connectionToken !== tokenAtStart) return;
          lastConnectError.set(e instanceof Error ? e.message : String(e));
        }
      })();
    } else if (!state.client || state.cluster !== cluster) {
      // Already counted but socket is gone (rare race) — restart.
      void ensureConnected(cluster);
    }

    let offCalled = false;
    return {
      off: () => {
        if (offCalled) return;
        offCalled = true;
        const cur = state.rooms.get(room) ?? 0;
        if (cur <= 1) {
          state.rooms.delete(room);
          // Schedule a real unsubscribe after grace.
          const timer = setTimeout(() => {
            state.pendingUnsub.delete(room);
            if (state.client && !state.rooms.has(room)) {
              const tokenAtStart = state.connectionToken;
              void state.client.unsubscribe(room).catch((e) => {
                if (state.connectionToken !== tokenAtStart) return;
                lastConnectError.set(e instanceof Error ? e.message : String(e));
              });
            }
            scheduleDisconnectIfIdle();
          }, ROOM_GRACE_MS);
          state.pendingUnsub.set(room, timer);
        } else {
          state.rooms.set(room, cur - 1);
        }
      },
    };
  },

  /**
   * Register a typed listener on the underlying SDK client. Returns an
   * unsubscribe function. The wrapper queues the listener into an internal
   * set so it survives cluster switches: every time a fresh SDK client is
   * opened, the wrapper re-attaches every queued listener under the new
   * transport. Consumers can therefore call `on()` immediately at store
   * `start()` time, before `useRoom` has had a chance to spin the socket.
   */
  on<K extends keyof RealtimeEventMap>(
    channel: K,
    listener: (payload: RealtimeEventMap[K]) => void,
  ): () => void {
    if (!browser) return () => {};

    const entry: PendingListener = {
      channel,
      // Erase the consumer generic — runtime invocations always pass the
      // matching `RealtimeEventMap[channel]` payload, so this is sound.
      listener: listener as ErasedListener,
      detach: null,
    };
    wrapperListeners.add(entry);
    if (state.client) attachListenerToCurrentClient(entry);

    return () => {
      detachListenerFromCurrentClient(entry);
      wrapperListeners.delete(entry);
    };
  },

  /** Set of rooms currently flagged stale by the SDK. */
  staleRooms: { subscribe: staleRooms.subscribe } as Readable<Set<Room>>,

  /** Whether the underlying socket is connected right now. */
  connected: { subscribe: connected.subscribe } as Readable<boolean>,

  /** Last connect/subscribe error message — null when healthy. */
  lastConnectError: { subscribe: lastConnectError.subscribe } as Readable<string | null>,
};

// -----------------------------------------------------------------------------
// Test-only hooks
// -----------------------------------------------------------------------------

/** @internal */
export function __setIoFactoryForTests(factory: ConnectOptions['ioFactory'] | undefined): void {
  testIoFactory = factory;
}

/** @internal */
export function __resetForTests(): void {
  teardown();
  state.rooms.clear();
  state.pendingUnsub.clear();
  state.connectionToken = 0;
  wrapperListeners.clear();
  if (unsubscribeNetwork) {
    unsubscribeNetwork();
    unsubscribeNetwork = null;
  }
  testIoFactory = undefined;
  lastConnectError.set(null);
}

/** @internal */
export function __getStateForTests(): {
  cluster: Cluster | null;
  rooms: Map<Room, number>;
  connectionToken: number;
  hasClient: boolean;
} {
  return {
    cluster: state.cluster,
    rooms: state.rooms,
    connectionToken: state.connectionToken,
    hasClient: state.client !== null,
  };
}
