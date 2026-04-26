/**
 * Render tests for `ConvertMetadataCard`.
 *
 * Verifies that:
 *  - All KPI fields surface from a `StreamConvertedEvent`.
 *  - The dual / swap-only / mint-only path classification works.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ConvertMetadataCard from '../ConvertMetadataCard.svelte';
import type { StreamConvertedEvent } from '$lib/api/layer8';

function makeEvent(overrides: Partial<StreamConvertedEvent> = {}): StreamConvertedEvent {
  return {
    kind: 'StreamConverted',
    signature: 'tx-sig-1',
    slot: 123,
    blockTime: 1700000000,
    distributor: '11111111111111111111111111111111',
    otMint: '11111111111111111111111111111112',
    amount: 1_000_000n,
    protocolFee: 50_000n,
    totalFunded: 5_000_000n,
    lockedVested: 2_000_000n,
    timestamp: 1700000000n,
    usdcIn: 2_000_000n,
    swapOutRwt: 800_000n,
    mintOutRwt: 250_000n,
    ...overrides,
  };
}

describe('ConvertMetadataCard', () => {
  it('renders title and dual-path tag when both legs non-zero', () => {
    render(ConvertMetadataCard, { props: { event: makeEvent() } });
    expect(screen.getByText('Stream Conversion')).toBeInTheDocument();
    expect(screen.getByText(/Dual/i)).toBeInTheDocument();
  });

  it('classifies swap-only when mint leg is zero', () => {
    render(ConvertMetadataCard, {
      props: { event: makeEvent({ swapOutRwt: 1_000_000n, mintOutRwt: 0n }) },
    });
    expect(screen.getByText(/Swap-only/i)).toBeInTheDocument();
  });

  it('classifies mint-only when swap leg is zero', () => {
    render(ConvertMetadataCard, {
      props: { event: makeEvent({ swapOutRwt: 0n, mintOutRwt: 1_000_000n }) },
    });
    expect(screen.getByText(/Mint-only/i)).toBeInTheDocument();
  });

  it('shows the protocol fee row', () => {
    render(ConvertMetadataCard, { props: { event: makeEvent() } });
    expect(screen.getByText('Protocol fee')).toBeInTheDocument();
  });
});
