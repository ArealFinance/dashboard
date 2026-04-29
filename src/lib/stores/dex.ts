import { writable, get, derived } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { ArlexClient } from '$lib/arlex-client/index.mjs';
import { connection } from './network';
import idl from '$lib/idl/native-dex.json';
import { findDexConfigPda, findPoolCreatorsPda, findPoolStatePda, findLpPositionPda, findBinArrayPda } from '$lib/utils/pda';

// Program ID — will be updated after deployment
const PROGRAM_ID = new PublicKey(idl.metadata?.address ?? '11111111111111111111111111111112');

/**
 * Reactive ArlexClient for Native DEX
 */
export const dexClient = derived(connection, ($connection) => {
  return new ArlexClient(idl as any, PROGRAM_ID, $connection);
});

export const dexProgramId = PROGRAM_ID;

/**
 * DexConfig state
 */
export interface DexConfigState {
  authority: string;
  pendingAuthority: string;
  hasPending: boolean;
  pauseAuthority: string;
  baseFeeBps: number;
  lpFeeShareBps: number;
  arealFeeDestination: string;
  rebalancer: string;
  isActive: boolean;
  bump: number;
}

/**
 * PoolState
 */
export interface PoolStateData {
  poolType: number;
  tokenAMint: string;
  tokenBMint: string;
  vaultA: string;
  vaultB: string;
  reserveA: bigint;
  reserveB: bigint;
  totalLpShares: bigint;
  feeBps: number;
  isActive: boolean;
  totalFeesAccumulated: bigint;
  binStepBps: number;
  activeBinId: number;
  otTreasuryFeeDestination: string;
  hasOtTreasury: boolean;
  bump: number;
  // Derived
  pda: string;
  price: number; // reserveB / reserveA
}

/**
 * PoolCreators state
 */
export interface PoolCreatorsState {
  authority: string;
  creators: string[];
  activeCount: number;
  bump: number;
}

/**
 * LpPosition state
 */
export interface LpPositionState {
  pool: string;
  owner: string;
  shares: bigint;
  lastUpdateTs: bigint;
  bump: number;
}

/**
 * Bin data for concentrated pools
 */
export interface BinData {
  liquidityA: bigint;
  liquidityB: bigint;
}

/**
 * BinArray state for concentrated pools
 */
export interface BinArrayState {
  pool: string;
  bins: BinData[];
  lowerBinId: number;
  binStepBps: number;
  activeBinId: number;
  bump: number;
}

/**
 * Combined DEX store state
 */
export interface DexState {
  config: DexConfigState | null;
  creators: PoolCreatorsState | null;
  pools: PoolStateData[];
  configPda: PublicKey | null;
  creatorsPda: PublicKey | null;
  loading: boolean;
  error: string | null;
}

function bytesToPubkeyString(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new PublicKey(arr).toBase58();
}

function isZeroPubkey(s: string): boolean {
  return s === '11111111111111111111111111111111';
}

// N-1 audit note: `Record<string, any>` inputs for parsers below reflect
// ArlexClient.fetch()'s current untyped return. Full typing (proper generated
// IDL→TS interfaces) would replace these with shape-checked accesses; deferred
// to a follow-up IDL-codegen pass. snake_case keys mirror on-chain struct
// field names.

function parseConfig(data: Record<string, any>): DexConfigState {
  return {
    authority: bytesToPubkeyString(data.authority),
    pendingAuthority: bytesToPubkeyString(data.pending_authority),
    hasPending: data.has_pending,
    pauseAuthority: bytesToPubkeyString(data.pause_authority),
    baseFeeBps: data.base_fee_bps,
    lpFeeShareBps: data.lp_fee_share_bps,
    arealFeeDestination: bytesToPubkeyString(data.areal_fee_destination),
    rebalancer: bytesToPubkeyString(data.rebalancer),
    isActive: data.is_active,
    bump: data.bump,
  };
}

function parseCreators(data: Record<string, any>): PoolCreatorsState {
  const count = data.active_count;
  const creators: string[] = [];
  for (let i = 0; i < count; i++) {
    creators.push(bytesToPubkeyString(data.creators[i]));
  }
  return {
    authority: bytesToPubkeyString(data.authority),
    creators,
    activeCount: count,
    bump: data.bump,
  };
}

