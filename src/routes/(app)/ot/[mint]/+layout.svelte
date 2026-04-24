<script lang="ts">
  import { onMount, onDestroy, setContext } from 'svelte';
  import { page } from '$app/stores';
  import { writable } from 'svelte/store';
  import { ArrowLeft, RefreshCw, Loader2 } from 'lucide-svelte';
  import { createOtStore } from '$lib/stores/ot';
  import { trimNullBytes as trimNull } from '$lib/utils/format';
  import CopyAddress from '$lib/components/CopyAddress.svelte';

  $: mintAddress = $page.params.mint ?? '';
  $: currentPath = $page.url.pathname;

  let otStore = createOtStore(mintAddress || '11111111111111111111111111111111');
  setContext('otStore', otStore);

  // M-13: point the existing store at the new mint when the URL param changes,
  // instead of leaving a stale clone in context.
  let lastMintAddress = mintAddress;
  $: if (mintAddress && mintAddress !== lastMintAddress) {
    otStore.setMint(mintAddress);
    lastMintAddress = mintAddress;
  }

  // Navigation tabs
  $: basePath = `/ot/${mintAddress}`;
  $: tabs = [
    { label: 'Overview', href: basePath, exact: true },
    { label: 'Actions', href: `${basePath}/actions` },
    { label: 'Destinations', href: `${basePath}/destinations` },
    { label: 'Governance', href: `${basePath}/governance` }
  ];

  function isActive(tab: { href: string; exact?: boolean }) {
    if (tab.exact) return currentPath === tab.href;
    return currentPath.startsWith(tab.href);
  }

  onMount(async () => {
    await otStore.refresh();
    otStore.setupSubscriptions();
  });

  onDestroy(() => {
    otStore.cleanup();
  });
</script>

<div class="ot-layout">
  <div class="ot-header">
    <div class="header-top">
      <a href="/ot" class="back-link">
        <ArrowLeft size={16} />
        <span>Back to list</span>
      </a>
      <button class="btn-icon" on:click={() => otStore.refresh()} title="Refresh">
        <RefreshCw size={14} />
      </button>
    </div>

    <div class="header-title">
      {#if $otStore.otConfig}
        {@const name = trimNull($otStore.otConfig.name)}
        {@const symbol = trimNull($otStore.otConfig.symbol)}
        <h2>{symbol}</h2>
        <span class="token-name">{name}</span>
      {:else}
        <h2>OT</h2>
      {/if}
      <CopyAddress address={mintAddress} chars={6} />
    </div>

    <nav class="tab-nav">
      {#each tabs as tab}
        <a href={tab.href} class="tab" class:active={isActive(tab)}>
          {tab.label}
        </a>
      {/each}
    </nav>
  </div>

  {#if $otStore.loading}
    <div class="loading">
      <Loader2 size={24} class="spin" />
      <span>Loading OT state...</span>
    </div>
  {:else if $otStore.error}
    <div class="error-banner">{$otStore.error}</div>
  {:else}
    <slot />
  {/if}
</div>


<style>
  .ot-layout {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .ot-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .back-link:hover {
    color: var(--color-text);
    text-decoration: none;
  }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    transition: all var(--transition-fast);
  }

  .btn-icon:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .header-title {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .header-title h2 {
    color: var(--color-primary);
  }

  .token-name {
    color: var(--color-text-secondary);
    font-size: var(--text-base);
  }

  .tab-nav {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0;
  }

  .tab {
    padding: var(--space-2) var(--space-4);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--transition-fast);
  }

  .tab:hover {
    color: var(--color-text);
    text-decoration: none;
  }

  .tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-12);
    color: var(--color-text-muted);
  }

  .error-banner {
    padding: var(--space-4);
    background: var(--color-danger-muted);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    color: var(--color-danger);
  }
</style>
