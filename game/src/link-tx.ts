// The desktop app's wallet relay, the parts both sides check by hand (no imports, so tests load
// this file straight from its TypeScript source):
//
//   - Solana's wire format, read byte by byte: a transaction's signature slots and its message
//     (legacy or v0: header, account keys, blockhash, instructions, address lookup tables);
//   - the relay's own compute budget (withComputeBudget), so a browser wallet has no priority fee
//     to add while signing;
//   - the one rule both sides apply to what came back from the browser (checkWalletEdits): the
//     message it sent but for the recentBlockhash and the wallet's compute budget, everything else
//     the same once decompiled; and the app's check (checkRelayedTransaction): that rule, the same
//     signer slots, the owner's slot holding a valid ed25519 signature over the returned message;
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

// ---- The relay's compute budget ------------------------------------------------------
//
// Phantom adds a priority fee (ComputeBudget instructions) to any transaction it signs that has no
// signature yet and neither a SetComputeUnitLimit nor a SetComputeUnitPrice, as long as it still
// fits in a packet (docs.phantom.com/developer-powertools/solana-priority-fees). The relay zeroes
// the signatures it sends, so it puts its own compute budget in first.

export const PACKET_SIZE = 1232;
/** What the runtime grants an instruction when the transaction sets no limit, and the cap. */
export const DEFAULT_INSTRUCTION_UNITS = 200_000;
export const MAX_COMPUTE_UNITS = 1_400_000;
/** The relay's price, micro-lamports per compute unit: at most 0.000014 SOL on 1.4M units. */
export const RELAY_MICRO_LAMPORTS_PER_UNIT = 10_000n;
/**
 * The most priority fee a wallet may put on a relayed transaction, in lamports: 0.001 SOL, 200
 * times the 5000-lamport signature fee and far above what a wallet asks for a transaction this
 * small, yet a bounded loss if one asks for much more.
 */
export const MAX_WALLET_PRIORITY_FEE = 1_000_000n;

function shortVecBytes(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (!n) return [...out, b];
    out.push(b | 0x80);
  }
}

/** A parsed message back to its bytes (parseMessage's inverse). */
export function serializeMessage(m: ParsedMessage): Uint8Array {
  const out: number[] = [];
  if (m.version === 0) out.push(0x80);
  out.push(m.header.numRequiredSignatures, m.header.numReadonlySigned, m.header.numReadonlyUnsigned, ...shortVecBytes(m.keys.length));
  for (const k of m.keys) out.push(...k);
  out.push(...m.blockhash, ...shortVecBytes(m.instructions.length));
  for (const ix of m.instructions) out.push(ix.programIndex, ...shortVecBytes(ix.accounts.length), ...ix.accounts, ...shortVecBytes(ix.data.length), ...ix.data);
  if (m.version === 0) {
    out.push(...shortVecBytes(m.lookups.length));
    for (const t of m.lookups) out.push(...t.account, ...shortVecBytes(t.writable.length), ...t.writable, ...shortVecBytes(t.readonly.length), ...t.readonly);
  }
  return Uint8Array.from(out);
}

/** SetComputeUnitLimit (2, u32) or SetComputeUnitPrice (3, u64), little-endian. */
function budgetData(kind: 2 | 3, value: bigint): Uint8Array {
  const d = new Uint8Array(kind === 2 ? 5 : 9);
  d[0] = kind;
  const view = new DataView(d.buffer);
  if (kind === 2) view.setUint32(1, Number(value), true);
  else view.setBigUint64(1, value, true);
  return d;
}

/** The units a transaction gets without a SetComputeUnitLimit (an upper bound: builtins get less). */
export function defaultComputeUnits(instructions: number): number {
  return Math.min(MAX_COMPUTE_UNITS, DEFAULT_INSTRUCTION_UNITS * instructions);
}

