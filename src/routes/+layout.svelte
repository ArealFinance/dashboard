<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import {
    Hexagon, Coins, Vote, CircleDollarSign, ArrowLeftRight,
    GitBranch, Bot, LayoutDashboard, ChevronRight, Layers,
    Terminal, Upload, PlayCircle
  } from 'lucide-svelte';
  import WalletButton from '$lib/components/WalletButton.svelte';
  import NetworkSelector from '$lib/components/NetworkSelector.svelte';

  $: currentPath = $page.url.pathname;

  interface NavItem {
    label: string;
    href: string;
    icon: any;
    enabled: boolean;
    description: string;
  }

  const navItems: NavItem[] = [
    { label: 'Overview', href: '/', icon: LayoutDashboard, enabled: true, description: 'Protocol status' },
    { label: 'Ownership Token', href: '/ot', icon: Coins, enabled: true, description: 'Layer 1' },
    { label: 'Futarchy', href: '/futarchy', icon: Vote, enabled: true, description: 'Layer 2' },
    { label: 'RWT Engine', href: '/rwt', icon: CircleDollarSign, enabled: true, description: 'Layer 3' },
    { label: 'Native DEX', href: '/dex', icon: ArrowLeftRight, enabled: true, description: 'Layer 4-5' },
    { label: 'Yield Distribution', href: '/yd', icon: GitBranch, enabled: true, description: 'Layer 7' },
    { label: 'Layer 8 — Yield Flows', href: '/layer8', icon: Layers, enabled: true, description: 'Cranks + claims' },
    { label: 'Bots', href: '/bots', icon: Bot, enabled: false, description: 'Layer 8-9' },
  ];

  const devNavItems: NavItem[] = [
    { label: 'Dev Hub', href: '/dev', icon: Terminal, enabled: true, description: 'Keypairs & status' },
    { label: 'Deploy', href: '/dev/deploy', icon: Upload, enabled: true, description: 'Program deploy' },
    { label: 'E2E Tests', href: '/dev/e2e', icon: PlayCircle, enabled: true, description: 'Test runner' },
  ];

  function isActive(href: string): boolean {
    if (href === '/') return currentPath === '/';
    return currentPath.startsWith(href);
  }
</script>

<div class="app-shell">
  <aside class="sidebar">
    <div class="sidebar-header">
      <a href="/" class="logo">
        <Hexagon size={22} />
        <span class="logo-text">Areal Finance</span>
      </a>
    </div>

    <nav class="sidebar-nav">
      {#each navItems as item}
        <a href={item.href} class="nav-item" class:active={isActive(item.href)} class:disabled={!item.enabled}>
          <svelte:component this={item.icon} size={16} />
          <span class="nav-label">{item.label}</span>
          {#if !item.enabled}
            <span class="nav-badge">{item.description}</span>
          {:else if isActive(item.href)}
            <ChevronRight size={14} class="nav-arrow" />
          {/if}
        </a>
      {/each}
      <div class="nav-divider"></div>
      <span class="nav-section-label">Dev Tools</span>
      {#each devNavItems as item}
        <a href={item.href} class="nav-item" class:active={isActive(item.href)} class:disabled={!item.enabled}>
          <svelte:component this={item.icon} size={16} />
          <span class="nav-label">{item.label}</span>
          {#if isActive(item.href)}
            <ChevronRight size={14} class="nav-arrow" />
          {/if}
        </a>
      {/each}
    </nav>

    <div class="sidebar-footer">
      <NetworkSelector />
    </div>
  </aside>

  <div class="main-area">
    <header class="top-bar">
      <div class="breadcrumb">
        {#each currentPath.split('/').filter(Boolean) as segment, i}
          {#if i > 0}<span class="bc-sep">/</span>{/if}
          <span class="bc-segment">{segment}</span>
        {/each}
        {#if currentPath === '/'}
          <span class="bc-segment">Overview</span>
        {/if}
      </div>
      <WalletButton />
    </header>

    <main class="app-main">
      <slot />
    </main>
  </div>
</div>

<style>
  .app-shell {
    display: flex;
    min-height: 100vh;
  }

  /* ---- Sidebar ---- */
  .sidebar {
    width: 240px;
    min-width: 240px;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }

  .sidebar-header {
    padding: var(--space-5) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text);
    font-weight: 700;
    font-size: var(--text-md);
    text-decoration: none;
  }

  .logo:hover {
    color: var(--color-primary);
    text-decoration: none;
  }

  .sidebar-nav {
    flex: 1;
    padding: var(--space-3) var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    border-radius: var(--radius-md);
    text-decoration: none;
    transition: all var(--transition-fast);
    cursor: pointer;
  }

  .nav-item:hover:not(.disabled) {
    color: var(--color-text);
    background: var(--color-surface-hover);
    text-decoration: none;
  }

  .nav-item.active {
    color: var(--color-primary);
    background: var(--color-primary-muted);
    font-weight: 500;
  }

  .nav-item.disabled {
    cursor: default;
    opacity: 0.4;
  }

  .nav-label {
    flex: 1;
  }

  .nav-badge {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .nav-divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-3) var(--space-3);
  }

  .nav-section-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: var(--space-1) var(--space-3);
    font-weight: 500;
  }

  :global(.nav-arrow) {
    color: var(--color-primary);
    opacity: 0.6;
  }

  .sidebar-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
  }

  /* ---- Main area ---- */
  .main-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-6);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
  }

  .bc-sep {
    color: var(--color-text-muted);
  }

  .bc-segment {
    text-transform: capitalize;
  }

  .app-main {
    flex: 1;
    padding: var(--space-6);
    max-width: 1200px;
    width: 100%;
  }
</style>
