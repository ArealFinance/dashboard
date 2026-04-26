/**
 * Vitest setup — wires testing-library/jest-dom matchers and stubs
 * browser-only globals that aren't part of jsdom.
 */
import '@testing-library/jest-dom/vitest';

// jsdom doesn't include Web Crypto subtle by default — pull in Node's
// implementation so utilities that hash via SubtleCrypto (merkle, event
// discriminator) work in tests.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // node:crypto.webcrypto matches the Web Crypto interface.
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: true,
    value: webcrypto,
  });
}
