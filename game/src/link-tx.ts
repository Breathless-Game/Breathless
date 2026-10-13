// The desktop app's wallet relay, the parts both sides check by hand (no imports, so tests load
// this file straight from its TypeScript source):
//
//   - Solana's wire format, read byte by byte: a transaction's signature slots and its message
//     (legacy or v0: header, account keys, blockhash, instructions, address lookup tables);
//   - the app's check on what came back from the browser: the very message it sent, byte for
//     byte, except the 32-byte recentBlockhash; the same signer slots and fee payer; the owner's
//     slot holding a valid ed25519 signature over the returned message;
//   - the login message and its check;
//   - the link page's summary of a transaction, decoded from its bytes (never from text the app
//     sent): SOL and token amounts, Core NFT transfers and burns, which programs it calls.
//
// ed25519 itself is injected (`Verify`): the app passes @noble/curves, tests pass theirs.

export type Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;

// ---- Encodings -------------------------------------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error('Not base58');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** A 32-byte public key from its base58 address; throws on anything else. */
export function addressBytes(address: string): Uint8Array {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error('Not a Solana address');
  return b;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Wire format ---------------------------------------------------------------------

export interface CompiledInstruction {
  programIndex: number;
  accounts: number[];
  data: Uint8Array;
}

export interface LookupTable {
  account: Uint8Array;
  writable: number[];
  readonly: number[];
}

export interface ParsedMessage {
  version: 'legacy' | 0;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  /** The static account keys (32 bytes each); signers come first. */
  keys: Uint8Array[];
  blockhash: Uint8Array;
  /** Where the blockhash sits in the message bytes. */
  blockhashOffset: number;
  instructions: CompiledInstruction[];
  lookups: LookupTable[];
}

export interface ParsedTransaction {
  signatures: Uint8Array[];
  /** The message bytes (what every signature signs). */
  message: Uint8Array;
  /** Where the message starts in the transaction bytes. */
  messageOffset: number;
  parsed: ParsedMessage;
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  need(n: number) {
    if (this.pos + n > this.bytes.length) throw new Error('Truncated transaction');
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Solana's compact-u16 (1 to 3 bytes, 7 bits each). */
  shortVec(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      value |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) return value;
    }
    throw new Error('Bad compact-u16');
  }
}

export function parseMessage(bytes: Uint8Array): ParsedMessage {
  const r = new Reader(bytes);
  let version: 'legacy' | 0 = 'legacy';
  let first = r.u8();
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new Error(`Unsupported transaction version ${first & 0x7f}`);
    version = 0;
    first = r.u8();
  }
  const header = { numRequiredSignatures: first, numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  const keyCount = r.shortVec();
  const keys: Uint8Array[] = [];
  for (let i = 0; i < keyCount; i++) keys.push(r.take(32));
  if (header.numRequiredSignatures > keyCount || header.numRequiredSignatures < 1) throw new Error('Bad message header');
  const blockhashOffset = r.pos;
  const blockhash = r.take(32);
  const instructions: CompiledInstruction[] = [];
  const ixCount = r.shortVec();
  for (let i = 0; i < ixCount; i++) {
    const programIndex = r.u8();
    const accounts = Array.from(r.take(r.shortVec()));
    const data = r.take(r.shortVec());
    instructions.push({ programIndex, accounts, data });
  }
  const lookups: LookupTable[] = [];
  if (version === 0) {
    const n = r.shortVec();
    for (let i = 0; i < n; i++) {
      const account = r.take(32);
      const writable = Array.from(r.take(r.shortVec()));
      const readonly = Array.from(r.take(r.shortVec()));
      lookups.push({ account, writable, readonly });
    }
  }
  if (r.pos !== bytes.length) throw new Error('Trailing bytes after the message');
  return { version, header, keys, blockhash, blockhashOffset, instructions, lookups };
}

