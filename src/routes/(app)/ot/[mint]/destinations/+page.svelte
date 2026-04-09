<script lang="ts">
  import { getContext } from 'svelte';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { Plus, Trash2, Save, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-svelte';
  import { arlexClient, programId } from '$lib/stores/ot';
  import { wallet, connected, publicKey } from '$lib/stores/wallet';
  import { connection, network } from '$lib/stores/network';
  import { resolveAddress } from '$lib/utils/resolver';
  import TxStatus from '$lib/components/TxStatus.svelte';
  import { bytesToBase58, base58ToBytes, trimNullBytes, isValidAddress, stringToFixedBytes, formatAddress } from '$lib/utils/format';
  import { findOtGovernancePda, findRevenueConfigPda, findOtTreasuryPda, findAta, TOKEN_PROGRAM_ID, USDC_MINTS } from '$lib/utils/pda';
  import type { OtState } from '$lib/stores/ot';
  import type { Cluster } from '$lib/stores/network';
  import type { Writable } from 'svelte/store';

  const otStore = getContext<{ subscribe: Writable<OtState>['subscribe']; refresh: () => Promise<void> }>('otStore');

  $: mintAddress = $page.params.mint ?? '';
  $: otMint = mintAddress ? new PublicKey(mintAddress) : PublicKey.default;
  $: cluster = $network as Cluster;

  interface DestRow {
    address: string;
    bps: number;
    label: string;
  }

  let rows: DestRow[] = [];
  let showConfirm = false;
  let showQuickFill = false;
  let quickFillIndex = -1;
  let txStatus: 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error' = 'idle';
  let txSig = '';
  let txError = '';

  // Pre-fill from current config
  $: if ($otStore.revenueConfig && rows.length === 0) {
    const rcfg = $otStore.revenueConfig;
    const loaded: DestRow[] = [];
    for (let i = 0; i < rcfg.active_count; i++) {
      const dest = rcfg.destinations[i];
      loaded.push({
        address: bytesToBase58(dest.address),
        bps: dest.allocation_bps,
        label: trimNullBytes(dest.label)
      });
    }
    if (loaded.length > 0) {
      rows = loaded;
    }
  }

  $: isAuthority = $publicKey && $otStore.governance &&
    bytesToBase58($otStore.governance.authority) === $publicKey.toBase58();

  $: feeDestination = $otStore.revenueConfig
    ? bytesToBase58($otStore.revenueConfig.areal_fee_destination)
    : '';

  // Resolve each destination address for display
  $: resolvedAddresses = rows.map(row => {
    if (!row.address || !isValidAddress(row.address)) return null;
    return resolveAddress(row.address, cluster, {
      otState: $otStore,
      otProgramId: programId
    });
  });

  // Quick-fill known protocol addresses
  $: quickFillOptions = buildQuickFillOptions(cluster);

  function buildQuickFillOptions(cluster: Cluster): { label: string; address: string; suggestedBps: number; suggestedLabel: string }[] {
    const options: { label: string; address: string; suggestedBps: number; suggestedLabel: string }[] = [];

    // Treasury USDC ATA
    try {
      const [treasuryPda] = findOtTreasuryPda(otMint, programId);
      const usdcMint = USDC_MINTS[cluster];
      if (usdcMint) {
        const treasuryAta = findAta(treasuryPda, usdcMint);
        options.push({
          label: 'OT Treasury USDC ATA',
          address: treasuryAta.toBase58(),
          suggestedBps: 2000,
          suggestedLabel: 'Treasury'
        });
      }
    } catch { /* ignore */ }

    return options;
  }

  function applyQuickFill(index: number, option: { address: string; suggestedBps: number; suggestedLabel: string }) {
    rows[index].address = option.address;
    if (rows[index].bps === 0) rows[index].bps = option.suggestedBps;
    if (!rows[index].label) rows[index].label = option.suggestedLabel;
    rows = rows;
    showQuickFill = false;
    quickFillIndex = -1;
  }

  // Validation
  $: totalBps = rows.reduce((sum, r) => sum + (r.bps || 0), 0);
  $: remainingBps = 10000 - totalBps;
  $: bpsExact = totalBps === 10000;
  $: bpsOver = totalBps > 10000;

  $: validationErrors = (() => {
    const errors: string[] = [];
    const addresses = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isValidAddress(row.address)) {
        errors.push(`Row ${i + 1}: Invalid address`);
      } else {
        if (addresses.has(row.address)) {
          errors.push(`Row ${i + 1}: Duplicate address`);
        }
        addresses.add(row.address);

        if (feeDestination && row.address === feeDestination) {
          errors.push(`Row ${i + 1}: Cannot use fee destination address`);
        }
      }

      if (row.bps < 1 || row.bps > 10000) {
        errors.push(`Row ${i + 1}: BPS must be 1-10,000`);
      }
    }

    if (!bpsExact && rows.length > 0) {
      errors.push(`Total BPS must be exactly 10,000 (currently ${totalBps})`);
    }

    return errors;
  })();

  $: canSubmit = rows.length > 0 && rows.length <= 10 && bpsExact &&
    validationErrors.length === 0 && isAuthority && $connected;

  function addRow() {
    if (rows.length >= 10) return;
    rows = [...rows, { address: '', bps: 0, label: '' }];
  }

  function removeRow(index: number) {
    rows = rows.filter((_, i) => i !== index);
  }

  function handleBpsChange(index: number, value: string) {
    const num = parseInt(value, 10);
    rows[index].bps = isNaN(num) ? 0 : Math.max(0, Math.min(10000, num));
    rows = rows;
  }

  function openQuickFill(index: number) {
    quickFillIndex = index;
    showQuickFill = true;
  }

  async function handleSubmit() {
    if (!canSubmit || !$publicKey) return;

    showConfirm = false;
    txStatus = 'signing';
    txSig = '';
    txError = '';

    try {
      const client = get(arlexClient);
      const conn = get(connection);

      const [governancePda] = findOtGovernancePda(otMint, programId);
      const [revenueConfigPda] = findRevenueConfigPda(otMint, programId);

      const destinations = rows.map(row => ({
        address: Array.from(base58ToBytes(row.address)),
        allocation_bps: row.bps,
        label: Array.from(stringToFixedBytes(row.label, 32))
      }));

      const tx = client.buildTransaction('batch_update_destinations', {
        accounts: {
          authority: $publicKey,
          ot_mint: otMint,
          ot_governance: governancePda,
          revenue_config: revenueConfigPda
        },
        args: { destinations },
        computeUnits: 200_000
      });

      tx.feePayer = $publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signedTx = await wallet.signTransaction(tx);
      txStatus = 'sending';

      const sig = await conn.sendRawTransaction(signedTx.serialize());
      txSig = sig;
      txStatus = 'confirming';

      await conn.confirmTransaction(sig, 'confirmed');
      txStatus = 'success';
      setTimeout(() => otStore.refresh(), 1000);
    } catch (err: any) {
      txStatus = 'error';
      txError = err.message || 'Update failed';
    }
  }
