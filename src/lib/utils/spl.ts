import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import { signAndSendTransaction } from './tx';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from './pda';

/**
 * Create a new SPL Token mint.
 * Uses InitializeMint2 (instruction index 20) — no rent sysvar needed.
 */
export async function createMint(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  mintAuthority?: PublicKey
): Promise<{ mintAddress: PublicKey; mintKeypair: Keypair }> {
  const mintKeypair = Keypair.generate();
  const authority = mintAuthority ?? payer.publicKey;

  // Mint account size = 82 bytes
  const lamports = await connection.getMinimumBalanceForRentExemption(82);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports,
    space: 82,
    programId: TOKEN_PROGRAM_ID
  });

  // InitializeMint2 layout: [20, decimals(1), mint_authority(32), freeze_option(1), freeze_authority(32)]
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0); // instruction index
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // no freeze authority

  const initMintIx = new TransactionInstruction({
    keys: [{ pubkey: mintKeypair.publicKey, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data
  });

  const tx = new Transaction().add(createAccountIx, initMintIx);
  await signAndSendTransaction(connection, tx, [payer, mintKeypair]);

  return { mintAddress: mintKeypair.publicKey, mintKeypair };
}

/**
 * Derive ATA address (same as pda.ts findAta but exported separately for clarity)
 */
export function getAtaAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * Create an Associated Token Account.
 * Uses the standard ATA program Create instruction.
 */
export async function createAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = getAtaAddress(owner, mint);

  // Check if ATA already exists
  const info = await connection.getAccountInfo(ata);
  if (info !== null) {
    return ata;
  }

  // ATA Create instruction has no data — just the accounts in specific order
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0)
  });

  const tx = new Transaction().add(ix);
  await signAndSendTransaction(connection, tx, [payer]);

  return ata;
}

/**
 * Mint tokens to a destination token account.
 * MintTo instruction index = 7: [7, amount_le(8)]
 */
export async function mintTo(
  connection: Connection,
  mintAuthority: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint | number
): Promise<string> {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false }
    ],
    programId: TOKEN_PROGRAM_ID,
    data
  });

  const tx = new Transaction().add(ix);
  return await signAndSendTransaction(connection, tx, [mintAuthority]);
}

/**
 * Get token balance from raw account data.
 * SPL Token Account layout: [mint(32)][owner(32)][amount(u64)]...
 */
export async function getTokenBalance(
  connection: Connection,
  ataAddress: PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(ataAddress);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * Read mint info from raw account data.
 * SPL Mint layout: [mint_auth_option(4)][mint_auth(32)][supply(u64)][decimals(1)]...
 */
export async function getMintInfo(
  connection: Connection,
  mintAddress: PublicKey
): Promise<{
  mintAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
}> {
  const info = await connection.getAccountInfo(mintAddress);
  if (!info || info.data.length < 82) {
    throw new Error('Invalid mint account');
  }
  const data = info.data;

  const authOption = data.readUInt32LE(0);
  const mintAuthority = authOption === 1
    ? new PublicKey(data.subarray(4, 36))
    : null;

  const supply = data.readBigUInt64LE(36);
  const decimals = data.readUInt8(44);

  return { mintAuthority, supply, decimals };
}
