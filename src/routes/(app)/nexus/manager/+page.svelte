<script lang="ts">
  import { Lock } from 'lucide-svelte';
  import ManagerOpsPanel from '$lib/components/layer9/ManagerOpsPanel.svelte';
  import NexusStatePanel from '$lib/components/layer9/NexusStatePanel.svelte';
  import { wallet } from '$lib/stores/wallet';
  import { nexusStore } from '$lib/stores/layer9';

  $: walletState = $wallet;
  $: nexus = $nexusStore;

  $: isManager = !!(
    walletState.connected &&
    walletState.publicKey &&
    nexus.state &&
    !nexus.state.killSwitchEngaged &&
    nexus.state.manager === walletState.publicKey.toBase58()
  );
</script>

<div class="page-header">
  <h1>Manager — Swap / Add / Remove</h1>
  <p class="page-description">
    Manager-gated operations on Nexus-owned LP positions. Each call routes
    through the canonical <code>swap_internal</code> /
    <code>add_liquidity_internal</code> / <code>remove_liquidity_internal</code>
    helper with the Nexus PDA filling the authority slot. D22 kill-switch is
    checked before signer match.
  </p>
  {#if !isManager}
    <div class="advisory">
      <Lock size={14} />
      Connected wallet does not match <code>liquidity_nexus.manager</code>. Submissions
      will revert with <code>InvalidNexusManager</code> or
      <code>NexusManagerDisabled</code>.
    </div>
  {/if}
</div>

<section class="section">
  <NexusStatePanel state={nexus.state} pda={nexus.pda?.toBase58() ?? null} loading={nexus.loading} />
</section>

<section class="section">
  <ManagerOpsPanel />
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
