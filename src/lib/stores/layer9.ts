/**
 * Layer 9 reactive stores (Liquidity Nexus).
 *
 * Aggregates:
 *   - Nexus singleton state (manager, principal floors, kill-switch flag).
 *   - Nexus LP-positions per known pool.
 *   - Recent on-chain Layer 9 events.
 *   - Nexus Manager bot heartbeat.
 *
 * Polling is opt-in: callers must invoke `start()`/`stop()` from a layout's
 * `onMount`/`onDestroy` to control the lifecycle.
 *
 * Endpoints / mints come from `import.meta.env` so no secrets land in code:
 *   - PUBLIC_NEXUS_MANAGER_BOT_URL — heartbeat endpoint of the manager bot.
 *   - PUBLIC_USDC_MINT — base58 of the USDC mint for the active deployment.
 *
 * MAINNET-REPLACE: PUBLIC_USDC_MINT defaults to the devnet test USDC mint.
 * Mainnet release MUST set this via env var.
 */
import { writable, derived, get } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { browser } from '$app/environment';

import { connection } from './network';
import { dexProgramId, dexStore } from './dex';
import {
  fetchLayer9Events,
  fetchNexusManagerHealth,
  readLiquidityNexus,
  readLpPosition,
  type Layer9Event,
  type LiquidityNexusState,
  type LpPositionState,
  type NexusManagerHealth,
} from '$lib/api/layer9';
import { findLpPositionPda } from '$lib/utils/pda';

// -----------------------------------------------------------------------------
// Env-driven configuration
// -----------------------------------------------------------------------------

function readEnv(): ImportMetaEnv {
  return (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env
    : ({} as ImportMetaEnv);
}

export function resolveNexusManagerBotUrl(): string | undefined {
  return readEnv().PUBLIC_NEXUS_MANAGER_BOT_URL;
}

/**
 * Resolve the configured USDC mint. Falls back to the devnet test mint so
 * the dashboard stays usable on devnet without env config.
 *
 * MAINNET-REPLACE: set PUBLIC_USDC_MINT for mainnet.
 */
export function resolveUsdcMint(): PublicKey {
  const raw = readEnv().PUBLIC_USDC_MINT;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      return new PublicKey(raw.trim());
    } catch {
      // fall through to devnet default
    }
  }
  return new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
}

// -----------------------------------------------------------------------------
// LiquidityNexus PDA derivation (re-exported from pda.ts for back-compat).
// -----------------------------------------------------------------------------

export { findLiquidityNexusPda } from '$lib/utils/pda';
import { findLiquidityNexusPda } from '$lib/utils/pda';

// -----------------------------------------------------------------------------
// Nexus state store
// -----------------------------------------------------------------------------

interface NexusStoreState {
  pda: PublicKey | null;
  state: LiquidityNexusState | null;
  loading: boolean;
  error: string | null;
  lastRefreshTs: number | null;
}

