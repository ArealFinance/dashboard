<script lang="ts">
  import { onMount } from 'svelte';
  import { Upload, Copy, AlertTriangle, Check, Clock, RefreshCw } from 'lucide-svelte';
  import { protocolRegistry, PROTOCOL_PROGRAMS } from '$lib/stores/protocol';
  import { connection, rpcEndpoint } from '$lib/stores/network';
  import { formatAddress } from '$lib/utils/format';

  interface ProgramOnChain {
    programId: string;
    exists: boolean;
    executable: boolean;
    owner: string;
    dataSize: number;
    lamports: number;
    slot?: number;
  }

  let onChainInfo: Record<string, ProgramOnChain> = {};
  let loading = false;

  async function fetchOnChainInfo() {
    loading = true;
    const conn = $connection;

    for (const prog of PROTOCOL_PROGRAMS) {
      if (!prog.programId) continue;

      try {
        const { PublicKey } = await import('@solana/web3.js');
        const pk = new PublicKey(prog.programId);
        const info = await conn.getAccountInfo(pk);

        if (info) {
          onChainInfo[prog.id] = {
            programId: prog.programId,
            exists: true,
            executable: info.executable,
            owner: info.owner.toBase58(),
            dataSize: info.data.length,
            lamports: info.lamports
          };
        } else {
          onChainInfo[prog.id] = {
            programId: prog.programId,
            exists: false,
            executable: false,
            owner: '',
            dataSize: 0,
            lamports: 0
          };
        }
      } catch {
        onChainInfo[prog.id] = {
          programId: prog.programId!,
          exists: false,
          executable: false,
          owner: '',
          dataSize: 0,
          lamports: 0
        };
      }
    }

    onChainInfo = { ...onChainInfo };
    loading = false;
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function getDeployCommand(prog: typeof PROTOCOL_PROGRAMS[0]): string {
    return `solana program deploy target/deploy/${prog.id.replace('-', '_')}.so --program-id ${prog.programId ?? '<KEYPAIR>'}`;
  }

  function getResetCommand(): string {
    return `solana-test-validator --reset --ledger /tmp/test-ledger`;
  }

  onMount(() => {
    fetchOnChainInfo();
  });
</script>

<div class="deploy-page">
  <div class="dev-warning">
    <AlertTriangle size={18} />
    <span>DEV ONLY — NOT FOR PRODUCTION — Never use with real funds</span>
  </div>

  <div class="page-header">
    <Upload size={24} />
    <h1>Program Deployment</h1>
    <button class="btn btn-secondary" on:click={fetchOnChainInfo} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'spin' : ''} />
      Refresh
    </button>
  </div>

  <!-- Reset Validator -->
  <section class="card">
    <h2 class="card-title">Reset Validator</h2>
    <p class="card-desc">Reset the test validator to a clean state. Run this on the VPS via SSH.</p>
    <div class="cmd-block">
      <code>{getResetCommand()}</code>
      <button class="btn-icon" title="Copy" on:click={() => copyToClipboard(getResetCommand())}>
        <Copy size={14} />
      </button>
    </div>
  </section>

  <!-- Programs -->
  <section class="card">
    <h2 class="card-title">Protocol Programs</h2>
    <div class="programs-list">
      {#each PROTOCOL_PROGRAMS as prog}
        {@const chain = onChainInfo[prog.id]}
        <div class="program-card" class:deployed={chain?.exists && chain?.executable}>
          <div class="program-header">
            <div class="program-meta">
              <span class="program-name">{prog.name}</span>
              <span class="program-layer mono">Layer {prog.layer}</span>
            </div>
            <div class="program-status" class:status-ok={chain?.exists && chain?.executable} class:status-pending={!chain?.exists}>
              {#if chain?.exists && chain?.executable}
                <Check size={12} /> Deployed
              {:else}
                <Clock size={12} /> Not deployed
              {/if}
            </div>
          </div>

          {#if prog.programId}
            <div class="program-detail">
              <span class="detail-label">Program ID</span>
              <div class="detail-row">
                <code class="mono">{prog.programId}</code>
                <button class="btn-icon-sm" on:click={() => copyToClipboard(prog.programId ?? '')}>
                  <Copy size={12} />
                </button>
              </div>
            </div>
          {/if}

          {#if chain?.exists}
            <div class="program-details-grid">
              <div class="detail-item">
                <span class="detail-label">Owner</span>
                <span class="detail-value mono">{formatAddress(chain.owner, 6)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Data Size</span>
                <span class="detail-value mono">{(chain.dataSize / 1024).toFixed(1)} KB</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Balance</span>
                <span class="detail-value mono">{(chain.lamports / 1e9).toFixed(4)} SOL</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Executable</span>
                <span class="detail-value" class:status-ok={chain.executable}>{chain.executable ? 'Yes' : 'No'}</span>
              </div>
            </div>
          {/if}

          <div class="deploy-cmd">
            <span class="detail-label">Deploy Command</span>
            <div class="cmd-block">
              <code>{getDeployCommand(prog)}</code>
              <button class="btn-icon-sm" on:click={() => copyToClipboard(getDeployCommand(prog))}>
                <Copy size={12} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .deploy-page {
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
    flex: 1;
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

  .card-desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .cmd-block {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    overflow-x: auto;
  }

  .cmd-block code {
    flex: 1;
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .programs-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .program-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: border-color var(--transition-fast);
  }

  .program-card.deployed {
    border-color: var(--color-success);
  }

  .program-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .program-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .program-name {
    font-weight: 600;
    font-size: var(--text-base);
  }

  .program-layer {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .program-status {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-surface-hover);
    color: var(--color-text-muted);
  }

  .program-status.status-ok {
    background: var(--color-success-muted);
    color: var(--color-success);
  }

  .program-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .detail-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .program-details-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--space-3);
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-value {
    font-size: var(--text-sm);
  }

  .deploy-cmd {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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
    color: var(--color-text-muted);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
    flex-shrink: 0;
  }

  .btn-icon:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .btn-icon-sm {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    color: var(--color-text-muted);
    border-radius: var(--radius-xs);
    transition: all var(--transition-fast);
    flex-shrink: 0;
  }

  .btn-icon-sm:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .status-ok {
    color: var(--color-success);
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
