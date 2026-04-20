import { PublicKey } from '@solana/web3.js';

/**
 * Merkle tree utilities matching the YD contract's on-chain format.
 *
 * Conventions (from docs/contracts/yield-distribution.mdx and contract merkle.rs):
 *  - Leaf = SHA256(claimant_pubkey_bytes || cumulative_amount_le_bytes)
 *  - Internal node = SHA256(min(left, right) || max(left, right))  [canonical ordering, lexicographic]
 *  - `cumulative_amount` is u64 LE (8 bytes).
 */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Byte-lexicographic <= comparison. */
function lteBytes(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length <= b.length;
}

function u64LeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, value, true);
  return out;
}

/**
 * Compute leaf hash: SHA256(claimant || cumulative_amount_le)
 */
export async function computeLeaf(
  claimant: PublicKey,
  cumulativeAmount: bigint
): Promise<Uint8Array> {
  const buf = concat(claimant.toBytes(), u64LeBytes(cumulativeAmount));
  return sha256(buf);
}

/**
 * Verify a merkle proof using canonical (lower-first) ordering.
 */
export async function verifyMerkleProof(
  proof: Uint8Array[],
  root: Uint8Array,
  leaf: Uint8Array
): Promise<boolean> {
  let current = leaf;
  for (const sibling of proof) {
    const ordered = lteBytes(current, sibling)
      ? concat(current, sibling)
      : concat(sibling, current);
    current = await sha256(ordered);
  }
  if (current.length !== root.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== root[i]) return false;
  }
  return true;
}

/**
 * Build a merkle tree (canonical lower-first) from leaves.
 * Returns the root and an accessor to get proofs per leaf-index.
 */
export interface BuiltTree {
  root: Uint8Array;
  leaves: Uint8Array[];
  /** Proof for the leaf at `index`, as array of siblings (bottom-up). */
  getProof(index: number): Uint8Array[];
}

export async function buildMerkleTree(leaves: Uint8Array[]): Promise<BuiltTree> {
  if (leaves.length === 0) {
    // Empty tree: matches bot-side convention (tree-builder.ts::buildTree).
    // Zeroed root, empty proofs — contract accepts this when no holder qualified.
    return { root: new Uint8Array(32), leaves: [], getProof: () => [] };
  }

  // layers[0] = leaves, layers[N] = [root]
  const layers: Uint8Array[][] = [leaves.slice()];
  let current = leaves.slice();

  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i]; // duplicate last
      const ordered = lteBytes(left, right) ? concat(left, right) : concat(right, left);
      // eslint-disable-next-line no-await-in-loop
      next.push(await sha256(ordered));
    }
    layers.push(next);
    current = next;
  }

  const root = layers[layers.length - 1][0];

  function getProof(index: number): Uint8Array[] {
    if (index < 0 || index >= leaves.length) {
      throw new Error(`Proof index out of range: ${index}`);
    }
    const proof: Uint8Array[] = [];
    let idx = index;
    for (let layer = 0; layer < layers.length - 1; layer++) {
      const nodes = layers[layer];
      const siblingIdx = idx % 2 === 0 ? Math.min(idx + 1, nodes.length - 1) : idx - 1;
      proof.push(nodes[siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, leaves, getProof };
}

/**
 * Encode a merkle proof (Uint8Array[]) as hex strings for UI input.
 */
export function proofToHex(proof: Uint8Array[]): string[] {
  return proof.map(bytesToHex);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').trim();
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parse proof from a JSON array of hex strings or byte arrays.
 * Accepts:
 *   [[1,2,...], [3,4,...]]        // byte arrays
 *   ["0xAB...", "0xCD..."]         // hex
 *   ["AB...", "CD..."]             // hex w/o prefix
 */
/** Mirror of contract's MAX_PROOF_LEN (see claim.rs). */
export const MAX_PROOF_LEN = 20;

export function parseProofJson(input: string): Uint8Array[] {
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) {
    throw new Error('Proof must be a JSON array');
  }
  // Short-circuit BEFORE iterating — prevents DoS from oversize JSON on low-end devices.
  if (parsed.length > MAX_PROOF_LEN) {
    throw new Error(`Proof length ${parsed.length} exceeds MAX_PROOF_LEN (${MAX_PROOF_LEN})`);
  }
  return parsed.map((node, i) => {
    if (typeof node === 'string') {
      const bytes = hexToBytes(node);
      if (bytes.length !== 32) {
        throw new Error(`Proof node ${i} must be 32 bytes, got ${bytes.length}`);
      }
      return bytes;
    }
    if (Array.isArray(node)) {
      if (node.length !== 32) {
        throw new Error(`Proof node ${i} must be 32 bytes, got ${node.length}`);
      }
      return new Uint8Array(node);
    }
    throw new Error(`Proof node ${i} has unsupported type`);
  });
}