function parsePool(data: Record<string, any>, pda: PublicKey): PoolStateData {
  const reserveA = BigInt(data.reserve_a.toString());
  const reserveB = BigInt(data.reserve_b.toString());
  // H-6: BigInt-safe price calc. Divide BigInt by BigInt (6-decimal scale) and
  // convert to Number only for display. Loses no precision until reserves
  // exceed Number.MAX_SAFE_INTEGER / 1_000_000 ≈ 9e9 (still plenty for any
  // realistic pool).
  const price = reserveA > 0n
    ? Number((reserveB * 1_000_000n) / reserveA) / 1_000_000
    : 0;
  return {
    poolType: data.pool_type,
    tokenAMint: bytesToPubkeyString(data.token_a_mint),
    tokenBMint: bytesToPubkeyString(data.token_b_mint),
    vaultA: bytesToPubkeyString(data.vault_a),
    vaultB: bytesToPubkeyString(data.vault_b),
    reserveA: reserveA,
    reserveB: reserveB,
    totalLpShares: BigInt(data.total_lp_shares.toString()),
    feeBps: data.fee_bps,
    isActive: data.is_active,
    totalFeesAccumulated: BigInt(data.total_fees_accumulated.toString()),
    binStepBps: data.bin_step_bps,
    activeBinId: data.active_bin_id,
    otTreasuryFeeDestination: bytesToPubkeyString(data.ot_treasury_fee_destination),
    hasOtTreasury: data.has_ot_treasury,
    bump: data.bump,
    pda: pda.toBase58(),
    price,
  };
}

function createDexStore() {
  const initial: DexState = {
    config: null,
    creators: null,
    pools: [],
    configPda: null,
    creatorsPda: null,
    loading: false,
    error: null,
  };

  const { subscribe, set, update } = writable<DexState>(initial);

  // Single-flight guard (T-57) — prevents stacking work when the master
  // tick fires while a slow RPC roundtrip is still in flight.
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh() {
    update(s => ({ ...s, loading: true, error: null }));
    try {
      const client = get(dexClient);
      const [configPda] = findDexConfigPda(PROGRAM_ID);
      const [creatorsPda] = findPoolCreatorsPda(PROGRAM_ID);

      const [configData, creatorsData] = await Promise.all([
        client.fetch('DexConfig', configPda).catch(() => null),
        client.fetch('PoolCreators', creatorsPda).catch(() => null),
      ]);

      // T-58: pools[] is populated by refreshPool() (per-pool ondemand).
      // The master refresh must NOT wipe that cache — preserve via update.
      update(s => ({
        ...s,
        config: configData ? parseConfig(configData) : null,
        creators: creatorsData ? parseCreators(creatorsData) : null,
        pools: s.pools, // preserve existing pools loaded via refreshPool
        configPda,
        creatorsPda,
        loading: false,
        error: null,
      }));
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

    async refreshPool(tokenAMint: PublicKey, tokenBMint: PublicKey) {
      try {
        const client = get(dexClient);
        const [poolPda] = findPoolStatePda(tokenAMint, tokenBMint, PROGRAM_ID);
        const poolData = await client.fetch('PoolState', poolPda).catch(() => null);
        if (poolData) {
          const parsed = parsePool(poolData, poolPda);
          update(s => {
            const existing = s.pools.findIndex(p => p.pda === parsed.pda);
            const pools = [...s.pools];
            if (existing >= 0) {
              pools[existing] = parsed;
            } else {
              pools.push(parsed);
            }
            return { ...s, pools };
          });
          return parsed;
        }
        return null;
      } catch {
        return null;
      }
    },

    async fetchBinArray(poolStatePda: PublicKey): Promise<BinArrayState | null> {
      try {
        const client = get(dexClient);
        const [binPda] = findBinArrayPda(poolStatePda, PROGRAM_ID);
        const data = await client.fetch('BinArray', binPda).catch(() => null);
        if (!data) return null;
        const bins: BinData[] = [];
        for (let i = 0; i < 70; i++) {
          const b = data.bins[i];
          bins.push({
            liquidityA: BigInt(b.liquidity_a.toString()),
            liquidityB: BigInt(b.liquidity_b.toString()),
          });
        }
        return {
          pool: bytesToPubkeyString(data.pool),
          bins,
          lowerBinId: data.lower_bin_id,
          binStepBps: data.bin_step_bps,
          activeBinId: data.active_bin_id,
          bump: data.bump,
        };
      } catch {
        return null;
      }
    },

    reset() {
      set(initial);
    }
  };
}

export const dexStore = createDexStore();
