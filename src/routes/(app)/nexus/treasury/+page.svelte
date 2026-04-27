<script lang="ts">
  import { Lock } from 'lucide-svelte';
  import ProfitsClaimPanel from '$lib/components/layer9/ProfitsClaimPanel.svelte';
  import NexusStatePanel from '$lib/components/layer9/NexusStatePanel.svelte';
  import { wallet } from '$lib/stores/wallet';
  import { dexStore } from '$lib/stores/dex';
  import { nexusStore } from '$lib/stores/layer9';

  $: walletState = $wallet;
  $: dex = $dexStore;
  $: nexus = $nexusStore;

  $: isAuthority = !!(
    walletState.connected &&
    walletState.publicKey &&
    dex.config &&
    dex.config.authority === walletState.publicKey.toBase58()
  );
</script>

<div class="page-header">
  <h1>Treasury — Withdraw &amp; Claim</h1>
  <p class="page-description">
    Authority-gated profit-extraction operations: <code>nexus_withdraw_profits</code>
    sweeps the above-floor balance to a Treasury ATA;
    <code>nexus_claim_rewards</code> realises LP fees on a Nexus position.
  </p>
  {#if !isAuthority}
    <div class="advisory">
      <Lock size={14} />
      Connected wallet does not match <code>dex_config.authority</code>. Submissions
      will revert unless you connect the Authority wallet.
    </div>
  {/if}
</div>

<section class="section">
  <NexusStatePanel state={nexus.state} pda={nexus.pda?.toBase58() ?? null} loading={nexus.loading} />
</section>

<section class="section">
  <ProfitsClaimPanel />
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
  .advisory {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: var(--color-warning);
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
