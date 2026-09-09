/**
 * Regenerates compact ctok vocabulary data for `src/utok/claude/`
 * (`tools/cache/ctok_*.bin`).
 *
 * Source of truth is the measured vocabulary of sanderland/ctok (MIT), pinned
 * to a release revision. Compaction drops the per-piece witness metadata,
 * parses the public `⟨bow⟩the⟨eow⟩` notation into C0 marker bytes, adds the
 * glued contraction spellings, and emits the version-2 front-coded binary
 * format below — cutting ~4.7 MB of upstream JSON to ~254 KB of embedded
 * data. If the pin moves, also regenerate
 * `src/utok/claude/testdata/fixtures.json` against the same ctok release
 * (`uv run --with ctok …`; see the fixture doc in `src/utok/claude/mod.rs`).
 *
 * Format (little-endian; parsed by `VocabCore::parse` in
 * `src/utok/claude/engine.rs`):
 *
 *   magic            b"CTOK"
 *   version          u8 = 2
 *   flags            u8 (bit 0: fold_quotes)
 *   message_overhead u8
 *   allcaps_min      u8 (0 = disabled)
 *   byte_token_count u16
 *   piece_count      u32
 *   byte tokens      count × { len u8, bytes }
 *   pieces           count × { shared_prefix varint, suffix_len varint, suffix bytes }
 *
 * Pieces are written in the compact alphabet — marker glyphs as the single
 * bytes above, everything else UTF-8 — and sorted by those bytes;
 * `shared_prefix` is the byte length shared with the previous piece (front
 * coding). Varints are LEB128.
 */

import * as path from "node:path";

/** Pinned upstream: sanderland/ctok v1.0.0. */
const CTOK_REV = "df3b59b5e645289a5eadc8e24036b99d39c333c4";
const UPSTREAM = `https://raw.githubusercontent.com/sanderland/ctok/${CTOK_REV}/ctok/data`;

const DATA_DIR = path.join(import.meta.dir, "cache");

/** Marker glyphs of ctok's internal marked form, keyed by public atom. */
const ATOMS: Record<string, string> = {
	"⟨bow⟩": "\ufdd0",
	"⟨eow⟩": "\ufdd1",
	"⟨pad⟩": "\ufdd2",
	"⟨shift⟩": "\ufdd3",
	"⟨caps⟩": "\ufdd4",
};

/**
 * Marker glyph → the single byte the Rust encoder writes for it (mirrors
 * `MARKERS` in ctok/constants.rs). The tokenizer strips C0 controls from input
 * before anything else, so these bytes can never collide with text, and one
 * byte per marker instead of three shrinks both the marked stream and the
 * matching automaton by about a third.
 */
const MARKER_BYTES: Record<string, number> = {
	"\ufdd0": 0x01,
	"\ufdd1": 0x02,
	"\ufdd2": 0x03,
	"\ufdd3": 0x04,
	"\ufdd4": 0x05,
};

const encoder = new TextEncoder();

function encodeCompact(piece: string): Uint8Array<ArrayBuffer> {
	const out: number[] = [];
	for (const ch of piece) {
		const marker = MARKER_BYTES[ch];
		if (marker === undefined) out.push(...encoder.encode(ch));
		else out.push(marker);
	}
	return new Uint8Array(out);
}

const EOW = "\ufdd1";
const BYTE_ATOM = /^⟨0x([0-9A-Fa-f]{2})⟩/;

/**
 * Parse one public-notation vocabulary key into the internal marked string:
 * named atoms become single glyphs, `⟨0xNN⟩` escape runs decode back to their
 * characters, anything else is literal.
 */
function parseMarked(publicKey: string): string {
	let out = "";
	let bytes: number[] = [];
	const flush = () => {
		if (bytes.length === 0) return;
		out += new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
		bytes = [];
	};
	let rest = publicKey;
	outer: while (rest.length > 0) {
		if (rest.startsWith("⟨")) {
			for (const atom in ATOMS) {
				if (rest.startsWith(atom)) {
					flush();
					out += ATOMS[atom];
					rest = rest.slice(atom.length);
					continue outer;
				}
			}
			const byteAtom = BYTE_ATOM.exec(rest);
			if (byteAtom) {
				bytes.push(Number.parseInt(byteAtom[1], 16));
				rest = rest.slice(byteAtom[0].length);
				continue;
			}
		}
		flush();
		const ch = String.fromCodePoint(rest.codePointAt(0) as number);
		out += ch;
		rest = rest.slice(ch.length);
	}
	flush();
	return out;
}

function pushVarint(out: number[], value: number): void {
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v);
}

interface UpstreamDoc {
	meta: { message_overhead: number; fold_quotes: boolean; allcaps_min: number | null };
	tokens: Record<string, Record<string, unknown>>;
}

async function generate(src: string, dst: string): Promise<void> {
	const url = `${UPSTREAM}/${src}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
	const doc = (await response.json()) as UpstreamDoc;

	const pieces = new Set<string>();
	const byteTokens: string[] = [];
	for (const group in doc.tokens) {
		const entries = doc.tokens[group];
		if (group === "bytes_fallback") {
			byteTokens.push(...Object.keys(entries));
			continue;
		}
		for (const key in entries) {
			const parsed = parseMarked(key);
			if (group === "contractions") {
				// The file stores `'t`; the encoder writes `'t⟨eow⟩` (ctok's
				// glued_contraction). Both spellings join the tiling vocabulary.
				pieces.add(parsed + EOW);
			}
			pieces.add(parsed);
		}
	}

	const sorted = [...pieces].map(encodeCompact).sort(Buffer.compare);

	const out: number[] = [0x43, 0x54, 0x4f, 0x4b, 2]; // "CTOK", version
	out.push(doc.meta.fold_quotes ? 1 : 0);
	out.push(doc.meta.message_overhead);
	out.push(doc.meta.allcaps_min ?? 0);
	byteTokens.sort();
	out.push(byteTokens.length & 0xff, byteTokens.length >>> 8);
	const n = sorted.length;
	out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
	for (const hex of byteTokens) {
		out.push(hex.length / 2);
		for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
	}
	let prev = new Uint8Array(0);
	for (const piece of sorted) {
		let shared = 0;
		const max = Math.min(prev.length, piece.length);
		while (shared < max && prev[shared] === piece[shared]) shared++;
		pushVarint(out, shared);
		pushVarint(out, piece.length - shared);
		for (let i = shared; i < piece.length; i++) out.push(piece[i]);
		prev = piece;
	}

	const dstPath = path.join(DATA_DIR, dst);
	await Bun.write(dstPath, new Uint8Array(out));
	console.log(`${dst}: ${n} pieces, ${byteTokens.length} byte tokens, ${out.length} bytes`);
}

await generate("pieces_v3.json", "ctok_v3.bin");
await generate("pieces_v4_7.json", "ctok_v4_7.bin");
