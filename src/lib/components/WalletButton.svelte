<script lang="ts">
  import { onMount } from 'svelte';
  import { Wallet, LogOut, ChevronDown } from 'lucide-svelte';
  import { wallet, connected, publicKey } from '$lib/stores/wallet';
  import type { WalletName } from '$lib/stores/wallet';
  import { formatAddress } from '$lib/utils/format';

  let availableWallets: WalletName[] = [];
  let showDropdown = false;
  let connectError = '';
  let errorTimeout: ReturnType<typeof setTimeout> | null = null;

  function setErrorWithAutoClear(msg: string, durationMs = 6000) {
    connectError = msg;
    if (errorTimeout) clearTimeout(errorTimeout);
    errorTimeout = setTimeout(() => {
      connectError = '';
      errorTimeout = null;
    }, durationMs);
  }

  onMount(() => {
    availableWallets = wallet.getAvailableWallets();
    return () => {
      if (errorTimeout) clearTimeout(errorTimeout);
    };
  });

  async function handleConnect(name: WalletName) {
    connectError = '';
    showDropdown = false;
    try {
      await wallet.connect(name);
    } catch (err: any) {
      // L-11: auto-clear toast so it doesn't linger after user retries/dismisses
      setErrorWithAutoClear(err.message || 'Failed to connect');
    }
  }

  async function handleDisconnect() {
    showDropdown = false;
    await wallet.disconnect();
  }

  function toggleDropdown() {
    showDropdown = !showDropdown;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.wallet-button-wrapper')) {
      showDropdown = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="wallet-button-wrapper">
  {#if $connected && $publicKey}
    <button class="wallet-btn connected" on:click={toggleDropdown}>
      <Wallet size={16} />
      <span class="address mono">{formatAddress($publicKey.toBase58())}</span>
      <ChevronDown size={14} />
    </button>

    {#if showDropdown}
      <div class="dropdown">
        <div class="dropdown-address mono">{$publicKey.toBase58()}</div>
        <button class="dropdown-item disconnect" on:click={handleDisconnect}>
          <LogOut size={14} />
          <span>Disconnect</span>
        </button>
      </div>
    {/if}
  {:else}
    <button class="wallet-btn" on:click={toggleDropdown}>
      <Wallet size={16} />
      <span>Connect Wallet</span>
      <ChevronDown size={14} />
    </button>

    {#if showDropdown}
      <div class="dropdown">
        {#if availableWallets.length === 0}
          <div class="dropdown-empty">
            No wallets detected. Install Phantom or Solflare.
          </div>
        {:else}
          {#each availableWallets as w}
            <button class="dropdown-item" on:click={() => handleConnect(w)}>
              <span class="wallet-name">{w.charAt(0).toUpperCase() + w.slice(1)}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  {/if}

  {#if connectError}
    <div class="error-toast">{connectError}</div>
  {/if}
</div>

<style>
  .wallet-button-wrapper {
    position: relative;
  }

  .wallet-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: all var(--transition-fast);
    font-size: var(--text-sm);
  }

  .wallet-btn:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-primary);
  }

  .wallet-btn.connected {
    border-color: var(--color-success);
    background: var(--color-success-muted);
  }

  .address {
    font-size: var(--text-sm);
  }

  .dropdown {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    min-width: 220px;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-elevated);
    z-index: 100;
    overflow: hidden;
  }

  .dropdown-address {
    padding: var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    border-bottom: 1px solid var(--color-border);
    word-break: break-all;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3);
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-sm);
    transition: background var(--transition-fast);
    text-align: left;
  }

  .dropdown-item:hover {
    background: var(--color-surface-hover);
  }

  .dropdown-item.disconnect {
    color: var(--color-danger);
  }

  .dropdown-empty {
    padding: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .wallet-name {
    text-transform: capitalize;
  }

  .error-toast {
    position: absolute;
    top: calc(100% + var(--space-2));
    right: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--color-danger-muted);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    white-space: nowrap;
    z-index: 101;
  }
</style>
