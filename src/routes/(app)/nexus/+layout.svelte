<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import {
    Layers,
    LineChart,
    ShieldCheck,
    Banknote,
    Sliders,
    ArrowDownToLine,
  } from 'lucide-svelte';
  import { nexusStore, nexusEvents, nexusManagerHealth, nexusPositions } from '$lib/stores/layer9';
  import { dexStore } from '$lib/stores/dex';

  $: pathname = $page.url.pathname;

  const tabs = [
    { href: '/nexus', label: 'Overview', icon: Layers, exact: true },
    { href: '/nexus/positions', label: 'Positions', icon: LineChart, exact: false },
    { href: '/nexus/admin', label: 'Admin', icon: ShieldCheck, exact: false },
    { href: '/nexus/treasury', label: 'Treasury', icon: Banknote, exact: false },
    { href: '/nexus/manager', label: 'Manager', icon: Sliders, exact: false },
    { href: '/nexus/deposit', label: 'Deposit', icon: ArrowDownToLine, exact: false },
  ];

  function isActive(href: string, exact: boolean): boolean {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  onMount(() => {
    nexusStore.start(15_000);
    nexusEvents.start(30_000);
    nexusManagerHealth.start(15_000);
    void dexStore.refresh();
    // Positions depend on dex.pools — refresh once after dex hydrates.
    void Promise.resolve().then(() => nexusPositions.refresh());
  });

  onDestroy(() => {
    nexusStore.stop();
    nexusEvents.stop();
    nexusManagerHealth.stop();
  });
</script>

<div class="nexus-layout">
  <nav class="tabs" aria-label="Liquidity Nexus navigation">
    {#each tabs as tab}
      <a
        href={tab.href}
        class="tab"
        class:active={isActive(tab.href, tab.exact)}
      >
        <svelte:component this={tab.icon} size={14} />
        <span>{tab.label}</span>
      </a>
    {/each}
  </nav>

  <slot />
</div>

<style>
  .nexus-layout {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--color-text);
    text-decoration: none;
  }
  .tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }
</style>