/** Limit times price, in lamports (rounded up, as the runtime does). */
export function priorityFeeLamports(units: number, microLamports: bigint): bigint {
  return (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
}

/**
 * A copy of `tx` with every signature zeroed and the relay's compute budget in front: a limit of
 * what the runtime would grant anyway (200k per instruction, at most 1.4M, so nothing gets less
 * compute than before) and a small price. `tx` itself when it has a compute budget already, uses
 * lookup tables (none of the app's do), or would no longer fit in a packet.
 */
export function withComputeBudget(tx: Uint8Array, microLamports = RELAY_MICRO_LAMPORTS_PER_UNIT): Uint8Array {
  const { signatures, parsed: m } = parseTransaction(tx);
  const program = addressBytes(COMPUTE_BUDGET_PROGRAM);
  if (!m.instructions.length || m.lookups.length || m.keys.some((k) => bytesEqual(k, program))) return tx;
  // A read-only program goes last among the keys: no other index moves.
  const at = m.keys.length;
  const message = serializeMessage({
    ...m,
    header: { ...m.header, numReadonlyUnsigned: m.header.numReadonlyUnsigned + 1 },
    keys: [...m.keys, program],
    instructions: [
      { programIndex: at, accounts: [], data: budgetData(2, BigInt(defaultComputeUnits(m.instructions.length))) },
      { programIndex: at, accounts: [], data: budgetData(3, microLamports) },
      ...m.instructions,
    ],
  });
  const head = shortVecBytes(signatures.length);
  const out = new Uint8Array(head.length + 64 * signatures.length + message.length);
  out.set(head);
  out.set(message, head.length + 64 * signatures.length);
  return out.length > PACKET_SIZE ? tx : out;
}

// ---- What a browser wallet may change while signing -------------------------------------

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

interface AccountMeta {
  address: string;
  signer: boolean;
  writable: boolean;
}

interface Decompiled {
  program: string;
  accounts: AccountMeta[];
  data: Uint8Array;
}

/** Every static key with its flags, from the header (signers first, read-only ones last in each part). */
function accountMetas(m: ParsedMessage): AccountMeta[] {
  const { numRequiredSignatures: s, numReadonlySigned: rs, numReadonlyUnsigned: ru } = m.header;
  return m.keys.map((k, i) => ({ address: base58Encode(k), signer: i < s, writable: i < s ? i < s - rs : i < m.keys.length - ru }));
}

function decompile(m: ParsedMessage, metas: AccountMeta[]): Decompiled[] {
  const meta = (i: number) => {
    if (!metas[i]) throw new RelayCheckError('an instruction names an account that is not in the transaction', '某条指令引用了交易中不存在的账户');
    return metas[i];
  };
  return m.instructions.map((ix) => ({ program: meta(ix.programIndex).address, accounts: ix.accounts.map(meta), data: ix.data }));
}

/** SetComputeUnitLimit or SetComputeUnitPrice: the only instructions a wallet may add, drop or change. */
function budgetKind(ix: Decompiled): 'limit' | 'price' | null {
  if (ix.program !== COMPUTE_BUDGET_PROGRAM || ix.accounts.length) return null;
  if (ix.data[0] === 2 && ix.data.length === 5) return 'limit';
  if (ix.data[0] === 3 && ix.data.length === 9) return 'price';
  return null;
}

const sameAccount = (a: AccountMeta, b: AccountMeta) => a.address === b.address && a.signer === b.signer && a.writable === b.writable;
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export interface WalletEdits {
  blockhashChanged: boolean;
  /** Something besides the blockhash differs (the wallet's compute budget). */
  edited: boolean;
}

/**
 * The one rule both sides apply to the message a browser wallet signed (`got`) for the message the
 * relay sent (`sent`), message bytes each. Accepted: the very message, but for
 *   - the blockhash (unless `keepBlockhash`), and
 *   - SetComputeUnitLimit / SetComputeUnitPrice instructions added, dropped or changed (Phantom's
 *     priority fee), while the priority fee they ask is at most MAX_WALLET_PRIORITY_FEE.
 * Everything else must match once decompiled (adding a program reorders the keys): every other
 * instruction, in the same order, with the same program, accounts (address, signer, writable) and
 * data; the same signers in the same slots, so the same fee payer; the same writable accounts.
 * `exact`: a key the app can't sign with again has signed this message, so nothing may change.
 * Throws RelayCheckError naming the first difference.
 */
export function checkWalletEdits(sent: Uint8Array, got: Uint8Array, { keepBlockhash = false, exact = false } = {}): WalletEdits {
  let a: ParsedMessage;
  let b: ParsedMessage;
  try {
    a = parseMessage(sent);
    b = parseMessage(got);
  } catch (e) {
    throw new RelayCheckError(`unreadable transaction (${(e as Error).message})`, '交易无法解析');
  }
  const blockhashChanged = !bytesEqual(a.blockhash, b.blockhash);
  if (keepBlockhash && blockhashChanged) throw new RelayCheckError('the blockhash had to stay as it was', 'blockhash 不应被改动');
  if (sameExceptBlockhash(sent, got)) return { blockhashChanged, edited: false };
  const fail = (en: string, zh: string): never => {
    throw new RelayCheckError(`the wallet ${en}`, `钱包${zh}`);
  };
  if (!bytesEqual(a.keys[0], b.keys[0])) fail('changed the fee payer', '换了手续费支付方');
  if (exact) fail('changed a transaction another key had signed already (it must come back unchanged)', '改动了已有其他密钥签名的交易（必须原样返回）');
  if (a.version !== b.version) fail('changed the transaction version', '改了交易版本');
  if (a.lookups.length || b.lookups.length) fail('changed a transaction that uses address lookup tables (it must come back unchanged)', '改动了使用地址查找表的交易（必须原样返回）');
  const n = a.header.numRequiredSignatures;
  if (b.header.numRequiredSignatures !== n || a.keys.some((k, i) => i < n && !bytesEqual(k, b.keys[i]))) fail('changed the signers', '改了签名方');
  const ma = accountMetas(a);
  const mb = accountMetas(b);
  if (new Set(mb.map((m) => m.address)).size !== mb.length) fail('listed an account twice', '重复列出了账户');

  // Every instruction but the compute budget, in order: the same programs first (the clearest
  // report of an added one), then the same writable accounts, then each one's accounts and data.
  const ia = decompile(a, ma).filter((ix) => !budgetKind(ix));
  const all = decompile(b, mb);
  const ib = all.filter((ix) => !budgetKind(ix));
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const [x, y] = [ia[i], ib[i]];
    if (!x) fail(`added an instruction for program ${y.program}`, `加入了程序 ${y.program} 的指令`);
    if (!y) fail(`dropped the instruction for program ${x.program}`, `删掉了程序 ${x.program} 的指令`);
    if (x.program !== y.program) {
      fail(
        `made instruction ${i + 1} call program ${y.program}, not ${x.program} (added, dropped or reordered)`,
        `把第 ${i + 1} 条指令改为调用程序 ${y.program}，原本是 ${x.program}（有指令被加入、删除或调换顺序）`,
      );
    }
  }
  const wasWritable = new Set(ma.filter((m) => m.writable).map((m) => m.address));
  const isWritable = new Set(mb.filter((m) => m.writable).map((m) => m.address));
  for (const w of isWritable) if (!wasWritable.has(w)) fail(`made account ${short(w)} writable`, `把账户 ${short(w)} 改成了可写`);
  for (const w of wasWritable) if (!isWritable.has(w)) fail(`made account ${short(w)} read-only`, `把账户 ${short(w)} 改成了只读`);
  ia.forEach((x, i) => {
    const y = ib[i];
    if (x.accounts.length !== y.accounts.length || x.accounts.some((acc, j) => !sameAccount(acc, y.accounts[j]))) {
      fail(`changed the accounts of instruction ${i + 1} (program ${x.program})`, `改了第 ${i + 1} 条指令（程序 ${x.program}）的账户`);
    }
    if (!bytesEqual(x.data, y.data)) fail(`changed the data of instruction ${i + 1} (program ${x.program})`, `改了第 ${i + 1} 条指令（程序 ${x.program}）的数据`);
  });

  // The compute budget it ended up with, and what that costs.
  const limits = all.filter((ix) => budgetKind(ix) === 'limit');
  const prices = all.filter((ix) => budgetKind(ix) === 'price');
  if (limits.length > 1 || prices.length > 1) fail('set the compute budget twice', '重复设置了计算预算');
  const units = limits.length ? u32(limits[0].data, 1) : defaultComputeUnits(all.filter((ix) => ix.program !== COMPUTE_BUDGET_PROGRAM).length);
  const fee = priorityFeeLamports(units, prices.length ? u64(prices[0].data, 1) : 0n);
  if (fee > MAX_WALLET_PRIORITY_FEE) {
    const [asked, cap] = [formatUnits(fee, 9), formatUnits(MAX_WALLET_PRIORITY_FEE, 9)];
    fail(`asked a priority fee of ${asked} SOL, above the ${cap} SOL limit`, `要求 ${asked} SOL 的优先费，超过上限 ${cap} SOL`);
  }
  return { blockhashChanged, edited: true };
}