export function parseTransaction(bytes: Uint8Array): ParsedTransaction {
  const r = new Reader(bytes);
  const n = r.shortVec();
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(r.take(64));
  const messageOffset = r.pos;
  const message = bytes.subarray(messageOffset);
  const parsed = parseMessage(message);
  if (parsed.header.numRequiredSignatures !== n) throw new Error('Signature count does not match the message header');
  return { signatures, message, messageOffset, parsed };
}

/** A copy with every signature slot zeroed (what the relay carries: nothing signed yet). */
export function zeroSignatures(tx: Uint8Array): Uint8Array {
  const { messageOffset } = parseTransaction(tx);
  const out = tx.slice();
  const r = new Reader(out);
  const start = (r.shortVec(), r.pos);
  out.fill(0, start, messageOffset);
  return out;
}

/** A copy with `blockhash` (32 bytes) in place of the recentBlockhash, and every signature zeroed. */
export function withBlockhash(tx: Uint8Array, blockhash: Uint8Array): Uint8Array {
  if (blockhash.length !== 32) throw new Error('A blockhash is 32 bytes');
  const { messageOffset, parsed } = parseTransaction(tx);
  const out = zeroSignatures(tx);
  out.set(blockhash, messageOffset + parsed.blockhashOffset);
  return out;
}

/** Same bytes everywhere but the recentBlockhash: header, keys, instructions and lookup tables all identical. */
export function sameExceptBlockhash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const off = parseMessage(a).blockhashOffset;
  if (parseMessage(b).blockhashOffset !== off) return false;
  for (let i = 0; i < a.length; i++) if ((i < off || i >= off + 32) && a[i] !== b[i]) return false;
  return true;
}

// ---- The app's check on a signed transaction coming back --------------------------------

/** Why a relayed answer was refused: `message` in English, `zh` in 中文 (this file has no i18n import). */
export class RelayCheckError extends Error {
  constructor(
    message: string,
    readonly zh: string,
  ) {
    super(message);
    this.name = 'RelayCheckError';
  }
}

export interface RelayCheck {
  /** The returned message bytes (equal to what was sent but for the blockhash). */
  message: Uint8Array;
  ownerIndex: number;
  ownerSignature: Uint8Array;
  /** The returned message's blockhash, base58. */
  blockhash: string;
  blockhashChanged: boolean;
}

/**
 * Accept `got` (a signed transaction from the link page) only as a signature on `sent`: the same
 * signer slots, the same message byte for byte except the blockhash (unchanged too when
 * `keepBlockhash`), the owner a required signer, and the owner's slot a valid signature over the
 * returned message. Throws RelayCheckError saying what differed.
 */
export function checkRelayedTransaction(sent: Uint8Array, got: Uint8Array, owner: Uint8Array, verify: Verify, { keepBlockhash = false } = {}): RelayCheck {
  let a: ParsedTransaction;
  let b: ParsedTransaction;
  try {
    a = parseTransaction(sent);
    b = parseTransaction(got);
  } catch (e) {
    throw new RelayCheckError(`unreadable transaction (${(e as Error).message})`, '交易无法解析');
  }
  if (b.signatures.length !== a.signatures.length) throw new RelayCheckError('the signer slots changed', '签名位被改动了');
  if (!bytesEqual(a.parsed.keys[0], b.parsed.keys[0])) throw new RelayCheckError('the fee payer changed', '手续费支付方被改动了');
  if (!sameExceptBlockhash(a.message, b.message)) throw new RelayCheckError('the transaction was changed (more than its blockhash)', '交易内容被改动了（不只是 blockhash）');
  const blockhashChanged = !bytesEqual(a.parsed.blockhash, b.parsed.blockhash);
  if (keepBlockhash && blockhashChanged) throw new RelayCheckError('the blockhash had to stay as it was', 'blockhash 不应被改动');
  const n = a.parsed.header.numRequiredSignatures;
  const ownerIndex = a.parsed.keys.findIndex((k, i) => i < n && bytesEqual(k, owner));
  if (ownerIndex < 0) throw new RelayCheckError('the owner is not a signer of this transaction', '钱包所有者不是这笔交易的签名方');
  const ownerSignature = b.signatures[ownerIndex];
  if (!verify(ownerSignature, b.message, owner)) throw new RelayCheckError("the owner's signature is not valid", '所有者的签名无效');
  return { message: b.message.slice(), ownerIndex, ownerSignature: ownerSignature.slice(), blockhash: base58Encode(b.parsed.blockhash), blockhashChanged };
}

