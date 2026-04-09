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
}

export {};
