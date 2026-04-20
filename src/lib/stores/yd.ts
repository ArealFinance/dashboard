import { writable, get, derived } from 'svelte/store';
import { PublicKey } from '@solana/web3.js';
import { ArlexClient } from '$lib/arlex-client/index.mjs';
import { connection } from './network';
import idl from '$lib/idl/yield-distribution.json';
import {
  findYdConfigPda,
  findMerkleDistributorPda,
  findYdAccumulatorPda,
  findClaimStatusPda,
  findAta
} from '$lib/utils/pda';

// Program ID — sourced from IDL (generated from contract's declare_id!).
// Fail fast if missing rather than silently using a placeholder (ADR: HIGH-1).
const idlAddress = (idl as any).metadata?.address ?? (idl as any).declare_id;
if (!idlAddress || typeof idlAddress !== 'string' || idlAddress.length === 0) {
  throw new Error(
    'yield-distribution IDL is missing program ID (metadata.address / declare_id). ' +
    'Regenerate the IDL or patch it after deploy.'
  );
}
const PROGRAM_ID = new PublicKey(idlAddress);

/**
 * Reactive ArlexClient for Yield Distribution
 */
export const ydClient = derived(connection, ($connection) => {
  return new ArlexClient(idl as any, PROGRAM_ID, $connection);
});

export const ydProgramId = PROGRAM_ID;
export const ydIdl = idl;

// ------------- State types -------------

export interface YdConfigState {
  authority: string;
  pendingAuthority: string;
  hasPending: boolean;
  publishAuthority: string;
  protocolFeeBps: number;
  minDistributionAmount: bigint;
  arealFeeDestination: string;
  isActive: boolean;
  bump: number;
}

export interface YdDistributorState {
  address: string;                // PDA address
  otMint: string;
  rewardVault: string;
  accumulator: string;
  merkleRoot: Uint8Array;
  maxTotalClaim: bigint;
  totalClaimed: bigint;
  totalFunded: bigint;
  lockedVested: bigint;
  lastFundTs: bigint;
  vestingPeriodSecs: bigint;
  epoch: bigint;
  isActive: boolean;
  bump: number;
}

export interface YdClaimStatusState {
  claimant: string;
  distributor: string;
  claimedAmount: bigint;
  bump: number;
}

export interface YdAccumulatorState {
  address: string; // PDA address
  otMint: string;
  bump: number;
}

export interface YdStoreState {
  config: YdConfigState | null;
  configPda: PublicKey | null;
  distributors: YdDistributorState[];
  loading: boolean;
  error: string | null;
}

// ------------- Parsers -------------

function bytesToPubkeyString(bytes: any): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new PublicKey(arr).toBase58();
}

function toBigInt(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (v == null) return 0n;
  return BigInt(v.toString());
}

function parseConfig(data: Record<string, any>): YdConfigState {
  return {
    authority: bytesToPubkeyString(data.authority),
    pendingAuthority: bytesToPubkeyString(data.pending_authority),
    hasPending: !!data.has_pending,
    publishAuthority: bytesToPubkeyString(data.publish_authority),
    protocolFeeBps: Number(data.protocol_fee_bps),
    minDistributionAmount: toBigInt(data.min_distribution_amount),
    arealFeeDestination: bytesToPubkeyString(data.areal_fee_destination),
    isActive: !!data.is_active,
    bump: Number(data.bump)
  };
}

function parseDistributor(address: PublicKey, data: Record<string, any>): YdDistributorState {
  const root = data.merkle_root instanceof Uint8Array
    ? data.merkle_root
    : new Uint8Array(data.merkle_root);
  return {
    address: address.toBase58(),
    otMint: bytesToPubkeyString(data.ot_mint),
    rewardVault: bytesToPubkeyString(data.reward_vault),
    accumulator: bytesToPubkeyString(data.accumulator),
    merkleRoot: root,
    maxTotalClaim: toBigInt(data.max_total_claim),
    totalClaimed: toBigInt(data.total_claimed),
    totalFunded: toBigInt(data.total_funded),
    lockedVested: toBigInt(data.locked_vested),
    lastFundTs: toBigInt(data.last_fund_ts),
    vestingPeriodSecs: toBigInt(data.vesting_period_secs),
    epoch: toBigInt(data.epoch),
    isActive: !!data.is_active,
    bump: Number(data.bump)
  };
}

