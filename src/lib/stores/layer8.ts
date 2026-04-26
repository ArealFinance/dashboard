/**
 * Layer 8 reactive stores.
 *
 * Aggregates:
 *   - Crank health (3 cranks: revenue / convert-and-fund / yield-claim).
 *   - Recent on-chain events across the 4 contracts (newest first).
 *   - LiquidityHolding singleton state.
 *
 * Polling is opt-in: callers must invoke `start()`/`stop()` from a layout's
 * `onMount`/`onDestroy` to control the lifecycle.
 *
 * Endpoints come from `import.meta.env` so no secrets land in code (CSP-safe,
 * public-repo friendly):
 *   - PUBLIC_CRANK_REVENUE_URL
 *   - PUBLIC_CRANK_CONVERT_URL
 *   - PUBLIC_CRANK_CLAIM_URL
 *   - PUBLIC_PROOF_STORE_URL  (merkle-publisher proof-store base)
 */
import { writable, derived, get } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { browser } from '$app/environment';

import { connection } from './network';
import { ydProgramId } from './yd';
import { rwtProgramId } from './rwt';
import {
  fetchCrankHealth,
  fetchEvents,
  readLiquidityHoldingState,
  type CrankHealth,
  type CrankName,
  type Layer8Event,
  type LiquidityHoldingState,
} from '$lib/api/layer8';
import { findLiquidityHoldingPda } from '$lib/utils/pda';

// -----------------------------------------------------------------------------
// Env-driven endpoint resolution
// -----------------------------------------------------------------------------

interface CrankEndpoints {
  revenue: string | undefined;
  'convert-and-fund': string | undefined;
  'yield-claim': string | undefined;
}

function readEnv(): ImportMetaEnv {
  // import.meta.env access is browser-only safe (Vite injects).
  return (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env
    : ({} as ImportMetaEnv);
}

function resolveCrankEndpoints(): CrankEndpoints {
  const env = readEnv();
  return {
    revenue: env.PUBLIC_CRANK_REVENUE_URL,
    'convert-and-fund': env.PUBLIC_CRANK_CONVERT_URL,
    'yield-claim': env.PUBLIC_CRANK_CLAIM_URL,
  };
}

export function resolveProofStoreUrl(): string | undefined {
  return readEnv().PUBLIC_PROOF_STORE_URL;
}

// -----------------------------------------------------------------------------
// Crank statuses store
// -----------------------------------------------------------------------------

const CRANK_NAMES: CrankName[] = ['revenue', 'convert-and-fund', 'yield-claim'];

interface CrankStatusesState {
  statuses: CrankHealth[];
  loading: boolean;
  error: string | null;
  lastRefreshTs: number | null;
}

function createCrankStatusesStore() {
  const initial: CrankStatusesState = {
    statuses: CRANK_NAMES.map((name) => ({
      name,
      status: 'unreachable',
      lastRunTs: null,
      version: null,
      error: null,
    })),
    loading: false,
    error: null,
    lastRefreshTs: null,
  };

  const { subscribe, update, set } = writable<CrankStatusesState>(initial);
  let interval: ReturnType<typeof setInterval> | null = null;
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const endpoints = resolveCrankEndpoints();
      const settled = await Promise.all(
        CRANK_NAMES.map((n) => fetchCrankHealth(n, endpoints[n])),
      );
      set({
        statuses: settled,
        loading: false,
        error: null,
        lastRefreshTs: Date.now(),
      });
    } catch (err) {
      update((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return {
    subscribe,

    async refresh(): Promise<void> {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => {
        pendingRefresh = null;
      });
      return pendingRefresh;
    },

    /** Begin auto-refreshing every `intervalMs` (default 15s). */
    start(intervalMs = 15_000): void {
      if (!browser) return;
      void this.refresh();
      if (interval) clearInterval(interval);
      interval = setInterval(() => {
        void this.refresh();
      }, intervalMs);
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },

    reset(): void {
      this.stop();
      set(initial);
    },
  };
}

export const crankStatuses = createCrankStatusesStore();

// -----------------------------------------------------------------------------
// Recent events store
// -----------------------------------------------------------------------------

interface RecentEventsState {
  events: Layer8Event[];
  loading: boolean;
  error: string | null;
  lastRefreshTs: number | null;
}

function createRecentEventsStore() {
  const initial: RecentEventsState = {
    events: [],
    loading: false,
    error: null,
    lastRefreshTs: null,
  };

  const { subscribe, update, set } = writable<RecentEventsState>(initial);
  let interval: ReturnType<typeof setInterval> | null = null;
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh(perAddressLimit = 30): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const conn = get(connection);
      // Fan-out across the 3 most-event-rich programs. (We skip OT/DEX here
      // because their event count is low; users land on the convert / yield
      // pages anyway.)
      const [yd, rwt] = await Promise.all([
        fetchEvents(conn, ydProgramId, { limit: perAddressLimit }).catch(
          () => [] as Layer8Event[],
        ),
        fetchEvents(conn, rwtProgramId, { limit: perAddressLimit }).catch(
          () => [] as Layer8Event[],
        ),
      ]);
      const merged = [...yd, ...rwt];
      // Newest first.
      merged.sort((a, b) => {
        const ta = a.blockTime ?? 0;
        const tb = b.blockTime ?? 0;
        if (tb !== ta) return tb - ta;
        return b.slot - a.slot;
      });
      set({
        events: merged.slice(0, 100),
        loading: false,
        error: null,
        lastRefreshTs: Date.now(),
      });
    } catch (err) {
      update((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return {
    subscribe,

    async refresh(): Promise<void> {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => {
        pendingRefresh = null;
      });
      return pendingRefresh;
    },

    /** Begin auto-refreshing every `intervalMs` (default 30s). */
    start(intervalMs = 30_000): void {
      if (!browser) return;
      void this.refresh();
      if (interval) clearInterval(interval);
      interval = setInterval(() => {
        void this.refresh();
      }, intervalMs);
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },

    reset(): void {
      this.stop();
      set(initial);
    },
  };
}

export const recentEvents = createRecentEventsStore();

// -----------------------------------------------------------------------------
// LiquidityHolding singleton state
// -----------------------------------------------------------------------------

interface LiquidityHoldingStoreState {
  state: LiquidityHoldingState | null;
  pda: PublicKey | null;
  loading: boolean;
  error: string | null;
}

function createLiquidityHoldingStore() {
  const [pda] = findLiquidityHoldingPda(ydProgramId);
  const initial: LiquidityHoldingStoreState = {
    state: null,
    pda,
    loading: false,
    error: null,
  };
  const { subscribe, update, set } = writable<LiquidityHoldingStoreState>(initial);

  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const conn = get(connection);
      const state = await readLiquidityHoldingState(conn, pda);
      set({ state, pda, loading: false, error: null });
    } catch (err) {
      update((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return {
    subscribe,
    pda,

    async refresh(): Promise<void> {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => {
        pendingRefresh = null;
      });
      return pendingRefresh;
    },

    reset(): void {
      set(initial);
    },
  };
}

export const liquidityHolding = createLiquidityHoldingStore();

// -----------------------------------------------------------------------------
// Convenience derived stores
// -----------------------------------------------------------------------------

/** Number of cranks currently reporting healthy. */
export const healthyCrankCount = derived(crankStatuses, ($s) =>
  $s.statuses.filter((c) => c.status === 'running').length,
);
