#!/usr/bin/env bun
// Build the n-gram engine's web prior: data/web-prior.bin.zst, embedded by
// `include_bytes!` in src/ngram/web.rs (decoded once per process).
//
// Inputs (file paths; the Norvig lists are downloaded when omitted):
//   --unigrams  Norvig count_1w.txt (`word\tcount`), https://norvig.com/ngrams/count_1w.txt
//   --bigrams   Norvig count_2w.txt (`w1 w2\tcount`, `<S>` = sentence start), https://norvig.com/ngrams/count_2w.txt
//   --dict      /usr/share/dict/words (membership only; "trusted" spelling)
//   --vocab     how many of the most frequent words to keep (default 150000)
//
//   bun crates/pi-predict/scripts/build-web-prior.ts
//
// Unigrams are lowercased, restricted to `[\p{L}\p{M}']+`, and merged per
// lowercase form; the top `--vocab` by count are kept and stored in UTF-8
// byte order, so word ids are lexicographic ranks. Bigrams are kept when both
// words are in the vocabulary (or the left one is `<S>`); case variants
// merge. The sentence-start total is summed over every `<S> w` row whose `w`
// is a Norvig word, as the research model did.
//
// Layout (little endian), then zstd -19:
//   "PIWP" u32 version=1
//   u32 words, u32 dictExtra, u32 contexts, u32 rows, f64 sentenceStartTotal
//   f32 count[words]
//   u8  inDict[ceil(words / 8)]          bit i = word i is a dictionary word
//   u32 context[contexts]                 ascending word id; `words` = sentence start (last)
//   u32 followers[contexts]               rows per context
//   u32 followerDelta[rows]               ascending word ids, delta-coded per context
//   f32 bigramCount[rows]
//   words blob                            '\n'-terminated, byte order
//   dictionary-only blob                  '\n'-terminated, byte order: lowercase dictionary words outside the vocabulary

import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const NORVIG = "https://norvig.com/ngrams";

function arg(name: string, fallback: string): string {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

/** Text of a local file, or of `url` when `file` is empty. */
async function source(file: string, url: string): Promise<string> {
	if (file) return Bun.file(file).text();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
	return response.text();
}

const unigramsText = await source(arg("unigrams", ""), `${NORVIG}/count_1w.txt`);
const bigramsText = await source(arg("bigrams", ""), `${NORVIG}/count_2w.txt`);
const dictPath = arg("dict", "/usr/share/dict/words");
const vocabSize = Number(arg("vocab", "150000"));
const outPath = path.join(root, "data", "web-prior.bin.zst");

const WORD = /^[\p{L}\p{M}']+$/u;
const encoder = new TextEncoder();

function byteOrder(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// Unigrams: lowercase, word-like, merged; rank by count.
const merged = new Map<string, number>();
for (const line of unigramsText.split("\n")) {
	const tab = line.indexOf("\t");
	if (tab <= 0) continue;
	const word = line.slice(0, tab).toLowerCase();
	if (WORD.test(word)) merged.set(word, (merged.get(word) ?? 0) + Number(line.slice(tab + 1)));
}
const ranked = [...merged.keys()].sort((a, b) => merged.get(b)! - merged.get(a)!);
const words = ranked.slice(0, vocabSize).sort(byteOrder);
const idOf = new Map<string, number>();
for (let i = 0; i < words.length; i++) idOf.set(words[i]!, i);

// Bigrams: merge case variants; the sentence-start total covers every Norvig follower.
const BOS = words.length;
const pairs = new Map<number, number>();
let bosTotal = 0;
for (const line of bigramsText.split("\n")) {
	const tab = line.indexOf("\t");
	const space = line.indexOf(" ");
	if (tab <= 0 || space <= 0 || space > tab) continue;
	const rawLeft = line.slice(0, space);
	const right = line.slice(space + 1, tab).toLowerCase();
	const count = Number(line.slice(tab + 1));
	const bos = rawLeft === "<S>";
	if (bos && merged.has(right)) bosTotal += count;
	const v = bos ? BOS : idOf.get(rawLeft.toLowerCase());
	const w = idOf.get(right);
	if (v === undefined || w === undefined) continue;
	const key = v * 2 ** 24 + w;
	pairs.set(key, (pairs.get(key) ?? 0) + count);
}
const keys = [...pairs.keys()].sort((a, b) => a - b);
const contexts: number[] = [];
const followers: number[] = [];
const deltas = new Uint32Array(keys.length);
const bigramCounts = new Float32Array(keys.length);
let previous = -1;
for (let i = 0; i < keys.length; i++) {
	const key = keys[i]!;
	const w = key % 2 ** 24;
	const v = (key - w) / 2 ** 24;
	if (v !== contexts.at(-1)) {
		contexts.push(v);
		followers.push(0);
		previous = 0;
	}
	followers[followers.length - 1]!++;
	deltas[i] = w - previous;
	previous = w;
	bigramCounts[i] = pairs.get(key)!;
}

// Dictionary membership: flags for vocabulary words, a sorted list for the rest.
const dict = new Set<string>();
for (const line of (await Bun.file(dictPath).text()).split("\n")) {
	const word = line.trim().toLowerCase();
	if (word && WORD.test(word)) dict.add(word);
}
const inDict = new Uint8Array(Math.ceil(words.length / 8));
for (let i = 0; i < words.length; i++) if (dict.has(words[i]!)) inDict[i >> 3]! |= 1 << (i & 7);
const dictOnly = [...dict].filter(word => !idOf.has(word)).sort(byteOrder);

const wordsBlob = encoder.encode(words.map(word => `${word}\n`).join(""));
const dictBlob = encoder.encode(dictOnly.map(word => `${word}\n`).join(""));
const header = new ArrayBuffer(32);
const view = new DataView(header);
new Uint8Array(header).set(encoder.encode("PIWP"), 0);
view.setUint32(4, 1, true);
view.setUint32(8, words.length, true);
view.setUint32(12, dictOnly.length, true);
view.setUint32(16, contexts.length, true);
view.setUint32(20, keys.length, true);
view.setFloat64(24, bosTotal, true);
const counts = Float32Array.from(words, word => merged.get(word)!);
const raw = Buffer.concat([
	new Uint8Array(header),
	new Uint8Array(counts.buffer),
	inDict,
	new Uint8Array(Uint32Array.from(contexts).buffer),
	new Uint8Array(Uint32Array.from(followers).buffer),
	new Uint8Array(deltas.buffer),
	new Uint8Array(bigramCounts.buffer),
	wordsBlob,
	dictBlob,
]);
const packed = Bun.zstdCompressSync(raw, { level: 19 });
await Bun.write(outPath, packed);
console.log(
	`${outPath}: ${words.length} words, ${dictOnly.length} dictionary-only, ${contexts.length} contexts, ${keys.length} bigrams; ${raw.length} -> ${packed.length} bytes`,
);
