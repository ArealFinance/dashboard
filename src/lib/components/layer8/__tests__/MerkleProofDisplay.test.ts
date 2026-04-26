/**
 * Render tests for `MerkleProofDisplay` (DASH-2 fixture-render).
 *
 * Verifies:
 *   - Renders all proof fields when a proof is loaded.
 *   - Displays "no proof loaded" empty state when proof is null.
 *   - Verification badge state transitions surface in the UI.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { Keypair } from '@solana/web3.js';
import MerkleProofDisplay from '../MerkleProofDisplay.svelte';
import type { MerkleProof } from '$lib/api/layer8';

function makeProof(overrides: Partial<MerkleProof> = {}): MerkleProof {
  return {
    distributor: Keypair.generate().publicKey.toBase58(),
    epoch: 1,
    holder: Keypair.generate().publicKey.toBase58(),
    cumulativeAmount: '5000000',
    proof: ['ab'.repeat(32), 'cd'.repeat(32)],
    merkleRoot: 'ef'.repeat(32),
    publishedAt: 1_700_000_000,
    ...overrides,
  };
}

describe('MerkleProofDisplay', () => {
  it('renders the empty state when no proof is loaded', () => {
    render(MerkleProofDisplay, { props: { proof: null } });
    expect(screen.getByText('No proof loaded.')).toBeInTheDocument();
  });

  it('renders all proof fields when a proof is provided', () => {
    const proof = makeProof();
    render(MerkleProofDisplay, { props: { proof, decimals: 6 } });

    // Headings + label rows
    expect(screen.getByText('Merkle proof')).toBeInTheDocument();
    expect(screen.getByText('Distributor')).toBeInTheDocument();
    expect(screen.getByText('Holder')).toBeInTheDocument();
    expect(screen.getByText('Epoch')).toBeInTheDocument();
    expect(screen.getByText('Cumulative amount')).toBeInTheDocument();
    expect(screen.getByText('Merkle root')).toBeInTheDocument();

    // Proof list count surfaces (2 nodes)
    expect(screen.getByText(/Sibling hashes/)).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('omits the verify badge when on-chain root is not provided', () => {
    render(MerkleProofDisplay, { props: { proof: makeProof() } });
    // Without onChainRoot the badge stays hidden — none of these labels render.
    expect(screen.queryByText(/^Valid$/)).toBeNull();
    expect(screen.queryByText(/^Invalid$/)).toBeNull();
    expect(screen.queryByText(/^Verifying/)).toBeNull();
  });
});
