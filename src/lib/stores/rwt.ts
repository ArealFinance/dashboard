import { writable, get, derived } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { ArlexClient } from '$lib/arlex-client/index.mjs';
import { connection } from './network';
import idl from '$lib/idl/rwt-engine.json';
import { findRwtVaultPda, findRwtDistConfigPda } from '$lib/utils/pda';

// Program ID — will be updated after deployment
const PROGRAM_ID = new PublicKey(idl.metadata?.address ?? '11111111111111111111111111111112');

/**
 * Reactive ArlexClient for RWT Engine
 */
export const rwtClient = derived(connection, ($connection) => {
  return new ArlexClient(idl as any, PROGRAM_ID, $connection);
});

export const rwtProgramId = PROGRAM_ID;

/**
 * RWT Vault state
 */
export interface RwtVaultState {
  totalInvestedCapital: bigint;
  totalRwtSupply: bigint;
  navBookValue: bigint;
  capitalAccumulatorAta: string;
  rwtMint: string;
  authority: string;
  pendingAuthority: string;
  hasPending: boolean;
  manager: string;
  pauseAuthority: string;
  mintPaused: boolean;
  arealFeeDestination: string;
  bump: number;
}

/**
 * RWT Distribution Config state
 */
export interface RwtDistConfigState {
  bookValueBps: number;
  liquidityBps: number;
  protocolRevenueBps: number;
  liquidityDestination: string;
  protocolRevenueDestination: string;
  bump: number;
}

/**
 * Combined RWT store state
 */
export interface RwtState {
  vault: RwtVaultState | null;
  distConfig: RwtDistConfigState | null;
  vaultPda: PublicKey | null;
  distConfigPda: PublicKey | null;
  loading: boolean;
  error: string | null;
}

function bytesToPubkeyString(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new PublicKey(arr).toBase58();
}

// N-1 audit note: `Record<string, any>` inputs below mirror ArlexClient.fetch()'s
// current untyped return. Proper shape typing awaits an IDL→TS codegen pass —
// until then, parsers serve as the runtime typing boundary.

function parseVault(data: Record<string, any>): RwtVaultState {
  return {
    totalInvestedCapital: BigInt(data.total_invested_capital.toString()),
    totalRwtSupply: BigInt(data.total_rwt_supply.toString()),
    navBookValue: BigInt(data.nav_book_value.toString()),
    capitalAccumulatorAta: bytesToPubkeyString(data.capital_accumulator_ata),
    rwtMint: bytesToPubkeyString(data.rwt_mint),
    authority: bytesToPubkeyString(data.authority),
    pendingAuthority: bytesToPubkeyString(data.pending_authority),
    hasPending: data.has_pending,
    manager: bytesToPubkeyString(data.manager),
    pauseAuthority: bytesToPubkeyString(data.pause_authority),
    mintPaused: data.mint_paused,
    arealFeeDestination: bytesToPubkeyString(data.areal_fee_destination),
    bump: data.bump
  };
}

function parseDistConfig(data: Record<string, any>): RwtDistConfigState {
  return {
    bookValueBps: data.book_value_bps,
    liquidityBps: data.liquidity_bps,
    protocolRevenueBps: data.protocol_revenue_bps,
    liquidityDestination: bytesToPubkeyString(data.liquidity_destination),
    protocolRevenueDestination: bytesToPubkeyString(data.protocol_revenue_destination),
    bump: data.bump
  };
}

function createRwtStore() {
  const initial: RwtState = {
    vault: null,
    distConfig: null,
    vaultPda: null,
    distConfigPda: null,
    loading: false,
    error: null
  };

  const { subscribe, set, update } = writable<RwtState>(initial);

  // Single-flight guard (T-57) — prevents stacking work when the master
  // 5s tick fires while a slow RPC roundtrip is still in flight.
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh() {
    update(s => ({ ...s, loading: true, error: null }));
    try {
      const client = get(rwtClient);
      const [vaultPda] = findRwtVaultPda(PROGRAM_ID);
      const [distConfigPda] = findRwtDistConfigPda(PROGRAM_ID);

      const [vaultData, distData] = await Promise.all([
        client.fetch('RwtVault', vaultPda).catch(() => null),
        client.fetch('RwtDistributionConfig', distConfigPda).catch(() => null)
      ]);

      set({
        vault: vaultData ? parseVault(vaultData) : null,
        distConfig: distData ? parseDistConfig(distData) : null,
        vaultPda,
        distConfigPda,
        loading: false,
        error: null
      });
    } catch (err: any) {
      update(s => ({ ...s, loading: false, error: err.message }));
    }
  }

  return {
    subscribe,

    async refresh() {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => { pendingRefresh = null; });
      return pendingRefresh;
    },

    reset() {
      set(initial);
    }
  };
}

export const rwtStore = createRwtStore();