function parseClaimStatus(data: Record<string, any>): YdClaimStatusState {
  return {
    claimant: bytesToPubkeyString(data.claimant),
    distributor: bytesToPubkeyString(data.distributor),
    claimedAmount: toBigInt(data.claimed_amount),
    bump: Number(data.bump)
  };
}

function parseAccumulator(address: PublicKey, data: Record<string, any>): YdAccumulatorState {
  return {
    address: address.toBase58(),
    otMint: bytesToPubkeyString(data.ot_mint),
    bump: Number(data.bump)
  };
}

// ------------- PDA helpers -------------

export function getYdConfigPda(): PublicKey {
  const [pda] = findYdConfigPda(PROGRAM_ID);
  return pda;
}

export function getDistributorPda(otMint: PublicKey): [PublicKey, number] {
  return findMerkleDistributorPda(PROGRAM_ID, otMint);
}

export function getAccumulatorPda(otMint: PublicKey): [PublicKey, number] {
  return findYdAccumulatorPda(PROGRAM_ID, otMint);
}

export function getClaimStatusPda(
  distributor: PublicKey,
  claimant: PublicKey
): [PublicKey, number] {
  return findClaimStatusPda(PROGRAM_ID, distributor, claimant);
}

// ------------- Main store -------------

function createYdStore() {
  const initial: YdStoreState = {
    config: null,
    configPda: null,
    distributors: [],
    loading: false,
    error: null
  };

  const { subscribe, set, update } = writable<YdStoreState>(initial);

  // single-flight refresh
  let pendingRefresh: Promise<void> | null = null;

  async function doRefresh() {
    update(s => ({ ...s, loading: true, error: null }));
    try {
      const client = get(ydClient);
      const [configPda] = findYdConfigPda(PROGRAM_ID);

      // Config fetch (tolerant — contract may not be deployed yet)
      let configParsed: YdConfigState | null = null;
      try {
        const configData = await client.fetch('DistributionConfig', configPda);
        configParsed = configData ? parseConfig(configData) : null;
      } catch {
        configParsed = null;
      }

      // Distributors — fetchAll tolerates program-not-deployed
      let distributors: YdDistributorState[] = [];
      try {
        const all = await client.fetchAll('MerkleDistributor');
        distributors = all.map(({ address, data }) => parseDistributor(address, data));
      } catch {
        distributors = [];
      }

      set({
        config: configParsed,
        configPda,
        distributors,
        loading: false,
        error: null
      });
    } catch (err: any) {
      update(s => ({ ...s, loading: false, error: err?.message ?? String(err) }));
    }
  }

  return {
    subscribe,

    async refresh() {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh().finally(() => { pendingRefresh = null; });
      return pendingRefresh;
    },

    async loadConfig() {
      return this.refresh();
    },

    async loadDistributors() {
      return this.refresh();
    },

    /**
     * Fetch a single distributor by OT mint.
     * Returns null if not found.
     */
    async loadDistributor(otMint: PublicKey): Promise<YdDistributorState | null> {
      const client = get(ydClient);
      const [pda] = findMerkleDistributorPda(PROGRAM_ID, otMint);
      try {
        const data = await client.fetch('MerkleDistributor', pda);
        if (!data) return null;
        return parseDistributor(pda, data);
      } catch {
        return null;
      }
    },

    /**
     * Fetch a single distributor by its PDA address.
     */
    async loadDistributorByPda(pda: PublicKey): Promise<YdDistributorState | null> {
      const client = get(ydClient);
      try {
        const data = await client.fetch('MerkleDistributor', pda);
        if (!data) return null;
        return parseDistributor(pda, data);
      } catch {
        return null;
      }
    },

    /**
     * Fetch user's ClaimStatus for a given distributor.
     * Returns null if no prior claim.
     */
    async loadClaimStatus(
      distributor: PublicKey,
      claimant: PublicKey
    ): Promise<YdClaimStatusState | null> {
      const client = get(ydClient);
      const [pda] = findClaimStatusPda(PROGRAM_ID, distributor, claimant);
      try {
        const data = await client.fetch('ClaimStatus', pda);
        if (!data) return null;
        return parseClaimStatus(data);
      } catch {
        return null;
      }
    },

    /**
     * Fetch Accumulator account state for a given OT mint.
     * Returns null if not initialized (distributor not created yet).
     * Needed for Layer 8 convert_to_rwt flow (accumulator is the USDC sink).
     */
    async loadAccumulator(otMint: PublicKey): Promise<YdAccumulatorState | null> {
      const client = get(ydClient);
      const [pda] = findYdAccumulatorPda(PROGRAM_ID, otMint);
      try {
        const data = await client.fetch('Accumulator', pda);
        if (!data) return null;
        return parseAccumulator(pda, data);
      } catch {
        return null;
      }
    },

    /**
     * Fetch USDC balance of the Accumulator's USDC ATA.
     * Returns 0n if the ATA is uninitialized or unreadable.
     * Prep for Layer 8 — accumulator holds USDC between stream deposit and convert_to_rwt.
     */
    async loadAccumulatorBalance(
      otMint: PublicKey,
      usdcMint: PublicKey
    ): Promise<bigint> {
      const [accumulatorPda] = findYdAccumulatorPda(PROGRAM_ID, otMint);
      const ata = findAta(accumulatorPda, usdcMint);
      try {
        const conn = get(connection);
        const info = await conn.getAccountInfo(ata);
        if (!info || info.data.length < 72) return 0n;
        // SPL Token Account layout: amount at offset 64 (u64 LE)
        const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
        return view.getBigUint64(64, true);
      } catch {
        return 0n;
      }
    },

    reset() {
      set(initial);
    }
  };
}

