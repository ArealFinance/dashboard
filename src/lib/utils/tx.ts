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
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  // Poll for confirmation instead of using WebSocket
  await pollConfirmation(connection, signature, lastValidBlockHeight);

  return signature;
}

/**
 * Poll getSignatureStatuses until confirmed or expired.
 */
async function pollConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  intervalMs = 1000,
  timeoutMs = 60000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
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

    // Check if blockhash expired
    const blockHeight = await connection.getBlockHeight('confirmed');
    if (blockHeight > lastValidBlockHeight) {
      throw new Error('Transaction expired: block height exceeded');
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}
