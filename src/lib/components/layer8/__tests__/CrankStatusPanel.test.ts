/**
 * Render tests for `CrankStatusPanel`.
 *
 * Verifies:
 *  - Title + role mapping per crank name.
 *  - Status badge text matches the input status.
 *  - Error message surfaces when present.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import CrankStatusPanel from '../CrankStatusPanel.svelte';
import type { CrankHealth } from '$lib/api/layer8';

function makeCrank(overrides: Partial<CrankHealth> = {}): CrankHealth {
  return {
    name: 'revenue',
    status: 'running',
    lastRunTs: Math.floor(Date.now() / 1000) - 30,
    version: '0.1.0',
    error: null,
    ...overrides,
  };
}

describe('CrankStatusPanel', () => {
  it('renders revenue crank title', () => {
    render(CrankStatusPanel, { props: { crank: makeCrank() } });
    expect(screen.getByText('Revenue Crank')).toBeInTheDocument();
    expect(screen.getByText('distribute_revenue')).toBeInTheDocument();
    expect(screen.getByText(/Running/i)).toBeInTheDocument();
  });

  it('renders unreachable status for unconfigured crank', () => {
    render(CrankStatusPanel, {
      props: {
        crank: makeCrank({
          name: 'convert-and-fund',
          status: 'unreachable',
          lastRunTs: null,
          version: null,
          error: 'No endpoint configured',
        }),
      },
    });
    expect(screen.getByText('Convert & Fund Crank')).toBeInTheDocument();
    expect(screen.getByText(/Unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/No endpoint configured/)).toBeInTheDocument();
  });

  it('shows "Never" when lastRunTs is null', () => {
    render(CrankStatusPanel, {
      props: {
        crank: makeCrank({ status: 'stopped', lastRunTs: null, error: null }),
      },
    });
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});
