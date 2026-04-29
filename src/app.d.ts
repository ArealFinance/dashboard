// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  interface Window {
    phantom?: {
      solana?: import('$lib/stores/wallet').WalletProvider & { isPhantom: boolean };
    };
    solflare?: import('$lib/stores/wallet').WalletProvider & { isSolflare: boolean };
  }

  interface ImportMetaEnv {
    /** Optional revenue-crank heartbeat endpoint (no trailing slash). */
    readonly PUBLIC_CRANK_REVENUE_URL?: string;
    /** Optional convert-and-fund-crank heartbeat endpoint. */
    readonly PUBLIC_CRANK_CONVERT_URL?: string;
    /** Optional yield-claim-crank heartbeat endpoint. */
    readonly PUBLIC_CRANK_CLAIM_URL?: string;
    /** Optional merkle-publisher proof-store base URL. */
    readonly PUBLIC_PROOF_STORE_URL?: string;
    /**
     * Optional localnet RPC URL. Defaults to `http://127.0.0.1:8899` (the
     * standard Solana test-validator endpoint). Operators that run a remote
     * staging localnet point this at their own RPC.
     */
    readonly PUBLIC_LOCALNET_RPC_URL?: string;
    /** Optional Nexus Manager bot heartbeat endpoint (Layer 9). */
    readonly PUBLIC_NEXUS_MANAGER_BOT_URL?: string;
    /**
     * Optional override for the active deployment's USDC mint (base58).
     * Defaults to the devnet test mint. MAINNET-REPLACE: must be set per
     * deployment.
     */
    readonly PUBLIC_USDC_MINT?: string;
    /**
     * System Overview: bot heartbeat staleness threshold (ms). Default
     * 900_000 (15 min) — beyond this a red alert fires.
     */
    readonly PUBLIC_DASHBOARD_BOT_STALE_THRESHOLD_MS?: string;
    /**
     * System Overview: bot wallet SOL balance below this triggers a yellow
     * low-SOL alert. Default 10_000_000 lamports (0.01 SOL). R-74 wiring
     * pending — heartbeats do not yet expose wallet balance.
     */
    readonly PUBLIC_DASHBOARD_LOW_SOL_THRESHOLD_LAMPORTS?: string;
    /**
     * System Overview: master per-card tick cadence (ms) for GPA-fan-out
     * stores (RWT/DEX/OT/Futarchy/YD/Layer8/Layer9). Default 5_000 — bumped
     * from 1s under T-59/T-60 to amortise GPA scans on shared mainnet RPC.
     */
    readonly PUBLIC_DASHBOARD_CARD_INTERVAL_MS?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
