<script lang="ts">
  import type { NexusLpPositionEntry } from '$lib/stores/layer9';
  import { formatAddress, explorerUrl } from '$lib/utils/format';
  import { network } from '$lib/stores/network';
  import { computeClaimable } from '$lib/api/layer9';

  export let positions: NexusLpPositionEntry[] = [];
  export let loading = false;

  $: cluster = $network;

  function formatU128(v: bigint): string {
    return v.toString();
  }

  // Render `—` (em-dash) instead of `0` when the pool's
  // `cumulative_fees_per_share_*` accumulator hasn't been surfaced by the
  // dexStore yet (Substep 10 follow-up M-2). A literal `0` is silently
  // misleading — the position may have real pending fees that the UI
  // simply can't compute until the store wires the field through. The
  // dash communicates "data not yet available" without false precision.
  function pendingDisplay(
    cumulative: bigint,
    feesClaimedPerShare: bigint,
    shares: bigint,
    positionPresent: boolean,
  ): string {
    if (!positionPresent) return '—';
    if (cumulative === 0n) return '—';
    return computeClaimable(cumulative, feesClaimedPerShare, shares).toString();
  }
</script>

<div class="table-wrap">
  {#if loading && positions.length === 0}
    <div class="empty">Loading Nexus LP positions…</div>
  {:else if positions.length === 0}
    <div class="empty">No LP positions found for the Nexus PDA on this cluster.</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Pool</th>
          <th>Token A</th>
          <th>Token B</th>
          <th>Shares</th>
          <th>Pending A</th>
          <th>Pending B</th>
          <th>Position PDA</th>
        </tr>
      </thead>
      <tbody>
        {#each positions as entry (entry.lpPda)}
          <tr>
            <td class="mono">
              <a href={explorerUrl(entry.poolPda, 'address', cluster)} target="_blank" rel="noreferrer noopener">
                {formatAddress(entry.poolPda, 4)}
              </a>
            </td>
            <td class="mono">{formatAddress(entry.tokenAMint, 4)}</td>
            <td class="mono">{formatAddress(entry.tokenBMint, 4)}</td>
            <td class="mono">
              {entry.position ? formatU128(entry.position.shares) : '—'}
            </td>
            <td class="mono">
              {pendingDisplay(
                entry.cumulativeA,
                entry.position?.feesClaimedPerShareA ?? 0n,
                entry.position?.shares ?? 0n,
                !!entry.position,
              )}
            </td>
            <td class="mono">
              {pendingDisplay(
                entry.cumulativeB,
                entry.position?.feesClaimedPerShareB ?? 0n,
                entry.position?.shares ?? 0n,
                !!entry.position,
              )}
            </td>
            <td class="mono">
              <a href={explorerUrl(entry.lpPda, 'address', cluster)} target="_blank" rel="noreferrer noopener">
                {formatAddress(entry.lpPda, 4)}
              </a>
              {#if !entry.position}
                <span class="muted"> · uninit</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .table-wrap {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  thead th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--color-border);
  }
  tbody td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--color-bg); }
  a {
    color: var(--color-text);
    text-decoration: none;
  }
  a:hover { color: var(--color-primary); }
  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); }
  .empty {
    padding: var(--space-4);
    text-align: center;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }
</style>
