<script lang="ts">
  /*
   * RecentEvents — consolidated feed across all 5 contracts (last 20).
   *
   * Drives off `recentConsolidatedEvents` (event-stream-aggregated, 2s tick,
   * D34) — each entry is `program + signature + slot + blockTime`. Body
   * decoding stays per-feature; this view is a live pulse only.
   *
   * Stale marker:
   *   - lastTickTs not seen for >10s → yellow ribbon (R-F)
   *   - lastTickTs not seen for >30s → red ribbon
   */
  import { recentConsolidatedEvents } from '$lib/stores/systemOverview';
  import { network } from '$lib/stores/network';
  import { explorerUrl, formatAddress } from '$lib/utils/format';

  $: agg = $recentConsolidatedEvents;
  $: cluster = $network;

  // Stale marker recomputes only when the events store ticks (every 2s
  // per recentConsolidatedEvents.start()). Replacing the prior 1Hz local
  // timer — agg.lastTickTs is the only freshness signal we need.
  $: tickAgeMs = agg.lastTickTs == null ? null : Date.now() - agg.lastTickTs;
  $: staleClass = tickAgeMs == null
    ? 'stale-hard'
    : tickAgeMs > 30_000
      ? 'stale-hard'
      : tickAgeMs > 10_000
        ? 'stale-soft'
        : 'fresh';

  function staleLabel(): string {
    if (agg.lastTickTs == null) return 'never updated';
    const age = Math.floor((tickAgeMs ?? 0) / 1000);
    if (age < 5) return 'just now';
    if (age < 60) return `${age}s ago`;
    return `${Math.floor(age / 60)}m ago`;
  }

  function programColor(p: string): string {
    if (p === 'ot') return 'ot';
    if (p === 'futarchy') return 'futarchy';
    if (p === 'rwt') return 'rwt';
    if (p === 'dex') return 'dex';
    return 'yd';
  }

  function programLabel(p: string): string {
    if (p === 'ot') return 'OT';
    if (p === 'futarchy') return 'Futarchy';
    if (p === 'rwt') return 'RWT';
    if (p === 'dex') return 'DEX';
    return 'YD';
  }

  function blockTimeLabel(t: number | null): string {
    if (t == null) return '—';
    const age = Math.floor(Date.now() / 1000) - t;
    if (age < 60) return `${age}s ago`;
    if (age < 3600) return `${Math.floor(age / 60)}m ago`;
    return `${Math.floor(age / 3600)}h ago`;
  }
</script>

<div class="recent-events">
  <div class="stale-marker stale-{staleClass}">
    <span class="stale-dot"></span>
    <span>Last reconcile: {staleLabel()}</span>
    {#if agg.error}
      <span class="err">— {agg.error}</span>
    {/if}
  </div>

  {#if agg.events.length === 0}
    <div class="empty">No events seen across the 5 contracts since dashboard load.</div>
  {:else}
    <div class="event-list">
      {#each agg.events as ev (ev.signature)}
        <div class="event-row">
          <span class="program-pill program-{programColor(ev.program)}">{programLabel(ev.program)}</span>
          <span class="kind mono">{ev.kind}</span>
          <a
            class="sig mono"
            href={explorerUrl(ev.signature, 'tx', cluster)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {formatAddress(ev.signature, 6)}
          </a>
          <span class="slot mono">slot {ev.slot}</span>
          <span class="time">{blockTimeLabel(ev.blockTime)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .recent-events {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .stale-marker {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }

  .stale-marker.stale-fresh {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  .stale-marker.stale-soft {
    color: var(--color-warning);
    background: var(--color-warning-muted);
  }

  .stale-marker.stale-hard {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .stale-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .err {
    font-family: var(--font-mono);
    opacity: 0.8;
  }

  .empty {
    padding: var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    text-align: center;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .event-row {
    display: grid;
    grid-template-columns: 80px minmax(120px, 1fr) minmax(140px, 1fr) 100px 80px;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-1) var(--space-2);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .program-pill {
    text-align: center;
    padding: 2px var(--space-1);
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .program-ot { background: rgba(139, 92, 246, 0.15); color: var(--color-primary); }
  .program-futarchy { background: rgba(59, 130, 246, 0.15); color: var(--color-info); }
  .program-rwt { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .program-dex { background: rgba(245, 158, 11, 0.15); color: var(--color-warning); }
  .program-yd { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }

  .kind {
    color: var(--color-text);
    font-weight: 500;
  }

  .sig {
    color: var(--color-primary);
    text-decoration: none;
  }

  .sig:hover {
    text-decoration: underline;
  }

  .slot {
    color: var(--color-text-muted);
  }

  .time {
    color: var(--color-text-secondary);
    text-align: right;
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
