/**
 * Parse Arlex program errors out of Solana transaction failures.
 *
 * Arlex (via arlex-derive `#[error_code]`) emits `ProgramError::Custom(N)` where
 * N starts at 6000 for the FIRST enum variant and increments by 1 per variant.
 * On a failed transaction, the SendTransactionError / SignatureStatus.err
 * carries the following shapes (depending on where in the stack the failure
 * bubbled):
 *
 *   1. Object with `InstructionError: [ixIndex, { Custom: N }]`
 *   2. Object with `err: { InstructionError: [...] }`
 *   3. String: `"custom program error: 0x1770"` (hex, 0x1770 == 6000)
 *   4. Plain Error whose message contains one of the above
 *
 * Shape (1) appears in `signAndSendTransaction`'s rethrown error message:
 *   "Transaction failed: {\"InstructionError\":[0,{\"Custom\":6003}]}"
 *
 * This helper normalizes all of these and returns `{ code, name }` where
 * `name` is the Arlex enum variant name (YdError::Unauthorized etc) if the
 * user passed an enum list, otherwise undefined.
 *
 * @see docs/contracts/yield-distribution.mdx §"Error codes"
 */

export interface ParsedProgramError {
  /** Raw custom code as a u32 (6000 + variant_index for Arlex). */
  code: number;
  /** Resolved enum variant name (if errorEnum provided and code maps). */
  name?: string;
  /** Raw message/object that was parsed, for debug display. */
  raw: string;
}

/**
 * YdError enum variants in declaration order. Code = 6000 + index.
 *
 * Keep this in sync with contracts/yield-distribution/src/error.rs.
 */
export const YD_ERROR_CODES: readonly string[] = [
  'Unauthorized',                  // 6000
  'UnauthorizedPublisher',         // 6001
  'SystemPaused',                  // 6002
  'DistributorNotActive',          // 6003
  'RootNotPublished',              // 6004
  'ProofTooLong',                  // 6005
  'InvalidProof',                  // 6006
  'InvalidMaxClaim',               // 6007
  'ZeroMaxClaim',                  // 6008
  'MaxClaimBelowClaimed',          // 6009
  'ExceedsMaxClaim',               // 6010
  'ZeroAmount',                    // 6011
  'BelowMinDistribution',          // 6012
  'InvalidVestingPeriod',          // 6013
  'InvalidTokenAccount',           // 6014
  'InvalidFeeBps',                 // 6015
  'InvalidOtMint',                 // 6016
  'InvalidRewardVault',            // 6017
  'InvalidFeeAccount',             // 6018
  'InvalidClaimStatus',            // 6019
  'InvalidClaimantTokenOwner',     // 6020
  'MathOverflow',                  // 6021
  'SelfTransfer',                  // 6022
  'NoPendingAuthority',            // 6023
  'InvalidPendingAuthority',       // 6024
  'ZeroDestination',               // 6025
];

const ARLEX_ERROR_BASE = 6000;

/**
 * Extract a Solana custom program error code from an arbitrary thrown value.
 * Returns null if no recognizable error code can be found.
 */
export function parseArlexError(
  err: unknown,
  errorEnum: readonly string[] = YD_ERROR_CODES,
): ParsedProgramError | null {
  const msg = errToString(err);

  // Pattern 1: "\"Custom\":6003" JSON substring
  const mJson = /"Custom"\s*:\s*(\d+)/.exec(msg);
  if (mJson) {
    const code = Number(mJson[1]);
    return { code, name: resolveName(code, errorEnum), raw: msg };
  }

  // Pattern 2: "custom program error: 0x1770" (hex)
  const mHex = /custom program error:\s*0x([0-9a-fA-F]+)/i.exec(msg);
  if (mHex) {
    const code = parseInt(mHex[1]!, 16);
    return { code, name: resolveName(code, errorEnum), raw: msg };
  }

  // Pattern 3: nested InstructionError objects (rare, extract any [_, { Custom: N }])
  const mNested = /\[\s*\d+\s*,\s*\{\s*"Custom"\s*:\s*(\d+)\s*\}/.exec(msg);
  if (mNested) {
    const code = Number(mNested[1]);
    return { code, name: resolveName(code, errorEnum), raw: msg };
  }

  return null;
}

function resolveName(code: number, errorEnum: readonly string[]): string | undefined {
  if (code < ARLEX_ERROR_BASE) return undefined;
  const idx = code - ARLEX_ERROR_BASE;
  return errorEnum[idx];
}

function errToString(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Convenience: assert that a tx rejection carries a specific YdError variant.
 * Returns `{ ok: true, code, name }` on match, `{ ok: false, reason }` otherwise.
 *
 * Intended as a drop-in for `try { tx } catch { rejected = true }` patterns:
 *
 *   const res = await expectYdError(promise, 'UnauthorizedPublisher');
 *   result['Negative (UnauthorizedPublisher)'] = res.ok ? 'PASS' : `FAIL: ${res.reason}`;
 */
export async function expectYdError(
  p: Promise<unknown>,
  expectedName: string,
): Promise<{ ok: true; code: number; name: string } | { ok: false; reason: string }> {
  try {
    await p;
    return { ok: false, reason: 'tx succeeded (expected rejection)' };
  } catch (err) {
    const parsed = parseArlexError(err);
    if (!parsed) {
      return { ok: false, reason: `rejection had no parseable error code: ${errToString(err).slice(0, 200)}` };
    }
    if (parsed.name !== expectedName) {
      return {
        ok: false,
        reason: `expected ${expectedName} but got ${parsed.name ?? 'Custom(' + parsed.code + ')'}`,
      };
    }
    return { ok: true, code: parsed.code, name: parsed.name };
  }
}
