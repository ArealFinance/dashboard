import { writable, get, derived } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { ArlexClient } from '$lib/arlex-client/index.mjs';
import { connection } from './network';
import idl from '$lib/idl/futarchy.json';
import { findFutarchyConfigPda, findProposalPda } from '$lib/utils/pda';

// Program ID — will be updated after deployment
const PROGRAM_ID = new PublicKey(idl.metadata?.address ?? '11111111111111111111111111111112');

/**
 * Reactive ArlexClient for Futarchy
 */
export const futarchyClient = derived(connection, ($connection) => {
  return new ArlexClient(idl as any, PROGRAM_ID, $connection);
});

export const futarchyProgramId = PROGRAM_ID;

// Proposal type labels
export const PROPOSAL_TYPES: Record<number, string> = {
  0: 'MintOt',
  1: 'SpendTreasury',
  2: 'UpdateDestinations'
};

// Proposal status labels and colors
export const PROPOSAL_STATUSES: Record<number, { label: string; color: string }> = {
  0: { label: 'Active', color: 'var(--color-info)' },
  1: { label: 'Approved', color: 'var(--color-warning)' },
  2: { label: 'Executed', color: 'var(--color-success)' },
  3: { label: 'Cancelled', color: 'var(--color-danger)' }
};

/**
 * Futarchy state for a single config instance
 */
export interface FutarchyState {
  configAddress: PublicKey;
  config: Record<string, any> | null;
  proposals: ProposalItem[];
  loading: boolean;
  error: string | null;
}

export interface ProposalItem {
  address: PublicKey;
  proposalId: bigint;
  otMint: string;
  proposer: string;
  proposalType: number;
  amount: bigint;
  destination: string;
  tokenMint: string;
  paramsHash: Uint8Array;
  status: number;
  createdTs: bigint;
  executedTs: bigint;
}

/**
 * Futarchy list store — all FutarchyConfig accounts
 */
export interface FutarchyListItem {
  address: PublicKey;
  otMint: string;
  authority: string;
  nextProposalId: bigint;
  isActive: boolean;
  hasPending: boolean;
}

function createFutarchyListStore() {
  const { subscribe, set, update } = writable<{
    items: FutarchyListItem[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: false, error: null });

  return {
    subscribe,

    async refresh() {
      update(s => ({ ...s, loading: true, error: null }));
      try {
        const client = get(futarchyClient);
        const accounts = await client.fetchAll('FutarchyConfig');

        const items: FutarchyListItem[] = accounts.map(({ address, data }) => {
          const mintBytes = data.ot_mint instanceof Uint8Array
            ? data.ot_mint : new Uint8Array(data.ot_mint);
          const authBytes = data.authority instanceof Uint8Array
            ? data.authority : new Uint8Array(data.authority);

          return {
            address,
            otMint: new PublicKey(mintBytes).toBase58(),
            authority: new PublicKey(authBytes).toBase58(),
            nextProposalId: BigInt(data.next_proposal_id.toString()),
            isActive: data.is_active,
            hasPending: data.has_pending
          };
        });

        set({ items, loading: false, error: null });
      } catch (err: any) {
        update(s => ({ ...s, loading: false, error: err.message }));
      }
    }
  };
}

export const futarchyList = createFutarchyListStore();

/**
 * Create store for a specific FutarchyConfig
 */
export function createFutarchyStore(configAddress: string) {
  const configPda = new PublicKey(configAddress);
  const initial: FutarchyState = {
    configAddress: configPda,
    config: null,
    proposals: [],
    loading: true,
    error: null
  };

  const { subscribe, set, update } = writable<FutarchyState>(initial);
  const subscriptionIds: number[] = [];

  async function fetchAll() {
    update(s => ({ ...s, loading: true, error: null }));

    try {
      const client = get(futarchyClient);

      // Fetch config
      const config = await client.fetch('FutarchyConfig', configPda).catch(() => null);

      // Fetch all proposals for this config
      let proposals: ProposalItem[] = [];
      if (config) {
        const nextId = BigInt(config.next_proposal_id.toString());
        const proposalPromises: Promise<any>[] = [];
        for (let i = 0n; i < nextId; i++) {
          const [proposalPda] = findProposalPda(configPda, i, PROGRAM_ID);
          proposalPromises.push(
            client.fetch('Proposal', proposalPda)
              .then(data => ({ address: proposalPda, data }))
              .catch(() => null)
          );
        }

        const results = await Promise.all(proposalPromises);
        proposals = results.filter(Boolean).map(({ address, data }) => {
          const mintBytes = data.ot_mint instanceof Uint8Array
            ? data.ot_mint : new Uint8Array(data.ot_mint);
          const proposerBytes = data.proposer instanceof Uint8Array
            ? data.proposer : new Uint8Array(data.proposer);
          const destBytes = data.destination instanceof Uint8Array
            ? data.destination : new Uint8Array(data.destination);
          const tokenMintBytes = data.token_mint instanceof Uint8Array
            ? data.token_mint : new Uint8Array(data.token_mint);
          const hashBytes = data.params_hash instanceof Uint8Array
            ? data.params_hash : new Uint8Array(data.params_hash);

          return {
            address,
            proposalId: BigInt(data.proposal_id.toString()),
            otMint: new PublicKey(mintBytes).toBase58(),
            proposer: new PublicKey(proposerBytes).toBase58(),
            proposalType: data.proposal_type,
            amount: BigInt(data.amount.toString()),
            destination: new PublicKey(destBytes).toBase58(),
            tokenMint: new PublicKey(tokenMintBytes).toBase58(),
            paramsHash: hashBytes,
            status: data.status,
            createdTs: BigInt(data.created_ts.toString()),
            executedTs: BigInt(data.executed_ts.toString())
          };
        });
      }

      set({
        configAddress: configPda,
        config,
        proposals,
        loading: false,
        error: null
      });
    } catch (err: any) {
      update(s => ({ ...s, loading: false, error: err.message }));
    }
  }

  function setupSubscriptions() {
    const client = get(futarchyClient);
    const sub = client.onAccountChange('FutarchyConfig', configPda, (data) => {
      update(s => ({ ...s, config: data }));
    });
    subscriptionIds.push(sub);
  }

  function cleanup() {
    const client = get(futarchyClient);
    for (const id of subscriptionIds) {
      client.removeListener(id).catch(() => {});
    }
    subscriptionIds.length = 0;
  }

  return { subscribe, refresh: fetchAll, setupSubscriptions, cleanup };
}

/**
 * Typed interface for the store returned by createFutarchyStore.
 * Consumers pass this to getContext<FutarchyStore>('futarchyStore') (H-7).
 */
export type FutarchyStore = ReturnType<typeof createFutarchyStore>;