// ---- The app's check on a signed transaction coming back --------------------------------

export interface RelayCheck {
  /** The returned message bytes: what the owner signed, so what the app sends. */
  message: Uint8Array;
  ownerIndex: number;
  ownerSignature: Uint8Array;
  /** The returned message's blockhash, base58. */
  blockhash: string;
  blockhashChanged: boolean;
  /** The wallet changed more than the blockhash (its compute budget: checkWalletEdits). */
  edited: boolean;
}

/**
 * Accept `got` (a signed transaction from the link page) only as a signature on `sent`: the same
 * signer slots, a message checkWalletEdits accepts (the blockhash unchanged too when
 * `keepBlockhash`, nothing changed at all when `exact`), the owner a required signer, and the
 * owner's slot a valid signature over the returned message. Throws RelayCheckError saying what
 * differed.
 */
export function checkRelayedTransaction(sent: Uint8Array, got: Uint8Array, owner: Uint8Array, verify: Verify, { keepBlockhash = false, exact = false } = {}): RelayCheck {
  let a: ParsedTransaction;
  let b: ParsedTransaction;
  try {
    a = parseTransaction(sent);
    b = parseTransaction(got);
  } catch (e) {
    throw new RelayCheckError(`unreadable transaction (${(e as Error).message})`, '交易无法解析');
  }
  if (b.signatures.length !== a.signatures.length) throw new RelayCheckError('the signer slots changed', '签名位被改动了');
  const { blockhashChanged, edited } = checkWalletEdits(a.message, b.message, { keepBlockhash, exact });
  const n = a.parsed.header.numRequiredSignatures;
  const ownerIndex = a.parsed.keys.findIndex((k, i) => i < n && bytesEqual(k, owner));
  if (ownerIndex < 0) throw new RelayCheckError('the owner is not a signer of this transaction', '钱包所有者不是这笔交易的签名方');
  const ownerSignature = b.signatures[ownerIndex];
  if (!verify(ownerSignature, b.message, owner)) throw new RelayCheckError("the owner's signature is not valid", '所有者的签名无效');
  return { message: b.message.slice(), ownerIndex, ownerSignature: ownerSignature.slice(), blockhash: base58Encode(b.parsed.blockhash), blockhashChanged, edited };
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
