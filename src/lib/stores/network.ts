import { writable, derived, get } from 'svelte/store';
import { Connection } from '@solana/web3.js';
import { browser } from '$app/environment';

const STORAGE_KEY = 'areal_network';

export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta';

// R32: localnet RPC URL is operator-configurable via env. Default falls back to
// the Solana CLI's standard local validator endpoint so the dashboard works
// out-of-box for community contributors. Operators that run their own staging
// localnet point PUBLIC_LOCALNET_RPC_URL at it.
function readLocalnetRpcUrl(): string {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const raw = import.meta.env.PUBLIC_LOCALNET_RPC_URL;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return 'http://127.0.0.1:8899';
}

const RPC_ENDPOINTS: Record<Cluster, string> = {
  'localnet': readLocalnetRpcUrl(),
  'devnet': 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};

const CLUSTER_LABELS: Record<Cluster, string> = {
  'localnet': 'Test Validator',
  'devnet': 'Devnet',
  'mainnet-beta': 'Mainnet'
};

function getInitialCluster(): Cluster {
  if (browser) {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'localnet' || saved === 'devnet' || saved === 'mainnet-beta') return saved;
  }
  return 'localnet';
}

function createNetworkStore() {
  const { subscribe, set } = writable<Cluster>(getInitialCluster());

  return {
    subscribe,

    setCluster(cluster: Cluster) {
      set(cluster);
      if (browser) {
        localStorage.setItem(STORAGE_KEY, cluster);
      }
    }
  };
}

export const network = createNetworkStore();
export const clusterLabels = CLUSTER_LABELS;
export const allClusters: Cluster[] = ['localnet', 'devnet', 'mainnet-beta'];

export const rpcEndpoint = derived(network, ($network) => RPC_ENDPOINTS[$network]);

export const connection = derived(rpcEndpoint, ($rpcEndpoint) => {
  // M-12: @solana/web3.js types expect `wsEndpoint: string`, but passing `false`
  // is the officially supported way to disable WebSocket subscriptions and fall
  // back to HTTP polling. The `as unknown as string` cast silences the type
  // mismatch without suppressing real type errors elsewhere.
  return new Connection($rpcEndpoint, {
    commitment: 'confirmed',
    wsEndpoint: false as unknown as string,
    confirmTransactionInitialTimeout: 120000,
  });
});
