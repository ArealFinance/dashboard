<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import type { Layer8Event, Layer8EventKind } from '$lib/api/layer8';
  import { formatAddress, formatAmount, explorerUrl, formatTimestamp } from '$lib/utils/format';
  import { network } from '$lib/stores/network';

  export let events: Layer8Event[] = [];
  export let limit: number | null = 20;
  export let emptyMessage = 'No events captured yet.';
  export let title = 'Recent events';
  export let showHeader = true;

  // RWT decimals (6) — matches contract.
  const RWT_DECIMALS = 6;
  const USDC_DECIMALS = 6;

  $: visible = limit ? events.slice(0, limit) : events;
  $: clusterTag = $network;

  function kindClass(kind: Layer8EventKind): string {
    return `kind-${kind.toLowerCase()}`;
  }

  function eventSummary(ev: Layer8Event): string {
    switch (ev.kind) {
      case 'StreamConverted':
        return `+${formatAmount(ev.amount, RWT_DECIMALS)} RWT funded (USDC in ${formatAmount(ev.usdcIn, USDC_DECIMALS)})`;
      case 'YieldDistributed':
        return `${formatAmount(ev.totalYield, RWT_DECIMALS)} RWT split 70/15/15`;
      case 'LiquidityHoldingFunded':
        return `+${formatAmount(ev.amount, RWT_DECIMALS)} RWT into liquidity holding`;
      case 'CompoundYieldExecuted':
        return `+${formatAmount(ev.rwtClaimed, RWT_DECIMALS)} RWT compounded into pool`;
      case 'TreasuryYieldClaimed':
        return `+${formatAmount(ev.amount, RWT_DECIMALS)} RWT to OT treasury`;
      case 'LiquidityHoldingInitialized':
        return `Liquidity-holding singleton initialized`;
      case 'DistributorFunded':
        return `+${formatAmount(ev.amount, RWT_DECIMALS)} RWT funded (Layer 7)`;
    }
  }

  function eventOtMint(ev: Layer8Event): string | null {
    if ('otMint' in ev && typeof ev.otMint === 'string') return ev.otMint;
    return null;
  }
</script>

<section class="event-feed">
  {#if showHeader}
    <header class="feed-head">
      <h3>{title}</h3>
      <span class="count">{events.length}</span>
    </header>
  {/if}

  {#if visible.length === 0}
    <div class="empty">{emptyMessage}</div>
  {:else}
    <ul class="event-list">
      {#each visible as ev (ev.signature + '-' + ev.kind)}
        <li class="event-row">
          <div class="kind-cell">
            <span class={`kind-tag ${kindClass(ev.kind)}`}>{ev.kind}</span>
          </div>
          <div class="content-cell">
            <div class="summary">{eventSummary(ev)}</div>
            <div class="meta">
              {#if eventOtMint(ev)}
                <span class="meta-item mono" title={eventOtMint(ev) || ''}>OT {formatAddress(eventOtMint(ev) || '', 4)}</span>
              {/if}
              <span class="meta-item">slot {ev.slot}</span>
              {#if ev.blockTime}
                <span class="meta-item">{formatTimestamp(BigInt(ev.blockTime))}</span>
              {/if}
            </div>
          </div>
          <div class="link-cell">
            <a
              href={explorerUrl(ev.signature, 'tx', clusterTag)}
              target="_blank"
              rel="noreferrer noopener"
              class="external-link"
              title="View transaction in explorer"
            >
              <ExternalLink size={14} />
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .event-feed {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .feed-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }
  .feed-head h3 {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin: 0;
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-primary-muted);
    color: var(--color-primary);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
  }

  .empty {
    padding: var(--space-6) var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .event-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 480px;
  }

  .event-row {
    display: grid;
    grid-template-columns: minmax(140px, auto) 1fr auto;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    align-items: start;
  }
  .event-row:last-child {
    border-bottom: 0;
  }

  .kind-cell {
    display: flex;
    align-items: flex-start;
    padding-top: 2px;
  }

  .kind-tag {
    display: inline-block;
    font-size: var(--text-xs);
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    font-family: var(--font-mono);
    background: var(--color-surface-active);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
  }

  /* Per-kind colors as CSS variables (Layer 8 palette).
     Defined here so consumers don't need to import a separate file. */
  .kind-streamconverted {
    background: var(--kind-stream-converted, rgba(139, 92, 246, 0.15));
    color: var(--kind-stream-converted-fg, #C4B5FD);
    border-color: var(--kind-stream-converted-fg, rgba(139, 92, 246, 0.4));
  }
  .kind-yielddistributed {
    background: var(--kind-yield-distributed, rgba(16, 185, 129, 0.15));
    color: var(--kind-yield-distributed-fg, #6EE7B7);
    border-color: var(--kind-yield-distributed-fg, rgba(16, 185, 129, 0.4));
  }
  .kind-liquidityholdingfunded {
    background: var(--kind-liquidity-funded, rgba(59, 130, 246, 0.15));
    color: var(--kind-liquidity-funded-fg, #93C5FD);
    border-color: var(--kind-liquidity-funded-fg, rgba(59, 130, 246, 0.4));
  }
  .kind-compoundyieldexecuted {
    background: var(--kind-compound-yield, rgba(20, 184, 166, 0.15));
    color: var(--kind-compound-yield-fg, #5EEAD4);
    border-color: var(--kind-compound-yield-fg, rgba(20, 184, 166, 0.4));
  }
  .kind-treasuryyieldclaimed {
    background: var(--kind-treasury-yield, rgba(245, 158, 11, 0.15));
    color: var(--kind-treasury-yield-fg, #FCD34D);
    border-color: var(--kind-treasury-yield-fg, rgba(245, 158, 11, 0.4));
  }
  .kind-liquidityholdinginitialized {
    background: var(--kind-liquidity-init, rgba(99, 102, 241, 0.15));
    color: var(--kind-liquidity-init-fg, #A5B4FC);
    border-color: var(--kind-liquidity-init-fg, rgba(99, 102, 241, 0.4));
  }
  .kind-distributorfunded {
    background: var(--kind-distributor-funded, rgba(236, 72, 153, 0.15));
    color: var(--kind-distributor-funded-fg, #F9A8D4);
    border-color: var(--kind-distributor-funded-fg, rgba(236, 72, 153, 0.4));
  }

  .summary {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.4;
    word-break: break-word;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .meta-item.mono {
    font-family: var(--font-mono);
  }

  .link-cell {
    display: flex;
    align-items: center;
  }
  .external-link {
    color: var(--color-text-muted);
    display: inline-flex;
    align-items: center;
    padding: 4px;
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .external-link:hover {
    color: var(--color-primary);
    background: var(--color-surface-hover);
    text-decoration: none;
  }
</style>
