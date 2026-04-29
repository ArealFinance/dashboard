<script lang="ts">
  /*
   * DexPoolsOverview — list of pools currently surfaced via dexStore.
   *
   * Per pool:
   *   - reserves (raw, both sides)
   *   - price (B per A, derived in store)
   *   - LP shares total
   *   - feeBps + cumulative fees accumulated
   *   - active flag + pool type (StandardCurve vs Concentrated)
   *
   * 24h volume is intentionally NOT computed here yet — the dashboard would
   * need a backfill of swap events for that, which scales N pools × event
   * fan-out per tick. Surfaced as "—" with a follow-up note. Operators
   * inspect per-pool volume via `/dex/<pool>`.
   */
  import { dexStore } from '$lib/stores/dex';
  import { formatAmount, formatAddress } from '$lib/utils/format';

  $: dex = $dexStore;

  function poolTypeLabel(t: number): string {
    if (t === 0) return 'StandardCurve';
    if (t === 1) return 'Concentrated';
    return `type=${t}`;
  }
</script>

<div class="dex-pools-overview">
  {#if dex.pools.length === 0}
    <div class="empty">
      No pools loaded yet. Pools are fetched on-demand by per-pool pages —
      visit <a href="/dex">DEX</a> to populate this view.
    </div>
  {:else}
    <table class="pool-table">
      <thead>
        <tr>
          <th>Pool</th>
          <th>Type</th>
          <th>Token A / B</th>
          <th>Reserves A</th>
          <th>Reserves B</th>
          <th>Price</th>
          <th>LP shares</th>
          <th>Fee bps</th>
          <th>Fees acc.</th>
          <th>Active</th>
        </tr>
      </thead>
      <tbody>
        {#each dex.pools as p (p.pda)}
          <tr>
            <td class="mono">{formatAddress(p.pda, 4)}</td>
            <td>{poolTypeLabel(p.poolType)}</td>
            <td class="mono">{formatAddress(p.tokenAMint, 4)} / {formatAddress(p.tokenBMint, 4)}</td>
            <td class="mono">{formatAmount(p.reserveA, 6)}</td>
            <td class="mono">{formatAmount(p.reserveB, 6)}</td>
            <td class="mono">{p.price.toFixed(6)}</td>
            <td class="mono">{p.totalLpShares.toString()}</td>
            <td class="mono">{p.feeBps}</td>
            <td class="mono">{formatAmount(p.totalFeesAccumulated, 6)}</td>
            <td>
              <span class="dot" class:active={p.isActive} class:inactive={!p.isActive}></span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .dex-pools-overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-x: auto;
  }

  .empty {
    padding: var(--space-4);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    text-align: center;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .empty a {
    color: var(--color-primary);
  }

  .pool-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .pool-table th,
  .pool-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    white-space: nowrap;
  }

  .pool-table th {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dot.active {
    background: var(--color-success);
    box-shadow: 0 0 6px rgba(16, 185, 129, 0.45);
  }

  .dot.inactive {
    background: var(--color-text-muted);
  }
</style>
