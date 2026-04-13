<script lang="ts">
  import { onMount } from 'svelte';
  import { rwtStore } from '$lib/stores/rwt';

  onMount(() => {
    rwtStore.refresh();
  });
</script>

<slot />
