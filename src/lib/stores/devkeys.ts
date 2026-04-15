import { writable, derived, get } from 'svelte/store';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from './network';
import { browser } from '$app/environment';
import bs58 from 'bs58';

const STORAGE_KEY = 'areal_dev_keypairs';
const ACTIVE_KEY = 'areal_dev_active';

/**
 * Stored keypair (serializable to localStorage)
 */
export interface StoredKeypair {
  name: string;
  publicKey: string;
  secretKeyBase58: string;
}

export interface DevKeypairInfo {
  name: string;
  publicKey: string;
  balance: number; // SOL
}

function loadKeypairs(): StoredKeypair[] {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveKeypairs(keypairs: StoredKeypair[]) {
  if (!browser) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keypairs));
}

function loadActiveName(): string | null {
  if (!browser) return null;
  return localStorage.getItem(ACTIVE_KEY) || null;
}

function saveActiveName(name: string | null) {
  if (!browser) return;
  if (name) {
    localStorage.setItem(ACTIVE_KEY, name);
  } else {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

function createDevKeypairStore() {
  const keypairs = writable<StoredKeypair[]>(loadKeypairs());
  const activeName = writable<string | null>(null);
  const balances = writable<Record<string, number>>({});

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Initialize active keypair — prefer persisted active, fallback to first stored
  if (browser) {
    const stored = loadKeypairs();
    const persisted = loadActiveName();
    if (persisted && stored.some(k => k.name === persisted)) {
      activeName.set(persisted);
    } else if (stored.length > 0) {
      activeName.set(stored[0].name);
      saveActiveName(stored[0].name);
    }
  }

  function getKeypairObject(stored: StoredKeypair): Keypair {
    const secretKey = bs58.decode(stored.secretKeyBase58);
    return Keypair.fromSecretKey(secretKey);
  }

  async function pollBalances() {
    const conn = get(connection);
    const kps = get(keypairs);
    const newBalances: Record<string, number> = {};

    for (const kp of kps) {
      try {
        const pk = new PublicKey(kp.publicKey);
        const bal = await conn.getBalance(pk);
        newBalances[kp.publicKey] = bal / LAMPORTS_PER_SOL;
      } catch {
        newBalances[kp.publicKey] = 0;
      }
    }

    balances.set(newBalances);
  }

  function startPolling() {
    stopPolling();
    pollBalances();
    pollInterval = setInterval(pollBalances, 5000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // Auto-start polling when there are keypairs
  if (browser) {
    const stored = loadKeypairs();
    if (stored.length > 0) {
      startPolling();
    }
  }

  return {
    keypairs: { subscribe: keypairs.subscribe },
    activeName: { subscribe: activeName.subscribe },
    balances: { subscribe: balances.subscribe },

    generateKeypair(name: string) {
      const kp = Keypair.generate();
      const stored: StoredKeypair = {
        name,
        publicKey: kp.publicKey.toBase58(),
        secretKeyBase58: bs58.encode(kp.secretKey)
      };

      keypairs.update(arr => {
        // Prevent duplicate names — WARNING: this replaces the keypair!
        const existing = arr.find(k => k.name === name);
        if (existing) {
          console.warn(`[devkeys] Replacing existing keypair "${name}" (${existing.publicKey}) with new one (${stored.publicKey})`);
        }
        const filtered = arr.filter(k => k.name !== name);
        const next = [...filtered, stored];
        saveKeypairs(next);
        return next;
      });

      // Set as active if first keypair
      const current = get(activeName);
      if (!current) {
        activeName.set(name);
        saveActiveName(name);
      }

      startPolling();
      return stored;
    },

    importKeypair(name: string, secretKeyArray: Uint8Array) {
      const kp = Keypair.fromSecretKey(secretKeyArray);
      const stored: StoredKeypair = {
        name,
        publicKey: kp.publicKey.toBase58(),
        secretKeyBase58: bs58.encode(kp.secretKey)
      };

      keypairs.update(arr => {
        const filtered = arr.filter(k => k.name !== name);
        const next = [...filtered, stored];
        saveKeypairs(next);
        return next;
      });

      const current = get(activeName);
      if (!current) {
        activeName.set(name);
        saveActiveName(name);
      }

      startPolling();
      return stored;
    },

    removeKeypair(name: string) {
      keypairs.update(arr => {
        const next = arr.filter(k => k.name !== name);
        saveKeypairs(next);
        if (next.length === 0) stopPolling();
        return next;
      });

      if (get(activeName) === name) {
        const remaining = get(keypairs);
        const newActive = remaining.length > 0 ? remaining[0].name : null;
        activeName.set(newActive);
        saveActiveName(newActive);
      }
    },

    setActive(name: string) {
      activeName.set(name);
      saveActiveName(name);
    },

    getKeypair(name: string): Keypair | null {
      const kps = get(keypairs);
      const found = kps.find(k => k.name === name);
      if (!found) return null;
      return getKeypairObject(found);
    },

    getActiveKeypair(): Keypair | null {
      const name = get(activeName);
      if (!name) return null;
      const kps = get(keypairs);
      const found = kps.find(k => k.name === name);
      if (!found) return null;
      return getKeypairObject(found);
    },

    async requestAirdrop(amount: number = 2): Promise<string> {
      const name = get(activeName);
      if (!name) throw new Error('No active keypair');
      const kps = get(keypairs);
      const found = kps.find(k => k.name === name);
      if (!found) throw new Error('Keypair not found');

      const conn = get(connection);
      const pk = new PublicKey(found.publicKey);
      const sig = await conn.requestAirdrop(pk, amount * LAMPORTS_PER_SOL);
      // Poll for confirmation (no WebSocket)
      for (let i = 0; i < 30; i++) {
        const { value } = await conn.getSignatureStatuses([sig]);
        if (value?.[0]?.confirmationStatus === 'confirmed' || value?.[0]?.confirmationStatus === 'finalized') break;
        await new Promise(r => setTimeout(r, 1000));
      }

      // Refresh balances immediately
      await pollBalances();
      return sig;
    },

    refreshBalances: pollBalances,
    startPolling,
    stopPolling
  };
}

export const devKeys = createDevKeypairStore();

/**
 * Derived: info about the currently active keypair
 */
export const activeKeypairInfo = derived(
  [devKeys.keypairs, devKeys.activeName, devKeys.balances],
  ([$keypairs, $activeName, $balances]) => {
    if (!$activeName) return null;
    const found = $keypairs.find(k => k.name === $activeName);
    if (!found) return null;
    return {
      name: found.name,
      publicKey: found.publicKey,
      balance: $balances[found.publicKey] ?? 0
    } as DevKeypairInfo;
  }
);
