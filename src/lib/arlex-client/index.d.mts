import { PublicKey, Connection, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';

/**
 * Arlex IDL types — Anchor-compatible format
 */
interface Idl {
    version: string;
    name: string;
    metadata?: {
        address?: string;
    };
    instructions: IdlInstruction[];
    accounts: IdlAccountDef[];
    types?: IdlTypeDef[];
    events?: IdlEvent[];
    errors?: IdlError[];
}
interface IdlInstruction {
    name: string;
    accounts: IdlAccountItem[];
    args: IdlField[];
}
interface IdlAccountItem {
    name: string;
    isMut: boolean;
    isSigner: boolean;
}
interface IdlField {
    name: string;
    type: IdlType;
}
type IdlType = string | {
    vec: IdlType;
} | {
    option: IdlType;
} | {
    array: [IdlType, number];
} | {
    defined: string;
};
interface IdlAccountDef {
    name: string;
    type: {
        kind: string;
        fields: IdlField[];
    };
}
interface IdlTypeDef {
    name: string;
    type: {
        kind: string;
        fields?: IdlField[];
        variants?: {
            name: string;
        }[];
    };
}
interface IdlEvent {
    name: string;
    fields: IdlField[];
}
interface IdlError {
    code: number;
    name: string;
    msg: string;
}

/**
 * Custom program error with IDL-decoded name and message
 */
declare class ArlexProgramError extends Error {
    code: number;
    errorName: string;
    constructor(code: number, errorName: string, message: string);
}
/**
 * Decode a numeric error code into a named error from the IDL
 */
declare function decodeError(code: number, errors: IdlError[]): ArlexProgramError;
/**
 * Extract custom error code from a Solana transaction error
 */
declare function extractErrorCode(err: any): number | null;

interface ExecuteOptions {
    accounts: Record<string, PublicKey>;
    args?: Record<string, any>;
    signers?: Keypair[];
    remainingAccounts?: {
        pubkey: PublicKey;
        isSigner: boolean;
        isWritable: boolean;
    }[];
    computeUnits?: number;
    priorityFee?: number;
}
interface FetchOptions {
    commitment?: 'processed' | 'confirmed' | 'finalized';
}
declare class ArlexClient {
    readonly idl: Idl;
    readonly programId: PublicKey;
    readonly connection: Connection;
    private instructionMap;
    private accountMap;
    private typeRegistry;
    constructor(idl: Idl, programId: PublicKey, connection: Connection);
    /**
     * Build a Transaction without sending — for wallet adapter integration.
     * Returns the transaction for external signing (Phantom, Solflare, etc.)
     */
    buildTransaction(instructionName: string, options: ExecuteOptions): Transaction;
    /**
     * Build a single TransactionInstruction
     */
    buildInstruction(instructionName: string, options: ExecuteOptions): TransactionInstruction;
    /**
     * Execute an instruction with Keypair signing (for scripts/CLI)
     */
    execute(instructionName: string, options: ExecuteOptions, payer: Keypair): Promise<string>;
    /**
     * Poll getSignatureStatuses until confirmed or expired.
     * Works without WebSocket — pure HTTP polling.
     */
    private pollConfirmation;
    /**
     * Fetch and deserialize an account
     */
    fetch(accountType: string, address: PublicKey, options?: FetchOptions): Promise<Record<string, any>>;
    /**
     * Fetch all accounts of a given type (via getProgramAccounts + discriminator filter)
     */
    fetchAll(accountType: string, options?: FetchOptions): Promise<{
        address: PublicKey;
        data: Record<string, any>;
    }[]>;
    /**
     * Simulate a transaction (dry run)
     */
    simulate(instructionName: string, options: ExecuteOptions, feePayer: PublicKey): Promise<{
        success: boolean;
        logs: string[];
        unitsConsumed: number;
        error: ArlexProgramError | null;
    }>;
    /**
     * Subscribe to account changes (WebSocket)
     */
    onAccountChange(accountType: string, address: PublicKey, callback: (data: Record<string, any>) => void, onError?: (err: Error) => void): number;
    /**
     * Unsubscribe from account changes
     */
    removeListener(subscriptionId: number): Promise<void>;
    /**
     * Get instruction discriminator bytes
     */
    getDiscriminator(instructionName: string): Buffer;
    /**
     * Get account discriminator bytes
     */
    getAccountDiscriminator(accountType: string): Buffer;
}

/**
 * Compute 8-byte discriminator — Anchor-compatible.
 * For instructions: sha256("global:<name>")[0..8]
 * For accounts: sha256("account:<Name>")[0..8]
 * For events: sha256("event:<Name>")[0..8]
 */
declare function instructionDiscriminator(name: string): Buffer;
declare function accountDiscriminator(name: string): Buffer;
declare function eventDiscriminator(name: string): Buffer;

/**
 * Type registry for resolving `{ defined: "TypeName" }` references.
 * Populated from IDL `types[]` and `accounts[]`.
 */
type TypeRegistry = Map<string, IdlTypeDef>;
declare function buildTypeRegistry(types?: IdlTypeDef[], accounts?: {
    name: string;
    type: {
        kind: string;
        fields: IdlField[];
    };
}[]): TypeRegistry;
/**
 * Serialize instruction args to Buffer
 */
declare function serializeArgs(fields: IdlField[], values: Record<string, any>, registry?: TypeRegistry): Buffer;
/**
 * Deserialize account data from Buffer (skip 8-byte discriminator)
 */
declare function deserializeAccount(fields: IdlField[], data: Buffer, registry?: TypeRegistry): Record<string, any>;

export { ArlexClient, ArlexProgramError, type ExecuteOptions, type FetchOptions, type Idl, type IdlAccountDef, type IdlAccountItem, type IdlError, type IdlEvent, type IdlField, type IdlInstruction, type IdlType, type IdlTypeDef, type TypeRegistry, accountDiscriminator, buildTypeRegistry, decodeError, deserializeAccount, eventDiscriminator, extractErrorCode, instructionDiscriminator, serializeArgs };
