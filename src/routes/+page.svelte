<script lang="ts">
  import { Coins, Vote, CircleDollarSign, ArrowLeftRight, GitBranch, Bot, Check, Clock } from 'lucide-svelte';
  import { network } from '$lib/stores/network';
  import { protocolRegistry } from '$lib/stores/protocol';
  import CpiGraph from '$lib/components/CpiGraph.svelte';

  $: programs = $protocolRegistry.programs;
  $: readyCount = $protocolRegistry.deployedCount;
  $: totalInstructions = $protocolRegistry.totalInstructions;
  $: totalLinks = $protocolRegistry.links.length;
  $: activeLinks = $protocolRegistry.links.filter(l => l.status === 'active').length;

  // Icon map for each program
  const iconMap: Record<string, any> = {
    'ot': Coins,
    'futarchy': Vote,
    'rwt': CircleDollarSign,
    'dex': ArrowLeftRight,
    'yd': GitBranch
  };

  // Href map for each program
  const hrefMap: Record<string, string> = {
    'ot': '/ot',
    'futarchy': '/futarchy',
    'rwt': '/rwt',
    'dex': '/dex',
    'yd': '/yd'
  };
</script>

<div class="overview">
  <div class="hero">
    <h1>Areal Finance Protocol</h1>
    <p class="subtitle">5 on-chain contracts + 6 off-chain bots | {$network} network</p>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <span class="stat-value">{readyCount}/{programs.length}</span>
      <span class="stat-label">Modules deployed</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{totalInstructions}</span>
      <span class="stat-label">Total instructions</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{activeLinks}/{totalLinks}</span>
      <span class="stat-label">CPI links active</span>
    </div>
  </div>

  <!-- CPI Graph -->
  <section class="section-card">
    <h2 class="section-title">Protocol Architecture</h2>
    <p class="section-desc">Cross-Program Invocation graph showing contract relationships</p>
    <CpiGraph />
  </section>

  <!-- Quick Links -->
  <section class="quick-links">
    <h2 class="section-title">Quick Access</h2>
    <div class="links-row">
      <a href="/ot" class="quick-link">
        <Coins size={16} />
        <span>Manage OT Projects</span>
      </a>
    </div>
  </section>

  <h2 class="section-title">Protocol Modules</h2>

  <div class="modules-grid">
    {#each programs as mod}
      {@const icon = iconMap[mod.id]}
      {@const href = hrefMap[mod.id]}
      <div class="module-card" class:ready={mod.status === 'deployed'} class:disabled={mod.status === 'pending'}>
        {#if mod.status === 'deployed'}
          <a href={href} class="module-link">
            <div class="module-header">
              <div class="module-icon">
                <svelte:component this={icon} size={20} />
              </div>
              <div class="module-meta">
                <span class="module-name">{mod.name}</span>
                <span class="module-layer">Layer {mod.layer}</span>
              </div>
              <div class="module-status status-ready">
                <Check size={12} />
                Ready
              </div>
            </div>
            <p class="module-desc">{mod.description}</p>
            <div class="module-footer">
              <span class="module-stat">{mod.instructions} instructions</span>
              {#if mod.programId}
                <span class="module-stat">ID: {mod.programId.slice(0, 8)}...</span>
              {/if}
            </div>
          </a>
        {:else}
          <div class="module-link">
            <div class="module-header">
              <div class="module-icon">
                <svelte:component this={icon} size={20} />
              </div>
              <div class="module-meta">
                <span class="module-name">{mod.name}</span>
                <span class="module-layer">Layer {mod.layer}</span>
              </div>
              <div class="module-status status-pending">
                <Clock size={12} />
                Pending
              </div>
            </div>
            <p class="module-desc">{mod.description}</p>
            <div class="module-footer">
              <span class="module-stat">{mod.instructions} instructions</span>
            </div>
          </div>
        {/if}
      </div>
    {/each}

    <!-- Off-chain Bots (not in protocol registry — separate category) -->
    <div class="module-card disabled">
      <div class="module-link">
        <div class="module-header">
          <div class="module-icon">
            <Bot size={20} />
          </div>
          <div class="module-meta">
            <span class="module-name">Off-chain Bots</span>
            <span class="module-layer">Layer 8-9</span>
          </div>
          <div class="module-status status-pending">
            <Clock size={12} />
            Pending
          </div>
        </div>
        <p class="module-desc">Cranks, rebalancer, merkle publisher</p>
        <div class="module-footer">
          <span class="module-stat">6 services</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .hero h1 {
    font-size: var(--text-3xl);
    font-weight: 700;
  }

  .subtitle {
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
  }

  .stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .stat-value {
    font-size: var(--text-2xl);
    font-weight: 700;
    font-family: var(--font-mono);
  }

  .stat-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .section-title {
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .section-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  /* Quick links */
  .quick-links {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .links-row {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .quick-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--color-primary-muted);
    color: var(--color-primary);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    transition: all var(--transition-fast);
  }

  .quick-link:hover {
    background: var(--color-primary);
    color: white;
    text-decoration: none;
  }

  .modules-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-4);
  }

  .module-card {
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    transition: all var(--transition-fast);
    overflow: hidden;
  }

  .module-card.ready:hover {
    border-color: var(--color-primary);
    box-shadow: var(--shadow-card);
  }

  .module-card.disabled {
    opacity: 0.5;
  }

  .module-link {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    text-decoration: none;
    color: inherit;
  }

  .module-link:hover {
    text-decoration: none;
  }

  .module-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .module-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }

  .module-meta {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .module-name {
    font-weight: 600;
    font-size: var(--text-base);
  }

  .module-layer {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .module-status {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }

  .status-ready {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  .status-pending {
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .module-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  .module-footer {
    display: flex;
    gap: var(--space-3);
  }

  .module-stat {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }
</style>
