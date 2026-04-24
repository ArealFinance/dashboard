import { writable, derived, get } from 'svelte/store';
import { Connection } from '@solana/web3.js';
import { browser } from '$app/environment';

const STORAGE_KEY = 'areal_network';

export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta';

const RPC_ENDPOINTS: Record<Cluster, string> = {
  'localnet': 'https://rpc.areal.finance',
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
