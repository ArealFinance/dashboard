/**
 * Protocol summary store — Phase 12.3.3 (dashboard).
 *
 * Mirror of `systemOverview.ts` shape (classic Svelte writable, ref-counted
 * start/stop, single-flight refresh) but bound to the backend's
 * `/markets/summary` REST endpoint and the `protocol_summary_tick`
 * realtime event.
 *
 * Lifecycle:
 *
 *   1. `start()` — useRoom('protocol'), seed via REST, register tick listener.
 *   2. While the room is "live" (recent ticks observed by the SDK) the
 *      store updates from event payloads at the cron's 30s cadence.
 *   3. If the SDK flags the room as stale (no events for `staleAfterMs =
 *      90_000`), the store kicks a 60s REST poll loop until the room
 *      goes live again.
 *   4. Cluster switches re-issue the REST seed and re-register the tick
 *      listener; in-flight responses are discarded via the connection
 *      token capture pattern.
 *   5. `stop()` releases the room handle, detaches listeners, and clears
 *      the poll interval.
 *
 * The store is a singleton (single backend `protocol_summary` row, single
 * `protocol` realtime room) so the shape is plain start/stop, not the
 * map-of-pools pattern.
 */
import { writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

import {
  getProtocolSummary,
  type ProtocolSummary,
} from '@areal/sdk/markets-rest';
import { Rooms } from '@areal/sdk/realtime';
import { BACKEND_API_BASE_URLS } from '@areal/sdk/network';

import { network, toSdkCluster, type Cluster } from '$lib/stores/network';
import { realtimeClient, type RoomHandle } from '$lib/realtime/client';

/** Stale-poll cadence (ms) — architect-locked at 60s. */
const STALE_POLL_MS = 60_000;

export interface ProtocolSummaryState {
  /** Latest protocol summary row, null until first REST/event resolves. */
  summary: ProtocolSummary | null;
  /** True until the first response (REST or tick) has been applied. */
  loading: boolean;
  /** Last error from REST or tick handler, null when healthy. */
  error: string | null;
  /**
   * True when the realtime SDK has flagged the protocol room as stale
   * (no events for `staleAfterMs = 90_000`). Drives the "Reconnecting…"
   * indicator in the UI.
   */
  isStale: boolean;
  /** Wall-clock ms of last summary update from any source. */
  lastUpdatedMs: number | null;
}

function freshState(): ProtocolSummaryState {
  return {
    summary: null,
    loading: false,
    error: null,
    isStale: false,
    lastUpdatedMs: null,
  };
}

/** Optional env override of the markets REST URL. */
function readEnvBaseUrl(): string | null {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const raw = (import.meta.env as ImportMetaEnv).PUBLIC_MARKETS_API_URL;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

function resolveBaseUrl(cluster: Cluster): string | null {
  const envUrl = readEnvBaseUrl();
  if (envUrl) return envUrl;
  const url = BACKEND_API_BASE_URLS[toSdkCluster(cluster)];
  return url && url.length > 0 ? url : null;
}

function createProtocolSummaryStore() {
  const { subscribe, set, update } = writable<ProtocolSummaryState>(freshState());

  let refCount = 0;
  let roomHandle: RoomHandle | null = null;
  let detachTickListener: (() => void) | null = null;
  let detachStaleSubscription: (() => void) | null = null;
  let detachNetworkSubscription: (() => void) | null = null;
  let stalePollInterval: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every cluster switch / stop — async paths compare against. */
  let token = 0;
  /** Single-flight REST refresh guard. */
  let pendingRefresh: Promise<void> | null = null;

  function clearStalePoll(): void {
    if (stalePollInterval) {
      clearInterval(stalePollInterval);
      stalePollInterval = null;
    }
  }

  async function doRefresh(capturedToken: number): Promise<void> {
    const cluster = get(network);
    const baseUrl = resolveBaseUrl(cluster);
    if (!baseUrl) {
      update((s) => ({
        ...s,
        loading: false,
        error: `No markets API URL for cluster ${cluster}`,
      }));
      return;
    }

    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const summary = await getProtocolSummary({ baseUrl });
      // Late-response guard: cluster flipped or store was stopped mid-flight.
      if (capturedToken !== token) return;
      update((s) => ({
        ...s,
        summary,
        loading: false,
        error: null,
        lastUpdatedMs: Date.now(),
      }));
    } catch (e) {
      if (capturedToken !== token) return;
      update((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  async function refresh(): Promise<void> {
    if (pendingRefresh) return pendingRefresh;
    const capturedToken = token;
    pendingRefresh = doRefresh(capturedToken).finally(() => {
      pendingRefresh = null;
    });
    return pendingRefresh;
  }

  function attachTickListener(): void {
    detachTickListener?.();
    detachTickListener = realtimeClient.on('protocol_summary_tick', (payload) => {
      // The wire payload mirrors `ProtocolSummary` minus `updatedAt` (the
      // event has no ISO timestamp — the cron emits it from the same UPDATE
      // round-trip so wall-clock ms is the right substitute for UI freshness).
      update((s) => ({
        ...s,
        summary: {
          totalTvlUsd: payload.totalTvlUsd,
          volume24hUsd: payload.volume24hUsd,
          txCount24h: payload.txCount24h,
          activeWallets24h: payload.activeWallets24h,
          poolCount: payload.poolCount,
          cumulativeDistributorCount: payload.cumulativeDistributorCount,
          blockTime: payload.blockTime,
          // Best-effort updatedAt — the tick has no ISO field; use wall-clock.
          updatedAt: new Date().toISOString(),
        },
        loading: false,
        error: null,
        lastUpdatedMs: Date.now(),
      }));
    });
  }

  function attachStaleSubscription(): void {
    detachStaleSubscription?.();
    detachStaleSubscription = realtimeClient.staleRooms.subscribe((rooms) => {
      const isStale = rooms.has(Rooms.protocol);
      update((s) => (s.isStale === isStale ? s : { ...s, isStale }));

      if (isStale) {
        // Start REST polling fallback — first refresh fires immediately so
        // the UI reflects fresh data without waiting a full 60s window.
        if (stalePollInterval) return;
        // Fire one immediately, then on the cadence.
        void refresh();
        stalePollInterval = setInterval(() => {
          void refresh();
        }, STALE_POLL_MS);
      } else {
        clearStalePoll();
      }
    });
  }

  function attachNetworkSubscription(): void {
    detachNetworkSubscription?.();
    let firstCall = true;
    detachNetworkSubscription = network.subscribe(() => {
      if (firstCall) {
        firstCall = false;
        return;
      }
      // Cluster switch — bump token to invalidate in-flight, refetch under
      // the new cluster. The realtime client tears down its socket on the
      // same cluster signal, so the room is already re-subscribed by the
      // time we land here. Drop the single-flight pendingRefresh handle:
      // the in-flight REST belongs to the OBSOLETE cluster and its result
      // is already filtered by the token check, so we must allow a fresh
      // refresh to start under the new cluster instead of being deduped
      // against the old promise.
      token++;
      pendingRefresh = null;
      update(() => freshState());
      void refresh();
    });
  }

  return {
    subscribe,

    /**
     * Start polling/listening. Ref-counted: the first call wires
     * everything; subsequent calls just bump the count.
     */
    start(): void {
      if (!browser) return;
      refCount++;
      if (refCount > 1) return;

      token++;
      roomHandle = realtimeClient.useRoom(Rooms.protocol);
      attachTickListener();
      attachStaleSubscription();
      attachNetworkSubscription();
      void refresh();
    },

    stop(): void {
      if (!browser) return;
      if (refCount === 0) return;
      refCount--;
      if (refCount > 0) return;

      token++;
      detachTickListener?.();
      detachTickListener = null;
      detachStaleSubscription?.();
      detachStaleSubscription = null;
      detachNetworkSubscription?.();
      detachNetworkSubscription = null;
      clearStalePoll();
      roomHandle?.off();
      roomHandle = null;
      set(freshState());
    },

    /**
     * Force a REST refresh — useful for retry buttons. No-op until the
     * store has been started.
     */
    async refresh(): Promise<void> {
      if (!browser) return;
      if (refCount === 0) return;
      await refresh();
    },
  };
}

export const protocolSummary: Readable<ProtocolSummaryState> & {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
} = createProtocolSummaryStore();
