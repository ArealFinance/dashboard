import { readable } from 'svelte/store';
import idl from '$lib/idl/ownership-token.json';
import futarchyIdl from '$lib/idl/futarchy.json';
import rwtIdl from '$lib/idl/rwt-engine.json';
import dexIdl from '$lib/idl/native-dex.json';

/**
 * Protocol program descriptor
 */
export interface ProtocolProgram {
  id: string;
  name: string;
  programId: string | null;
  status: 'deployed' | 'pending';
  layer: string;
  idlPath: string | null;
  instructions: number;
  description: string;
  binaryName?: string;
}

/**
 * Cross-Program Invocation link between two programs
 */
export interface CpiLink {
  from: string;
  to: string;
  instruction: string;
  description: string;
  status: 'active' | 'pending';
}

// OT program ID from IDL metadata (or system program placeholder)
const OT_PROGRAM_ID = idl.metadata?.address ?? null;

/**
 * All Areal protocol programs — single source of truth
 */
export const PROTOCOL_PROGRAMS: ProtocolProgram[] = [
  {
    id: 'ot',
    name: 'Ownership Token',
    programId: OT_PROGRAM_ID,
    status: OT_PROGRAM_ID ? 'deployed' : 'pending',
    layer: '1',
    idlPath: '$lib/idl/ownership-token.json',
    instructions: 7,
    description: 'Tokenized ownership, revenue distribution, treasury management',
    binaryName: 'ownership_token'
  },
  {
    id: 'futarchy',
    name: 'Futarchy',
    programId: futarchyIdl.metadata?.address ?? null,
    status: futarchyIdl.metadata?.address ? 'deployed' : 'pending',
    layer: '2',
    idlPath: '$lib/idl/futarchy.json',
    instructions: 8,
    description: 'Per-OT governance, proposal execution via CPI'
  },
  {
    id: 'rwt',
    name: 'RWT Engine',
    programId: rwtIdl.metadata?.address ?? null,
    status: rwtIdl.metadata?.address ? 'deployed' : 'pending',
    layer: '3',
    idlPath: '$lib/idl/rwt-engine.json',
    instructions: 10,
    description: 'Reward token minting, NAV pricing, vault management',
    binaryName: 'rwt_engine'
  },
  {
    id: 'dex',
    name: 'Native DEX',
    programId: dexIdl.metadata?.address ?? null,
    status: dexIdl.metadata?.address ? 'deployed' : 'pending',
    layer: '4-5',
    idlPath: '$lib/idl/native-dex.json',
    instructions: 12,
    description: 'StandardCurve AMM pools, swaps, LP management',
    binaryName: 'native_dex'
  },
  {
    id: 'yd',
    name: 'Yield Distribution',
    programId: null,
    status: 'pending',
    layer: '7',
    idlPath: null,
    instructions: 11,
    description: 'Merkle streams, RWT distribution to OT holders'
  }
];

/**
 * All CPI links between Areal programs
 */
export const CPI_LINKS: CpiLink[] = [
  // Futarchy -> OT
  { from: 'futarchy', to: 'ot', instruction: 'mint_ot', description: 'Mint OT tokens via governance proposal', status: 'pending' },
  { from: 'futarchy', to: 'ot', instruction: 'spend_treasury', description: 'Spend from OT treasury via governance', status: 'pending' },
  { from: 'futarchy', to: 'ot', instruction: 'batch_update_destinations', description: 'Update revenue destinations via governance', status: 'pending' },
  { from: 'futarchy', to: 'ot', instruction: 'accept_authority', description: 'Accept governance authority transfer', status: 'pending' },

  // RWT Engine -> DEX
  { from: 'rwt', to: 'dex', instruction: 'vault_swap', description: 'Swap vault assets via DEX', status: 'pending' },

  // RWT Engine -> YD
  { from: 'rwt', to: 'yd', instruction: 'claim_yield', description: 'Claim yield from distribution', status: 'pending' },

  // YD -> DEX
  { from: 'yd', to: 'dex', instruction: 'convert_to_rwt', description: 'Convert revenue to RWT via DEX swap', status: 'pending' },

  // YD -> RWT Engine
  { from: 'yd', to: 'rwt', instruction: 'mint_rwt', description: 'Mint RWT reward tokens', status: 'pending' },

  // DEX -> YD
  { from: 'dex', to: 'yd', instruction: 'compound_yield', description: 'Compound yield back into distribution', status: 'pending' },

  // OT -> YD
  { from: 'ot', to: 'yd', instruction: 'claim_yd_for_treasury', description: 'Claim yield distribution for OT treasury', status: 'pending' }
];

/**
 * Readable store — provides programs and CPI links
 */
export const protocolRegistry = readable({
  programs: PROTOCOL_PROGRAMS,
  links: CPI_LINKS,

  getProgram(id: string): ProtocolProgram | undefined {
    return PROTOCOL_PROGRAMS.find(p => p.id === id);
  },

  getProgramByAddress(address: string): ProtocolProgram | undefined {
    return PROTOCOL_PROGRAMS.find(p => p.programId === address);
  },

  getLinksFrom(programId: string): CpiLink[] {
    return CPI_LINKS.filter(l => l.from === programId);
  },

  getLinksTo(programId: string): CpiLink[] {
    return CPI_LINKS.filter(l => l.to === programId);
  },

  getLinksFor(programId: string): CpiLink[] {
    return CPI_LINKS.filter(l => l.from === programId || l.to === programId);
  },

  get deployedCount(): number {
    return PROTOCOL_PROGRAMS.filter(p => p.status === 'deployed').length;
  },

  get totalInstructions(): number {
    return PROTOCOL_PROGRAMS.reduce((s, p) => s + p.instructions, 0);
  }
});
