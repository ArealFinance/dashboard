<script lang="ts">
  import { ArrowRight, Coins, Repeat, Sparkles } from 'lucide-svelte';
  import type { StreamConvertedEvent } from '$lib/api/layer8';
  import { formatAddress, formatAmount, formatTimestamp, explorerUrl } from '$lib/utils/format';
  import { network } from '$lib/stores/network';

  export let event: StreamConvertedEvent;

  const RWT_DECIMALS = 6;
  const USDC_DECIMALS = 6;

  $: total = event.swapOutRwt + event.mintOutRwt;
  $: swapPct = total === 0n ? 0 : Number((event.swapOutRwt * 10000n) / total) / 100;
  $: mintPct = total === 0n ? 0 : Number((event.mintOutRwt * 10000n) / total) / 100;

  $: pathLabel = computePathLabel(event.swapOutRwt, event.mintOutRwt);
  function computePathLabel(swap: bigint, mint: bigint): string {
    if (swap > 0n && mint === 0n) return 'Swap-only';
    if (mint > 0n && swap === 0n) return 'Mint-only';
    if (swap > 0n && mint > 0n) return 'Dual (swap + mint)';
    return 'Empty';
  }
</script>

<article class="convert-card">
  <header class="head">
    <div class="head-left">
      <span class="head-icon"><Repeat size={16} /></span>
      <div>
        <h4 class="title">Stream Conversion</h4>
        <span class="sub mono">{formatAddress(event.distributor, 6)}</span>
      </div>
    </div>
    <span class={`path-tag path-${pathLabel.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      {pathLabel}
    </span>
  </header>

  <div class="grid">
    <div class="kpi">
      <span class="label">USDC in</span>
      <span class="value mono">{formatAmount(event.usdcIn, USDC_DECIMALS)}</span>
    </div>
    <div class="kpi">
      <span class="label">RWT acquired</span>
      <span class="value mono">{formatAmount(total, RWT_DECIMALS)}</span>
    </div>
    <div class="kpi">
      <span class="label">Net funded</span>
      <span class="value mono">{formatAmount(event.amount, RWT_DECIMALS)}</span>
    </div>
    <div class="kpi">
      <span class="label">Protocol fee</span>
      <span class="value mono">{formatAmount(event.protocolFee, RWT_DECIMALS)}</span>
    </div>
  </div>

  <div class="bars">
    <div class="bar-row">
      <div class="bar-label">
        <span class="bar-label-text">
          <Repeat size={11} />
          Swap leg
        </span>
        <span class="bar-amount mono">{formatAmount(event.swapOutRwt, RWT_DECIMALS)} RWT</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill swap" style={`width:${Math.max(0, Math.min(100, swapPct))}%`}></div>
      </div>
      <span class="bar-pct mono">{swapPct.toFixed(1)}%</span>
    </div>

    <div class="bar-row">
      <div class="bar-label">
        <span class="bar-label-text">
          <Sparkles size={11} />
          Mint leg
        </span>
        <span class="bar-amount mono">{formatAmount(event.mintOutRwt, RWT_DECIMALS)} RWT</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill mint" style={`width:${Math.max(0, Math.min(100, mintPct))}%`}></div>
      </div>
      <span class="bar-pct mono">{mintPct.toFixed(1)}%</span>
    </div>
  </div>

  <footer class="foot">
    <div class="foot-row">
      <span class="foot-label">OT mint</span>
      <span class="foot-value mono" title={event.otMint}>{formatAddress(event.otMint, 6)}</span>
    </div>
    <div class="foot-row">
      <span class="foot-label">Total funded</span>
      <span class="foot-value mono">{formatAmount(event.totalFunded, RWT_DECIMALS)} RWT</span>
    </div>
    <div class="foot-row">
      <span class="foot-label">Locked vested</span>
      <span class="foot-value mono">{formatAmount(event.lockedVested, RWT_DECIMALS)} RWT</span>
    </div>
    {#if event.blockTime}
      <div class="foot-row">
        <span class="foot-label">Confirmed</span>
        <span class="foot-value">{formatTimestamp(BigInt(event.blockTime))}</span>
      </div>
    {/if}
    <a class="signature" href={explorerUrl(event.signature, 'tx', $network)} target="_blank" rel="noreferrer noopener">
      tx <span class="mono">{formatAddress(event.signature, 6)}</span>
      <ArrowRight size={11} />
    </a>
  </footer>
</article>

<style>
  .convert-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .head-left {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .head-icon {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    background: var(--color-primary-muted);
    color: var(--color-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .title {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .path-tag {
    font-size: var(--text-xs);
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    background: var(--color-surface-active);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .path-tag.path-swap-only {
    color: var(--color-info);
    border-color: rgba(59, 130, 246, 0.4);
    background: rgba(59, 130, 246, 0.12);
  }
  .path-tag.path-mint-only {
    color: var(--color-warning);
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.12);
  }
  .path-tag.path-dual-swap-mint {
    color: var(--color-primary);
    border-color: rgba(139, 92, 246, 0.4);
    background: var(--color-primary-muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--color-bg);
    border-radius: var(--radius-md);
  }

  .kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .value {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--color-text);
  }
  .mono {
    font-family: var(--font-mono);
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .bar-row {
    display: grid;
    grid-template-columns: 1fr 50px;
    gap: var(--space-2);
    align-items: center;
  }

  .bar-label {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .bar-label-text {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .bar-amount {
    font-family: var(--font-mono);
  }

  .bar-track {
    height: 6px;
    background: var(--color-bg);
    border-radius: 999px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 999px;
    transition: width 0.3s ease;
  }
  .bar-fill.swap {
    background: linear-gradient(90deg, var(--color-info) 0%, var(--color-primary) 100%);
  }
  .bar-fill.mint {
    background: linear-gradient(90deg, var(--color-warning) 0%, var(--color-success) 100%);
  }
  .bar-pct {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-align: right;
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
  }

  .foot-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-xs);
  }
  .foot-label {
    color: var(--color-text-muted);
  }
  .foot-value {
    color: var(--color-text);
  }

  .signature {
    margin-top: var(--space-1);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    align-self: flex-start;
  }
  .signature:hover {
    color: var(--color-primary);
    text-decoration: none;
  }
</style>
