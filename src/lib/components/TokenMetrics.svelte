<script lang="ts">
  /*
   * TokenMetrics — ARL OT supply, RWT supply, RWT NAV, total invested capital.
   *
   * Reads typed state from `rwtStore` (Layer 3) + `otList` (Layer 1, all
   * deployed OT projects). NAV displayed as raw 6-decimal USDC; invested
   * capital uses the same scale.
   */
  import { rwtStore } from '$lib/stores/rwt';
  import { otList } from '$lib/stores/ot';
  import { formatAmount, formatUsdc } from '$lib/utils/format';

  $: rwt = $rwtStore;
  $: ots = $otList;

  const RWT_DECIMALS = 6;
  const USDC_DECIMALS = 6;

  $: navPerRwt = ((): string => {
    if (!rwt.vault) return '—';
    const supply = rwt.vault.totalRwtSupply;
    if (supply === 0n) return '—';
    // NAV per RWT = nav_book_value / total_rwt_supply (both 6-decimal scale).
    // Result is raw USDC per raw RWT — for display, present at higher
    // precision (12 dp scaled). We keep math BigInt to avoid float drift.
    const num = rwt.vault.navBookValue * 10n ** 12n;
    const ratio = num / supply;
    const whole = ratio / 10n ** 12n;
    const frac = ratio % 10n ** 12n;
    const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '').slice(0, 6);
    return fracStr.length > 0 ? `$${whole.toString()}.${fracStr}` : `$${whole.toString()}`;
  })();
</script>

<div class="token-metrics">
  <div class="metric-grid">
    <div class="metric">
      <span class="metric-label">RWT supply</span>
      {#if rwt.vault}
        <span class="metric-value mono">{formatAmount(rwt.vault.totalRwtSupply, RWT_DECIMALS)}</span>
      {:else}
        <span class="metric-value muted">—</span>
      {/if}
    </div>
    <div class="metric">
      <span class="metric-label">RWT NAV (book value)</span>
      {#if rwt.vault}
        <span class="metric-value mono">{formatUsdc(rwt.vault.navBookValue)}</span>
      {:else}
        <span class="metric-value muted">—</span>
      {/if}
    </div>
    <div class="metric">
      <span class="metric-label">NAV per RWT</span>
      <span class="metric-value mono">{navPerRwt}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Total invested capital</span>
      {#if rwt.vault}
        <span class="metric-value mono">{formatUsdc(rwt.vault.totalInvestedCapital)}</span>
      {:else}
        <span class="metric-value muted">—</span>
      {/if}
    </div>
    <div class="metric">
      <span class="metric-label">Mint paused</span>
      {#if rwt.vault}
        <span class="metric-value" class:warn={rwt.vault.mintPaused}>
          {rwt.vault.mintPaused ? 'YES' : 'no'}
        </span>
      {:else}
        <span class="metric-value muted">—</span>
      {/if}
    </div>
    <div class="metric">
      <span class="metric-label">OT projects</span>
      <span class="metric-value mono">{ots.items.length}</span>
    </div>
  </div>

  {#if ots.items.length > 0}
    <table class="ot-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Name</th>
          <th>Decimals</th>
          <th>Total minted</th>
        </tr>
      </thead>
      <tbody>
        {#each ots.items as ot (ot.mint)}
          <tr>
            <td class="mono">{ot.symbol || '—'}</td>
            <td>{ot.name || '—'}</td>
            <td class="mono">{ot.decimals}</td>
            <td class="mono">{formatAmount(ot.totalMinted, ot.decimals)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .token-metrics {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-2);
  }

  .metric {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .metric-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .metric-value {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--color-text);
  }

  .metric-value.warn {
    color: var(--color-warning);
  }

  .metric-value.muted {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .ot-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .ot-table th,
  .ot-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .ot-table th {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 500;
  }
</style>
