import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from '@solana/web3.js';

/**
 * Sign and send a transaction with the given signers.
 * Sets recent blockhash, fee payer, signs, sends with preflight, confirms.
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

  return await sendAndConfirmTransaction(connection, transaction, signers, {
    commitment: 'confirmed',
    skipPreflight: false
  });
}
