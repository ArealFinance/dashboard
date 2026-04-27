<script lang="ts">
  import { Activity, AlertTriangle, CheckCircle2, ShieldOff } from 'lucide-svelte';
  import type { LiquidityNexusState } from '$lib/api/layer9';
  import { formatAddress, formatAmount, explorerUrl } from '$lib/utils/format';
  import { network } from '$lib/stores/network';

  export let state: LiquidityNexusState | null;
  export let pda: string | null = null;
  export let loading = false;

  $: cluster = $network;
</script>

<article class="state-panel">
  <header class="state-head">
    <div class="title-block">
      <h2>Liquidity Nexus</h2>
      {#if state}
        {#if state.killSwitchEngaged}
          <span class="badge danger">
            <ShieldOff size={12} />
            Kill-switch
          </span>
        {:else if state.isActive}
          <span class="badge success">
            <CheckCircle2 size={12} />
            Active
          </span>
        {:else}
          <span class="badge warn">
            <Activity size={12} />
            Inactive
          </span>
        {/if}
      {/if}
    </div>
    {#if pda}
      <a class="pda mono" href={explorerUrl(pda, 'address', cluster)} target="_blank" rel="noreferrer noopener">
        {formatAddress(pda, 6)}
      </a>
    {/if}
  </header>

  {#if loading && !state}
    <div class="empty">Loading Nexus state…</div>
  {:else if !state}
    <div class="empty">
      <AlertTriangle size={14} />
      Nexus singleton not initialized on this cluster.
    </div>
  {:else}
    <div class="grid">
      <div class="cell">
        <span class="cell-label">Manager</span>
        <span class="cell-value mono" class:danger={state.killSwitchEngaged}>
          {state.killSwitchEngaged ? 'KILL-SWITCH (zero pubkey)' : formatAddress(state.manager, 6)}
        </span>
      </div>
      <div class="cell">
        <span class="cell-label">Principal floor — USDC</span>
        <span class="cell-value mono">{formatAmount(state.totalDepositedUsdc, 6)}</span>
      </div>
      <div class="cell">
        <span class="cell-label">Principal floor — RWT</span>
        <span class="cell-value mono">{formatAmount(state.totalDepositedRwt, 6)}</span>
      </div>
      <div class="cell">
        <span class="cell-label">PDA bump</span>
        <span class="cell-value mono">{state.bump}</span>
      </div>
    </div>
  {/if}
</article>

<style>
  .state-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .state-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .title-block {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .title-block h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .badge.success {
    background: rgba(16, 185, 129, 0.15);
    color: var(--color-success);
  }
  .badge.warn {
    background: rgba(245, 158, 11, 0.15);
    color: var(--color-warning);
  }
  .badge.danger {
    background: rgba(239, 68, 68, 0.15);
    color: var(--color-danger);
  }
  .pda {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    text-decoration: none;
  }
  .pda:hover { color: var(--color-text); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-bg);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }
  .cell-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cell-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    word-break: break-all;
  }
  .cell-value.danger { color: var(--color-danger); }

  .empty {
    background: var(--color-bg);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    justify-content: center;
  }

  .mono { font-family: var(--font-mono); }
</style>
