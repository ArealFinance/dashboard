"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ArlexClient: () => ArlexClient,
  ArlexProgramError: () => ArlexProgramError,
  accountDiscriminator: () => accountDiscriminator,
  buildTypeRegistry: () => buildTypeRegistry,
  decodeError: () => decodeError,
  deserializeAccount: () => deserializeAccount,
  eventDiscriminator: () => eventDiscriminator,
  extractErrorCode: () => extractErrorCode,
  instructionDiscriminator: () => instructionDiscriminator,
  serializeArgs: () => serializeArgs
});
module.exports = __toCommonJS(index_exports);

// src/client.ts
var import_web32 = require("@solana/web3.js");
var import_bs58 = __toESM(require("bs58"));

// src/discriminator.ts
var import_crypto = require("crypto");
function instructionDiscriminator(name) {
  return (0, import_crypto.createHash)("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function accountDiscriminator(name) {
  return (0, import_crypto.createHash)("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
function eventDiscriminator(name) {
  return (0, import_crypto.createHash)("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

// src/serialization.ts
var import_web3 = require("@solana/web3.js");
var MAX_VEC_LEN = 1048576;
function buildTypeRegistry(types, accounts) {
  const registry = /* @__PURE__ */ new Map();
  if (types) {
    for (const t of types) registry.set(t.name, t);
  }
  if (accounts) {
    for (const a of accounts) {
      registry.set(a.name, { name: a.name, type: a.type });
    }
  }
  return registry;
}
function serializeArgs(fields, values, registry) {
  const buffers = [];
  for (const field of fields) {
    const val = values[field.name];
    const isOption = typeof field.type === "object" && "option" in field.type;
    if (val === void 0 && !isOption) throw new Error(`Missing arg: ${field.name}`);
    buffers.push(serializeType(field.type, val, registry));
  }
  return Buffer.concat(buffers);
}
function serializeType(type, value, registry) {
  if (typeof type === "string") {
    switch (type) {
      case "u8": {
        const b = Buffer.alloc(1);
        b.writeUInt8(value);
        return b;
      }
      case "i8": {
        const b = Buffer.alloc(1);
        b.writeInt8(value);
        return b;
      }
      case "u16": {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(value);
        return b;
      }
      case "i16": {
        const b = Buffer.alloc(2);
        b.writeInt16LE(value);
        return b;
      }
      case "u32": {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(value);
        return b;
      }
      case "i32": {
        const b = Buffer.alloc(4);
        b.writeInt32LE(value);
        return b;
      }
      case "u64": {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(value));
        return b;
      }
      case "i64": {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(BigInt(value));
        return b;
      }
      case "u128": {
        const n = BigInt(value);
        const b = Buffer.alloc(16);
        b.writeBigUInt64LE(n & BigInt("0xFFFFFFFFFFFFFFFF"), 0);
        b.writeBigUInt64LE(n >> BigInt(64), 8);
        return b;
      }
      case "i128": {
        const n = BigInt(value);
        const b = Buffer.alloc(16);
        b.writeBigUInt64LE(n & BigInt("0xFFFFFFFFFFFFFFFF"), 0);
        b.writeBigInt64LE(n >> BigInt(64), 8);
        return b;
      }
      case "f32": {
        const b = Buffer.alloc(4);
        b.writeFloatLE(value);
        return b;
      }
      case "f64": {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(value);
        return b;
      }
      case "bool":
        return Buffer.from([value ? 1 : 0]);
      case "publicKey": {
        const pk = value instanceof import_web3.PublicKey ? value : new import_web3.PublicKey(value);
        return pk.toBuffer();
      }
      case "string": {
        const strBuf = Buffer.from(value, "utf8");
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(strBuf.length);
        return Buffer.concat([lenBuf, strBuf]);
      }
      case "bytes": {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(bytes.length);
        return Buffer.concat([lenBuf, bytes]);
      }
      default:
        throw new Error(`Unknown primitive type: ${type}`);
    }
  }
  if ("array" in type) {
    const [itemType, size] = type.array;
    if (itemType === "u8" && (Buffer.isBuffer(value) || Array.isArray(value))) {
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const result = Buffer.alloc(size);
      buf.copy(result, 0, 0, Math.min(buf.length, size));
      return result;
    }
    const bufs = [];
    for (let i = 0; i < size; i++) bufs.push(serializeType(itemType, value[i], registry));
    return Buffer.concat(bufs);
  }
  if ("vec" in type) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(value.length);
    const items = value.map((v) => serializeType(type.vec, v, registry));
    return Buffer.concat([lenBuf, ...items]);
  }
  if ("option" in type) {
    if (value === null || value === void 0) return Buffer.from([0]);
    return Buffer.concat([Buffer.from([1]), serializeType(type.option, value, registry)]);
  }
  if ("defined" in type) {
    if (!registry) throw new Error(`No type registry for defined type: ${type.defined}`);
    const typeDef = registry.get(type.defined);
    if (!typeDef) throw new Error(`Unknown defined type: ${type.defined}`);
    if (typeDef.type.kind === "struct" && typeDef.type.fields) {
      const bufs = [];
      for (const field of typeDef.type.fields) {
        const val = value[field.name];
        if (val === void 0) throw new Error(`Missing field '${field.name}' for type '${type.defined}'`);
        bufs.push(serializeType(field.type, val, registry));
      }
      return Buffer.concat(bufs);
    }
    if (typeDef.type.kind === "enum" && typeDef.type.variants) {
      const variantName = typeof value === "string" ? value : value?.variant;
      const idx = typeDef.type.variants.findIndex((v) => v.name === variantName);
      if (idx === -1) throw new Error(`Unknown variant '${variantName}' for enum '${type.defined}'`);
      return Buffer.from([idx]);
    }
    throw new Error(`Unsupported defined type kind: ${typeDef.type.kind}`);
  }
  throw new Error(`Cannot serialize type: ${JSON.stringify(type)}`);
}
function deserializeAccount(fields, data, registry) {
  if (data.length < 8) throw new Error(`Account data too short: ${data.length} bytes (need at least 8)`);
  let offset = 8;
  const result = {};
  for (const field of fields) {
    if (offset >= data.length) throw new Error(`Buffer exhausted at field '${field.name}' (offset ${offset}, length ${data.length})`);
    const { value, bytesRead } = deserializeType(field.type, data, offset, registry);
    result[field.name] = value;
    offset += bytesRead;
  }
  return result;
}
function ensureBytes(data, offset, need, context) {
  if (offset + need > data.length) {
    throw new Error(`Buffer too short for ${context}: need ${need} bytes at offset ${offset}, have ${data.length}`);
  }
}
function deserializeType(type, data, offset, registry) {
  if (typeof type === "string") {
    switch (type) {
      case "u8":
        ensureBytes(data, offset, 1, "u8");
        return { value: data.readUInt8(offset), bytesRead: 1 };
      case "i8":
        ensureBytes(data, offset, 1, "i8");
        return { value: data.readInt8(offset), bytesRead: 1 };
      case "u16":
        ensureBytes(data, offset, 2, "u16");
        return { value: data.readUInt16LE(offset), bytesRead: 2 };
      case "i16":
        ensureBytes(data, offset, 2, "i16");
        return { value: data.readInt16LE(offset), bytesRead: 2 };
      case "u32":
        ensureBytes(data, offset, 4, "u32");
        return { value: data.readUInt32LE(offset), bytesRead: 4 };
      case "i32":
        ensureBytes(data, offset, 4, "i32");
        return { value: data.readInt32LE(offset), bytesRead: 4 };
      case "u64":
        ensureBytes(data, offset, 8, "u64");
        return { value: data.readBigUInt64LE(offset), bytesRead: 8 };
      case "i64":
        ensureBytes(data, offset, 8, "i64");
        return { value: data.readBigInt64LE(offset), bytesRead: 8 };
      case "u128": {
        ensureBytes(data, offset, 16, "u128");
        const lo = data.readBigUInt64LE(offset);
        const hi = data.readBigUInt64LE(offset + 8);
        return { value: hi << BigInt(64) | lo, bytesRead: 16 };
      }
      case "i128": {
        ensureBytes(data, offset, 16, "i128");
        const lo = data.readBigUInt64LE(offset);
        const hi = data.readBigInt64LE(offset + 8);
        return { value: hi << BigInt(64) | lo, bytesRead: 16 };
      }
      case "f32":
        ensureBytes(data, offset, 4, "f32");
        return { value: data.readFloatLE(offset), bytesRead: 4 };
      case "f64":
        ensureBytes(data, offset, 8, "f64");
        return { value: data.readDoubleLE(offset), bytesRead: 8 };
      case "bool":
        ensureBytes(data, offset, 1, "bool");
        return { value: data[offset] !== 0, bytesRead: 1 };
      case "publicKey":
        ensureBytes(data, offset, 32, "publicKey");
        return { value: new import_web3.PublicKey(data.subarray(offset, offset + 32)), bytesRead: 32 };
      case "string": {
        ensureBytes(data, offset, 4, "string length");
        const len = data.readUInt32LE(offset);
        if (len > MAX_VEC_LEN) throw new Error(`String too long: ${len}`);
        ensureBytes(data, offset + 4, len, "string data");
        const str = data.subarray(offset + 4, offset + 4 + len).toString("utf8");
        return { value: str, bytesRead: 4 + len };
      }
      case "bytes": {
        ensureBytes(data, offset, 4, "bytes length");
        const len = data.readUInt32LE(offset);
        if (len > MAX_VEC_LEN) throw new Error(`Bytes too long: ${len}`);
        ensureBytes(data, offset + 4, len, "bytes data");
        return { value: data.subarray(offset + 4, offset + 4 + len), bytesRead: 4 + len };
      }
      default:
        throw new Error(`Unknown primitive type: ${type}`);
    }
  }
  if ("array" in type) {
    const [itemType, size] = type.array;
    if (itemType === "u8") {
      ensureBytes(data, offset, size, `[u8; ${size}]`);
      return { value: data.subarray(offset, offset + size), bytesRead: size };
    }
    const arr = [];
    let total = 0;
    for (let i = 0; i < size; i++) {
      const { value, bytesRead } = deserializeType(itemType, data, offset + total, registry);
      arr.push(value);
      total += bytesRead;
    }
    return { value: arr, bytesRead: total };
  }
  if ("vec" in type) {
    ensureBytes(data, offset, 4, "vec length");
    const len = data.readUInt32LE(offset);
    if (len > MAX_VEC_LEN) throw new Error(`Vec too long: ${len} (max ${MAX_VEC_LEN})`);
    const arr = [];
    let total = 4;
    for (let i = 0; i < len; i++) {
      const { value, bytesRead } = deserializeType(type.vec, data, offset + total, registry);
      arr.push(value);
      total += bytesRead;
    }
    return { value: arr, bytesRead: total };
  }
  if ("option" in type) {
    ensureBytes(data, offset, 1, "option tag");
    const tag = data[offset];
    if (tag === 0) return { value: null, bytesRead: 1 };
    const { value, bytesRead } = deserializeType(type.option, data, offset + 1, registry);
    return { value, bytesRead: 1 + bytesRead };
  }
  if ("defined" in type) {
    if (!registry) throw new Error(`No type registry for defined type: ${type.defined}`);
    const typeDef = registry.get(type.defined);
    if (!typeDef) throw new Error(`Unknown defined type: ${type.defined}`);
    if (typeDef.type.kind === "struct" && typeDef.type.fields) {
      const obj = {};
      let total = 0;
      for (const field of typeDef.type.fields) {
        const { value, bytesRead } = deserializeType(field.type, data, offset + total, registry);
        obj[field.name] = value;
        total += bytesRead;
      }
      return { value: obj, bytesRead: total };
    }
    if (typeDef.type.kind === "enum" && typeDef.type.variants) {
      ensureBytes(data, offset, 1, "enum variant");
      const idx = data[offset];
      const variant = typeDef.type.variants[idx];
      if (!variant) throw new Error(`Unknown variant index ${idx} for enum ${type.defined}`);
      return { value: variant.name, bytesRead: 1 };
    }
    throw new Error(`Unsupported defined type kind: ${typeDef.type.kind}`);
  }
  throw new Error(`Cannot deserialize type: ${JSON.stringify(type)}`);
}

// src/errors.ts
var ArlexProgramError = class extends Error {
  constructor(code, errorName, message) {
    super(`${errorName} (${code}): ${message}`);
    this.code = code;
    this.errorName = errorName;
    this.name = "ArlexProgramError";
  }
};
function decodeError(code, errors) {
  const found = errors.find((e) => e.code === code);
  if (found) {
    return new ArlexProgramError(found.code, found.name, found.msg);
  }
  return new ArlexProgramError(code, "UnknownError", `Error code: ${code}`);
}
function extractErrorCode(err) {
  const instrErr = err?.InstructionError || err?.instructionError;
  if (Array.isArray(instrErr) && instrErr[1]?.Custom !== void 0) {
    return instrErr[1].Custom;
  }
  const msg = err?.message || err?.toString?.() || "";
  const match = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (match) return parseInt(match[1], 16);
  return null;
}

// src/client.ts
var ArlexClient = class {
  constructor(idl, programId, connection) {
    this.idl = idl;
    this.programId = programId;
    this.connection = connection;
    this.instructionMap = new Map((idl.instructions ?? []).map((ix) => [ix.name, ix]));
    this.accountMap = new Map((idl.accounts ?? []).map((acc) => [acc.name, acc]));
    this.typeRegistry = buildTypeRegistry(idl.types ?? [], idl.accounts ?? []);
  }
  /**
   * Build a Transaction without sending — for wallet adapter integration.
   * Returns the transaction for external signing (Phantom, Solflare, etc.)
   */
  buildTransaction(instructionName, options) {
    const ix = this.buildInstruction(instructionName, options);
    const tx = new import_web32.Transaction();
    if (options.computeUnits) {
      tx.add(import_web32.ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnits }));
    }
    if (options.priorityFee) {
      tx.add(import_web32.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.priorityFee }));
    }
    tx.add(ix);
    return tx;
  }
  /**
   * Build a single TransactionInstruction
   */
  buildInstruction(instructionName, options) {
    const ixDef = this.instructionMap.get(instructionName);
    if (!ixDef) throw new Error(`Unknown instruction: ${instructionName}. Available: ${[...this.instructionMap.keys()].join(", ")}`);
    const disc = instructionDiscriminator(instructionName);
    const argsData = ixDef.args.length > 0 && options.args ? serializeArgs(ixDef.args, options.args, this.typeRegistry) : Buffer.alloc(0);
    const data = Buffer.concat([disc, argsData]);
    const keys = ixDef.accounts.map((accDef) => {
      const pubkey = options.accounts[accDef.name];
      if (!pubkey) throw new Error(`Missing account '${accDef.name}' for instruction '${instructionName}'`);
      return { pubkey, isSigner: accDef.isSigner, isWritable: accDef.isMut };
    });
    if (options.remainingAccounts) {
      keys.push(...options.remainingAccounts);
    }
    return new import_web32.TransactionInstruction({ keys, programId: this.programId, data });
  }
  /**
   * Execute an instruction with Keypair signing (for scripts/CLI)
   */
  async execute(instructionName, options, payer) {
    const tx = this.buildTransaction(instructionName, options);
    tx.feePayer = payer.publicKey;
    const signers = [payer, ...options.signers || []];
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      const sig = await this.connection.sendTransaction(tx, signers, {
        skipPreflight: false,
        preflightCommitment: "confirmed"
      });
      await this.pollConfirmation(sig, lastValidBlockHeight);
      return sig;
    } catch (err) {
      const code = extractErrorCode(err);
      if (code !== null && this.idl.errors) {
        throw decodeError(code, this.idl.errors);
      }
      throw err;
    }
  }
  /**
   * Poll getSignatureStatuses until confirmed or expired.
   * Works without WebSocket — pure HTTP polling.
   */
  async pollConfirmation(signature, lastValidBlockHeight, intervalMs = 1e3, timeoutMs = 6e4) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value?.[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return;
        }
      }
      const blockHeight = await this.connection.getBlockHeight("confirmed");
      if (blockHeight > lastValidBlockHeight) {
        throw new Error("Transaction expired: block height exceeded");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
  }
  /**
   * Fetch and deserialize an account
   */
  async fetch(accountType, address, options) {
    const accDef = this.accountMap.get(accountType);
    if (!accDef) throw new Error(`Unknown account type: ${accountType}. Available: ${[...this.accountMap.keys()].join(", ")}`);
    const info = await this.connection.getAccountInfo(address, options?.commitment || "confirmed");
    if (!info) throw new Error(`Account not found: ${address.toBase58()}`);
    if (!info.owner.equals(this.programId)) {
      throw new Error(`Account ${address.toBase58()} owned by ${info.owner.toBase58()}, expected ${this.programId.toBase58()}`);
    }
    const expectedDisc = accountDiscriminator(accountType);
    const actualDisc = info.data.subarray(0, 8);
    if (!expectedDisc.equals(actualDisc)) {
      throw new Error(`Discriminator mismatch for ${accountType}: expected ${expectedDisc.toString("hex")}, got ${actualDisc.toString("hex")}`);
    }
    return deserializeAccount(accDef.type.fields, info.data, this.typeRegistry);
  }
  /**
   * Fetch all accounts of a given type (via getProgramAccounts + discriminator filter)
   */
  async fetchAll(accountType, options) {
    const accDef = this.accountMap.get(accountType);
    if (!accDef) throw new Error(`Unknown account type: ${accountType}`);
    const disc = accountDiscriminator(accountType);
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: options?.commitment || "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: import_bs58.default.encode(disc) } }
      ]
    });
    return accounts.map(({ pubkey, account }) => ({
      address: pubkey,
      data: deserializeAccount(accDef.type.fields, account.data, this.typeRegistry)
    }));
  }
  /**
   * Simulate a transaction (dry run)
   */
  async simulate(instructionName, options, feePayer) {
    const tx = this.buildTransaction(instructionName, options);
    tx.feePayer = feePayer;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const sim = await this.connection.simulateTransaction(tx, void 0);
    let error = null;
    if (sim.value.err) {
      const code = extractErrorCode(sim.value.err);
      if (code !== null && this.idl.errors) {
        error = decodeError(code, this.idl.errors);
      }
    }
    return {
      success: sim.value.err === null,
      logs: sim.value.logs || [],
      unitsConsumed: sim.value.unitsConsumed || 0,
      error
    };
  }
  /**
   * Subscribe to account changes (WebSocket)
   */
  onAccountChange(accountType, address, callback, onError) {
    const accDef = this.accountMap.get(accountType);
    if (!accDef) throw new Error(`Unknown account type: ${accountType}`);
    return this.connection.onAccountChange(address, (info) => {
      try {
        const data = deserializeAccount(accDef.type.fields, info.data, this.typeRegistry);
        callback(data);
      } catch (err) {
        if (onError) {
          onError(err);
        } else {
          console.warn(`[arlex] Failed to deserialize ${accountType} at ${address.toBase58()}:`, err.message);
        }
      }
    }, "confirmed");
  }
  /**
   * Unsubscribe from account changes
   */
  async removeListener(subscriptionId) {
    await this.connection.removeAccountChangeListener(subscriptionId);
  }
  /**
   * Get instruction discriminator bytes
   */
  getDiscriminator(instructionName) {
    return instructionDiscriminator(instructionName);
  }
  /**
   * Get account discriminator bytes
   */
  getAccountDiscriminator(accountType) {
    return accountDiscriminator(accountType);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ArlexClient,
  ArlexProgramError,
  accountDiscriminator,
  buildTypeRegistry,
  decodeError,
  deserializeAccount,
  eventDiscriminator,
  extractErrorCode,
  instructionDiscriminator,
  serializeArgs
});
