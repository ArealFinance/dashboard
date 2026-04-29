/**
 * System Overview store — Layer 10 Substep 9.
 *
 * Aggregates read-only state across the 5 contracts + 6 bots for the root
 * dashboard's `/` page. Every card subscribes to its own existing store
 * (so no duplicated on-chain reads happen here); this module owns:
 *
 *   - 5s polling tick driver (D34, T-59/T-60) — fans out to the per-contract
 *     stores. Default raised from 1s to 5s to amortise GPA scans on shared
 *     mainnet RPC; tunable via PUBLIC_DASHBOARD_CARD_INTERVAL_MS.
 *   - 2s reconcile-style ticker for the consolidated `Recent Events` feed
 *     (event-stream-aggregated across the 5 program addresses, drop-resilient
 *     via `lastReconciledSlot` per contract — R-F mitigation, R31/SD-11
 *     pattern reuse from Layer 9 reconcile).
 *   - Bot heartbeat + alert derivation (stale-marker thresholds).
 *
 * Polling is opt-in: `systemOverview.start()` from `onMount`, `stop()` from
 * `onDestroy` (mirrors Layer 9 `nexusStore.start()` shape).
 *
 * Env-driven thresholds (build-time inlined via Vite):
 *   - PUBLIC_DASHBOARD_BOT_STALE_THRESHOLD_MS (default 900_000 = 15 min)
 *   - PUBLIC_DASHBOARD_LOW_SOL_THRESHOLD_LAMPORTS (default 10_000_000 =
 *     0.01 SOL) — kept for future R-74 wiring (heartbeat → wallet balance);
 *     no alert path consumes it today.
 *   - PUBLIC_DASHBOARD_CARD_INTERVAL_MS (default 5_000 = 5s, T-59/T-60)
 */
