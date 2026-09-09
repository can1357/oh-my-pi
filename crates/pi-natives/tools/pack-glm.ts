// Pack GLM-5 vocab (zai-org/GLM-5 tokenizer.json) into UTOK1 + zstd -19.
// Base vocab only: 154,820 entries, ids 0..154819 contiguous; the 36
// added_tokens all sit above the base vocab (154820+) and are excluded.
// Vocab keys use the GPT-2 byte-level alphabet; decode back to raw bytes
// and assert every char maps (alphabet-decode cleanliness).
//
// Usage: bun tools/pack-glm.ts

import { zstdCompressSync } from "bun";

const EXPECTED = 154_820;

// GPT-2 bytes_to_unicode, inverted.
function unicodeToBytes(): Map<number, number> {
	const bs: number[] = [];
	for (let i = "!".charCodeAt(0); i <= "~".charCodeAt(0); i++) bs.push(i);
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
	const inv = new Map<number, number>();
	for (let i = 0; i < bs.length; i++) inv.set(cs[i], bs[i]);
	return inv;
}

const inv = unicodeToBytes();
const tj = await Bun.file(new URL("cache/glm-5.tokenizer.json", import.meta.url)).json();
const vocab: Record<string, number> = tj.model.vocab;

// added_tokens must all be out-of-vocab (above base range).
for (const t of tj.added_tokens) {
	if (t.id < EXPECTED) throw new Error(`added token '${t.content}' (id ${t.id}) inside base vocab`);
	if (vocab[t.content] !== undefined) throw new Error(`added token '${t.content}' also in model.vocab`);
}

// Decode each key to raw bytes; assert contiguity + alphabet cleanliness.
const byRank: Uint8Array[] = new Array(EXPECTED);
let seen = 0;
for (const key in vocab) {
	const rank = vocab[key];
	seen++;
	if (!Number.isInteger(rank) || rank < 0 || rank >= EXPECTED) throw new Error(`rank ${rank} out of range for '${key}'`);
	if (byRank[rank] !== undefined) throw new Error(`duplicate rank ${rank}`);
	const bytes = new Uint8Array(key.length);
	let n = 0;
	for (const ch of key) {
		const b = inv.get(ch.codePointAt(0)!);
		if (b === undefined) throw new Error(`rank ${rank}: char U+${ch.codePointAt(0)!.toString(16)} not in GPT-2 byte alphabet ('${key}')`);
		bytes[n++] = b;
	}
	byRank[rank] = bytes.subarray(0, n);
}
if (seen !== EXPECTED) throw new Error(`vocab size ${seen} != ${EXPECTED}`);
for (let i = 0; i < EXPECTED; i++) if (byRank[i] === undefined) throw new Error(`missing rank ${i}`);

// UTOK1: magic, u32le count, per entry varint(len)+bytes.
const parts: Uint8Array[] = [new TextEncoder().encode("UTOK1\n")];
const count = new Uint8Array(4);
new DataView(count.buffer).setUint32(0, EXPECTED, true);
parts.push(count);
for (const tok of byRank) {
	let len = tok.length;
	const hdr: number[] = [];
	do {
		hdr.push(len >= 0x80 ? (len & 0x7f) | 0x80 : len);
		len >>>= 7;
	} while (len > 0);
	parts.push(new Uint8Array(hdr), tok);
}
const raw = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
let off = 0;
for (const p of parts) {
	raw.set(p, off);
	off += p.length;
}

const zst = zstdCompressSync(raw, { level: 19 });
await Bun.write(new URL("../data/glm5.bin.zst", import.meta.url), zst);
console.log(`glm5: ${EXPECTED} tokens, raw ${raw.length} B, zst ${zst.length} B`);
