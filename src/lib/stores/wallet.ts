import { writable, derived, get } from 'svelte/store';
import { PublicKey, Transaction } from '@solana/web3.js';
import { browser } from '$app/environment';

/**
 * Minimal wallet adapter — connects to Phantom or Solflare via window providers.
 * No external wallet-adapter packages needed.
 */

export interface WalletProvider {
  publicKey: PublicKey | null;
  isConnected: boolean;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
}

export type WalletName = 'phantom' | 'solflare';

interface WalletState {
  connected: boolean;
  publicKey: PublicKey | null;
  providerName: WalletName | null;
  provider: WalletProvider | null;
  connecting: boolean;
}

function detectProviders(): { name: WalletName; provider: WalletProvider }[] {
  if (!browser) return [];
  const results: { name: WalletName; provider: WalletProvider }[] = [];

  const win = window as any;
  if (win.phantom?.solana?.isPhantom) {
    results.push({ name: 'phantom', provider: win.phantom.solana });
  }
  if (win.solflare?.isSolflare) {
    results.push({ name: 'solflare', provider: win.solflare });
  }

  return results;
}

function createWalletStore() {
  const initial: WalletState = {
    connected: false,
    publicKey: null,
    providerName: null,
    provider: null,
    connecting: false
  };

  const { subscribe, set, update } = writable<WalletState>(initial);

  let disconnectHandler: (() => void) | null = null;

  return {
    subscribe,

    getAvailableWallets(): WalletName[] {
      return detectProviders().map(p => p.name);
    },

    async connect(name: WalletName) {
      const providers = detectProviders();
      const found = providers.find(p => p.name === name);
      if (!found) {
        throw new Error(`${name} wallet not found. Please install the extension.`);
      }

      update(s => ({ ...s, connecting: true }));

      try {
        const resp = await found.provider.connect();

        // Listen for disconnect
        disconnectHandler = () => {
          set(initial);
        };
        found.provider.on('disconnect', disconnectHandler);

        set({
          connected: true,
          publicKey: resp.publicKey,
          providerName: name,
          provider: found.provider,
          connecting: false
        });
      } catch (err) {
        update(s => ({ ...s, connecting: false }));
        throw err;
      }
    },

    async disconnect() {
      const state = get({ subscribe });
      if (state.provider) {
        if (disconnectHandler) {
          state.provider.off('disconnect', disconnectHandler);
          disconnectHandler = null;
        }
        try {
          await state.provider.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
      set(initial);
    },

    async signTransaction(tx: Transaction): Promise<Transaction> {
      const state = get({ subscribe });
      if (!state.provider || !state.connected) {
        throw new Error('Wallet not connected');
      }
      return state.provider.signTransaction(tx);
    }
  };
}

export const wallet = createWalletStore();

export const publicKey = derived(wallet, ($wallet) => $wallet.publicKey);
export const connected = derived(wallet, ($wallet) => $wallet.connected);
