// Pack the measured TypeSafe Jev (jev-1.13) vocabulary into two UTOK1 + zstd -19 blobs.
//
//   bun tools/pack-jev.ts
//
// Inputs (tools/cache/, gitignored):
//   - o200k_base.tiktoken       — rank source; every Jev piece is an o200k token.
//   - jev-1.13.vocab.json       — {"W": hex[], "B": hex[]} measured against the
//                                  live API (see data/README.md): W = whole-word
//                                  entries, B = base tokens the merge loop may form.
//
// Outputs (rank = o200k id; slots outside the set are EMPTY so the engine's
// UTOK1 parser skips them and the merge loop can never produce them):
//   - data/jev_base.bin.zst     — base merge table (B at o200k ranks)
//   - data/jev_whole.bin.zst    — whole-word membership table (W at o200k ranks)

const root = new URL("..", import.meta.url).pathname;
const O200K = 199_998;
const EXPECTED = { W: 144_562, B: 53_622 };

function varint(n: number): number[] {
	const out: number[] = [];
	while (n >= 0x80) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return out;
}

const ranks: Uint8Array[] = [];
const byHex = new Map<string, number>();
{
	const lines = (await Bun.file(`${root}tools/cache/o200k_base.tiktoken`).text())
		.split("\n")
		.filter(l => l.length > 0);
	if (lines.length !== O200K) throw new Error(`o200k: expected ${O200K} entries, got ${lines.length}`);
	for (let rank = 0; rank < lines.length; rank++) {
		const [b64, rankStr] = lines[rank].split(" ");
		if (Number(rankStr) !== rank) throw new Error(`o200k: rank discontinuity at line ${rank}`);
		const token = Uint8Array.fromBase64(b64);
		ranks.push(token);
		byHex.set(token.toHex(), rank);
	}
}

const vocab: { W: string[]; B: string[] } = await Bun.file(`${root}tools/cache/jev-1.13.vocab.json`).json();

async function pack(name: string, members: string[], expected: number) {
	if (members.length !== expected) throw new Error(`${name}: expected ${expected} entries, got ${members.length}`);
	const keep = new Set<number>();
	for (const hex of members) {
		const rank = byHex.get(hex);
		if (rank === undefined) throw new Error(`${name}: ${hex} is not an o200k token`);
		keep.add(rank);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const push = (b: Uint8Array) => {
		chunks.push(b);
		total += b.length;
	};
	const header = new Uint8Array(10);
	header.set(new TextEncoder().encode("UTOK1\n"), 0);
	new DataView(header.buffer).setUint32(6, O200K, true);
	push(header);
	for (let rank = 0; rank < O200K; rank++) {
		const token = keep.has(rank) ? ranks[rank] : new Uint8Array(0);
		push(new Uint8Array(varint(token.length)));
		push(token);
	}
	const raw = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		raw.set(c, off);
		off += c.length;
	}
	const zst = Bun.zstdCompressSync(raw, { level: 19 });
	await Bun.write(`${root}data/${name}.bin.zst`, zst);
	console.log(`${name}: ${keep.size} of ${O200K} slots, ${raw.length} raw -> ${zst.length} zst`);
}

await pack("jev_base", vocab.B, EXPECTED.B);
await pack("jev_whole", vocab.W, EXPECTED.W);