function createNexusStore() {
  const [pda] = findLiquidityNexusPda(dexProgramId);
  const initial: NexusStoreState = {
    pda,
    state: null,
    loading: false,
    error: null,
    lastRefreshTs: null,
  };

  const { subscribe, set, update } = writable<NexusStoreState>(initial);
  let pendingRefresh: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function doRefresh(): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const conn = get(connection);
      const state = await readLiquidityNexus(conn, pda);
      set({
        pda,
        state,
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
    pda,

    async refresh(): Promise<void> {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => {
        pendingRefresh = null;
      });
      return pendingRefresh;
    },

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

export const nexusStore = createNexusStore();

// -----------------------------------------------------------------------------
// Nexus LP positions store
// -----------------------------------------------------------------------------

export interface NexusLpPositionEntry {
  /** Pool PDA (base58). */
  poolPda: string;
  /** LpPosition PDA (base58). */
  lpPda: string;
  /** Pool token A mint (base58). */
  tokenAMint: string;
  /** Pool token B mint (base58). */
  tokenBMint: string;
  /** Position state, or null if not yet initialized. */
  position: LpPositionState | null;
  /** Pool's cumulative_fees_per_share_a (Q64.64). */
  cumulativeA: bigint;
  /** Pool's cumulative_fees_per_share_b (Q64.64). */
  cumulativeB: bigint;
}

interface NexusPositionsState {
  positions: NexusLpPositionEntry[];
  loading: boolean;
  error: string | null;
  lastRefreshTs: number | null;
}

function createNexusPositionsStore() {
  const initial: NexusPositionsState = {
    positions: [],
    loading: false,
    error: null,
    lastRefreshTs: null,
  };

  const { subscribe, set, update } = writable<NexusPositionsState>(initial);
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    const nexusState = get(nexusStore);
    if (!nexusState.pda) return;
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const conn = get(connection);
      const dex = get(dexStore);
      const out: NexusLpPositionEntry[] = [];
      for (const pool of dex.pools) {
        const poolPk = new PublicKey(pool.pda);
        const [lpPda] = findLpPositionPda(poolPk, nexusState.pda, dexProgramId);
        const lp = await readLpPosition(conn, lpPda);
        // The DEX store doesn't currently surface
        // `cumulative_fees_per_share_*`. Until it does, we use 0 — the
        // dashboard reads the actual value via direct on-chain read in the
        // positions table when needed (M-2 follow-up). Keeping the slot here
        // so the field is present in the typed entry shape.
        out.push({
          poolPda: pool.pda,
          lpPda: lpPda.toBase58(),
          tokenAMint: pool.tokenAMint,
          tokenBMint: pool.tokenBMint,
          position: lp,
          cumulativeA: 0n,
          cumulativeB: 0n,
        });
      }
      set({
        positions: out,
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

    reset(): void {
      set(initial);
    },
  };
}

export const nexusPositions = createNexusPositionsStore();

// -----------------------------------------------------------------------------
// Recent Layer 9 events store
// -----------------------------------------------------------------------------

interface NexusEventsState {
  events: Layer9Event[];
  loading: boolean;
  error: string | null;
  lastRefreshTs: number | null;
}

function createNexusEventsStore() {
  const initial: NexusEventsState = {
    events: [],
    loading: false,
    error: null,
    lastRefreshTs: null,
  };

  const { subscribe, set, update } = writable<NexusEventsState>(initial);
  let pendingRefresh: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function doRefresh(limit = 30): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const conn = get(connection);
      const events = await fetchLayer9Events(conn, dexProgramId, { limit }).catch(
        () => [] as Layer9Event[],
      );
      events.sort((a, b) => {
        const ta = a.blockTime ?? 0;
        const tb = b.blockTime ?? 0;
        if (tb !== ta) return tb - ta;
        return b.slot - a.slot;
      });
      set({
        events: events.slice(0, 100),
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

export const nexusEvents = createNexusEventsStore();

// -----------------------------------------------------------------------------
// Nexus Manager bot heartbeat
// -----------------------------------------------------------------------------

interface NexusManagerHealthState {
  health: NexusManagerHealth;
  loading: boolean;
  lastRefreshTs: number | null;
}

function createNexusManagerHealthStore() {
  const initial: NexusManagerHealthState = {
    health: {
      status: 'unreachable',
      lastRunTs: null,
      version: null,
      error: null,
    },
    loading: false,
    lastRefreshTs: null,
  };

  const { subscribe, set, update } = writable<NexusManagerHealthState>(initial);
  let interval: ReturnType<typeof setInterval> | null = null;
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    update((s) => ({ ...s, loading: true }));
    const url = resolveNexusManagerBotUrl();
    const health = await fetchNexusManagerHealth(url);
    set({ health, loading: false, lastRefreshTs: Date.now() });
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

export const nexusManagerHealth = createNexusManagerHealthStore();

// -----------------------------------------------------------------------------
// Derived helpers
// -----------------------------------------------------------------------------

/** Pending unrealised LP fees across all Nexus positions (USDC-side + RWT-side). */
export const nexusPendingFees = derived(
  nexusPositions,
  ($n) => {
    let totalA = 0n;
    let totalB = 0n;
    for (const entry of $n.positions) {
      if (!entry.position) continue;
      const deltaA = entry.cumulativeA - entry.position.feesClaimedPerShareA;
      const deltaB = entry.cumulativeB - entry.position.feesClaimedPerShareB;
      if (deltaA > 0n) totalA += (deltaA * entry.position.shares) >> 64n;
      if (deltaB > 0n) totalB += (deltaB * entry.position.shares) >> 64n;
    }
    return { totalA, totalB };
  },
);
