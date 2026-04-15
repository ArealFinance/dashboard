import {
  Connection,
  Keypair,
  Transaction,
} from '@solana/web3.js';

/**
 * Sign, send, and confirm a transaction using HTTP polling (no WebSocket needed).
 * Resends transaction periodically until confirmed or expired.
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

  console.log('[tx] sending...');
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 0, // we handle retries ourselves
  });
  console.log('[tx] sent:', signature.slice(0, 20) + '...');

  // Poll + resend loop
  const startMs = Date.now();
  const timeoutMs = 120_000;
  let attempt = 0;
  let lastSendMs = Date.now();

  while (Date.now() - startMs < timeoutMs) {
    attempt++;

    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value?.[0];

      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          console.log('[tx] confirmed in', ((Date.now() - startMs) / 1000).toFixed(1) + 's');
          return signature;
        }
      }
    } catch (e: any) {
      if (e.message?.includes('Transaction failed')) throw e;
      // RPC error — continue polling
    }

    // Resend every 5 seconds to combat dropped transactions
    if (Date.now() - lastSendMs > 5000) {
      try {
        await connection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
        lastSendMs = Date.now();
        console.log('[tx] resent at attempt', attempt);
      } catch {
        // ignore resend errors
      }
    }

    // Check block height every 10th attempt
    if (attempt % 10 === 0) {
      try {
        const currentHeight = await connection.getBlockHeight('confirmed');
        if (currentHeight > lastValidBlockHeight) {
          throw new Error('Transaction expired: block height exceeded');
        }
      } catch (e: any) {
        if (e.message?.includes('expired')) throw e;
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}
