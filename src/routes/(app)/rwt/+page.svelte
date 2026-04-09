<script lang="ts">
  import { Clock } from 'lucide-svelte';
</script>

<div class="placeholder">
  <div class="placeholder-icon">
    <Clock size={48} />
  </div>
  <h2>Coming Soon</h2>
  <p>This module is not yet implemented. Check the Migration Plan for timeline.</p>
</div>

<style>
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    min-height: 400px;
    text-align: center;
  }

  .placeholder-icon {
    color: var(--color-text-muted);
    opacity: 0.4;
  }

  h2 {
    color: var(--color-text-secondary);
  }

  p {
    color: var(--color-text-muted);
    max-width: 400px;
  }
</style>
