<script lang="ts">
  /*
   * SystemHealth — extracted from the previous root `+page.svelte` per Q3 / D14.
   *
   * Renders the contracts-deployed + module-card grid + CPI graph that
   * formerly lived inline at the root. The new System Overview composes this
   * as one of 8 sections so the existing surface is preserved while the
   * other 7 sections add the live-state cards.
   */
  import { Coins, Vote, CircleDollarSign, ArrowLeftRight, GitBranch, Bot, Check, Clock } from 'lucide-svelte';
  import { protocolRegistry } from '$lib/stores/protocol';
  import { botHeartbeats } from '$lib/stores/systemOverview';
  import CpiGraph from './CpiGraph.svelte';

  $: programs = $protocolRegistry.programs;
  $: readyCount = $protocolRegistry.deployedCount;
  $: totalInstructions = $protocolRegistry.totalInstructions;
  $: totalLinks = $protocolRegistry.links.length;
  $: activeLinks = $protocolRegistry.links.filter((l) => l.status === 'active').length;

  $: bots = $botHeartbeats;
  $: botsHealthy = bots.filter((b) => b.status === 'running').length;

  // Icon map for each program
  const iconMap: Record<string, any> = {
    ot: Coins,
    futarchy: Vote,
    rwt: CircleDollarSign,
    dex: ArrowLeftRight,
    yd: GitBranch,
  };

  // Href map for each program
  const hrefMap: Record<string, string> = {
    ot: '/ot',
    futarchy: '/futarchy',
    rwt: '/rwt',
    dex: '/dex',
    yd: '/yd',
  };
</script>

<section class="system-health">
  <div class="stats-row">
    <div class="stat-card">
      <span class="stat-value">{readyCount}/{programs.length}</span>
      <span class="stat-label">Contracts deployed</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{botsHealthy}/{bots.length}</span>
      <span class="stat-label">Bots running</span>
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

  <div class="cpi-card">
    <h3 class="cpi-title">Protocol Architecture</h3>
    <p class="cpi-desc">Cross-Program Invocation graph showing contract relationships</p>
    <CpiGraph />
  </div>

  <div class="modules-grid">
    {#each programs as mod (mod.id)}
      {@const icon = iconMap[mod.id]}
      {@const href = hrefMap[mod.id]}
      <div
        class="module-card"
        class:ready={mod.status === 'deployed'}
        class:disabled={mod.status === 'pending'}
      >
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

    <a href="/bots" class="module-card module-link bots-card">
      <div class="module-header">
        <div class="module-icon">
          <Bot size={20} />
        </div>
        <div class="module-meta">
          <span class="module-name">Off-chain Bots</span>
          <span class="module-layer">Layer 5, 7-9</span>
        </div>
        <div class="module-status" class:status-ready={botsHealthy === bots.length}
             class:status-pending={botsHealthy !== bots.length}>
          {#if botsHealthy === bots.length}
            <Check size={12} />
            All running
          {:else}
            <Clock size={12} />
            {botsHealthy}/{bots.length} running
          {/if}
        </div>
      </div>
      <p class="module-desc">
        Cranks (revenue / convert-and-fund / yield-claim), publisher, rebalancer, Nexus manager.
      </p>
      <div class="module-footer">
        <span class="module-stat">{bots.length} services</span>
      </div>
    </a>
  </div>
</section>

<style>
  .system-health {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
  }

  .stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
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

  .cpi-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .cpi-title {
    font-size: var(--text-md);
    font-weight: 600;
    margin: 0;
  }

  .cpi-desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
  }

  .modules-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-3);
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
    padding: var(--space-4);
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
    margin: 0;
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

  .bots-card:hover {
    border-color: var(--color-primary);
    box-shadow: var(--shadow-card);
  }
</style>