// ---- Login ---------------------------------------------------------------------------

export interface LoginParts {
  sid: string;
  nonce: string;
  expiresAt: number;
  origin: string;
}

/** The text the browser wallet signs to log the desktop app in. Both sides build it from the same parts. */
export function loginMessage({ sid, nonce, expiresAt, origin }: LoginParts): string {
  for (const part of [sid, nonce, String(expiresAt), origin]) if (!part || part.includes('|')) throw new Error('Bad login message part');
  return `breathless-desktop-login|${sid}|${nonce}|${expiresAt}|${origin}`;
}

/** The signature is `address`'s, over exactly `expected`. Returns the address, or throws. */
export function checkLogin(expected: string, address: string, signature: Uint8Array, verify: Verify): string {
  let key: Uint8Array;
  try {
    key = addressBytes(address);
  } catch {
    throw new RelayCheckError('the wallet address is malformed', '钱包地址格式不对');
  }
  if (signature.length !== 64) throw new RelayCheckError('the signature is malformed', '签名格式不对');
  if (!verify(signature, new TextEncoder().encode(expected), key)) throw new RelayCheckError('the login signature is not valid', '登录签名无效');
  return address;
}

// ---- Summary (the link page) ---------------------------------------------------------

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/** An account an instruction names: its address, or that it comes from a lookup table. */
export type Account = string;

export type InstructionSummary =
  | { kind: 'sol-transfer'; from: Account; to: Account; lamports: bigint }
  | { kind: 'create-account'; from: Account; account: Account; lamports: bigint }
  | { kind: 'token-transfer'; program: string; source: Account; destination: Account; authority: Account; amount: bigint; decimals?: number; mint?: Account }
  | { kind: 'token-burn'; program: string; account: Account; mint: Account; authority: Account; amount: bigint; decimals?: number }
  | { kind: 'core-transfer'; asset: Account; newOwner: Account; authority: Account; collection?: Account }
  | { kind: 'core-burn'; asset: Account; authority: Account }
  | { kind: 'create-token-account'; owner: Account; mint: Account }
  | { kind: 'compute-budget'; units?: number; microLamports?: bigint }
  | { kind: 'memo'; text: string }
  | { kind: 'named'; program: string; label: string; name: string }
  | { kind: 'unknown'; program: string; label?: string; bytes: number };

export interface TxSummary {
  feePayer: string;
  signers: string[];
  blockhash: string;
  version: 'legacy' | 0;
  usesLookupTables: boolean;
  instructions: InstructionSummary[];
}

/** Programs the page can name, and their Anchor instructions by 8-byte discriminator (hex). */
export interface ProgramLabels {
  [programId: string]: { label: string; instructions?: Record<string, string> };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function u64(data: Uint8Array, at: number): bigint {
  if (data.length < at + 8) throw new Error('short');
  return new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true);
}
function u32(data: Uint8Array, at: number): number {
  if (data.length < at + 4) throw new Error('short');
  return new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true);
}

/** Every account of `m` by index: static keys first, then lookup-table entries (named as such). */
function accountNames(m: ParsedMessage): Account[] {
  const names = m.keys.map(base58Encode);
  for (const t of m.lookups) for (const i of t.writable) names.push(`${base58Encode(t.account)}#${i}`);
  for (const t of m.lookups) for (const i of t.readonly) names.push(`${base58Encode(t.account)}#${i}`);
  return names;
}

