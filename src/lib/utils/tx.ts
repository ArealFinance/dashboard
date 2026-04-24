import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';

/**
 * Wallet provider interface (matches Phantom/Solflare shape used in wallet.ts).
 */
export interface WalletSigner {
  publicKey: PublicKey | null;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

/**
 * Confirm-and-resend loop: polls `getSignatureStatuses` and resends the raw tx
 * every 5 s until the slot is confirmed or the last valid block height passes.
 * HTTP-only (no WebSocket required).
 */
async function confirmWithResend(
  connection: Connection,
  rawTx: Uint8Array,
  signature: string,
  lastValidBlockHeight: number,
): Promise<string> {
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

/**
 * Sign with local Keypair(s) and send. Used for dev-tools / e2e scenarios.
 */
export async function signAndSendTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[]
): Promise<string> {
  if (signers.length === 0) {
    throw new Error('At least one signer is required (use sendWalletTransaction for wallet-signed flows)');
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
    maxRetries: 0,
  });

  return confirmWithResend(connection, rawTx, signature, lastValidBlockHeight);
}

/**
 * Sign with a wallet provider (Phantom/Solflare) and send. Used for user flows
 * where the fee payer is the connected wallet (H-8).
 */
export async function sendWalletTransaction(
  connection: Connection,
  transaction: Transaction,
  signer: WalletSigner,
): Promise<string> {
  if (!signer.publicKey) {
    throw new Error('Wallet is not connected');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signer.publicKey;

  const signed = await signer.signTransaction(transaction);
  const rawTx = signed.serialize();

  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 0,
  });

  return confirmWithResend(connection, rawTx, signature, lastValidBlockHeight);
}
