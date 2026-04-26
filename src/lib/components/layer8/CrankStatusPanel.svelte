<script lang="ts">
  import { Activity, AlertCircle, CheckCircle2, Pause } from 'lucide-svelte';
  import type { CrankHealth } from '$lib/api/layer8';

  export let crank: CrankHealth;

  const ROLE_BY_NAME: Record<string, string> = {
    revenue: 'distribute_revenue',
    'convert-and-fund': 'convert_to_rwt',
    'yield-claim': 'claim_yield / compound_yield / claim_yd_for_treasury',
  };

  const TITLE_BY_NAME: Record<string, string> = {
    revenue: 'Revenue Crank',
    'convert-and-fund': 'Convert & Fund Crank',
    'yield-claim': 'Yield Claim Crank',
  };

  $: title = TITLE_BY_NAME[crank.name] ?? crank.name;
  $: role = ROLE_BY_NAME[crank.name] ?? '';
  $: lastSeen = formatLastSeen(crank.lastRunTs);

  function formatLastSeen(ts: number | null): string {
    if (!ts) return 'Never';
    const seconds = Math.floor((Date.now() - ts * 1000) / 1000);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
</script>

<article class="crank-card" class:running={crank.status === 'running'} class:stopped={crank.status === 'stopped'} class:unreachable={crank.status === 'unreachable'}>
  <header class="crank-head">
    <div class="title-block">
      <span class="status-dot" aria-hidden="true"></span>
      <h3 class="crank-title">{title}</h3>
    </div>
    <span class="status-badge">
      {#if crank.status === 'running'}
        <CheckCircle2 size={12} />
        Running
      {:else if crank.status === 'stopped'}
        <Pause size={12} />
        Stopped
      {:else}
        <AlertCircle size={12} />
        Unreachable
      {/if}
    </span>
  </header>

  <div class="crank-body">
    <div class="row">
      <span class="row-label">Role</span>
      <span class="row-value mono">{role}</span>
    </div>
    <div class="row">
      <span class="row-label">Last action</span>
      <span class="row-value">{lastSeen}</span>
    </div>
    {#if crank.version}
      <div class="row">
        <span class="row-label">Version</span>
        <span class="row-value mono">{crank.version}</span>
      </div>
    {/if}
    {#if crank.error}
      <div class="row error">
        <Activity size={12} />
        <span class="row-value mono">{crank.error}</span>
      </div>
    {/if}
  </div>
</article>

<style>
  .crank-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: border-color var(--transition-fast);
  }
  .crank-card.running {
    border-color: rgba(16, 185, 129, 0.4);
  }
  .crank-card.unreachable {
    border-color: rgba(239, 68, 68, 0.4);
    opacity: 0.85;
  }

  .crank-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }

  .title-block {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-text-muted);
    flex-shrink: 0;
  }
  .crank-card.running .status-dot {
    background: var(--color-success);
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
  }
  .crank-card.stopped .status-dot {
    background: var(--color-warning);
  }
  .crank-card.unreachable .status-dot {
    background: var(--color-danger);
  }

  .crank-title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    background: var(--color-surface-active);
    color: var(--color-text-secondary);
  }
  .crank-card.running .status-badge {
    background: rgba(16, 185, 129, 0.15);
    color: var(--color-success);
  }
  .crank-card.unreachable .status-badge {
    background: rgba(239, 68, 68, 0.15);
    color: var(--color-danger);
  }
  .crank-card.stopped .status-badge {
    background: rgba(245, 158, 11, 0.15);
    color: var(--color-warning);
  }

  .crank-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    min-width: 0;
  }
  .row.error {
    justify-content: flex-start;
    color: var(--color-danger);
    background: rgba(239, 68, 68, 0.08);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    margin-top: var(--space-1);
  }

  .row-label {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
  .row-value {
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