function summarizeInstruction(ix: CompiledInstruction, names: Account[], labels: ProgramLabels): InstructionSummary {
  const program = names[ix.programIndex] ?? '?';
  const acc = (i: number) => names[ix.accounts[i]] ?? '?';
  const d = ix.data;
  try {
    if (program === SYSTEM_PROGRAM) {
      const index = u32(d, 0);
      if (index === 2 && d.length === 12) return { kind: 'sol-transfer', from: acc(0), to: acc(1), lamports: u64(d, 4) };
      if (index === 0 && d.length >= 52) return { kind: 'create-account', from: acc(0), account: acc(1), lamports: u64(d, 4) };
    }
    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const which = program === TOKEN_PROGRAM ? 'Token' : 'Token-2022';
      if (d[0] === 3 && d.length === 9) return { kind: 'token-transfer', program: which, source: acc(0), destination: acc(1), authority: acc(2), amount: u64(d, 1) };
      if (d[0] === 12 && d.length === 10) return { kind: 'token-transfer', program: which, source: acc(0), mint: acc(1), destination: acc(2), authority: acc(3), amount: u64(d, 1), decimals: d[9] };
      if (d[0] === 8 && d.length === 9) return { kind: 'token-burn', program: which, account: acc(0), mint: acc(1), authority: acc(2), amount: u64(d, 1) };
      if (d[0] === 15 && d.length === 10) return { kind: 'token-burn', program: which, account: acc(0), mint: acc(1), authority: acc(2), amount: u64(d, 1), decimals: d[9] };
    }
    if (program === CORE_PROGRAM) {
      // Optional accounts the caller left out are the program id itself (mpl-core's builders).
      const opt = (i: number) => (acc(i) === CORE_PROGRAM ? undefined : acc(i));
      if (d[0] === 14) return { kind: 'core-transfer', asset: acc(0), collection: opt(1), authority: opt(3) ?? acc(2), newOwner: acc(4) };
      if (d[0] === 12) return { kind: 'core-burn', asset: acc(0), authority: opt(3) ?? acc(2) };
    }
    if (program === ATA_PROGRAM && (d.length === 0 || d[0] === 0 || d[0] === 1)) return { kind: 'create-token-account', owner: acc(2), mint: acc(3) };
    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (d[0] === 2 && d.length === 5) return { kind: 'compute-budget', units: u32(d, 1) };
      if (d[0] === 3 && d.length === 9) return { kind: 'compute-budget', microLamports: u64(d, 1) };
    }
    if (program === MEMO_PROGRAM) return { kind: 'memo', text: new TextDecoder().decode(d).slice(0, 200) };
  } catch {
    // Too short for what it claims to be: shown as unknown below.
  }
  const known = labels[program];
  const name = known?.instructions && d.length >= 8 ? known.instructions[hex(d.subarray(0, 8))] : undefined;
  if (known && name) return { kind: 'named', program, label: known.label, name };
  return { kind: 'unknown', program, ...(known ? { label: known.label } : {}), bytes: d.length };
}

/** What a transaction does, read from its bytes. */
export function summarizeTransaction(tx: Uint8Array, labels: ProgramLabels = {}): TxSummary {
  const { parsed } = parseTransaction(tx);
  const names = accountNames(parsed);
  return {
    feePayer: names[0],
    signers: names.slice(0, parsed.header.numRequiredSignatures),
    blockhash: base58Encode(parsed.blockhash),
    version: parsed.version,
    usesLookupTables: parsed.lookups.length > 0,
    instructions: parsed.instructions.map((ix) => summarizeInstruction(ix, names, labels)),
  };
}

/** Anchor discriminators (number arrays, as player-state.ts keeps them) keyed by hex, for ProgramLabels. */
export function anchorNames(discriminators: Record<string, readonly number[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(discriminators).map(([name, d]) => [hex(Uint8Array.from(d)), name]));
}

/** Lamports as SOL text, exactly (no float rounding). */
export function formatUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}
