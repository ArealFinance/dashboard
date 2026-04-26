<script lang="ts">
  import { Check, Copy, ShieldCheck, ShieldAlert } from 'lucide-svelte';
  import type { MerkleProof } from '$lib/api/layer8';
  import { hexToBytes, verifyMerkleProof, computeLeaf } from '$lib/utils/merkle';
  import { PublicKey } from '@solana/web3.js';
  import { formatAddress, formatAmount, isValidAddress } from '$lib/utils/format';

  export let proof: MerkleProof | null = null;
  /** Optional on-chain root (hex string without 0x prefix) for verification. */
  export let onChainRoot: string | null = null;
  /** Token decimals for human-readable cumulative_amount (default 6 = RWT/USDC). */
  export let decimals = 6;

  // L-7: explicit verification states (not booleans) — `unverified` distinct
  // from `error` so the UI can distinguish "no root provided" from "root
  // mismatch".
  type VerifyState = 'unverified' | 'verifying' | 'valid' | 'invalid' | 'error';
  let verifyState: VerifyState = 'unverified';
  let verifyError: string | null = null;
  let copiedKey: string | null = null;

  $: if (proof && onChainRoot) {
    runVerify();
  } else if (!proof) {
    verifyState = 'unverified';
  }

  async function runVerify(): Promise<void> {
    if (!proof || !onChainRoot) return;
    verifyState = 'verifying';
    verifyError = null;
    try {
      if (!isValidAddress(proof.holder)) {
        throw new Error('Invalid holder address');
      }
      const holderPk = new PublicKey(proof.holder);
      const cumulative = BigInt(proof.cumulativeAmount);
      const leaf = await computeLeaf(holderPk, cumulative);
      const proofNodes = proof.proof.map((h) => hexToBytes(h));
      const rootBytes = hexToBytes(onChainRoot);
      const ok = await verifyMerkleProof(proofNodes, rootBytes, leaf);
      verifyState = ok ? 'valid' : 'invalid';
    } catch (err) {
      verifyState = 'error';
      verifyError = err instanceof Error ? err.message : String(err);
    }
  }

  async function copyText(value: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = null;
      }, 1500);
    } catch {
      copiedKey = null;
    }
  }

  function truncatedHex(hex: string, head = 8, tail = 6): string {
    if (hex.length <= head + tail + 3) return hex;
    return `${hex.slice(0, head)}...${hex.slice(-tail)}`;
  }
</script>

<section class="merkle-proof">
  <header class="head">
    <h4>Merkle proof</h4>
    {#if proof && onChainRoot}
      <span class={`verify-badge state-${verifyState}`}>
        {#if verifyState === 'valid'}
          <ShieldCheck size={12} />
          Valid
        {:else if verifyState === 'invalid'}
          <ShieldAlert size={12} />
          Invalid
        {:else if verifyState === 'verifying'}
          Verifying…
        {:else if verifyState === 'error'}
          <ShieldAlert size={12} />
          Error
        {:else}
          Not verified
        {/if}
      </span>
    {/if}
  </header>

  {#if !proof}
    <div class="empty">No proof loaded.</div>
  {:else}
    <dl class="info">
      <div class="info-row">
        <dt>Distributor</dt>
        <dd class="mono">
          <span title={proof.distributor}>{formatAddress(proof.distributor, 6)}</span>
          <button class="copy-btn" on:click={() => copyText(proof.distributor, 'dist')} aria-label="Copy distributor">
            {#if copiedKey === 'dist'}<Check size={12} />{:else}<Copy size={12} />{/if}
          </button>
        </dd>
      </div>
      <div class="info-row">
        <dt>Holder</dt>
        <dd class="mono">
          <span title={proof.holder}>{formatAddress(proof.holder, 6)}</span>
          <button class="copy-btn" on:click={() => copyText(proof.holder, 'holder')} aria-label="Copy holder">
            {#if copiedKey === 'holder'}<Check size={12} />{:else}<Copy size={12} />{/if}
          </button>
        </dd>
      </div>
      <div class="info-row">
        <dt>Epoch</dt>
        <dd class="mono">{proof.epoch}</dd>
      </div>
      <div class="info-row">
        <dt>Cumulative amount</dt>
        <dd class="mono">{formatAmount(BigInt(proof.cumulativeAmount), decimals)}</dd>
      </div>
      <div class="info-row">
        <dt>Merkle root</dt>
        <dd class="mono">
          <span title={proof.merkleRoot}>{truncatedHex(proof.merkleRoot, 10, 8)}</span>
          <button class="copy-btn" on:click={() => copyText(proof.merkleRoot, 'root')} aria-label="Copy root">
            {#if copiedKey === 'root'}<Check size={12} />{:else}<Copy size={12} />{/if}
          </button>
        </dd>
      </div>
    </dl>

    <details class="proof-list">
      <summary>Sibling hashes <span class="muted">({proof.proof.length})</span></summary>
      <ul>
        {#each proof.proof as node, i}
          <li>
            <span class="idx mono">[{i}]</span>
            <span class="hex mono" title={node}>{truncatedHex(node, 10, 8)}</span>
            <button class="copy-btn" on:click={() => copyText(node, `node-${i}`)} aria-label={`Copy node ${i}`}>
              {#if copiedKey === `node-${i}`}<Check size={11} />{:else}<Copy size={11} />{/if}
            </button>
          </li>
        {/each}
      </ul>
    </details>

    {#if verifyError}
      <div class="error-box">
        <ShieldAlert size={12} />
        <span>{verifyError}</span>
      </div>
    {/if}
  {/if}
</section>

<style>
  .merkle-proof {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .head h4 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .verify-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-active);
    color: var(--color-text-secondary);
    font-weight: 500;
  }
  .verify-badge.state-valid {
    background: rgba(16, 185, 129, 0.15);
    color: var(--color-success);
  }
  .verify-badge.state-invalid {
    background: rgba(239, 68, 68, 0.15);
    color: var(--color-danger);
  }
  .verify-badge.state-error {
    background: rgba(245, 158, 11, 0.15);
    color: var(--color-warning);
  }

  .empty {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
    padding: var(--space-4) 0;
  }

  .info {
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  .info-row dt {
    color: var(--color-text-secondary);
  }

  .info-row dd {
    margin: 0;
    color: var(--color-text);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .copy-btn {
    background: transparent;
    border: 0;
    color: var(--color-text-muted);
    padding: 2px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .copy-btn:hover {
    color: var(--color-primary);
    background: var(--color-surface-hover);
  }

  .proof-list {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }

  .proof-list summary {
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    user-select: none;
  }

  .proof-list .muted {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .proof-list ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }

  .proof-list li {
    display: grid;
    grid-template-columns: 30px 1fr auto;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-xs);
  }
  .proof-list .idx {
    color: var(--color-text-muted);
  }
  .proof-list .hex {
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-box {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: var(--color-warning);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
  }
</style>
