<script lang="ts">
  import DepositPanel from '$lib/components/layer9/DepositPanel.svelte';
  import ClaimLpFeesPanel from '$lib/components/layer9/ClaimLpFeesPanel.svelte';
  import { rwtStore } from '$lib/stores/rwt';
  import { onMount } from 'svelte';

  // The deposit panel needs the RWT mint when the user picks RWT —
  // ensure the RWT store is hydrated.
  onMount(() => {
    void rwtStore.refresh();
  });
</script>

<div class="page-header">
  <h1>Public — Deposit &amp; Claim Fees</h1>
  <p class="page-description">
    Permissionless flows: any wallet can deposit USDC or RWT into the Nexus
    pool of liquidity (lifting the principal floor) and any LpPosition owner
    can call <code>claim_lp_fees</code> to realise accrued fees on their
    position.
  </p>
</div>

<section class="section">
  <DepositPanel />
</section>

<section class="section">
  <ClaimLpFeesPanel />
</section>

<style>
  .page-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .page-header h1 { font-size: var(--text-2xl); font-weight: 700; margin: 0; }
  .page-description {
    color: var(--color-text-secondary);
    margin: 0;
    font-size: var(--text-sm);
    max-width: 64ch;
  }
  code {
    background: var(--color-bg);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
  .section { margin-top: var(--space-4); }
</style>
