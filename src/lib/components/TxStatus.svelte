<script lang="ts">
  import { Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-svelte';
  import { network } from '$lib/stores/network';
  import { explorerUrl } from '$lib/utils/format';

  export let status: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  export let signature: string = '';
  export let error: string = '';

  $: explorerLink = signature ? explorerUrl(signature, 'tx', $network) : '';

  const STATUS_LABELS: Record<string, string> = {
    signing: 'Signing transaction...',
    sending: 'Sending transaction...',
    confirming: 'Confirming...',
    success: 'Transaction confirmed',
    error: 'Transaction failed'
  };
</script>

{#if status !== 'idle'}
  <div class="tx-status" class:signing={status === 'signing'} class:sending={status === 'sending'}
    class:confirming={status === 'confirming'} class:success={status === 'success'} class:error={status === 'error'}>
    <div class="status-row">
      {#if status === 'signing' || status === 'sending' || status === 'confirming'}
        <Loader2 size={16} class="spin" />
      {:else if status === 'success'}
        <CheckCircle2 size={16} />
      {:else if status === 'error'}
        <XCircle size={16} />
      {/if}
      <span class="status-label">{STATUS_LABELS[status] || ''}</span>
    </div>

    {#if status === 'error' && error}
      <div class="error-message">{error}</div>
    {/if}

    {#if signature && (status === 'success' || status === 'confirming')}
      <a href={explorerLink} target="_blank" rel="noopener noreferrer" class="explorer-link">
        <span class="mono">{signature.slice(0, 20)}...</span>
        <ExternalLink size={12} />
      </a>
    {/if}
  </div>
{/if}

<style>
  .tx-status {
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .signing, .sending, .confirming {
    background: var(--color-info-muted);
    border-color: var(--color-info);
    color: var(--color-info);
  }

  .success {
    background: var(--color-success-muted);
    border-color: var(--color-success);
    color: var(--color-success);
  }

  .error {
    background: var(--color-danger-muted);
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .error-message {
    font-size: var(--text-xs);
    word-break: break-word;
  }

  .explorer-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: inherit;
    opacity: 0.8;
  }

  .explorer-link:hover {
    opacity: 1;
    text-decoration: none;
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
