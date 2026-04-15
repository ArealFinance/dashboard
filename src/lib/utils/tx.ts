import {
  Connection,
  Keypair,
  Transaction,
} from '@solana/web3.js';

/**
 * Sign, send, and confirm a transaction using HTTP polling (no WebSocket needed).
 * Returns the transaction signature.
 */
export async function signAndSendTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[]
): Promise<string> {
  if (signers.length === 0) {
    throw new Error('At least one signer is required');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signers[0].publicKey;

  transaction.sign(...signers);

  const rawTx = transaction.serialize();

  console.log('[tx] sending transaction...');
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    preflightCommitment: 'confirmed',
  });
  console.log('[tx] sent:', signature);

  // Poll for confirmation instead of using WebSocket
  await pollConfirmation(connection, signature, lastValidBlockHeight);
  console.log('[tx] confirmed:', signature);

  return signature;
}

/**
 * Poll getSignatureStatuses until confirmed or expired.
 */
async function pollConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  intervalMs = 2000,
  timeoutMs = 120000,
): Promise<void> {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value?.[0];

      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return;
        }
      }

      // Check if blockhash expired (every 5th attempt to reduce RPC calls)
      if (attempt % 5 === 0) {
        const blockHeight = await connection.getBlockHeight('confirmed');
        if (blockHeight > lastValidBlockHeight) {
          throw new Error('Transaction expired: block height exceeded');
        }
      }
    } catch (e: any) {
      // If it's our own error, rethrow
      if (e.message?.includes('Transaction failed') || e.message?.includes('Transaction expired')) {
        throw e;
      }
      // Otherwise RPC error — retry
      console.warn(`[tx] poll attempt ${attempt} failed:`, e.message);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}
