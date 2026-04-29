<script lang="ts">
  /*
   * Alerts — derived from heartbeats + event-feed staleness.
   *
   * Today's signals (per substep 9 spec):
   *   - bot heartbeat older than threshold (red, default 15min)
   *   - all-events feed reconcile lag (yellow, >60s)
   *
   * Authority-mismatch detection is intentionally NOT shipped here yet —
   * it requires an off-chain canonical-authority registry to compare against,
   * which sits outside Layer 10's read-only UI scope. Surfaced as a follow-up.
   */
  import { AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-svelte';
  import { systemAlerts, botStaleThresholdMs } from '$lib/stores/systemOverview';

  $: alerts = $systemAlerts;
  $: redCount = alerts.filter((a) => a.level === 'red').length;
  $: yellowCount = alerts.filter((a) => a.level === 'yellow').length;
</script>

<div class="alerts">
  <div class="summary">
    {#if alerts.length === 0}
      <div class="all-clear">
        <ShieldCheck size={14} />
        <span>All clear — no active alerts.</span>
      </div>
    {:else}
      <div class="counts">
        {#if redCount > 0}
          <span class="badge badge-red">
            <AlertOctagon size={12} />
            {redCount} red
          </span>
        {/if}
        {#if yellowCount > 0}
          <span class="badge badge-yellow">
            <AlertTriangle size={12} />
            {yellowCount} yellow
          </span>
        {/if}
      </div>
    {/if}
  </div>

  {#each alerts as alert (alert.title + alert.detail)}
    <div class="alert alert-{alert.level}">
      <div class="alert-head">
        {#if alert.level === 'red'}
          <AlertOctagon size={14} />
        {:else}
          <AlertTriangle size={14} />
        {/if}
        <span class="alert-title">{alert.title}</span>
        <span class="alert-cat">{alert.category}</span>
      </div>
      <div class="alert-detail">{alert.detail}</div>
    </div>
  {/each}

  <div class="thresholds">
    <span class="threshold-line">
      Bot stale threshold: <span class="mono">{Math.floor(botStaleThresholdMs() / 60_000)} min</span>
    </span>
    <!--
      Low-SOL row removed — no code path emits a `low-sol` alert today
      (R-74 deferred: bot heartbeats don't yet report wallet balance).
      `lowSolThresholdLamports()` stays exported for the future wiring.
    -->
  </div>
</div>

<style>
  .alerts {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .summary {
    display: flex;
    gap: var(--space-2);
  }

  .all-clear {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-success);
    background: var(--color-success-muted);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }

  .counts {
    display: flex;
    gap: var(--space-2);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-weight: 600;
  }

  .badge-red {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .badge-yellow {
    color: var(--color-warning);
    background: var(--color-warning-muted);
  }

  .alert {
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    border: 1px solid;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .alert-red {
    background: var(--color-danger-muted);
    border-color: rgba(239, 68, 68, 0.4);
    color: var(--color-danger);
  }

  .alert-yellow {
    background: var(--color-warning-muted);
    border-color: rgba(245, 158, 11, 0.4);
    color: var(--color-warning);
  }

  .alert-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .alert-cat {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    margin-left: auto;
    opacity: 0.7;
  }

  .alert-detail {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.4;
  }

  .thresholds {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-top: var(--space-2);
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
