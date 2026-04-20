import { getContext, setContext } from 'svelte';
import type { Readable } from 'svelte/store';
import type { YdDistributorState, YdClaimStatusState } from '$lib/stores/yd';

const KEY = Symbol('yd-distributor-context');

export interface DistributorContext {
  distributor: Readable<YdDistributorState | null>;
  claimStatus: Readable<YdClaimStatusState | null>;
  loading: Readable<boolean>;
  refresh: () => Promise<void>;
}

export function setDistributorContext(ctx: DistributorContext) {
  setContext(KEY, ctx);
}

export function getDistributorContext(): DistributorContext {
  const ctx = getContext<DistributorContext>(KEY);
  if (!ctx) throw new Error('Distributor context not set');
  return ctx;
}
