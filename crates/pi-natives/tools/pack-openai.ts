// Pack OpenAI tiktoken rank files into UTOK1 + zstd -19 blobs.
//
//   bun tools/pack-openai.ts
//
// Reads tools/cache/{o200k_base,cl100k_base}.tiktoken (base64-token + rank
// per line), asserts rank contiguity, writes data/<name>.bin.zst.

const root = new URL("..", import.meta.url).pathname;

function varint(n: number): number[] {
	const out: number[] = [];
	while (n >= 0x80) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return out;
}

async function pack(name: string, expected: number) {
	const text = await Bun.file(`${root}tools/cache/${name}.tiktoken`).text();
	const lines = text.split("\n").filter((l) => l.length > 0);
	if (lines.length !== expected) {
		throw new Error(`${name}: expected ${expected} entries, got ${lines.length}`);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const push = (b: Uint8Array) => {
		chunks.push(b);
		total += b.length;
	};
	const header = new Uint8Array(10);
	header.set(new TextEncoder().encode("UTOK1\n"), 0);
	new DataView(header.buffer).setUint32(6, lines.length, true);
	push(header);
	for (let rank = 0; rank < lines.length; rank++) {
		const [b64, rankStr] = lines[rank].split(" ");
		if (Number(rankStr) !== rank) {
			throw new Error(`${name}: rank discontinuity at line ${rank}: got ${rankStr}`);
		}
		const token = Uint8Array.fromBase64(b64);
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
	console.log(`${name}: ${lines.length} entries, ${raw.length} raw -> ${zst.length} zst`);
}

await pack("o200k_base", 199998);
await pack("cl100k_base", 100256);
