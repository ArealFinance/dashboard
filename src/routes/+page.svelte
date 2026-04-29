<script lang="ts">
  /*
   * System Overview — Layer 10 Substep 9 root page (per Q3 / D14).
   *
   * Composes the 8 mandated sections:
   *   1. System Health  — contracts deployed + bot heartbeats + CPI graph
   *   2. Authority Chain
   *   3. Token Metrics
   *   4. Revenue Flow
   *   5. DEX Pools
   *   6. Nexus
   *   7. Recent Events  — consolidated cross-contract feed (event-stream
   *                       aggregated, 2s tick — D34 / R-F)
   *   8. Alerts          — derived from heartbeats + feed staleness
   *
   * Data flow:
   *   - Cards subscribe to existing per-contract typed stores (rwtStore,
   *     dexStore, otList, ydStore, futarchyList, nexusStore, etc.).
   *   - 1s master tick driver fans out per-card refresh (D34 — reuses
   *     /nexus/ pattern).
   *   - 2s consolidated-events ticker via systemOverview store (D34).
   *   - Stale markers + alerts derived client-side.
   */
  import { onMount, onDestroy } from 'svelte';
  import { RefreshCw, Network, Coins, ShieldCheck, GitBranch, ArrowLeftRight, Bot, Activity, AlertTriangle } from 'lucide-svelte';
  import { network } from '$lib/stores/network';
  import { systemOverview } from '$lib/stores/systemOverview';

  import SystemHealth from '$lib/components/SystemHealth.svelte';
  import BotHeartbeats from '$lib/components/BotHeartbeats.svelte';
  import AuthorityChain from '$lib/components/AuthorityChain.svelte';
  import TokenMetrics from '$lib/components/TokenMetrics.svelte';
  import RevenueFlowOverview from '$lib/components/RevenueFlowOverview.svelte';
  import DexPoolsOverview from '$lib/components/DexPoolsOverview.svelte';
  import NexusOverview from '$lib/components/NexusOverview.svelte';
  import RecentEvents from '$lib/components/RecentEvents.svelte';
  import Alerts from '$lib/components/Alerts.svelte';

  let refreshing = false;

  async function manualRefresh() {
    refreshing = true;
    try {
      await systemOverview.refresh();
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    // Card cadence resolved from PUBLIC_DASHBOARD_CARD_INTERVAL_MS
    // (default 5s, T-59/T-60). Events ticker stays at 2s (Recent Events
    // is the cheap signature-walk path, not the GPA-fan-out path).
    systemOverview.start(undefined, 2_000);
  });

  onDestroy(() => {
    systemOverview.stop();
  });
</script>

<div class="overview">
  <header class="hero">
    <div>
      <h1>Areal Finance Protocol</h1>
      <p class="subtitle">
        System Overview · 5 contracts + 6 bots · {$network}
      </p>
    </div>
    <button class="refresh-btn" on:click={manualRefresh} disabled={refreshing} aria-label="Refresh">
      <RefreshCw size={14} class={refreshing ? 'spin' : ''} />
      <span>Refresh</span>
    </button>
  </header>

  <!-- 1. System Health -->
  <section class="overview-section section-system-health" id="system-health">
    <div class="section-head">
      <Network size={16} />
      <h2 class="section-title">System Health</h2>
    </div>
    <SystemHealth />
    <div class="bots-block">
      <h3 class="subsection-title">Bot heartbeats</h3>
      <BotHeartbeats />
    </div>
  </section>

  <!-- 2. Authority Chain -->
  <section class="overview-section section-authority-chain" id="authority-chain">
    <div class="section-head">
      <ShieldCheck size={16} />
      <h2 class="section-title">Authority Chain</h2>
    </div>
    <AuthorityChain />
  </section>

  <!-- 3. Token Metrics -->
  <section class="overview-section section-token-metrics" id="token-metrics">
    <div class="section-head">
      <Coins size={16} />
      <h2 class="section-title">Token Metrics</h2>
    </div>
    <TokenMetrics />
  </section>

  <!-- 4. Revenue Flow -->
  <section class="overview-section section-revenue-flow" id="revenue-flow">
    <div class="section-head">
      <GitBranch size={16} />
      <h2 class="section-title">Revenue Flow</h2>
    </div>
    <RevenueFlowOverview />
  </section>

  <!-- 5. DEX Pools -->
  <section class="overview-section section-dex-pools" id="dex-pools">
    <div class="section-head">
      <ArrowLeftRight size={16} />
      <h2 class="section-title">DEX Pools</h2>
    </div>
    <DexPoolsOverview />
  </section>

  <!-- 6. Nexus -->
  <section class="overview-section section-nexus" id="nexus">
    <div class="section-head">
      <Bot size={16} />
      <h2 class="section-title">Nexus</h2>
    </div>
    <NexusOverview />
  </section>

  <!-- 7. Recent Events -->
  <section class="overview-section section-recent-events" id="recent-events">
    <div class="section-head">
      <Activity size={16} />
      <h2 class="section-title">Recent Events</h2>
    </div>
    <RecentEvents />
  </section>

  <!-- 8. Alerts -->
  <section class="overview-section section-alerts" id="alerts">
    <div class="section-head">
      <AlertTriangle size={16} />
      <h2 class="section-title">Alerts</h2>
    </div>
    <Alerts />
  </section>
</div>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .hero h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    margin: 0;
  }

  .subtitle {
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .refresh-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .refresh-btn:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .overview-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
  }

  .section-title {
    font-size: var(--text-lg);
    font-weight: 600;
    margin: 0;
  }

  .subsection-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .bots-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
