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
      // Buffer/global/process: false — disable the Inject pass entirely for
      // all three globals. Polyfills stay importable via `include` for code
      // that does e.g. `import process from 'process'` explicitly, but the
      // auto-injector breaks production builds on Linux runners: vite/rollup
      // cannot resolve the injected `vite-plugin-node-polyfills/shims/{global,
      // process,buffer}` paths from inside transitively-installed deps'
      // node_modules subtrees (e.g. engine.io-client beneath @areal/sdk).
      //
      // Deps that need a Buffer/process at runtime (sdk realtime client,
      // socket.io-client/engine.io-client) are pre-bundled below via
      // `optimizeDeps.include` so vite uses its own polyfill resolution
      // path rather than the inject pass. Same combination as app/.
      globals: { Buffer: false, global: false, process: false },
      overrides: { fs: 'empty' }
    })
  ],
  optimizeDeps: {
    include: [
      '@solana/web3.js',
      'bs58',
      'buffer',
      '@areal/sdk',
      '@areal/sdk/realtime',
      'socket.io-client'
    ],
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
        // Dedupe @solana/web3.js so the dashboard, @areal/sdk, and any
        // transitively-installed copies all share one PublicKey identity.
        // Without this, vi.spyOn(PublicKey, 'findProgramAddressSync') in
        // dashboard tests does NOT intercept calls made inside the SDK.
        // Also dedupe `buffer` so the polyfill's Buffer class (used by SDK
        // 0.1.2's explicit `import { Buffer } from 'buffer'`) is the same
        // identity as the Buffer the test reaches for via the global — both
        // come from node_modules/buffer, not Node's native Buffer class.
        dedupe: ['@solana/web3.js', 'buffer'],
        alias: {
          $lib: resolve('src/lib'),
          $app: resolve('src/__mocks__/sveltekit-app'),
        },
      }
    : { dedupe: ['@solana/web3.js', 'buffer'] },
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
