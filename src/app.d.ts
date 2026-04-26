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
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
