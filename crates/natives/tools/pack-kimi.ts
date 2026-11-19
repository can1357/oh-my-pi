// Pack Kimi K2/K3 base vocab (native tiktoken format) into UTOK1 + zstd.
// Usage: bun tools/pack-kimi.ts
// Input: tools/cache/kimi.tiktoken.model — lines of "<base64 token> <rank>".
// Specials live at 163584+ and are absent from the file.

const EXPECTED = 163_584;

const src = await Bun.file(new URL("cache/kimi.tiktoken.model", import.meta.url)).text();
const lines = src.split("\n").filter((l) => l.length > 0);
if (lines.length !== EXPECTED) throw new Error(`expected ${EXPECTED} entries, got ${lines.length}`);

const tokens: Uint8Array[] = new Array(lines.length);
for (const line of lines) {
	const sp = line.indexOf(" ");
	if (sp < 0) throw new Error(`malformed line: ${JSON.stringify(line)}`);
	const rank = Number(line.slice(sp + 1));
	if (!Number.isInteger(rank) || rank < 0 || rank >= EXPECTED) throw new Error(`bad rank ${rank}`);
	if (tokens[rank] !== undefined) throw new Error(`duplicate rank ${rank}`);
	tokens[rank] = Uint8Array.from(atob(line.slice(0, sp)), (c) => c.charCodeAt(0));
}
// Contiguity: every rank 0..EXPECTED-1 present exactly once.
for (let r = 0; r < EXPECTED; r++) if (tokens[r] === undefined) throw new Error(`missing rank ${r}`);

// UTOK1: magic 'UTOK1\n', u32le count, per entry varint(len)+bytes.
const parts: Uint8Array[] = [];
parts.push(new TextEncoder().encode("UTOK1\n"));
const cnt = new Uint8Array(4);
new DataView(cnt.buffer).setUint32(0, EXPECTED, true);
parts.push(cnt);
for (const tok of tokens) {
	let n = tok.length;
	const v: number[] = [];
	while (n >= 0x80) {
		v.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	v.push(n);
	parts.push(new Uint8Array(v), tok);
}
const raw = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
let off = 0;
for (const p of parts) {
	raw.set(p, off);
	off += p.length;
}

const zst = Bun.zstdCompressSync(raw, { level: 19 });
await Bun.write(new URL("../data/kimi_k2.bin.zst", import.meta.url), zst);
console.log(`kimi_k2: ${EXPECTED} entries, raw ${raw.length} B, zst ${zst.length} B`);
