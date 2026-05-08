<script lang="ts">
  /**
   * Protocol Summary widget — Phase 12.3.3 root-page KPI card.
   *
   * Six-tile snapshot of `/markets/summary`, kept fresh by the
   * `protocol_summary_tick` realtime event with a 60s REST poll fallback
   * when the SDK flags the room as stale. No interactive state — this is
   * a read-only conceptually-subhero widget that sits above the numbered
   * sections of the System Overview page.
   */
  import { onMount, onDestroy } from 'svelte';
  import { TrendingUp, AlertCircle, RefreshCw } from 'lucide-svelte';
  import { protocolSummary } from '$lib/stores/protocolSummary';

  $: ({ summary, loading, error, isStale, lastUpdatedMs } = $protocolSummary);

  function formatUsd(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
  }

  function formatCount(n: number): string {
    if (!Number.isFinite(n)) return '—';
    return Math.trunc(n).toLocaleString();
  }

  function formatRelativeTime(ms: number | null): string {
    if (ms == null) return 'never';
    const ageMs = Date.now() - ms;
    if (ageMs < 5_000) return 'just now';
    if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
    return `${Math.floor(ageMs / 3_600_000)}h ago`;
  }

  let now = Date.now();
  let nowInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    protocolSummary.start();
    // Refresh the relative timestamp every 5s so "27s ago" doesn't go stale.
    nowInterval = setInterval(() => {
      now = Date.now();
    }, 5_000);
  });

  onDestroy(() => {
    if (nowInterval) clearInterval(nowInterval);
    protocolSummary.stop();
  });

  // Force `now` into the reactive deps so the timestamp re-renders.
  $: relativeTime = (() => {
    void now;
    return formatRelativeTime(lastUpdatedMs);
  })();

  function handleRetry(): void {
    void protocolSummary.refresh();
  }
</script>

<section class="widget" aria-labelledby="protocol-analytics-title">
  <header class="widget-head">
    <div class="title-row">
      <TrendingUp size={16} />
      <h2 id="protocol-analytics-title" class="title">Protocol Analytics</h2>
    </div>
    <div class="meta-row">
      {#if isStale}
        <span class="stale-tag" role="status" aria-live="polite">
          <span class="stale-dot" aria-hidden="true"></span>
          Reconnecting…
        </span>
      {/if}
      {#if summary && lastUpdatedMs}
        <span class="updated-at" title={new Date(lastUpdatedMs).toISOString()}>
          updated {relativeTime}
        </span>
      {/if}
    </div>
  </header>

  {#if error && !summary}
    <div class="error-state">
      <AlertCircle size={14} />
      <span class="error-text">{error}</span>
      <button class="retry-btn" type="button" on:click={handleRetry}>
        <RefreshCw size={12} />
        <span>Retry</span>
      </button>
    </div>
  {:else if loading && !summary}
    <div class="tiles" aria-busy="true">
      {#each Array.from({ length: 6 }) as _, idx (idx)}
        <div class="tile skeleton">
          <span class="tile-label">&nbsp;</span>
          <span class="tile-value">&nbsp;</span>
        </div>
      {/each}
    </div>
  {:else if summary}
    <div class="tiles">
      <div class="tile">
        <span class="tile-label">Total TVL</span>
        <span class="tile-value">{formatUsd(summary.totalTvlUsd)}</span>
      </div>
      <div class="tile">
        <span class="tile-label">24h Volume</span>
        <span class="tile-value">{formatUsd(summary.volume24hUsd)}</span>
      </div>
      <div class="tile">
        <span class="tile-label">24h Tx Count</span>
        <span class="tile-value">{formatCount(summary.txCount24h)}</span>
      </div>
      <div class="tile">
        <span class="tile-label">Active Wallets (24h)</span>
        <span class="tile-value">{formatCount(summary.activeWallets24h)}</span>
      </div>
      <div class="tile">
        <span class="tile-label">Pools</span>
        <span class="tile-value">{formatCount(summary.poolCount)}</span>
      </div>
      <div class="tile">
        <span class="tile-label">Distributors (cumulative)</span>
        <span class="tile-value">{formatCount(summary.cumulativeDistributorCount)}</span>
      </div>
    </div>
  {:else}
    <div class="empty-state">
      <span>No protocol data yet.</span>
    </div>
  {/if}
</section>

<style>
  .widget {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .widget-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
  }

  .title {
    font-size: var(--text-lg);
    font-weight: 600;
    margin: 0;
    color: var(--color-text);
  }

  .meta-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
  }

  .stale-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-warning, #d97706);
  }

  .stale-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-warning, #d97706);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-3);
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    background: var(--color-surface-alt, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .tile-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tile-value {
    font-size: var(--text-xl);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }

  .skeleton .tile-label,
  .skeleton .tile-value {
    background: linear-gradient(
      90deg,
      var(--color-border) 0%,
      var(--color-surface-hover, rgba(0, 0, 0, 0.04)) 50%,
      var(--color-border) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
    border-radius: var(--radius-sm);
    color: transparent;
    min-height: 1em;
  }

  .error-state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-danger, #dc2626);
    font-size: var(--text-sm);
  }

  .error-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .retry-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .retry-btn:hover {
    background: var(--color-surface-hover, var(--color-bg));
    color: var(--color-text);
  }

  .empty-state {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
