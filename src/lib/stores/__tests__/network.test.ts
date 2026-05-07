/**
 * Phase 4.1 B.3c — `toSdkCluster` adapter unit test.
 *
 * The dashboard ships with the historical `'mainnet-beta'` literal whereas
 * the SDK normalised mainnet to `'mainnet'`. This test pins the bridge so
 * downstream consumers of SDK helpers (USDC_MINTS, CLUSTER_URLS, …) cannot
 * silently regress.
 */
import { describe, expect, it } from 'vitest';

import { toSdkCluster } from '../network';

describe('toSdkCluster (dashboard ↔ SDK cluster bridge)', () => {
  it('maps mainnet-beta to mainnet', () => {
    expect(toSdkCluster('mainnet-beta')).toBe('mainnet');
  });

  it('passes devnet through', () => {
    expect(toSdkCluster('devnet')).toBe('devnet');
  });

  it('passes localnet through', () => {
    expect(toSdkCluster('localnet')).toBe('localnet');
  });
});