</script>

<div class="dest-page">
  <section class="card">
    <div class="card-header">
      <h3>Revenue Destinations</h3>
      <button class="btn-sm" on:click={addRow} disabled={rows.length >= 10}>
        <Plus size={14} />
        Add Destination
      </button>
    </div>

    {#if rows.length === 0}
      <div class="empty">
        <p>No destinations configured. Add at least one destination.</p>
        <button class="btn-primary" on:click={addRow}>
          <Plus size={14} />
          Add First Destination
        </button>
      </div>
    {:else}
      <div class="dest-rows">
        <div class="dest-header-row">
          <span class="col-num">#</span>
          <span class="col-address">Address (USDC ATA)</span>
          <span class="col-resolved">Resolved</span>
          <span class="col-label">Label</span>
          <span class="col-bps">BPS</span>
          <span class="col-pct">%</span>
          <span class="col-action"></span>
        </div>

        {#each rows as row, i}
          <div class="dest-row">
            <span class="col-num muted">{i + 1}</span>
            <div class="col-address address-cell">
              <input class="mono" type="text" bind:value={row.address}
                placeholder="USDC token account address"
                class:invalid={row.address && !isValidAddress(row.address)} />
              {#if quickFillOptions.length > 0}
                <button class="quick-fill-btn" on:click={() => openQuickFill(i)} title="Quick-fill from known addresses">
                  +
                </button>
              {/if}
            </div>
            <span class="col-resolved">
              {#if resolvedAddresses[i]}
                {@const resolved = resolvedAddresses[i]}
                {#if resolved.type === 'unknown'}
                  <span class="resolved-unknown" title="Unknown address">
                    <AlertCircle size={12} />
                  </span>
                {:else}
                  <span class="resolved-known" title={resolved.label}>
                    <CheckCircle size={12} />
                    <span class="resolved-text">{resolved.label}</span>
                  </span>
                {/if}
              {/if}
            </span>
            <input class="col-label" type="text" bind:value={row.label}
              placeholder="Label" maxlength="32" />
            <input class="col-bps mono" type="number" value={row.bps}
              on:input={(e) => handleBpsChange(i, e.currentTarget.value)}
              min="1" max="10000" />
            <span class="col-pct mono">{(row.bps / 100).toFixed(2)}%</span>
            <button class="col-action btn-icon-sm danger" on:click={() => removeRow(i)} title="Remove">
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
      </div>

      <!-- BPS Total Bar -->
      <div class="bps-total" class:exact={bpsExact} class:over={bpsOver}>
        <div class="bps-bar">
          <div class="bps-fill" style="width: {Math.min(100, totalBps / 100)}%"></div>
        </div>
        <div class="bps-text">
          Total: <strong>{totalBps.toLocaleString()}</strong> / 10,000
          {#if !bpsExact}
            <span>({remainingBps > 0 ? `${remainingBps.toLocaleString()} remaining` : `${Math.abs(remainingBps).toLocaleString()} over`})</span>
          {/if}
        </div>
      </div>

      <!-- Validation Errors -->
      {#if validationErrors.length > 0}
        <div class="validation-errors">
          {#each validationErrors as err}
            <div class="val-error">
              <AlertTriangle size={12} />
              <span>{err}</span>
            </div>
          {/each}
        </div>
      {/if}

      <div class="form-actions">
        {#if !isAuthority}
          <span class="warning-text">Only the governance authority can update destinations.</span>
        {/if}
        <button class="btn-primary" disabled={!canSubmit ||
          txStatus === 'signing' || txStatus === 'sending' || txStatus === 'confirming'}
          on:click={() => { showConfirm = true; }}>
          <Save size={14} />
          Save Destinations
        </button>
      </div>

      <TxStatus status={txStatus} signature={txSig} error={txError} />
    {/if}
  </section>

  <!-- Quick Fill Modal -->
  {#if showQuickFill}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-overlay" on:click={() => { showQuickFill = false; }} role="presentation">
      <!-- svelte-ignore a11y_interactive_supports_focus a11y_click_events_have_key_events -->
      <div class="modal" on:click|stopPropagation role="dialog">
        <h3>Quick Fill - Known Addresses</h3>
        <p class="secondary">Select a known protocol address for destination #{quickFillIndex + 1}</p>

        <div class="quick-fill-list">
          {#each quickFillOptions as option}
            <button class="quick-fill-option" on:click={() => applyQuickFill(quickFillIndex, option)}>
              <div class="qf-info">
                <span class="qf-label">{option.label}</span>
                <span class="qf-address mono">{formatAddress(option.address, 6)}</span>
              </div>
              <div class="qf-meta">
                <span class="qf-bps">{option.suggestedBps} bps suggested</span>
              </div>
            </button>
          {/each}
          {#if quickFillOptions.length === 0}
            <p class="empty-text">No known protocol addresses available for this OT.</p>
          {/if}
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" on:click={() => { showQuickFill = false; }}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Confirm Dialog -->
  {#if showConfirm}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-overlay" on:click={() => { showConfirm = false; }} role="presentation">
      <!-- svelte-ignore a11y_interactive_supports_focus a11y_click_events_have_key_events -->
      <div class="modal" on:click|stopPropagation role="dialog">
        <h3>Confirm Destination Update</h3>
        <p class="secondary">This will replace all current destinations with the following configuration:</p>

        <div class="confirm-list">
          {#each rows as row, i}
            <div class="confirm-row">
              <span class="muted">{i + 1}.</span>
              <span class="mono">{row.address.slice(0, 8)}...{row.address.slice(-4)}</span>
              <span>{row.label || '-'}</span>
              <span class="mono">{row.bps} bps ({(row.bps / 100).toFixed(2)}%)</span>
              {#if resolvedAddresses[i] && resolvedAddresses[i].type !== 'unknown'}
                <span class="confirm-resolved">{resolvedAddresses[i].label}</span>
              {/if}
            </div>
          {/each}
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" on:click={() => { showConfirm = false; }}>Cancel</button>
          <button class="btn-primary" on:click={handleSubmit}>Confirm & Send</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dest-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .card-header h3 {
    font-size: var(--text-md);
  }

  .btn-sm {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    background: var(--color-surface-active);
    color: var(--color-text);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    transition: all var(--transition-fast);
  }

  .btn-sm:hover:not(:disabled) {
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-8);
    color: var(--color-text-muted);
  }

  .dest-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .dest-header-row, .dest-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dest-header-row {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 var(--space-1);
    margin-bottom: var(--space-1);
  }

  .dest-row input {
    font-size: var(--text-sm);
    padding: var(--space-1) var(--space-2);
  }

  .dest-row input.invalid {
    border-color: var(--color-danger);
  }

  .col-num { width: 24px; text-align: center; flex-shrink: 0; }
  .col-address { flex: 2.5; min-width: 0; }
  .col-resolved { width: 140px; flex-shrink: 0; overflow: hidden; }
  .col-label { flex: 1; min-width: 0; }
  .col-bps { width: 80px; flex-shrink: 0; text-align: right; }
  .col-pct { width: 60px; flex-shrink: 0; text-align: right; font-size: var(--text-sm); color: var(--color-text-secondary); }
  .col-action { width: 32px; flex-shrink: 0; }

  .address-cell {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }

  .address-cell input {
    flex: 1;
    min-width: 0;
  }

  .quick-fill-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-muted);
    color: var(--color-primary);
    border-radius: var(--radius-xs);
    font-size: var(--text-sm);
    font-weight: 700;
    flex-shrink: 0;
    transition: all var(--transition-fast);
  }

  .quick-fill-btn:hover {
    background: var(--color-primary);
    color: white;
  }

  /* Resolved address badges */
  .resolved-unknown {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-warning);
    font-size: var(--text-xs);
  }

  .resolved-known {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-success);
    font-size: var(--text-xs);
  }

  .resolved-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 110px;
  }

  .btn-icon-sm {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    transition: all var(--transition-fast);
  }

  .btn-icon-sm.danger:hover {
    background: var(--color-danger-muted);
    color: var(--color-danger);
  }

  .bps-total {
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-surface-active);
  }

  .bps-bar {
    height: 4px;
    background: var(--color-border);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: var(--space-2);
  }

  .bps-fill {
    height: 100%;
    border-radius: 2px;
    transition: width var(--transition-base);
  }

  .bps-total.exact .bps-fill {
    background: var(--color-success);
  }

  .bps-total:not(.exact):not(.over) .bps-fill {
    background: var(--color-warning);
  }

  .bps-total.over .bps-fill {
    background: var(--color-danger);
  }

  .bps-text {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .bps-total.exact .bps-text { color: var(--color-success); }
  .bps-total.over .bps-text { color: var(--color-danger); }

  .validation-errors {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .val-error {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-danger);
  }

  .form-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .warning-text {
    font-size: var(--text-xs);
    color: var(--color-warning);
    margin-right: auto;
  }

  .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-5);
    background: var(--color-primary);
    color: white;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: all var(--transition-fast);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-secondary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-5);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .btn-secondary:hover {
    background: var(--color-surface-hover);
  }

  .empty-text {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    padding: var(--space-4) 0;
    text-align: center;
  }

  /* Quick fill modal */
  .quick-fill-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .quick-fill-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    text-align: left;
    transition: all var(--transition-fast);
  }

  .quick-fill-option:hover {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
  }

  .qf-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .qf-label {
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .qf-address {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .qf-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }

  .qf-bps {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .confirm-resolved {
    font-size: var(--text-xs);
    color: var(--color-success);
    background: var(--color-success-muted);
    padding: 1px var(--space-1);
    border-radius: var(--radius-xs);
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }

  .modal {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    padding: var(--space-6);
    max-width: 560px;
    width: 90%;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    box-shadow: var(--shadow-elevated);
  }

  .confirm-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--color-surface);
    border-radius: var(--radius-md);
    max-height: 300px;
    overflow-y: auto;
  }

  .confirm-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
