/**
 * Hash benchmark: nanoseconds per hash for every hash × key size × key shape, best of
 * `--rounds` (default 5). `--hash <name>`, `--size <chars>`, and `--shape <name>` restrict the
 * matrix to one value each.
 */
import { parseArgs } from "node:util";
import { HASHES, type HashName } from "../src/config";

const SIZES = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 256, 512, 1024, 2048, 4096, 8192];
const SHAPES: Record<string, string> = {
	words: "abcdefghijklmnopqrstuvwxyz ",
	digits: "0123456789",
	hex: "0123456789abcdef",
	uuid: "0123456789abcdef-",
	path: "abcdefghijklmnopqrstuvwxyz/._-",
	accented: "aàbcçdeéèfghiîjklmnoôpqrstuùvwxyz",
};
/** Each round keeps hashing until this much time has passed. */
const ROUND_MS = 40;
const KEYS_PER_CELL = 256;

const { values } = parseArgs({
	options: {
		hash: { type: "string" },
		size: { type: "string" },
		shape: { type: "string" },
		rounds: { type: "string", default: "5" },
	},
});

function makeKeys(size: number, alphabet: string): string[] {
	let state = size * 2654435761;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
	return Array.from({ length: KEYS_PER_CELL }, () =>
		Array.from({ length: size }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""),
	);
}

function nsPerHash(hash: (key: string) => number, keys: readonly string[]): number {
	const started = performance.now();
	let hashed = 0;
	let sink = 0;
	while (performance.now() - started < ROUND_MS) {
		for (const key of keys) sink ^= hash(key);
		hashed += keys.length;
	}
	if (sink === Number.MIN_SAFE_INTEGER) throw new Error("unreachable");
	return ((performance.now() - started) * 1e6) / hashed;
}

const names = (Object.keys(HASHES) as HashName[]).filter(name => !values.hash || name === values.hash);
const sizes = SIZES.filter(size => !values.size || size === Number(values.size));
const shapes = Object.keys(SHAPES).filter(shape => !values.shape || shape === values.shape);
const rounds = Number(values.rounds);

console.log(`${"size".padStart(5)}  ${"shape".padEnd(9)} ${names.map(name => name.padStart(10)).join(" ")}   ns/hash, best of ${rounds}`);
for (const size of sizes) {
	for (const shape of shapes) {
		const keys = makeKeys(size, SHAPES[shape]);
		const cells = names.map(name => {
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < rounds; round++) best = Math.min(best, nsPerHash(HASHES[name], keys));
			return best.toFixed(1).padStart(10);
		});
		console.log(`${String(size).padStart(5)}  ${shape.padEnd(9)} ${cells.join(" ")}`);
	}
}
