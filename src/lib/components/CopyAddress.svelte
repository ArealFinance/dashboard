<script lang="ts">
  import { Copy, Check } from 'lucide-svelte';
  import { formatAddress } from '$lib/utils/format';

  export let address: string;
  export let chars: number = 4;
  export let full: boolean = false;

  let copied = false;

  async function handleCopy() {
    await navigator.clipboard.writeText(address);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }
</script>

<button class="copy-address" on:click={handleCopy} title="Copy full address">
  <span class="mono">{full ? address : formatAddress(address, chars)}</span>
  {#if copied}
    <Check size={12} />
  {:else}
    <Copy size={12} />
  {/if}
</button>

<style>
  .copy-address {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-1);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: inherit;
    border-radius: var(--radius-xs);
    transition: all var(--transition-fast);
  }

  .copy-address:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
</style>
