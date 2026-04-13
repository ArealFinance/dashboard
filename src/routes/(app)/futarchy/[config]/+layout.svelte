<script lang="ts">
  import { onMount, onDestroy, setContext } from 'svelte';
  import { page } from '$app/stores';
  import { ArrowLeft, RefreshCw, Loader2 } from 'lucide-svelte';
  import { createFutarchyStore } from '$lib/stores/futarchy';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { bytesToBase58 } from '$lib/utils/format';

  $: configAddress = ($page.params as any).config ?? '';
  $: currentPath = $page.url.pathname;

  let store = createFutarchyStore(configAddress || '11111111111111111111111111111111');
  setContext('futarchyStore', store);

  $: basePath = `/futarchy/${configAddress}`;
  $: tabs = [
    { label: 'Overview', href: basePath, exact: true },
    { label: 'Create Proposal', href: `${basePath}/proposals/create` },
    { label: 'Governance', href: `${basePath}/governance` }
  ];

  function isTabActive(tab: { href: string; exact?: boolean }) {
    if (tab.exact) return currentPath === tab.href;
    return currentPath.startsWith(tab.href);
  }

  onMount(async () => {
    await store.refresh();
    store.setupSubscriptions();
  });

  onDestroy(() => { store.cleanup(); });

  function trimNull(bytes: any): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let end = arr.length;
    for (let i = 0; i < arr.length; i++) { if (arr[i] === 0) { end = i; break; } }
    return new TextDecoder().decode(arr.subarray(0, end));
  }
</script>

<div class="futarchy-layout">
  <div class="header">
    <div class="header-top">
      <a href="/futarchy" class="back-link">
        <ArrowLeft size={16} /> <span>Back to list</span>
      </a>
      <button class="btn-icon" on:click={() => store.refresh()} title="Refresh">
        <RefreshCw size={14} />
      </button>
    </div>

    <div class="header-title">
      {#if $store.config}
        <h2>Futarchy Governance</h2>
        <span class="ot-label">OT: {bytesToBase58($store.config.ot_mint).slice(0, 8)}...</span>
      {:else}
        <h2>Futarchy</h2>
      {/if}
      <CopyAddress address={configAddress} chars={6} />
    </div>

    <nav class="tabs">
      {#each tabs as tab}
        <a href={tab.href} class="tab" class:active={isTabActive(tab)}>{tab.label}</a>
      {/each}
    </nav>
  </div>

  {#if $store.loading}
    <div class="center-msg"><Loader2 size={20} class="spin" /> Loading config...</div>
  {:else if $store.error}
    <div class="center-msg error">{$store.error}</div>
  {:else if !$store.config}
    <div class="center-msg">FutarchyConfig not found at this address.</div>
  {:else}
    <slot />
  {/if}
</div>

<style>
  .futarchy-layout { display: flex; flex-direction: column; gap: var(--space-4); }
  .header { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-4); }
  .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }
  .back-link { display: flex; align-items: center; gap: var(--space-1); color: var(--color-text-secondary); text-decoration: none; font-size: var(--text-sm); }
  .back-link:hover { color: var(--color-text); }
  .header-title { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
  .header-title h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; }
  .ot-label { font-size: var(--text-sm); color: var(--color-text-muted); font-family: var(--font-mono); }
  .tabs { display: flex; gap: var(--space-1); border-top: 1px solid var(--color-border); padding-top: var(--space-3); }
  .tab { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm); color: var(--color-text-secondary); text-decoration: none; transition: all 0.15s; }
  .tab:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .tab.active { background: var(--color-primary); color: white; }
  .btn-icon { background: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2); color: var(--color-text-secondary); cursor: pointer; }
  .center-msg { padding: var(--space-8); text-align: center; color: var(--color-text-muted); }
  .center-msg.error { color: var(--color-danger); }
</style>
