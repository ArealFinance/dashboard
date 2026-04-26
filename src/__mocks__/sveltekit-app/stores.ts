// Mock for $app/stores — minimal interface used in tests.
import { readable } from 'svelte/store';

export const page = readable({
  url: new URL('http://localhost/'),
  params: {},
  data: {},
  route: { id: '/' },
  error: null,
  status: 200,
  form: null,
  state: {},
});

export const navigating = readable(null);
export const updated = readable(false);
