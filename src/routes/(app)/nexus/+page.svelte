<script lang="ts">
  import { RefreshCw, Activity, AlertCircle, CheckCircle2, Pause } from 'lucide-svelte';
  import {
    nexusStore,
    nexusEvents,
    nexusManagerHealth,
    nexusPendingFees,
  } from '$lib/stores/layer9';
  import NexusStatePanel from '$lib/components/layer9/NexusStatePanel.svelte';
  import { formatAddress, explorerUrl } from '$lib/utils/format';
  import { network } from '$lib/stores/network';

  $: clusterTag = $network;
  $: nexus = $nexusStore;
  $: events = $nexusEvents;
  $: bot = $nexusManagerHealth;
  $: pending = $nexusPendingFees;

  function lastRefreshLabel(ts: number | null): string {
    if (!ts) return 'never';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    return `${Math.floor(diff / 60)}m ago`;
  }

  function refreshAll(): void {
    void nexusStore.refresh();
    void nexusEvents.refresh();
    void nexusManagerHealth.refresh();
  }

  function lastRunLabel(ts: number | null): string {
    if (!ts) return 'Never';
    const seconds = Math.floor((Date.now() - ts * 1000) / 1000);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
</script>

<div class="page-header">
  <div>
    <h1>Liquidity Nexus — Overview</h1>
    <p class="page-description">
      Areal Finance LP-management subsystem. Singleton PDA owns USDC + RWT
      ATAs and `LpPosition` entries; Manager wallet executes swap/add/remove,
      Authority sweeps profits and rotates the Manager. Layer 9.
    </p>
  </div>
  <div class="actions">
    <span class="refresh-tag mono">
      state {lastRefreshLabel(nexus.lastRefreshTs)} · events {lastRefreshLabel(events.lastRefreshTs)}
    </span>
    <button class="btn btn-ghost" on:click={refreshAll} disabled={nexus.loading}>
      <RefreshCw size={14} class={nexus.loading ? 'spin' : ''} />
      Refresh
    </button>
  </div>
</div>

<div class="kpi-row">
  <div class="kpi-card">
    <span class="kpi-label">Manager state</span>
    <span class="kpi-value mono">
      {#if !nexus.state}
        not initialized
      {:else if nexus.state.killSwitchEngaged}
        kill-switch
      {:else}
        active
      {/if}
    </span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">Pending LP fees (raw)</span>
    <span class="kpi-value mono">
      A: {pending.totalA.toString()} · B: {pending.totalB.toString()}
    </span>
  </div>
  <div class="kpi-card">
    <span class="kpi-label">Recent events</span>
    <span class="kpi-value mono">{events.events.length}</span>
  </div>
</div>

<section class="section">
  <NexusStatePanel state={nexus.state} pda={nexus.pda?.toBase58() ?? null} loading={nexus.loading} />
</section>

<section class="section">
  <h2 class="section-title">Manager bot heartbeat</h2>
  <article class="bot-card" class:running={bot.health.status === 'running'} class:unreachable={bot.health.status === 'unreachable'}>
    <header class="bot-head">
      <div class="bot-title">
        <span class="status-dot"></span>
        <h3>Nexus Manager Bot</h3>
      </div>
      <span class="status-badge">
        {#if bot.health.status === 'running'}
          <CheckCircle2 size={12} />
          Running
        {:else if bot.health.status === 'stopped'}
          <Pause size={12} />
          Stopped
        {:else}
          <AlertCircle size={12} />
          Unreachable
        {/if}
      </span>
    </header>
    <div class="bot-rows">
      <div class="row">
        <span class="row-label">Last action</span>
        <span class="row-value">{lastRunLabel(bot.health.lastRunTs)}</span>
      </div>
      {#if bot.health.version}
        <div class="row">
          <span class="row-label">Version</span>
          <span class="row-value mono">{bot.health.version}</span>
        </div>
      {/if}
      {#if bot.health.error}
        <div class="row error">
          <Activity size={12} />
          <span class="row-value mono">{bot.health.error}</span>
        </div>
      {/if}
    </div>
  </article>
</section>

<section class="section">
  <h2 class="section-title">Recent Layer 9 events</h2>
  {#if events.events.length === 0}
    <div class="empty">No Layer 9 events seen yet on this cluster.</div>
  {:else}
    <div class="events">
      {#each events.events as ev (ev.signature)}
        <article class="event">
          <header class="event-head">
            <span class="ev-kind">{ev.kind}</span>
            <a class="muted mono" href={explorerUrl(ev.signature, 'tx', clusterTag)} target="_blank" rel="noreferrer noopener">
              {formatAddress(ev.signature, 4)}
            </a>
          </header>
          <pre class="event-body mono">{JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}</pre>
        </article>
      {/each}
    </div>
  {/if}
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
    flex-wrap: wrap;
  }
  .refresh-tag {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
    margin: var(--space-4) 0;
  }
  .kpi-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .kpi-value {
    font-size: var(--text-md);
    color: var(--color-text);
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .bot-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .bot-card.running { border-color: rgba(16, 185, 129, 0.4); }
  .bot-card.unreachable { border-color: rgba(239, 68, 68, 0.4); }
  .bot-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .bot-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .bot-title h3 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-text-muted);
  }
  .bot-card.running .status-dot {
    background: var(--color-success);
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
  }
  .bot-card.unreachable .status-dot { background: var(--color-danger); }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text-secondary);
  }
  .bot-card.running .status-badge { background: rgba(16, 185, 129, 0.15); color: var(--color-success); }
  .bot-card.unreachable .status-badge { background: rgba(239, 68, 68, 0.15); color: var(--color-danger); }
  .bot-rows { display: flex; flex-direction: column; gap: var(--space-1); }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-sm);
  }
  .row.error {
    justify-content: flex-start;
    gap: 6px;
    color: var(--color-danger);
    background: rgba(239, 68, 68, 0.08);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
  }
  .row-label { color: var(--color-text-secondary); }
  .row-value { color: var(--color-text); }

  .events {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .event {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }
  .event-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }
  .ev-kind {
    color: var(--color-primary);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .event-body {
    margin: var(--space-2) 0 0;
    background: var(--color-bg);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    overflow-x: auto;
  }
  .empty {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    text-align: center;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }
  .muted { color: var(--color-text-muted); }
  .mono { font-family: var(--font-mono); }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }
  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
