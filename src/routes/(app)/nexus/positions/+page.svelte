<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import NexusPositionsTable from '$lib/components/layer9/NexusPositionsTable.svelte';
  import { nexusPositions } from '$lib/stores/layer9';
  import { dexStore } from '$lib/stores/dex';

  $: state = $nexusPositions;

  async function refresh(): Promise<void> {
    await dexStore.refresh();
    await nexusPositions.refresh();
  }
</script>

<div class="page-header">
  <div>
    <h1>Nexus LP Positions</h1>
    <p class="page-description">
      Per-pool LP positions owned by the Liquidity Nexus PDA. Pending fees
      are computed from the pool's `cumulative_fees_per_share_*` accumulator
      against the position's `fees_claimed_per_share_*` snapshot.
    </p>
  </div>
  <button class="btn btn-ghost" on:click={refresh} disabled={state.loading}>
    <RefreshCw size={14} class={state.loading ? 'spin' : ''} />
    Refresh
  </button>
</div>

{#if state.error}
  <div class="alert error">Load failed: {state.error}</div>
{/if}

<NexusPositionsTable positions={state.positions} loading={state.loading} />

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
  .alert {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }
  .alert.error {
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
