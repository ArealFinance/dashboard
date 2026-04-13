<script lang="ts">
  import { getContext } from 'svelte';
  import { FileText, ExternalLink } from 'lucide-svelte';
  import { PROPOSAL_TYPES, PROPOSAL_STATUSES } from '$lib/stores/futarchy';
  import CopyAddress from '$lib/components/CopyAddress.svelte';
  import { bytesToBase58, formatTimestamp, isZeroAddress } from '$lib/utils/format';

  const store: any = getContext('futarchyStore');

  $: config = $store.config;
  $: proposals = $store.proposals;
  $: authority = config ? bytesToBase58(config.authority) : '';
  $: otMint = config ? bytesToBase58(config.ot_mint) : '';
  $: pendingAuth = config?.has_pending ? bytesToBase58(config.pending_authority) : null;

  // Sort: Active first, then by created_ts desc
  $: sortedProposals = [...proposals].sort((a: any, b: any) => {
    if (a.status === 0 && b.status !== 0) return -1;
    if (a.status !== 0 && b.status === 0) return 1;
    return Number(b.createdTs - a.createdTs);
  });
</script>

<div class="overview">
  <!-- Config card -->
  <div class="card">
    <div class="card-header"><h3>Configuration</h3></div>
    <div class="card-body">
      <div class="field-grid">
        <div class="field">
          <span class="field-label">OT Mint</span>
          <CopyAddress address={otMint} chars={8} />
        </div>
        <div class="field">
          <span class="field-label">Authority</span>
          <CopyAddress address={authority} chars={8} />
        </div>
        <div class="field">
          <span class="field-label">Status</span>
          <span class="badge" class:badge-success={config?.is_active} class:badge-danger={!config?.is_active}>
            {config?.is_active ? 'Active' : 'Paused'}
          </span>
        </div>
        <div class="field">
          <span class="field-label">Total Proposals</span>
          <span class="field-value">{config?.next_proposal_id?.toString() ?? '0'}</span>
        </div>
        {#if pendingAuth}
          <div class="field">
            <span class="field-label">Pending Authority</span>
            <CopyAddress address={pendingAuth} chars={8} />
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Proposals list -->
  <div class="card">
    <div class="card-header">
      <h3>Proposals</h3>
      <a href="/futarchy/{$store.configAddress.toBase58()}/proposals/create" class="btn btn-sm">
        + New Proposal
      </a>
    </div>
    <div class="card-body">
      {#if sortedProposals.length === 0}
        <div class="center-msg">No proposals yet.</div>
      {:else}
        <div class="proposal-list">
          {#each sortedProposals as p}
            {@const statusInfo = PROPOSAL_STATUSES[p.status] ?? { label: 'Unknown', color: 'var(--color-text-muted)' }}
            {@const typeLabel = PROPOSAL_TYPES[p.proposalType] ?? 'Unknown'}
            <a href="/futarchy/{$store.configAddress.toBase58()}/proposals/{p.proposalId.toString()}" class="proposal-row">
              <div class="proposal-id">#{p.proposalId.toString()}</div>
              <span class="badge-type">{typeLabel}</span>
              <span class="badge-status" style="--status-color: {statusInfo.color}">{statusInfo.label}</span>
              {#if p.proposalType !== 2}
                <span class="amount">{p.amount.toString()}</span>
              {/if}
              <span class="ts">{formatTimestamp(Number(p.createdTs))}</span>
              <ExternalLink size={12} />
            </a>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .overview { display: flex; flex-direction: column; gap: var(--space-4); }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .card-header { padding: var(--space-4); border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
  .card-header h3 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .card-body { padding: var(--space-4); }

  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field-label { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .field-value { font-family: var(--font-mono); font-size: var(--text-sm); }

  .badge { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: var(--text-xs); font-weight: 500; }
  .badge-success { background: rgba(16,185,129,0.15); color: var(--color-success); }
  .badge-danger { background: rgba(239,68,68,0.15); color: var(--color-danger); }

  .btn-sm { padding: var(--space-1) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-xs); background: var(--color-primary); color: white; text-decoration: none; font-weight: 500; }

  .center-msg { padding: var(--space-6); text-align: center; color: var(--color-text-muted); font-size: var(--text-sm); }

  .proposal-list { display: flex; flex-direction: column; }
  .proposal-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-bottom: 1px solid var(--color-border); text-decoration: none; color: var(--color-text); transition: background 0.1s; }
  .proposal-row:last-child { border-bottom: none; }
  .proposal-row:hover { background: var(--color-surface-hover); }
  .proposal-id { font-family: var(--font-mono); font-weight: 600; font-size: var(--text-sm); min-width: 40px; }
  .badge-type { padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--text-xs); background: rgba(139,92,246,0.15); color: var(--color-primary); font-weight: 500; }
  .badge-status { padding: 2px 8px; border-radius: 999px; font-size: var(--text-xs); background: color-mix(in srgb, var(--status-color) 15%, transparent); color: var(--status-color); font-weight: 500; }
  .amount { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-text-secondary); }
  .ts { font-size: var(--text-xs); color: var(--color-text-muted); margin-left: auto; }
</style>