export const ydStore = createYdStore();

// ------------- Vesting math (client-side preview) -------------

/**
 * Mirror of contract's calculate_total_vested.
 * All math in BigInt to avoid precision loss.
 */
export function calculateTotalVested(
  dist: YdDistributorState,
  nowSecs: bigint,
  minVestedAmount: bigint = 1_000_000n
): bigint {
  const period = dist.vestingPeriodSecs > 0n ? dist.vestingPeriodSecs : 1n;
  const elapsed = nowSecs > dist.lastFundTs ? nowSecs - dist.lastFundTs : 0n;
  const capped = elapsed < period ? elapsed : period;

  const unvested = dist.totalFunded >= dist.lockedVested
    ? dist.totalFunded - dist.lockedVested
    : 0n;

  const newVested = (unvested * capped) / period;
  let total = dist.lockedVested + newVested;

  // Cap at max_total_claim
  if (total > dist.maxTotalClaim) total = dist.maxTotalClaim;

  // Floor at MIN_VESTED_AMOUNT (unless max_total_claim is smaller)
  const floor = minVestedAmount < dist.maxTotalClaim ? minVestedAmount : dist.maxTotalClaim;
  if (total < floor) total = floor;

  return total;
}

/**
 * Mirror of contract's calculate_claimable.
 * Returns claimable amount for a specific holder.
 */
export function calculateClaimable(
  totalVested: bigint,
  cumulativeAmount: bigint,
  maxTotalClaim: bigint,
  alreadyClaimed: bigint
): bigint {
  if (maxTotalClaim === 0n) return 0n;
  const myShare = (totalVested * cumulativeAmount) / maxTotalClaim;
  // Saturating subtraction
  return myShare > alreadyClaimed ? myShare - alreadyClaimed : 0n;
}
