<script lang="ts">
  /*
   * NexusOverview — Layer 9 Liquidity Nexus rollup.
   *
   * Reads:
   *   - LiquidityNexus singleton (manager, kill-switch, principal floors).
   *   - LpPosition entries via nexusPositions store (per-pool shares).
   *   - nexusPendingFees derived (cumulative claimable across positions).
   *
   * "Profit" = current ATA balance - principal floor (computed on the
   * `/nexus/treasury` page via dedicated readers — surfaced as a link here
   * to avoid duplicating the ATA-balance fan-out per tick).
   */
  import { nexusStore, nexusPositions, nexusPendingFees } from '$lib/stores/layer9';
  import { formatAddress } from '$lib/utils/format';

  $: nx = $nexusStore;
  $: pos = $nexusPositions;
  $: pending = $nexusPendingFees;

  function killStateLabel(): { text: string; cls: string } {
    if (!nx.state) return { text: 'not initialized', cls: 'unknown' };
    if (nx.state.killSwitchEngaged) return { text: 'kill-switch', cls: 'red' };
    return { text: 'active', cls: 'ok' };
  }

  $: ks = killStateLabel();
</script>

<div class="nexus-overview">
  <div class="kpi-row">
    <div class="kpi">
      <span class="kpi-label">Manager state</span>
      <span class="kpi-value mono kpi-{ks.cls}">{ks.text}</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Principal floor (USDC)</span>
      <span class="kpi-value mono">
        {nx.state?.totalDepositedUsdc.toString() ?? '—'}
      </span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Principal floor (RWT)</span>
      <span class="kpi-value mono">
        {nx.state?.totalDepositedRwt.toString() ?? '—'}
      </span>
    </div>
    <div class="kpi">
      <span class="kpi-label">LP positions</span>
      <span class="kpi-value mono">{pos.positions.length}</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Pending LP fees A / B</span>
      <span class="kpi-value mono">
        {pending.totalA.toString()} / {pending.totalB.toString()}
      </span>
    </div>
  </div>

  {#if pos.positions.length > 0}
    <table class="pos-table">
      <thead>
        <tr>
          <th>Pool</th>
          <th>Token A / B</th>
          <th>Shares</th>
          <th>Last update</th>
        </tr>
      </thead>
      <tbody>
        {#each pos.positions as p (p.lpPda)}
          <tr>
            <td class="mono">{formatAddress(p.poolPda, 4)}</td>
            <td class="mono">{formatAddress(p.tokenAMint, 4)} / {formatAddress(p.tokenBMint, 4)}</td>
            <td class="mono">{p.position?.shares.toString() ?? '0'}</td>
            <td class="mono">{p.position ? new Date(Number(p.position.lastUpdateTs) * 1000).toLocaleString() : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <a class="drill-link" href="/nexus">View full Nexus state →</a>
</div>

<style>
  .nexus-overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-2);
  }

  .kpi {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .kpi-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .kpi-value {
    font-size: var(--text-md);
    font-weight: 600;
  }

  .kpi-ok {
    color: var(--color-success);
  }

  .kpi-red {
    color: var(--color-danger);
  }

  .kpi-unknown {
    color: var(--color-text-muted);
  }

  .pos-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .pos-table th,
  .pos-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .pos-table th {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .drill-link {
    align-self: flex-end;
    font-size: var(--text-sm);
    color: var(--color-primary);
    text-decoration: none;
  }

  .drill-link:hover {
    text-decoration: underline;
  }
</style>
