#!/usr/bin/env bun
// Pack the ctok vocabulary blobs: zstd -19 compress the front-coded binaries
// produced by tools/gen-ctok-vocab.ts (upstream ctok df3b59b data).
//
// Sources (first hit wins): $CTOK_SRC, tools/cache/ (gen-ctok-vocab.ts output).
// Output: data/ctok_v3.bin.zst, data/ctok_v4_7.bin.zst — consumed by
// include_bytes! + zstd::decode_all in src/utok/claude/mod.rs.

import { existsSync } from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const candidates = [process.env.CTOK_SRC, path.join(root, "tools/cache")].filter(
	(d): d is string => !!d,
);

const MAGIC = "CTOK"; // container magic written by gen-ctok-vocab.ts
const VERSION = 2; // format version byte (compact C0 marker alphabet)

for (const name of ["ctok_v3.bin", "ctok_v4_7.bin"]) {
	const dir = candidates.find((d) => existsSync(path.join(d, name)));
	if (!dir) throw new Error(`${name}: not found in ${candidates.join(", ")}`);
	const raw = new Uint8Array(await Bun.file(path.join(dir, name)).arrayBuffer());
	const head = new TextDecoder().decode(raw.subarray(0, MAGIC.length));
	if (head !== MAGIC) throw new Error(`${name}: bad magic ${JSON.stringify(head)}`);
	if (raw[MAGIC.length] !== VERSION)
		throw new Error(`${name}: unsupported version ${raw[MAGIC.length]}, want ${VERSION}`);
	const packed = Bun.zstdCompressSync(raw, { level: 19 });
	const out = path.join(root, "data", `${name}.zst`);
	await Bun.write(out, packed);
	console.log(`${out}: ${raw.length} -> ${packed.length} bytes`);
}
