<script lang="ts">
  import { onMount } from 'svelte';
  import { dexStore } from '$lib/stores/dex';

  onMount(() => {
    dexStore.refresh();
  });
</script>

<slot />
