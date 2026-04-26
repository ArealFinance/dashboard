<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { Layers, Repeat, GitBranch, Droplet } from 'lucide-svelte';
  import { crankStatuses, recentEvents, liquidityHolding } from '$lib/stores/layer8';
  import { ydStore } from '$lib/stores/yd';

  $: pathname = $page.url.pathname;

  const tabs = [
    { href: '/layer8', label: 'Overview', icon: Layers, exact: true },
    { href: '/layer8/convert', label: 'Convert', icon: Repeat, exact: false },
    { href: '/layer8/yield-flows', label: 'Yield flows', icon: GitBranch, exact: false },
    { href: '/layer8/liquidity-holding', label: 'Liquidity holding', icon: Droplet, exact: false },
  ];

  function isActive(href: string, exact: boolean): boolean {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  onMount(() => {
    crankStatuses.start(15_000);
    recentEvents.start(30_000);
    void liquidityHolding.refresh();
    void ydStore.refresh();
  });

  onDestroy(() => {
    crankStatuses.stop();
    recentEvents.stop();
  });
</script>

<div class="layer8-layout">
  <nav class="tabs" aria-label="Layer 8 navigation">
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
  .layer8-layout {
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
