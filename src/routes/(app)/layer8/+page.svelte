<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import CrankStatusPanel from '$lib/components/layer8/CrankStatusPanel.svelte';
  import EventFeed from '$lib/components/layer8/EventFeed.svelte';
  import { crankStatuses, recentEvents, healthyCrankCount } from '$lib/stores/layer8';

  $: ($crankStatuses);
  $: ($recentEvents);

  function handleRefresh(): void {
    void crankStatuses.refresh();
    void recentEvents.refresh();
  }

  function lastRefreshLabel(ts: number | null): string {
    if (!ts) return 'never';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    return `${Math.floor(diff / 60)}m ago`;
  }
</script>

<div class="page-header">
  <div>
    <h1>Layer 8 — Yield Flows & Cranks</h1>
    <p class="page-description">
      End-to-end visibility into the convert, fund, and claim cycle. Tracks
      three permissionless cranks plus their on-chain footprints across
      RWT Engine, Native DEX, Ownership Token, and Yield Distribution.
    </p>
  </div>

  <div class="actions">
    <span class="refresh-tag mono">
      cranks {lastRefreshLabel($crankStatuses.lastRefreshTs)} · events {lastRefreshLabel($recentEvents.lastRefreshTs)}
    </span>
    <button
      class="btn btn-ghost"
      on:click={handleRefresh}
      disabled={$crankStatuses.loading || $recentEvents.loading}
    >
      <RefreshCw size={14} class={($crankStatuses.loading || $recentEvents.loading) ? 'spin' : ''} />
      Refresh
    </button>
  </div>
</div>

<div class="kpi-row">
  <div class="kpi-card">
    <span class="kpi-label">Cranks healthy</span>
    <span class="kpi-value mono">{$healthyCrankCount} / {$crankStatuses.statuses.length}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">Events tracked (recent)</span>
    <span class="kpi-value mono">{$recentEvents.events.length}</span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">Layer 8 progress</span>
    <span class="kpi-value mono">9 / 10 steps</span>
  </div>
</div>

<section class="section">
  <h2 class="section-title">Cranks</h2>
  <div class="crank-grid">
    {#each $crankStatuses.statuses as crank (crank.name)}
      <CrankStatusPanel {crank} />
    {/each}
  </div>
  {#if $crankStatuses.error}
    <div class="alert alert-error">
      <strong>Heartbeat error:</strong> {$crankStatuses.error}
    </div>
  {/if}
</section>

<section class="section">
  <h2 class="section-title">Recent events</h2>
  {#if $recentEvents.error}
    <div class="alert alert-error">
      <strong>Event load error:</strong> {$recentEvents.error}
    </div>
  {/if}
  <EventFeed events={$recentEvents.events} title="" showHeader={false} limit={30} emptyMessage="No Layer 8 events seen yet. Trigger a crank or wait for the next cycle." />
</section>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-2);
  }
  .page-header h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    margin: 0;
  }
  .page-description {
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    max-width: 64ch;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .refresh-tag {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
    margin: var(--space-4) 0 var(--space-6);
  }

  .kpi-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .kpi-value {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text);
  }
  .mono {
    font-family: var(--font-mono);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }
  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .crank-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-3);
  }

  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .alert-error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }
  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0); }
    to { transform: rotate(360deg); }
  }
</style>
