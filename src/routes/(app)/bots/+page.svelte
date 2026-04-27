<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Activity, AlertCircle, CheckCircle2, Pause, RefreshCw } from 'lucide-svelte';
  import { crankStatuses, healthyCrankCount } from '$lib/stores/layer8';
  import { nexusManagerHealth } from '$lib/stores/layer9';
  import CrankStatusPanel from '$lib/components/layer8/CrankStatusPanel.svelte';

  $: cranks = $crankStatuses;
  $: nexusBot = $nexusManagerHealth;
  $: healthy = $healthyCrankCount;

  function refreshAll(): void {
    void crankStatuses.refresh();
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

  onMount(() => {
    crankStatuses.start(15_000);
    nexusManagerHealth.start(15_000);
  });

  onDestroy(() => {
    crankStatuses.stop();
    nexusManagerHealth.stop();
  });
</script>

<div class="page-header">
  <div>
    <h1>Bots</h1>
    <p class="page-description">
      Heartbeat panel for the Layer 8 cranks (revenue / convert-and-fund /
      yield-claim) and the Layer 9 Nexus Manager bot. Endpoints are
      configured via <code>PUBLIC_*</code> env vars.
    </p>
  </div>
  <div class="actions">
    <span class="kpi mono">{healthy} / {cranks.statuses.length} cranks healthy</span>
    <button class="btn btn-ghost" on:click={refreshAll} disabled={cranks.loading || nexusBot.loading}>
      <RefreshCw size={14} class={(cranks.loading || nexusBot.loading) ? 'spin' : ''} />
      Refresh
    </button>
  </div>
</div>

<section class="section">
  <h2 class="section-title">Layer 8 — permissionless cranks</h2>
  <div class="grid">
    {#each cranks.statuses as crank (crank.name)}
      <CrankStatusPanel {crank} />
    {/each}
  </div>
  {#if cranks.error}
    <div class="alert error">{cranks.error}</div>
  {/if}
</section>

<section class="section">
  <h2 class="section-title">Layer 9 — Nexus Manager</h2>
  <article class="bot-card" class:running={nexusBot.health.status === 'running'} class:unreachable={nexusBot.health.status === 'unreachable'}>
    <header class="bot-head">
      <div class="bot-title">
        <span class="status-dot"></span>
        <h3>Nexus Manager Bot</h3>
      </div>
      <span class="status-badge">
        {#if nexusBot.health.status === 'running'}
          <CheckCircle2 size={12} />
          Running
        {:else if nexusBot.health.status === 'stopped'}
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
        <span class="row-label">Role</span>
        <span class="row-value mono">nexus_swap / nexus_add_liquidity / nexus_remove_liquidity</span>
      </div>
      <div class="row">
        <span class="row-label">Last action</span>
        <span class="row-value">{lastRunLabel(nexusBot.health.lastRunTs)}</span>
      </div>
      {#if nexusBot.health.version}
        <div class="row">
          <span class="row-label">Version</span>
          <span class="row-value mono">{nexusBot.health.version}</span>
        </div>
      {/if}
      {#if nexusBot.health.error}
        <div class="row error">
          <Activity size={12} />
          <span class="row-value mono">{nexusBot.health.error}</span>
        </div>
      {/if}
    </div>
  </article>
</section>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
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
  .kpi {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
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
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .alert.error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--color-danger);
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
  .bot-card.running .status-dot { background: var(--color-success); }
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
  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  code {
    background: var(--color-bg);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
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
