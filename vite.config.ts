import { sveltekit } from '@sveltejs/kit/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'node:path';

const isTest = !!process.env.VITEST;

export default defineConfig({
  plugins: [
    // Vitest doesn't play well with the SvelteKit plugin (it pulls in
    // server-only entry points). For the test pipeline we use the bare
    // `svelte` plugin in client compile mode; for normal dev/build we use
    // SvelteKit.
    isTest ? svelte() : sveltekit(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'process'],
      globals: { Buffer: true, global: true, process: true },
      overrides: { fs: 'empty' }
    })
  ],
  optimizeDeps: {
    include: ['@solana/web3.js', 'bs58', 'buffer'],
    // jsdom: ensure web3.js is pre-bundled rather than pulled from `src/*.ts`,
    // which loses the polyfilled curve check and breaks PDA derivation.
    force: process.env.VITEST ? true : undefined,
  },
  // Svelte 5 + testing-library: need browser conditions so `mount` resolves
  // to the client implementation (not server). When running under vitest we
  // also re-add the `$lib` alias by hand since SvelteKit isn't loaded.
  resolve: isTest
    ? {
        conditions: ['browser', 'svelte'],
        alias: {
          $lib: resolve('src/lib'),
          $app: resolve('src/__mocks__/sveltekit-app'),
        },
      }
    : undefined,
  // Deps that ship raw TypeScript that vite can't transpile cleanly under
  // jsdom (web3.js' `isOnCurve` uses `eval`-ish patterns in src). Force them
  // through the standard CJS bundle by listing in `ssr.noExternal` alone.
  ssr: { noExternal: ['@solana/web3.js'] },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./src/setup-tests.ts']
  }
});
