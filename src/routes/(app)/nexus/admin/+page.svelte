<script lang="ts">
  import { Lock } from 'lucide-svelte';
  import ManagerControlsPanel from '$lib/components/layer9/ManagerControlsPanel.svelte';
  import NexusStatePanel from '$lib/components/layer9/NexusStatePanel.svelte';
  import { wallet } from '$lib/stores/wallet';
  import { dexStore } from '$lib/stores/dex';
  import { nexusStore } from '$lib/stores/layer9';

  $: walletState = $wallet;
  $: dex = $dexStore;
  $: nexus = $nexusStore;

  // Advisory client-side gate — on-chain has_one is the source of truth.
  $: isAuthority = !!(
    walletState.connected &&
    walletState.publicKey &&
    dex.config &&
    dex.config.authority === walletState.publicKey.toBase58()
  );
</script>

<div class="page-header">
  <h1>Admin — Nexus Authority</h1>
  <p class="page-description">
    Authority-gated operations: <code>initialize_nexus</code> (one-shot)
    and <code>update_nexus_manager</code> (rotate / kill-switch). The on-chain
    handler enforces <code>has_one = authority</code>; the lock indicator
    below is advisory.
  </p>
  {#if !isAuthority}
    <div class="advisory">
      <Lock size={14} />
      Connected wallet does not match <code>dex_config.authority</code>. Submissions
      will revert on-chain unless you connect the Authority wallet.
    </div>
  {/if}
</div>

<section class="section">
  <NexusStatePanel state={nexus.state} pda={nexus.pda?.toBase58() ?? null} loading={nexus.loading} />
</section>

<section class="section">
  <ManagerControlsPanel />
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
  .section {
    margin-top: var(--space-4);
  }
</style>
