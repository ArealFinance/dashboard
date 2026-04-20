<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { writable } from 'svelte/store';
  import { PublicKey } from '@solana/web3.js';
  import { ydStore, type YdDistributorState, type YdClaimStatusState } from '$lib/stores/yd';
  import { devKeys } from '$lib/stores/devkeys';
  import { setDistributorContext } from './context';

  export const distributorStore = writable<YdDistributorState | null>(null);
  export const claimStatusStore = writable<YdClaimStatusState | null>(null);
  export const loadingStore = writable(false);

  let timer: any = null;

  async function loadAll() {
    try {
      const pdaStr = $page.params.distributor;
      if (!pdaStr) return;
      loadingStore.set(true);
      const pda = new PublicKey(pdaStr);
      const d = await ydStore.loadDistributorByPda(pda);
      distributorStore.set(d);

      const active = devKeys.getActiveKeypair();
      if (d && active) {
        const cs = await ydStore.loadClaimStatus(pda, active.publicKey);
        claimStatusStore.set(cs);
      } else {
        claimStatusStore.set(null);
      }
    } catch (err) {
      console.error('[yd distributor layout] load failed:', err);
      distributorStore.set(null);
      claimStatusStore.set(null);
    } finally {
      loadingStore.set(false);
    }
  }

  // publish context for child routes
  setDistributorContext({
    distributor: { subscribe: distributorStore.subscribe },
    claimStatus: { subscribe: claimStatusStore.subscribe },
    loading: { subscribe: loadingStore.subscribe },
    refresh: loadAll
  });

  onMount(() => {
    loadAll();
    // Soft poll for vesting UI updates (and to pick up new claim statuses).
    timer = setInterval(loadAll, 15000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  $: if ($page.params.distributor) {
    // When distributor param changes, reload.
    loadAll();
  }
</script>

<slot />
