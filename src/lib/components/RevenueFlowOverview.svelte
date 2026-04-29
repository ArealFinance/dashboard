<script lang="ts">
  /*
   * RevenueFlowOverview — per-OT revenue distribution status.
   *
   * Reads MerkleDistributor accounts (Layer 7) via ydStore — each row shows
   * one OT's last-distribution snapshot:
   *   - last fund timestamp
   *   - total_funded vs total_claimed (claim progress %)
   *   - locked_vested
   *   - epoch + active flag
   *
   * Per-OT accumulator USDC balance is NOT shown here (would require fanning
   * out N getAccountInfo calls per tick); operators drill into a specific OT's
   * `/ot/<mint>` page for the full revenue-flow tree.
   */
  import { ydStore } from '$lib/stores/yd';
  import { formatUsdc, formatAddress } from '$lib/utils/format';

  $: yd = $ydStore;

  function formatTs(secs: bigint): string {
    if (secs === 0n) return 'never';
    const ms = Number(secs) * 1000;
    const ageS = Math.floor((Date.now() - ms) / 1000);
    if (ageS < 60) return `${ageS}s ago`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
    if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
    return `${Math.floor(ageS / 86400)}d ago`;
  }

  function claimPct(funded: bigint, claimed: bigint): string {
    if (funded === 0n) return '0%';
    const pct = Number((claimed * 10000n) / funded) / 100;
    return `${pct.toFixed(2)}%`;
  }
</script>

<div class="revenue-flow-overview">
  {#if yd.loading && yd.distributors.length === 0}
    <div class="empty">Loading distributors…</div>
  {:else if yd.distributors.length === 0}
    <div class="empty">No MerkleDistributor accounts found yet.</div>
  {:else}
    <table class="dist-table">
      <thead>
        <tr>
          <th>OT mint</th>
          <th>Epoch</th>
          <th>Last fund</th>
          <th>Total funded</th>
          <th>Total claimed</th>
          <th>Locked vested</th>
          <th>Progress</th>
          <th>Active</th>
        </tr>
      </thead>
      <tbody>
        {#each yd.distributors as d (d.address)}
          <tr>
            <td class="mono">{formatAddress(d.otMint, 4)}</td>
            <td class="mono">{d.epoch}</td>
            <td class="mono">{formatTs(d.lastFundTs)}</td>
            <td class="mono">{formatUsdc(d.totalFunded)}</td>
            <td class="mono">{formatUsdc(d.totalClaimed)}</td>
            <td class="mono">{formatUsdc(d.lockedVested)}</td>
            <td class="mono">{claimPct(d.totalFunded, d.totalClaimed)}</td>
            <td>
              <span class="dot" class:active={d.isActive} class:inactive={!d.isActive}></span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .revenue-flow-overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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

  .dist-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .dist-table th,
  .dist-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .dist-table th {
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
