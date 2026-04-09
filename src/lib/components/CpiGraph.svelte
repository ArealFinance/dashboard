<script lang="ts">
  import { protocolRegistry } from '$lib/stores/protocol';
  import { Check, Clock } from 'lucide-svelte';
  import type { ProtocolProgram, CpiLink } from '$lib/stores/protocol';

  // Node layout positions (row, col) for CSS grid placement
  const NODE_POSITIONS: Record<string, { row: number; col: number }> = {
    'futarchy': { row: 1, col: 1 },
    'ot':       { row: 1, col: 3 },
    'yd':       { row: 2, col: 2 },
    'rwt':      { row: 3, col: 1 },
    'dex':      { row: 3, col: 3 },
  };

  // Deduplicate CPI links for display — group multiple instructions between same pair
  interface DisplayEdge {
    from: string;
    to: string;
    instructions: string[];
    status: 'active' | 'pending';
  }

  $: programs = $protocolRegistry.programs;
  $: links = $protocolRegistry.links;

  $: edges = buildEdges(links);

  function buildEdges(links: CpiLink[]): DisplayEdge[] {
    const map = new Map<string, DisplayEdge>();

    for (const link of links) {
      const key = `${link.from}->${link.to}`;
      const existing = map.get(key);
      if (existing) {
        existing.instructions.push(link.instruction);
        // If any link is active, the edge is active
        if (link.status === 'active') existing.status = 'active';
      } else {
        map.set(key, {
          from: link.from,
          to: link.to,
          instructions: [link.instruction],
          status: link.status
        });
      }
    }

    return Array.from(map.values());
  }

  function getProgramLabel(id: string): string {
    const p = programs.find(p => p.id === id);
    return p?.name ?? id;
  }

  function getProgramStatus(id: string): 'deployed' | 'pending' {
    const p = programs.find(p => p.id === id);
    return p?.status ?? 'pending';
  }

  function getProgramLayer(id: string): string {
    const p = programs.find(p => p.id === id);
    return p?.layer ?? '?';
  }
</script>

