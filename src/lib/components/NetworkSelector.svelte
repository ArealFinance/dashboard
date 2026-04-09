<script lang="ts">
  import { Globe } from 'lucide-svelte';
  import { network } from '$lib/stores/network';
  import type { Cluster } from '$lib/stores/network';

  function handleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    network.setCluster(select.value as Cluster);
  }
</script>

<div class="network-selector">
  <Globe size={14} />
  <select value={$network} on:change={handleChange}>
    <option value="devnet">Devnet</option>
    <option value="mainnet-beta">Mainnet</option>
  </select>
  <span class="indicator" class:devnet={$network === 'devnet'} class:mainnet={$network === 'mainnet-beta'}></span>
</div>

<style>
  .network-selector {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  select {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    padding: var(--space-1) 0;
    cursor: pointer;
    outline: none;
  }

  select option {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .indicator.devnet {
    background: var(--color-warning);
  }

  .indicator.mainnet {
    background: var(--color-success);
  }
</style>
