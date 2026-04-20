<script lang="ts">
  import { onMount } from 'svelte';
  import { ydStore } from '$lib/stores/yd';

  onMount(() => {
    ydStore.refresh();
  });
</script>

<slot />