<div class="cpi-graph">
  <div class="graph-grid">
    <!-- Program nodes -->
    {#each programs as program}
      {@const pos = NODE_POSITIONS[program.id]}
      {#if pos}
        <div
          class="graph-node"
          class:deployed={program.status === 'deployed'}
          class:pending={program.status === 'pending'}
          style="grid-row: {pos.row}; grid-column: {pos.col};"
        >
          <div class="node-status-icon">
            {#if program.status === 'deployed'}
              <Check size={12} />
            {:else}
              <Clock size={12} />
            {/if}
          </div>
          <span class="node-name">{program.name}</span>
          <span class="node-layer">Layer {program.layer}</span>
        </div>
      {/if}
    {/each}

    <!-- Edge labels placed in the grid cells between nodes -->
    <!-- Futarchy -> OT (row 1, col 2) -->
    {#each edges.filter(e => e.from === 'futarchy' && e.to === 'ot') as edge}
      <div class="edge-label" style="grid-row: 1; grid-column: 2;">
        <div class="edge-line horizontal" class:edge-pending={edge.status === 'pending'}></div>
        <span class="edge-text" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions.length} CPI{edge.instructions.length > 1 ? 's' : ''}
        </span>
      </div>
    {/each}

    <!-- OT -> YD (row 1-2, col 2-3 area) -->
    {#each edges.filter(e => e.from === 'ot' && e.to === 'yd') as edge}
      <div class="edge-label edge-diagonal" style="grid-row: 2; grid-column: 3;">
        <span class="edge-text" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}

    <!-- YD node connections -->
    <!-- YD -> DEX -->
    {#each edges.filter(e => e.from === 'yd' && e.to === 'dex') as edge}
      <div class="edge-label" style="grid-row: 2; grid-column: 3;">
        <span class="edge-text secondary-edge" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}

    <!-- YD -> RWT -->
    {#each edges.filter(e => e.from === 'yd' && e.to === 'rwt') as edge}
      <div class="edge-label" style="grid-row: 2; grid-column: 1;">
        <span class="edge-text" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}

    <!-- RWT -> DEX -->
    {#each edges.filter(e => e.from === 'rwt' && e.to === 'dex') as edge}
      <div class="edge-label" style="grid-row: 3; grid-column: 2;">
        <div class="edge-line horizontal" class:edge-pending={edge.status === 'pending'}></div>
        <span class="edge-text" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}

    <!-- RWT -> YD -->
    {#each edges.filter(e => e.from === 'rwt' && e.to === 'yd') as edge}
      <div class="edge-label" style="grid-row: 2; grid-column: 1;">
        <span class="edge-text secondary-edge" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}

    <!-- DEX -> YD -->
    {#each edges.filter(e => e.from === 'dex' && e.to === 'yd') as edge}
      <div class="edge-label" style="grid-row: 2; grid-column: 3;">
        <span class="edge-text secondary-edge" class:edge-pending={edge.status === 'pending'}>
          {edge.instructions[0]}
        </span>
      </div>
    {/each}
  </div>

  <!-- Legend -->
  <div class="graph-legend">
    <div class="legend-item">
      <div class="legend-dot deployed"></div>
      <span>Deployed</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot pending"></div>
      <span>Pending</span>
    </div>
    <div class="legend-item">
      <div class="legend-line solid"></div>
      <span>Active CPI</span>
    </div>
    <div class="legend-item">
      <div class="legend-line dashed"></div>
      <span>Pending CPI</span>
    </div>
  </div>

  <!-- Edge summary table -->
  <div class="edge-summary">
    <div class="summary-header">CPI Relationships</div>
    {#each edges as edge}
      <div class="summary-row" class:summary-pending={edge.status === 'pending'}>
        <span class="summary-from">{getProgramLabel(edge.from)}</span>
        <span class="summary-arrow">-></span>
        <span class="summary-to">{getProgramLabel(edge.to)}</span>
        <span class="summary-count">{edge.instructions.length} ix</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .cpi-graph {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* Grid layout for nodes */
  .graph-grid {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    grid-template-rows: auto auto auto;
    gap: var(--space-3);
    padding: var(--space-4);
    min-height: 240px;
    align-items: center;
    justify-items: center;
  }

  /* Program node */
  .graph-node {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-lg);
    border: 2px solid var(--color-border);
    background: var(--color-surface);
    min-width: 130px;
    text-align: center;
    position: relative;
    transition: all var(--transition-fast);
  }

  .graph-node.deployed {
    border-color: var(--color-success);
    background: var(--color-surface);
  }

  .graph-node.pending {
    border-color: var(--color-border);
    border-style: dashed;
    opacity: 0.7;
  }

  .node-status-icon {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .graph-node.deployed .node-status-icon {
    background: var(--color-success);
    color: white;
  }

  .graph-node.pending .node-status-icon {
    background: var(--color-surface-active);
    color: var(--color-text-muted);
  }

  .node-name {
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .node-layer {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  /* Edge labels */
  .edge-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    position: relative;
  }

  .edge-line {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
  }

  .edge-line.horizontal {
    width: 100%;
    height: 2px;
    background: var(--color-border);
  }

  .edge-line.horizontal.edge-pending {
    background: repeating-linear-gradient(
      90deg,
      var(--color-border) 0,
      var(--color-border) 4px,
      transparent 4px,
      transparent 8px
    );
  }

  .edge-text {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-secondary);
    background: var(--color-bg);
    padding: 0 var(--space-1);
    z-index: 1;
    white-space: nowrap;
  }

  .edge-text.edge-pending {
    color: var(--color-text-muted);
  }

  .edge-text.secondary-edge {
    font-size: 10px;
    color: var(--color-text-muted);
  }

  /* Legend */
  .graph-legend {
    display: flex;
    gap: var(--space-4);
    justify-content: center;
    padding: var(--space-2) 0;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .legend-dot.deployed {
    background: var(--color-success);
  }

  .legend-dot.pending {
    background: var(--color-text-muted);
    border: 1px dashed var(--color-border);
  }

  .legend-line {
    width: 16px;
    height: 2px;
  }

  .legend-line.solid {
    background: var(--color-success);
  }

  .legend-line.dashed {
    background: repeating-linear-gradient(
      90deg,
      var(--color-text-muted) 0,
      var(--color-text-muted) 3px,
      transparent 3px,
      transparent 6px
    );
  }

  /* Edge summary table */
  .edge-summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
  }

  .summary-header {
    font-weight: 600;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-1);
  }

  .summary-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-family: var(--font-mono);
  }

  .summary-row.summary-pending {
    opacity: 0.5;
  }

  .summary-from {
    min-width: 120px;
    color: var(--color-text-secondary);
  }

  .summary-arrow {
    color: var(--color-text-muted);
  }

  .summary-to {
    min-width: 120px;
    color: var(--color-text-secondary);
  }

  .summary-count {
    color: var(--color-text-muted);
    margin-left: auto;
  }
</style>
