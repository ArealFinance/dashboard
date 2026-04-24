import { writable, get, derived } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { ArlexClient } from '$lib/arlex-client/index.mjs';
import { connection, network } from './network';
import { trimNullBytes as trimNull } from '$lib/utils/format';
import idl from '$lib/idl/ownership-token.json';
import {
  findOtConfigPda,
  findRevenueAccountPda,
  findRevenueConfigPda,
  findOtGovernancePda,
  findOtTreasuryPda,
  findAta,
  USDC_MINTS
} from '$lib/utils/pda';
import type { Cluster } from './network';

// Program ID — will be updated after deployment
const PROGRAM_ID = new PublicKey(idl.metadata?.address ?? '11111111111111111111111111111112');

/**
 * Reactive ArlexClient that updates when network changes
 */
export const arlexClient = derived(connection, ($connection) => {
  return new ArlexClient(idl as any, PROGRAM_ID, $connection);
});

export const programId = PROGRAM_ID;

/**
 * OT state for a single Ownership Token instance
 */
export interface OtState {
  mint: PublicKey;
  otConfig: Record<string, any> | null;
  revenueAccount: Record<string, any> | null;
  revenueConfig: Record<string, any> | null;
  governance: Record<string, any> | null;
  treasury: Record<string, any> | null;
  revenueAtaBalance: bigint;
  treasuryTokenAccounts: TreasuryTokenAccount[];
  loading: boolean;
  error: string | null;
}

export interface TreasuryTokenAccount {
  mint: PublicKey;
  address: PublicKey;
  balance: bigint;
}

/**
 * OT list store — fetches all OtConfig accounts
 */
export interface OtListItem {
  address: PublicKey;
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  totalMinted: bigint;
}

function createOtListStore() {
  const { subscribe, set, update } = writable<{
    items: OtListItem[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: false, error: null });

  return {
    subscribe,

    async refresh() {
      update(s => ({ ...s, loading: true, error: null }));
      try {
        const client = get(arlexClient);
        const accounts = await client.fetchAll('OtConfig');

        const items: OtListItem[] = accounts.map(({ address, data }) => {
          const mintBytes = data.ot_mint instanceof Uint8Array
            ? data.ot_mint
            : new Uint8Array(data.ot_mint);
          const nameBytes = data.name instanceof Uint8Array
            ? data.name
            : new Uint8Array(data.name);
          const symbolBytes = data.symbol instanceof Uint8Array
            ? data.symbol
            : new Uint8Array(data.symbol);

          return {
            address,
            mint: new PublicKey(mintBytes).toBase58(),
            name: trimNull(nameBytes),
            symbol: trimNull(symbolBytes),
            decimals: data.decimals,
            totalMinted: BigInt(data.total_minted.toString())
          };
        });

        set({ items, loading: false, error: null });
      } catch (err: any) {
        update(s => ({ ...s, loading: false, error: err.message }));
      }
    }
  };
}

export const otList = createOtListStore();

/**
 * Create OT state store for a specific mint address
 */
export function createOtStore(mintAddress: string) {
  // M-13: mint is mutable so the store can be pointed at a different OT instance
  // when the user navigates to /ot/<newMint> without a full remount.
  let mint = new PublicKey(mintAddress);
  const initial: OtState = {
    mint,
    otConfig: null,
    revenueAccount: null,
    revenueConfig: null,
    governance: null,
    treasury: null,
    revenueAtaBalance: 0n,
    treasuryTokenAccounts: [],
    loading: true,
    error: null
  };

  const { subscribe, set, update } = writable<OtState>(initial);
  const subscriptionIds: number[] = [];

  async function fetchAll() {
    update(s => ({ ...s, loading: true, error: null }));

    try {
      const client = get(arlexClient);
      const conn = get(connection);
      const cluster = get(network) as Cluster;

      // Derive all PDAs
      const [otConfigPda] = findOtConfigPda(mint, PROGRAM_ID);
      const [revenuePda] = findRevenueAccountPda(mint, PROGRAM_ID);
      const [revenueConfigPda] = findRevenueConfigPda(mint, PROGRAM_ID);
      const [governancePda] = findOtGovernancePda(mint, PROGRAM_ID);
      const [treasuryPda] = findOtTreasuryPda(mint, PROGRAM_ID);

      // Fetch all accounts in parallel
      const [otConfig, revenueAccount, revenueConfig, governance, treasury] = await Promise.all([
        client.fetch('OtConfig', otConfigPda).catch(() => null),
        client.fetch('RevenueAccount', revenuePda).catch(() => null),
        client.fetch('RevenueConfig', revenueConfigPda).catch(() => null),
        client.fetch('OtGovernance', governancePda).catch(() => null),
        client.fetch('OtTreasury', treasuryPda).catch(() => null)
      ]);

      // Fetch revenue ATA balance
      let revenueAtaBalance = 0n;
      const usdcMint = USDC_MINTS[cluster];
      if (usdcMint) {
        const revenueAta = findAta(revenuePda, usdcMint);
        try {
          const ataInfo = await conn.getTokenAccountBalance(revenueAta);
          revenueAtaBalance = BigInt(ataInfo.value.amount);
        } catch {
          // ATA may not exist yet
        }
      }

      // Fetch treasury token accounts
      let treasuryTokenAccounts: TreasuryTokenAccount[] = [];
      try {
        const tokenAccounts = await conn.getTokenAccountsByOwner(treasuryPda, {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        });

        treasuryTokenAccounts = tokenAccounts.value.map(({ pubkey, account }) => {
          // SPL Token Account layout: [mint: 32][owner: 32][amount: u64]
          const data = account.data;
          const mintPk = new PublicKey(data.subarray(0, 32));
          const balance = data.readBigUInt64LE(64);
          return {
            mint: mintPk,
            address: pubkey,
            balance
          };
        });
      } catch {
        // Treasury may have no token accounts
      }

      set({
        mint,
        otConfig,
        revenueAccount,
        revenueConfig,
        governance,
        treasury,
        revenueAtaBalance,
        treasuryTokenAccounts,
        loading: false,
        error: null
      });
    } catch (err: any) {
      update(s => ({ ...s, loading: false, error: err.message }));
    }
  }

  function setupSubscriptions() {
    const client = get(arlexClient);

    // Subscribe to key account changes
    const [otConfigPda] = findOtConfigPda(mint, PROGRAM_ID);
    const [revenuePda] = findRevenueAccountPda(mint, PROGRAM_ID);
    const [governancePda] = findOtGovernancePda(mint, PROGRAM_ID);

    const sub1 = client.onAccountChange('OtConfig', otConfigPda, (data) => {
      update(s => ({ ...s, otConfig: data }));
    });
    const sub2 = client.onAccountChange('RevenueAccount', revenuePda, (data) => {
      update(s => ({ ...s, revenueAccount: data }));
    });
    const sub3 = client.onAccountChange('OtGovernance', governancePda, (data) => {
      update(s => ({ ...s, governance: data }));
    });

    subscriptionIds.push(sub1, sub2, sub3);
  }

  function cleanup() {
    const client = get(arlexClient);
    for (const id of subscriptionIds) {
      client.removeListener(id).catch(() => {});
    }
    subscriptionIds.length = 0;
  }

  async function setMint(newMintAddress: string) {
    if (newMintAddress === mint.toBase58()) return;
    cleanup();
    mint = new PublicKey(newMintAddress);
    set({
      ...initial,
      mint,
      loading: true,
    });
    await fetchAll();
    setupSubscriptions();
  }

  return {
    subscribe,
    refresh: fetchAll,
    setupSubscriptions,
    cleanup,
    setMint,
  };
}