import { writable, derived, get } from 'svelte/store';
import { PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { browser } from '$app/environment';

import { connection } from './network';
import { rwtStore, rwtProgramId } from './rwt';
import { dexStore, dexProgramId } from './dex';
import { otList, programId as otProgramId } from './ot';
import { ydStore, ydProgramId } from './yd';
import { futarchyList, futarchyProgramId } from './futarchy';
import {
  nexusStore,
  nexusPositions,
  nexusEvents,
  nexusManagerHealth,
} from './layer9';
import { crankStatuses, recentEvents } from './layer8';

// -----------------------------------------------------------------------------
// Env-driven thresholds (D34 / R-F)
// -----------------------------------------------------------------------------

function readEnv(): ImportMetaEnv {
  return (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env
    : ({} as ImportMetaEnv);
}

function readNumber(key: keyof ImportMetaEnv, fallback: number): number {
  const raw = readEnv()[key];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
}

/** Bot heartbeat is "stale" beyond this age (default 15 min). */
export function botStaleThresholdMs(): number {
  return readNumber('PUBLIC_DASHBOARD_BOT_STALE_THRESHOLD_MS', 900_000);
}

/**
 * Bot wallet SOL balance below this triggers a warning alert (R-74 follow-up;
 * exposed to the UI as a documented threshold but not yet wired into an
 * alert category — the bot heartbeat endpoints do not yet report wallet
 * balance).
 */
export function lowSolThresholdLamports(): number {
  return readNumber('PUBLIC_DASHBOARD_LOW_SOL_THRESHOLD_LAMPORTS', 10_000_000);
}

/**
 * Master per-card tick cadence (ms). Default 5_000 (T-59/T-60) — covers
 * cheap config reads + GPA scans (OT/Futarchy/YD) under one schedule
 * without hammering the RPC.
 */
export function cardIntervalMs(): number {
  return readNumber('PUBLIC_DASHBOARD_CARD_INTERVAL_MS', 5_000);
}

// -----------------------------------------------------------------------------
// Bot heartbeats — read from existing crank + nexus manager stores
// -----------------------------------------------------------------------------

export type BotName =
  | 'revenue-crank'
  | 'convert-and-fund-crank'
  | 'yield-claim-crank'
  | 'merkle-publisher'
  | 'pool-rebalancer'
  | 'nexus-manager';

export type BotStatus = 'running' | 'stopped' | 'unreachable' | 'unknown';
/** Stale tier: 'fresh' (<10s), 'stale-soft' (>10s, <30s), 'stale-hard' (>30s). */
export type BotStaleness = 'fresh' | 'stale-soft' | 'stale-hard';

export interface BotHeartbeat {
  name: BotName;
  /** Raw status from the bot's own /heartbeat endpoint, or 'unknown' if no
   *  heartbeat endpoint is wired (publisher + rebalancer fall here today). */
  status: BotStatus;
  /** Unix seconds of last reported cycle, or null if never seen. */
  lastRunTs: number | null;
  /** Wall-clock age of the last refresh (ms since now), null if never. */
  refreshAgeMs: number | null;
  staleness: BotStaleness;
  error: string | null;
}

const ALL_BOT_NAMES: BotName[] = [
  'revenue-crank',
  'convert-and-fund-crank',
  'yield-claim-crank',
  'merkle-publisher',
  'pool-rebalancer',
  'nexus-manager',
];

function classifyStaleness(refreshAgeMs: number | null): BotStaleness {
  if (refreshAgeMs == null) return 'stale-hard';
  if (refreshAgeMs < 10_000) return 'fresh';
  if (refreshAgeMs < 30_000) return 'stale-soft';
  return 'stale-hard';
}

/**
 * Derived bot heartbeats — cross-cuts crankStatuses (3 cranks) + nexus
 * manager (1) + 2 stub entries for publisher/rebalancer (no heartbeat
 * endpoint shipped yet — see R-74, deferred to Layer 11+).
 */
export const botHeartbeats = derived(
  [crankStatuses, nexusManagerHealth],
  ([$cranks, $nexus]): BotHeartbeat[] => {
    const now = Date.now();
    const cranksByName = new Map(
      $cranks.statuses.map((c) => [c.name, c]),
    );
    return ALL_BOT_NAMES.map((name): BotHeartbeat => {
      if (name === 'nexus-manager') {
        const refreshAge = $nexus.lastRefreshTs == null
          ? null
          : now - $nexus.lastRefreshTs;
        return {
          name,
          status: $nexus.health.status,
          lastRunTs: $nexus.health.lastRunTs,
          refreshAgeMs: refreshAge,
          staleness: classifyStaleness(refreshAge),
          error: $nexus.health.error,
        };
      }
      if (name === 'merkle-publisher' || name === 'pool-rebalancer') {
        // R-74 deferred — these bots don't expose /heartbeat yet. Surface as
        // 'unknown' so operators see the gap rather than a silent gap.
        return {
          name,
          status: 'unknown',
          lastRunTs: null,
          refreshAgeMs: null,
          staleness: 'stale-hard',
          error: 'No /heartbeat endpoint (R-74 pending)',
        };
      }
      // Crank names: revenue-crank → revenue, convert-and-fund-crank →
      // convert-and-fund, yield-claim-crank → yield-claim.
      const crankName = name.replace(/-crank$/, '') as
        | 'revenue'
        | 'convert-and-fund'
        | 'yield-claim';
      const c = cranksByName.get(crankName);
      if (!c) {
        return {
          name,
          status: 'unknown',
          lastRunTs: null,
          refreshAgeMs: null,
          staleness: 'stale-hard',
          error: 'No status reported',
        };
      }
      const refreshAge = $cranks.lastRefreshTs == null
        ? null
        : now - $cranks.lastRefreshTs;
      return {
        name,
        status: c.status,
        lastRunTs: c.lastRunTs,
        refreshAgeMs: refreshAge,
        staleness: classifyStaleness(refreshAge),
        error: c.error,
      };
    });
  },
);

// -----------------------------------------------------------------------------
// Recent Events — consolidated cross-contract feed
// -----------------------------------------------------------------------------

/**
 * Generic shape for any contract's event entry projected into the consolidated
 * feed. `kind` is the on-chain event name; `program` is which of the 5
 * contracts emitted it.
 */
export interface ConsolidatedEvent {
  program: 'ot' | 'futarchy' | 'rwt' | 'dex' | 'yd';
  kind: string;
  signature: string;
  slot: number;
  blockTime: number | null;
}

const RECENT_EVENTS_RING_SIZE = 20;

interface RecentEventsAggState {
  events: ConsolidatedEvent[];
  /** Per-program highest signed slot we've seen; reconcile-resilience ref. */
  lastReconciledSlot: Record<ConsolidatedEvent['program'], number>;
  /** Wall-clock ms of last successful tick — used for stale UI marker. */
  lastTickTs: number | null;
  loading: boolean;
  error: string | null;
}

function freshAggState(): RecentEventsAggState {
  return {
    events: [],
    lastReconciledSlot: { ot: 0, futarchy: 0, rwt: 0, dex: 0, yd: 0 },
    lastTickTs: null,
    loading: false,
    error: null,
  };
}

function programLabel(programId: PublicKey): ConsolidatedEvent['program'] | null {
  const p = programId.toBase58();
  if (p === otProgramId.toBase58()) return 'ot';
  if (p === futarchyProgramId.toBase58()) return 'futarchy';
  if (p === rwtProgramId.toBase58()) return 'rwt';
  if (p === dexProgramId.toBase58()) return 'dex';
  if (p === ydProgramId.toBase58()) return 'yd';
  return null;
}

/**
 * Tag a recent signature as a generic on-chain event (no body parsing). The
 * "Recent Events" feed only needs program + signature + slot + blockTime to
 * give operators a live pulse — body decoding stays in the per-feature
 * pages where the field shapes matter (e.g. `/nexus/`, `/yd/`).
 *
 * We label events with their event name when the per-program parser is
 * already wired in stores (layer8/layer9 events). Otherwise, the entry is
 * tagged with a coarse "ix-batch" marker so it's visible without parsing.
 */
function projectSignature(
  sig: ConfirmedSignatureInfo,
  program: ConsolidatedEvent['program'],
  knownKind?: string,
): ConsolidatedEvent {
  return {
    program,
    kind: knownKind ?? 'ix',
    signature: sig.signature,
    slot: sig.slot,
    blockTime: sig.blockTime ?? null,
  };
}

function createRecentEventsAgg() {
  const { subscribe, set, update } = writable<RecentEventsAggState>(
    freshAggState(),
  );
  let interval: ReturnType<typeof setInterval> | null = null;
  let pendingTick: Promise<void> | null = null;

  /** Page size per RPC call — matches bots/shared/reconcile.ts cadence. */
  const SIGNATURE_PAGE_LIMIT = 1_000;
  /** Per-program safety cap (across paged calls) for one tick. */
  const PER_PROGRAM_TICK_CAP = 200;

  async function fetchProgramHead(
    programId: PublicKey,
    label: ConsolidatedEvent['program'],
    sinceSlot: number,
  ): Promise<{ events: ConsolidatedEvent[]; maxSlot: number }> {
    const conn = get(connection);
    let maxSlot = sinceSlot;
    const out: ConsolidatedEvent[] = [];
    let before: string | undefined;

    // Walk newest→oldest pages until we cross sinceSlot or hit safety cap
    // (mirrors `bots/shared/src/reconcile.ts:177-208`). Strict `<` boundary
    // preserves siblings on `sinceSlot`.
    while (out.length < PER_PROGRAM_TICK_CAP) {
      let batch: ConfirmedSignatureInfo[];
      try {
        batch = await conn.getSignaturesForAddress(programId, {
          before,
          limit: SIGNATURE_PAGE_LIMIT,
        });
      } catch {
        return { events: out, maxSlot };
      }
      if (batch.length === 0) break;

      let crossedLowerBound = false;
      for (const s of batch) {
        if (sinceSlot > 0 && s.slot < sinceSlot) {
          crossedLowerBound = true;
          break;
        }
        if (s.err) continue;
        out.push(projectSignature(s, label));
        if (s.slot > maxSlot) maxSlot = s.slot;
        if (out.length >= PER_PROGRAM_TICK_CAP) {
          crossedLowerBound = true;
          break;
        }
      }
      if (crossedLowerBound) break;
      if (batch.length < SIGNATURE_PAGE_LIMIT) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      before = last.signature;
    }
    return { events: out, maxSlot };
  }

  async function doTick(): Promise<void> {
    const cur = get({ subscribe });
    const since = cur.lastReconciledSlot;
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const fanout = await Promise.all([
        fetchProgramHead(otProgramId, 'ot', since.ot),
        fetchProgramHead(futarchyProgramId, 'futarchy', since.futarchy),
        fetchProgramHead(rwtProgramId, 'rwt', since.rwt),
        fetchProgramHead(dexProgramId, 'dex', since.dex),
        fetchProgramHead(ydProgramId, 'yd', since.yd),
      ]);
      update((s) => {
        // Merge new entries with existing ring buffer, dedupe by signature,
        // newest-first by (blockTime, slot).
        const merged: ConsolidatedEvent[] = [...s.events];
        const seen = new Set(merged.map((e) => e.signature));
        for (const head of fanout) {
          for (const e of head.events) {
            if (seen.has(e.signature)) continue;
            seen.add(e.signature);
            merged.push(e);
          }
        }
        merged.sort((a, b) => {
          const ta = a.blockTime ?? 0;
          const tb = b.blockTime ?? 0;
          if (tb !== ta) return tb - ta;
          return b.slot - a.slot;
        });
        return {
          events: merged.slice(0, RECENT_EVENTS_RING_SIZE),
          lastReconciledSlot: {
            ot: Math.max(s.lastReconciledSlot.ot, fanout[0].maxSlot),
            futarchy: Math.max(
              s.lastReconciledSlot.futarchy,
              fanout[1].maxSlot,
            ),
            rwt: Math.max(s.lastReconciledSlot.rwt, fanout[2].maxSlot),
            dex: Math.max(s.lastReconciledSlot.dex, fanout[3].maxSlot),
            yd: Math.max(s.lastReconciledSlot.yd, fanout[4].maxSlot),
          },
          lastTickTs: Date.now(),
          loading: false,
          error: null,
        };
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
      if (pendingTick) return pendingTick;
      pendingTick = doTick().finally(() => {
        pendingTick = null;
      });
      return pendingTick;
    },

    /** D34: 2s cadence for events feed (vs 1s for state cards). */
    start(intervalMs = 2_000): void {
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
      set(freshAggState());
    },
  };
}

export const recentConsolidatedEvents = createRecentEventsAgg();

// -----------------------------------------------------------------------------
// Alerts — derived from heartbeats + state
// -----------------------------------------------------------------------------

export type AlertLevel = 'red' | 'yellow';

export interface SystemAlert {
  level: AlertLevel;
  category: 'bot-stale' | 'authority-mismatch' | 'rpc-stale';
  title: string;
  detail: string;
}

/**
 * Derive alerts client-side from heartbeats + Recent Events staleness.
 *
 * Today's signals:
 *   - Bot last-event-ts > stale threshold → red.
 *   - All-events stale > 60s (reconcile lag) → yellow rpc-stale (R-F).
 *
 * `low-sol` is not a category here today: the bot heartbeat endpoints don't
 * yet report wallet balance (R-74 deferred to Layer 11+). The threshold
 * helper `lowSolThresholdLamports()` stays exported so the UI can surface
 * the configured value; once heartbeats expose balance, a `low-sol`
 * category will be re-introduced via the union.
 */
export const systemAlerts = derived(
  [botHeartbeats, recentConsolidatedEvents],
  ([$bots, $events]): SystemAlert[] => {
    const out: SystemAlert[] = [];
    const staleMs = botStaleThresholdMs();
    const now = Math.floor(Date.now() / 1000);

    for (const bot of $bots) {
      // Ignore unknown bots (R-74: publisher/rebalancer don't ship /heartbeat
      // endpoints today — the Bots panel surfaces that directly).
      if (bot.status === 'unknown') continue;
      if (bot.lastRunTs == null) {
        out.push({
          level: 'red',
          category: 'bot-stale',
          title: `${bot.name} never seen`,
          detail: `No heartbeat received since dashboard load. Check ${bot.name} process.`,
        });
        continue;
      }
      // Defensive clamp: a bot reporting `lastRunTs` in milliseconds (vs
      // expected seconds) would otherwise give a large negative `ageMs` and
      // the threshold check below would silently never fire. Floor at 0 so
      // any unit-of-time regression is at worst a missed alert until the
      // wall clock catches up — never a stale-but-quiet bot.
      const ageMs = Math.max(0, (now - bot.lastRunTs) * 1000);
      if (ageMs > staleMs) {
        out.push({
          level: 'red',
          category: 'bot-stale',
          title: `${bot.name} stale`,
          detail: `Last cycle ${Math.floor(ageMs / 60_000)} min ago — exceeds ${Math.floor(staleMs / 60_000)} min threshold.`,
        });
      }
    }

    // R-F: yellow alert if the events ticker has been stale for >60s
    // (reconcile lag warning — operators read stale state otherwise).
    if ($events.lastTickTs != null) {
      const tickAge = Date.now() - $events.lastTickTs;
      if (tickAge > 60_000) {
        out.push({
          level: 'yellow',
          category: 'rpc-stale',
          title: 'Events feed stale',
          detail: `Last reconcile ${Math.floor(tickAge / 1000)}s ago — RPC may be lagging.`,
        });
      }
    }

    return out;
  },
);

// -----------------------------------------------------------------------------
// Master tick driver — fans out to every per-card store on a 1s cadence
// -----------------------------------------------------------------------------

interface OverviewDriverState {
  /** Wall-clock ms of last completed driver tick. */
  lastDriverTickTs: number | null;
  /** Per-card driver errors (non-fatal — surfaced in Alerts). */
  errors: Record<string, string | null>;
}

function createSystemOverview() {
  const driver = writable<OverviewDriverState>({
    lastDriverTickTs: null,
    errors: {},
  });
  let cardInterval: ReturnType<typeof setInterval> | null = null;

  async function tickCards(): Promise<void> {
    // Fire-and-forget per-store refreshes. Each store is single-flight so
    // overlapping ticks never stack work.
    const tasks: Array<Promise<unknown>> = [
      rwtStore.refresh(),
      dexStore.refresh(),
      otList.refresh(),
      ydStore.refresh(),
      futarchyList.refresh(),
      nexusStore.refresh(),
      nexusPositions.refresh(),
      nexusEvents.refresh(),
      crankStatuses.refresh(),
      nexusManagerHealth.refresh(),
      recentEvents.refresh(),
    ];
    const results = await Promise.allSettled(tasks);
    const errors: Record<string, string | null> = {};
    const labels = [
      'rwtStore', 'dexStore', 'otList', 'ydStore', 'futarchyList',
      'nexusStore', 'nexusPositions', 'nexusEvents', 'crankStatuses',
      'nexusManagerHealth', 'recentEvents',
    ];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      errors[labels[i]] = r.status === 'rejected'
        ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
        : null;
    }
    driver.set({ lastDriverTickTs: Date.now(), errors });
  }

  return {
    driver: { subscribe: driver.subscribe },

    /**
     * Begin polling. Cards refresh on the env-configured cadence (default
     * 5s via `cardIntervalMs()`, T-59/T-60); the Recent Events feed has
     * its own 2s ticker started here in parallel. Callers may override via
     * the explicit `cardMs` argument (still respected for tests / future
     * fine-tuning).
     */
    start(cardMs?: number, eventsIntervalMs = 2_000): void {
      if (!browser) return;
      const effectiveCardMs = cardMs ?? cardIntervalMs();
      void tickCards();
      if (cardInterval) clearInterval(cardInterval);
      cardInterval = setInterval(() => {
        void tickCards();
      }, effectiveCardMs);
      recentConsolidatedEvents.start(eventsIntervalMs);
    },

    stop(): void {
      if (cardInterval) {
        clearInterval(cardInterval);
        cardInterval = null;
      }
      recentConsolidatedEvents.stop();
    },

    /** Force a single tick (for refresh button). */
    async refresh(): Promise<void> {
      await Promise.all([tickCards(), recentConsolidatedEvents.refresh()]);
    },
  };
}

export const systemOverview = createSystemOverview();
