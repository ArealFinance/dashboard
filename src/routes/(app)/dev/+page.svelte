<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal, Plus, Trash2, Download, Upload, Zap, Copy, AlertTriangle } from 'lucide-svelte';
  import { devKeys, activeKeypairInfo } from '$lib/stores/devkeys';
  import { connection, network, rpcEndpoint } from '$lib/stores/network';
  import { formatAddress } from '$lib/utils/format';

  let newKeypairName = '';
  let importName = '';
  let fileInput: HTMLInputElement;
  let airdropAmount = 2;
  let airdropLoading = false;
  let airdropError = '';
  let airdropSuccess = '';
  let rpcHealth: { version: string; slot: number } | null = null;
  let healthError = '';

  // Sub-stores from devKeys
  const keypairsStore = devKeys.keypairs;
  const activeNameStore = devKeys.activeName;
  const balancesStore = devKeys.balances;

  $: keypairs = $keypairsStore;
  $: activeName = $activeNameStore;
  $: balances = $balancesStore;
  $: info = $activeKeypairInfo;

  function handleGenerate() {
    if (!newKeypairName.trim()) return;
    devKeys.generateKeypair(newKeypairName.trim());
    newKeypairName = '';
  }

  function handleRemove(name: string) {
    if (confirm(`Remove keypair "${name}"? This cannot be undone.`)) {
      devKeys.removeKeypair(name);
    }
  }

  function handleFileImport() {
    fileInput?.click();
  }

  async function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('Invalid keypair file — expected JSON array of 64 numbers');
      }
      const name = importName.trim() || file.name.replace('.json', '');
      devKeys.importKeypair(name, new Uint8Array(arr));
      importName = '';
    } catch (err: any) {
      alert(`Import failed: ${err.message}`);
    }
    input.value = '';
  }

  async function handleAirdrop() {
    airdropLoading = true;
    airdropError = '';
    airdropSuccess = '';
    try {
      const sig = await devKeys.requestAirdrop(airdropAmount);
      airdropSuccess = `Airdrop OK: ${sig.slice(0, 20)}...`;
      setTimeout(() => { airdropSuccess = ''; }, 5000);
    } catch (err: any) {
      airdropError = err.message || 'Airdrop failed';
    } finally {
      airdropLoading = false;
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  async function fetchHealth() {
    healthError = '';
    try {
      const conn = $connection;
      const version = await conn.getVersion();
      const slot = await conn.getSlot();
      rpcHealth = { version: version['solana-core'], slot };
    } catch (err: any) {
      healthError = err.message || 'RPC unreachable';
      rpcHealth = null;
    }
  }

  onMount(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  });
</script>

<div class="dev-hub">
  <div class="dev-warning">
    <AlertTriangle size={18} />
    <span>DEV ONLY — NOT FOR PRODUCTION — Never use with real funds</span>
  </div>

  <div class="page-header">
    <Terminal size={24} />
    <h1>Dev Hub</h1>
  </div>

  <!-- Connection Status -->
  <section class="card">
    <h2 class="card-title">Connection Status</h2>
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Network</span>
        <span class="info-value mono">{$network}</span>
      </div>
      <div class="info-item">
        <span class="info-label">RPC URL</span>
        <span class="info-value mono">{$rpcEndpoint}</span>
      </div>
      {#if rpcHealth}
        <div class="info-item">
          <span class="info-label">Version</span>
          <span class="info-value mono">{rpcHealth.version}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Slot</span>
          <span class="info-value mono">{rpcHealth.slot.toLocaleString()}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Status</span>
          <span class="info-value status-ok">Connected</span>
        </div>
      {:else if healthError}
        <div class="info-item">
          <span class="info-label">Status</span>
          <span class="info-value status-err">{healthError}</span>
        </div>
      {:else}
        <div class="info-item">
          <span class="info-label">Status</span>
          <span class="info-value secondary">Checking...</span>
        </div>
      {/if}
    </div>
  </section>

  <!-- Keypair Manager -->
  <section class="card">
    <h2 class="card-title">Keypair Manager</h2>

    <!-- Generate -->
    <div class="action-row">
      <input type="text" bind:value={newKeypairName} placeholder="Keypair name" class="input" />
      <button class="btn btn-primary" on:click={handleGenerate} disabled={!newKeypairName.trim()}>
        <Plus size={14} />
        Generate
      </button>
    </div>

    <!-- Import -->
    <div class="action-row">
      <input type="text" bind:value={importName} placeholder="Name (optional)" class="input" />
      <button class="btn btn-secondary" on:click={handleFileImport}>
        <Upload size={14} />
        Import JSON
      </button>
      <input type="file" accept=".json" bind:this={fileInput} on:change={handleFileSelected} style="display:none" />
    </div>

    <!-- List -->
    {#if keypairs.length === 0}
      <p class="empty-msg">No keypairs yet. Generate or import one to start.</p>
    {:else}
      <div class="keypair-list">
        {#each keypairs as kp}
          <div class="keypair-row" class:active={kp.name === activeName}>
            <button class="keypair-select" on:click={() => devKeys.setActive(kp.name)}>
              <div class="keypair-info">
                <span class="keypair-name">{kp.name}</span>
                <span class="keypair-address mono">{formatAddress(kp.publicKey, 8)}</span>
              </div>
              <span class="keypair-balance mono">{(balances[kp.publicKey] ?? 0).toFixed(4)} SOL</span>
            </button>
            <button class="btn-icon" title="Copy address" on:click={() => copyToClipboard(kp.publicKey)}>
              <Copy size={14} />
            </button>
            <button class="btn-icon btn-danger" title="Remove" on:click={() => handleRemove(kp.name)}>
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Airdrop -->
    {#if info}
      <div class="airdrop-section">
        <h3 class="sub-title">Airdrop to: {info.name}</h3>
        <div class="action-row">
          <input type="number" bind:value={airdropAmount} min="0.1" max="10" step="0.5" class="input input-sm" />
          <span class="secondary">SOL</span>
          <button class="btn btn-primary" on:click={handleAirdrop} disabled={airdropLoading}>
            <Zap size={14} />
            {airdropLoading ? 'Requesting...' : 'Airdrop'}
          </button>
        </div>
        {#if airdropSuccess}
          <p class="msg-success">{airdropSuccess}</p>
        {/if}
        {#if airdropError}
          <p class="msg-error">{airdropError}</p>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .dev-hub {
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

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .card-title {
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .sub-title {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-3);
  }

  .info-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .info-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .info-value {
    font-size: var(--text-sm);
  }

  .status-ok {
    color: var(--color-success);
    font-weight: 500;
  }

  .status-err {
    color: var(--color-danger);
    font-size: var(--text-xs);
  }

  .action-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .input {
    flex: 1;
    max-width: 280px;
  }

  .input-sm {
    max-width: 100px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-secondary {
    background: var(--color-surface-hover);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-active);
  }

  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    color: var(--color-text-secondary);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
  }

  .btn-icon:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .btn-icon.btn-danger:hover {
    background: var(--color-danger-muted);
    color: var(--color-danger);
  }

  .empty-msg {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    padding: var(--space-3) 0;
  }

  .keypair-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .keypair-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1);
    border-radius: var(--radius-md);
    transition: background var(--transition-fast);
  }

  .keypair-row.active {
    background: var(--color-primary-muted);
  }

  .keypair-select {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: transparent;
    color: var(--color-text);
    text-align: left;
    border-radius: var(--radius-sm);
    transition: background var(--transition-fast);
  }

  .keypair-select:hover {
    background: var(--color-surface-hover);
  }

  .keypair-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .keypair-name {
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .keypair-address {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .keypair-balance {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .airdrop-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-4);
  }

  .msg-success {
    font-size: var(--text-xs);
    color: var(--color-success);
    font-family: var(--font-mono);
  }

  .msg-error {
    font-size: var(--text-xs);
    color: var(--color-danger);
  }
</style>
