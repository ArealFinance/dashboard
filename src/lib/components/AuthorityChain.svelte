<script lang="ts">
  /*
   * AuthorityChain — visual tree of on-chain authority assignments.
   *
   *   Multisig ──▶ Futarchy ──▶ OT
   *            ├──▶ RWT
   *            ├──▶ DEX
   *            └──▶ YD
   *
   * Reads authority fields from each contract's existing typed store
   * (rwtStore, dexStore, ydStore, futarchyList, otList) — no hand-rolled
   * byte offsets.
   */
  import { ShieldCheck, AlertTriangle } from 'lucide-svelte';
  import { rwtStore } from '$lib/stores/rwt';
  import { dexStore } from '$lib/stores/dex';
  import { ydStore } from '$lib/stores/yd';
  import { futarchyList } from '$lib/stores/futarchy';
  import { formatAddress } from '$lib/utils/format';

  $: rwt = $rwtStore;
  $: dex = $dexStore;
  $: yd = $ydStore;
  $: futarchies = $futarchyList;

  interface AuthRow {
    contract: string;
    field: string;
    address: string | null;
    /** True iff the address is the unset/zero key (placeholder). */
    isZero: boolean;
  }

  function isZero(addr: string | null): boolean {
    if (!addr) return true;
    return addr === '11111111111111111111111111111111';
  }

  $: rows = ((): AuthRow[] => {
    const out: AuthRow[] = [];
    if (rwt.vault) {
      out.push({ contract: 'RWT Engine', field: 'authority', address: rwt.vault.authority, isZero: isZero(rwt.vault.authority) });
      out.push({ contract: 'RWT Engine', field: 'manager', address: rwt.vault.manager, isZero: isZero(rwt.vault.manager) });
      out.push({ contract: 'RWT Engine', field: 'pause_authority', address: rwt.vault.pauseAuthority, isZero: isZero(rwt.vault.pauseAuthority) });
    }
    if (dex.config) {
      out.push({ contract: 'Native DEX', field: 'authority', address: dex.config.authority, isZero: isZero(dex.config.authority) });
      out.push({ contract: 'Native DEX', field: 'pause_authority', address: dex.config.pauseAuthority, isZero: isZero(dex.config.pauseAuthority) });
      out.push({ contract: 'Native DEX', field: 'rebalancer', address: dex.config.rebalancer, isZero: isZero(dex.config.rebalancer) });
    }
    if (yd.config) {
      out.push({ contract: 'Yield Distribution', field: 'authority', address: yd.config.authority, isZero: isZero(yd.config.authority) });
      out.push({ contract: 'Yield Distribution', field: 'publish_authority', address: yd.config.publishAuthority, isZero: isZero(yd.config.publishAuthority) });
    }
    for (const fut of futarchies.items) {
      out.push({
        contract: `Futarchy(${formatAddress(fut.otMint, 4)})`,
        field: 'authority',
        address: fut.authority,
        isZero: isZero(fut.authority),
      });
    }
    return out;
  })();

  // Pending transfers
  $: pendingTransfers = ((): { contract: string; pending: string }[] => {
    const out: { contract: string; pending: string }[] = [];
    if (rwt.vault?.hasPending) out.push({ contract: 'RWT Engine', pending: rwt.vault.pendingAuthority });
    if (dex.config?.hasPending) out.push({ contract: 'Native DEX', pending: dex.config.pendingAuthority });
    if (yd.config?.hasPending) out.push({ contract: 'Yield Distribution', pending: yd.config.pendingAuthority });
    return out;
  })();
</script>

<div class="authority-chain">
  <div class="tree-diagram">
    <div class="tree-root">
      <ShieldCheck size={16} />
      <span>Multisig (root)</span>
    </div>
    <div class="tree-branches">
      <div class="branch">
        <span class="branch-edge">└─▶</span>
        <span class="branch-target">Futarchy</span>
        <div class="branch-sub">
          <span class="branch-edge sub">└─▶</span>
          <span>OT (per project)</span>
        </div>
      </div>
      <div class="branch">
        <span class="branch-edge">├─▶</span>
        <span class="branch-target">RWT Engine</span>
      </div>
      <div class="branch">
        <span class="branch-edge">├─▶</span>
        <span class="branch-target">Native DEX</span>
      </div>
      <div class="branch">
        <span class="branch-edge">└─▶</span>
        <span class="branch-target">Yield Distribution</span>
      </div>
    </div>
  </div>

  {#if pendingTransfers.length > 0}
    <div class="pending-row">
      <AlertTriangle size={12} />
      <span>{pendingTransfers.length} pending authority transfer{pendingTransfers.length === 1 ? '' : 's'}</span>
    </div>
  {/if}

  <table class="auth-table">
    <thead>
      <tr>
        <th>Contract</th>
        <th>Field</th>
        <th>Pubkey</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.contract + ':' + r.field)}
        <tr class:zero={r.isZero}>
          <td>{r.contract}</td>
          <td class="mono">{r.field}</td>
          <td class="mono pubkey">
            {#if r.address}
              {formatAddress(r.address, 6)}
            {:else}
              <span class="muted">unset</span>
            {/if}
            {#if r.isZero}
              <span class="zero-badge">zero</span>
            {/if}
          </td>
        </tr>
      {/each}
      {#if rows.length === 0}
        <tr><td colspan="3" class="empty">Authority data not yet loaded.</td></tr>
      {/if}
    </tbody>
  </table>
</div>

<style>
  .authority-chain {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .tree-diagram {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.7;
  }

  .tree-root {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-primary);
    font-weight: 600;
  }

  .tree-branches {
    margin-top: var(--space-1);
    margin-left: var(--space-2);
    display: flex;
    flex-direction: column;
  }

  .branch {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text);
  }

  .branch-edge {
    color: var(--color-text-muted);
    width: 36px;
  }

  .branch-edge.sub {
    width: 36px;
  }

  .branch-target {
    color: var(--color-text);
  }

  .branch-sub {
    margin-left: var(--space-5);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
  }

  .pending-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-warning);
    background: var(--color-warning-muted);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }

  .auth-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .auth-table th,
  .auth-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .auth-table th {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  tr.zero td {
    color: var(--color-text-muted);
  }

  .pubkey {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .zero-badge {
    font-size: var(--text-xs);
    color: var(--color-warning);
    background: var(--color-warning-muted);
    padding: 1px var(--space-1);
    border-radius: var(--radius-xs);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .empty {
    text-align: center;
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
