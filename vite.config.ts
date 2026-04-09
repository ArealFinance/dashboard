import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    sveltekit(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'process'],
      globals: { Buffer: true, global: true, process: true },
      overrides: { fs: 'empty' }
    })
  ],
  optimizeDeps: {
    include: ['@solana/web3.js', 'bs58', 'buffer']
  }
});
