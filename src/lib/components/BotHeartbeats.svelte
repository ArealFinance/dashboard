<script lang="ts">
  /*
   * BotHeartbeats — last-event-ts grid for the 6 off-chain bots.
   *
   * Stale tier (D34 / R-F):
   *   - <10s        → green (fresh)
   *   - 10s..30s    → yellow (stale-soft)
   *   - >30s OR null → red (stale-hard)
   */
  import { CheckCircle2, AlertTriangle, AlertOctagon, HelpCircle } from 'lucide-svelte';
  import { botHeartbeats } from '$lib/stores/systemOverview';

  $: bots = $botHeartbeats;

  function statusLabel(s: string): string {
    if (s === 'running') return 'Running';
    if (s === 'stopped') return 'Stopped';
    if (s === 'unreachable') return 'Unreachable';
    return 'Unknown';
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

<div class="bot-heartbeats">
  {#each bots as bot (bot.name)}
    <div class="bot-row staleness-{bot.staleness}">
      <span class="bot-name mono">{bot.name}</span>
      <span class="bot-status status-{bot.status}">
        {#if bot.status === 'running'}
          <CheckCircle2 size={12} />
        {:else if bot.status === 'unknown'}
          <HelpCircle size={12} />
        {:else if bot.status === 'unreachable'}
          <AlertOctagon size={12} />
        {:else}
          <AlertTriangle size={12} />
        {/if}
        {statusLabel(bot.status)}
      </span>
      <span class="bot-last">{lastRunLabel(bot.lastRunTs)}</span>
      {#if bot.error}
        <span class="bot-error mono" title={bot.error}>{bot.error}</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .bot-heartbeats {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .bot-row {
    display: grid;
    grid-template-columns: 220px 140px 100px 1fr;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }

  .bot-row.staleness-fresh {
    border-left: 3px solid var(--color-success);
  }

  .bot-row.staleness-stale-soft {
    border-left: 3px solid var(--color-warning);
  }

  .bot-row.staleness-stale-hard {
    border-left: 3px solid var(--color-danger);
  }

  .bot-name {
    font-weight: 500;
  }

  .bot-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
  }

  .status-running {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  .status-stopped {
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .status-unreachable {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .status-unknown {
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .bot-last {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }

  .bot-error {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
