// Pack DeepSeek V3..V4 base vocabulary (128,000 entries) into UTOK1 + zstd -19.
//
// Source: tools/cache/deepseek-v4.tokenizer.json (HF tokenizers format).
// model.vocab keys are GPT-2 byte-level alphabet strings; the three
// sentinel specials at ids 0..2 live inside model.vocab (not byte-level
// decodable) and are merge-unreachable, so they are packed as EMPTY byte
// strings per fleet protocol (rank contiguity kept; RankTable::parse
// skips zero-length entries). The 1,283 added_tokens are excluded per
// encode_ordinary semantics.
//
// Usage: bun tools/pack-deepseek.ts

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = `${ROOT}tools/cache/deepseek-v4.tokenizer.json`;
const OUT = `${ROOT}data/deepseek3.bin.zst`;
const VOCAB_SIZE = 128_000;

// GPT-2 bytes_to_unicode, inverted: alphabet char -> original byte.
function unicodeToByte(): Map<string, number> {
	const bs: number[] = [];
	for (let i = 0x21; i <= 0x7e; i++) bs.push(i);
	for (let i = 0xa1; i <= 0xac; i++) bs.push(i);
	for (let i = 0xae; i <= 0xff; i++) bs.push(i);
	const cs = bs.slice();
	let n = 0;
	for (let b = 0; b < 256; b++) {
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
	}
	const m = new Map<string, number>();
	for (let i = 0; i < bs.length; i++) m.set(String.fromCodePoint(cs[i]!), bs[i]!);
	return m;
}

const u2b = unicodeToByte();

function decodeToken(tok: string): Uint8Array | null {
	const out: number[] = [];
	for (const ch of tok) {
		const b = u2b.get(ch);
		if (b === undefined) return null;
		out.push(b);
	}
	return Uint8Array.from(out);
}

const json = await Bun.file(SRC).json();
const vocab: Record<string, number> = json.model.vocab;
const added: { id: number; content: string }[] = json.added_tokens;

if (added.length !== 1283) throw new Error(`expected 1283 added_tokens, got ${added.length}`);

// rank -> token bytes, asserting contiguity 0..127999.
const byRank: (Uint8Array | undefined)[] = new Array(VOCAB_SIZE);
let entries = 0;
for (const tok in vocab) {
	const id = vocab[tok]!;
	if (id < 0 || id >= VOCAB_SIZE) throw new Error(`vocab id ${id} out of range for "${tok}"`);
	if (byRank[id] !== undefined) throw new Error(`duplicate rank ${id}`);
	const decoded = decodeToken(tok);
	if (decoded === null && id > 2) {
		throw new Error(`non-byte-level token at unexpected rank ${id}: "${tok}"`);
	}
	// Dead sentinel specials -> empty (reachability asserted below).
	byRank[id] = decoded ?? new Uint8Array(0);
	entries++;
}
if (entries !== VOCAB_SIZE) throw new Error(`expected ${VOCAB_SIZE} vocab entries, got ${entries}`);
for (let r = 0; r < VOCAB_SIZE; r++) {
	if (byRank[r] === undefined) throw new Error(`rank ${r} missing — vocab not contiguous`);
}

// Non-empty byte keys must be unique or RankTable lookups are ambiguous.
const seen = new Set<string>();
for (const bytes of byRank as Uint8Array[]) {
	if (bytes.length === 0) continue;
	const key = Buffer.from(bytes).toString("latin1");
	if (seen.has(key)) throw new Error(`duplicate token byte sequence: ${JSON.stringify(key)}`);
	seen.add(key);
}

// Merge reachability: a rank-table engine can whole-piece-match any vocab
// entry, but HF (ignore_merges=false) only ever emits alphabet chars and
// merge products. Assert the ONLY unreachable entries are the three
// sentinel specials (ids 0..2), which the pretokenizer can never yield as
// a whole piece — so no drift is possible.
{
	// Merges are "left right" strings; byte-level alphabet never contains
	// a raw space (space maps to Ġ), so a single split is unambiguous.
	const merges: string[] = json.model.merges;
	if (merges.length !== 127_741) throw new Error(`expected 127741 merges, got ${merges.length}`);
	const reachable = new Set<string>();
	for (const tok in vocab) if ([...tok].length === 1 && u2b.has(tok)) reachable.add(tok);
	if (reachable.size !== 256) throw new Error(`expected 256 alphabet entries, got ${reachable.size}`);
	for (const m of merges) {
		const parts = m.split(" ");
		if (parts.length !== 2) throw new Error(`malformed merge: ${JSON.stringify(m)}`);
		reachable.add(parts[0]! + parts[1]!);
	}
	const dead: number[] = [];
	for (const tok in vocab) if (!reachable.has(tok)) dead.push(vocab[tok]!);
	dead.sort((x, y) => x - y);
	if (dead.length !== 3 || dead[0] !== 0 || dead[1] !== 1 || dead[2] !== 2) {
		throw new Error(`unexpected merge-unreachable ranks: ${dead.slice(0, 20).join(",")}`);
	}
}

// UTOK1: magic, u32le count, per entry LEB128(len) + raw bytes.
const parts: Uint8Array[] = [new TextEncoder().encode("UTOK1\n")];
const count = new Uint8Array(4);
new DataView(count.buffer).setUint32(0, VOCAB_SIZE, true);
parts.push(count);
for (const bytes of byRank as Uint8Array[]) {
	let len = bytes.length;
	const varint: number[] = [];
	do {
		let b = len & 0x7f;
		len >>>= 7;
		if (len > 0) b |= 0x80;
		varint.push(b);
	} while (len > 0);
	parts.push(Uint8Array.from(varint), bytes);
}
const blob = Buffer.concat(parts);
const zst = Bun.zstdCompressSync(blob, { level: 19 });
await Bun.write(OUT, zst);
console.log(`packed ${VOCAB_SIZE} entries: ${blob.length} raw -> ${zst.length} zst -> ${OUT}`);
