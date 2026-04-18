<script lang="ts">
  import {
    PlayCircle, RotateCcw, AlertTriangle, ChevronDown, ChevronRight,
    ExternalLink, Clock, Check, X, Loader, SkipForward
  } from 'lucide-svelte';
  import { e2eRunner } from '$lib/stores/e2e-runner';
  import { activeKeypairInfo, devKeys } from '$lib/stores/devkeys';
  import { rpcEndpoint } from '$lib/stores/network';
  import type { E2EStep } from '$lib/stores/e2e-runner';

  let running = false;
  let runError = '';
  let expandedSteps: Record<string, boolean> = {};

  // Scenario selection
  $: availableScenarios = e2eRunner.scenarios;
  let selectedScenarioId = '';
  $: if (!selectedScenarioId) selectedScenarioId = scenario.id;

  function handleSelectScenario(id: string) {
    selectedScenarioId = id;
    e2eRunner.selectScenario(id);
    expandedSteps = {};
    runError = '';
  }

  $: scenario = $e2eRunner;
  $: info = $activeKeypairInfo;
  $: passCount = scenario.steps.filter(s => s.status === 'success').length;
  $: failCount = scenario.steps.filter(s => s.status === 'error').length;
  $: skipCount = scenario.steps.filter(s => s.status === 'skipped').length;
  $: totalDuration = scenario.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  function toggleStep(id: string) {
    expandedSteps[id] = !expandedSteps[id];
    expandedSteps = { ...expandedSteps };
  }

  async function handleRunAll() {
    running = true;
    runError = '';
    try {
      await e2eRunner.runAll();
    } catch (err: any) {
      runError = err.message || 'Failed to run E2E';
    } finally {
      running = false;
    }
  }

  function handleReset() {
    e2eRunner.reset();
    expandedSteps = {};
    runError = '';
  }

  function getExplorerUrl(sig: string): string {
    // For test validator, use localhost explorer or solana.fm with custom RPC
    // Default to Solana Explorer with custom cluster
    const endpoint = $rpcEndpoint;
    if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
      return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(endpoint)}`;
    }
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }

  function formatDuration(ms: number | undefined): string {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function getStatusIcon(status: E2EStep['status']): typeof Check {
    switch (status) {
      case 'pending': return Clock;
      case 'running': return Loader;
      case 'success': return Check;
      case 'error': return X;
      case 'skipped': return SkipForward;
      default: return Clock;
    }
  }
</script>

<div class="e2e-page">
  <div class="dev-warning">
    <AlertTriangle size={18} />
    <span>DEV ONLY — NOT FOR PRODUCTION — Never use with real funds</span>
  </div>

  <div class="page-header">
    <PlayCircle size={24} />
    <h1>E2E Test Runner</h1>
  </div>

  <!-- Prerequisites -->
  <section class="card prereq-card">
    <h2 class="card-title">Prerequisites</h2>
    <div class="prereq-list">
      <div class="prereq-item" class:prereq-ok={info !== null} class:prereq-fail={info === null}>
        {#if info}
          <Check size={14} />
          <span>Active keypair: <strong>{info.name}</strong> ({info.balance.toFixed(2)} SOL)</span>
        {:else}
          <X size={14} />
          <span>No active dev keypair. <a href="/dev">Go to Dev Hub</a> to create one.</span>
        {/if}
      </div>
      <div class="prereq-item prereq-ok">
        <Check size={14} />
        <span>RPC: <code class="mono">{$rpcEndpoint}</code></span>
      </div>
    </div>
  </section>

  <!-- Scenario Selector -->
  {#if availableScenarios.length > 1}
    <div class="scenario-tabs">
      {#each availableScenarios as s}
        <button
          class="scenario-tab"
          class:active={selectedScenarioId === s.id}
          on:click={() => handleSelectScenario(s.id)}
          disabled={running}
        >
          {s.name}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Controls -->
  <section class="card">
    <div class="controls-row">
      <div class="scenario-info">
        <h2 class="card-title">{scenario.name}</h2>
        <span class="step-count">{scenario.steps.length} steps</span>
      </div>
      <div class="controls-actions">
        {#if scenario.status === 'idle' || scenario.status === 'completed' || scenario.status === 'failed'}
          <button
            class="btn btn-run"
            on:click={handleRunAll}
            disabled={!info || running}
          >
            <PlayCircle size={16} />
            {scenario.status === 'idle' ? 'Run All' : 'Run Again'}
          </button>
        {/if}
        {#if scenario.status !== 'idle'}
          <button class="btn btn-secondary" on:click={handleReset} disabled={running}>
            <RotateCcw size={14} />
            Reset
          </button>
        {/if}
      </div>
    </div>

    {#if runError}
      <p class="run-error">{runError}</p>
    {/if}

    <!-- Summary -->
    {#if scenario.status !== 'idle'}
      <div class="summary-row">
        <div class="summary-item summary-pass">
          <Check size={14} />
          <span>{passCount} passed</span>
        </div>
        <div class="summary-item summary-fail" class:hidden={failCount === 0}>
          <X size={14} />
          <span>{failCount} failed</span>
        </div>
        <div class="summary-item summary-skip" class:hidden={skipCount === 0}>
          <SkipForward size={14} />
          <span>{skipCount} skipped</span>
        </div>
        <div class="summary-item summary-time">
          <Clock size={14} />
          <span>{formatDuration(totalDuration)}</span>
        </div>
      </div>
    {/if}
  </section>

  <!-- Steps -->
  <div class="steps-list">
    {#each scenario.steps as step, i}
      {@const expanded = expandedSteps[step.id] ?? false}
      {@const StatusIcon = getStatusIcon(step.status)}
      <div class="step-card" class:step-running={step.status === 'running'} class:step-error={step.status === 'error'} class:step-success={step.status === 'success'}>
        <button class="step-header" on:click={() => toggleStep(step.id)}>
          <span class="step-number">{i + 1}</span>
          <span class="step-status-icon status-{step.status}">
            <svelte:component this={StatusIcon} size={14} />
          </span>
          <div class="step-meta">
            <span class="step-name">{step.name}</span>
            <span class="step-desc">{step.description}</span>
          </div>
          <span class="step-duration mono">{formatDuration(step.durationMs)}</span>
          {#if step.txSignature}
            <a
              href={getExplorerUrl(step.txSignature)}
              target="_blank"
              rel="noopener"
              class="tx-link"
              on:click|stopPropagation
              title="View on explorer"
            >
              <ExternalLink size={12} />
              TX
            </a>
          {/if}
          <span class="step-chevron">
            {#if expanded}
              <ChevronDown size={14} />
            {:else}
              <ChevronRight size={14} />
            {/if}
          </span>
        </button>

        {#if expanded}
          <div class="step-details">
            {#if step.error}
              <div class="detail-block detail-error">
                <span class="detail-block-label">Error</span>
                <pre class="detail-pre">{step.error}</pre>
              </div>
            {/if}

            {#if step.txSignature}
              <div class="detail-block">
                <span class="detail-block-label">Transaction</span>
                <a href={getExplorerUrl(step.txSignature)} target="_blank" rel="noopener" class="detail-tx mono">
                  {step.txSignature}
                  <ExternalLink size={12} />
                </a>
              </div>
            {/if}

            {#if step.result}
              <div class="detail-block">
                <span class="detail-block-label">Result</span>
                <div class="result-grid">
                  {#each Object.entries(step.result) as [key, value]}
                    <div class="result-item">
                      <span class="result-key">{key}</span>
                      <span class="result-value mono" class:result-pass={value === true} class:result-fail={value === false}>
                        {typeof value === 'boolean' ? (value ? 'PASS' : 'FAIL') : String(value)}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .e2e-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .dev-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--color-danger-muted);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--color-text);
  }

  .page-header h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
  }

  .scenario-tabs {
    display: flex;
    gap: var(--space-1);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 4px;
  }

  .scenario-tab {
    flex: 1;
    padding: var(--space-2) var(--space-4);
    border: none;
    background: none;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .scenario-tab:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .scenario-tab.active {
    background: var(--color-primary);
    color: white;
  }

  .scenario-tab:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .card-title {
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .prereq-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .prereq-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }

  .prereq-ok {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  .prereq-fail {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .prereq-item a {
    color: inherit;
    text-decoration: underline;
  }

  .controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .scenario-info {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .step-count {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .controls-actions {
    display: flex;
    gap: var(--space-2);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn-run {
    background: var(--color-success);
    color: white;
    padding: var(--space-3) var(--space-5);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .btn-run:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .btn-run:disabled {
    background: var(--color-surface-active);
    color: var(--color-text-muted);
  }

  .btn-secondary {
    background: var(--color-surface-hover);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-active);
  }

  .run-error {
    color: var(--color-danger);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    background: var(--color-danger-muted);
    border-radius: var(--radius-sm);
  }

  .summary-row {
    display: flex;
    gap: var(--space-4);
  }

  .summary-item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .summary-pass { color: var(--color-success); }
  .summary-fail { color: var(--color-danger); }
  .summary-skip { color: var(--color-text-muted); }
  .summary-time { color: var(--color-text-secondary); }

  .hidden { display: none; }

  /* Steps */
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .step-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--transition-fast);
  }

  .step-card.step-running {
    border-color: var(--color-info);
    animation: pulse-border 1.5s ease-in-out infinite;
  }

  .step-card.step-error {
    border-color: var(--color-danger);
  }

  .step-card.step-success {
    border-color: var(--color-border);
  }

  @keyframes pulse-border {
    0%, 100% { border-color: var(--color-info); }
    50% { border-color: var(--color-primary); }
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: transparent;
    color: var(--color-text);
    width: 100%;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .step-header:hover {
    background: var(--color-surface-hover);
  }

  .step-number {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    font-family: var(--font-mono);
  }

  .step-status-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .status-pending { color: var(--color-text-muted); }
  .status-running { color: var(--color-info); animation: spin 1s linear infinite; }
  .status-success { color: var(--color-success); }
  .status-error { color: var(--color-danger); }
  .status-skipped { color: var(--color-text-muted); opacity: 0.5; }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .step-meta {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .step-name {
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .step-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step-duration {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .tx-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--color-primary);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-primary-muted);
    text-decoration: none;
    flex-shrink: 0;
  }

  .tx-link:hover {
    background: var(--color-primary);
    color: white;
    text-decoration: none;
  }

  .step-chevron {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  /* Step details */
  .step-details {
    padding: 0 var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    margin: 0 var(--space-2);
  }

  .detail-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .detail-block-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }

  .detail-error {
    background: var(--color-danger-muted);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
  }

  .detail-pre {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-danger);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-tx {
    font-size: var(--text-xs);
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-primary);
    word-break: break-all;
  }

  .result-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-2);
  }

  .result-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: var(--color-bg);
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
  }

  .result-key {
    color: var(--color-text-secondary);
  }

  .result-value {
    text-align: right;
    word-break: break-all;
    max-width: 200px;
  }

  .result-pass {
    color: var(--color-success);
    font-weight: 600;
  }

  .result-fail {
    color: var(--color-danger);
    font-weight: 600;
  }
</style>
