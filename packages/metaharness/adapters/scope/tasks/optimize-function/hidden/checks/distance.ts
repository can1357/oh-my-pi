/** Outcome check: `editDistance` returns the same distances at 5× the original speed. */
import { CATALOGUE } from "../src/catalogue";
import { editDistance } from "../src/distance";

const REQUIRED_SPEEDUP = 5;

/** Textbook full-matrix distance over UTF-16 code units: the correctness reference. */
function reference(a: string, b: string): number {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => {
		const row = new Array<number>(b.length + 1).fill(0);
		row[0] = i;
		return row;
	});
	for (let j = 0; j <= b.length; j++) rows[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
		}
	}
	return rows[a.length][b.length];
}

/** The implementation the task started from: the speed baseline. */
function original(a: string, b: string): number {
	const memo = new Map<string, number>();
	const solve = (i: number, j: number): number => {
		if (i === a.length) return b.length - j;
		if (j === b.length) return a.length - i;
		const key = `${i}:${j}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		const distance =
			a[i] === b[j] ? solve(i + 1, j + 1) : 1 + Math.min(solve(i + 1, j), solve(i, j + 1), solve(i + 1, j + 1));
		memo.set(key, distance);
		return distance;
	};
	return solve(0, 0);
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const next = random(5);
const ALPHABET = "abcdeé 12";
const word = () => Array.from({ length: Math.floor(next() * 46) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
const pairs: Array<[string, string]> = [
	["", ""],
	["", "abc"],
	["abc", ""],
	["same name", "same name"],
	...Array.from({ length: 400 }, (): [string, string] => [word(), word()]),
	...Array.from({ length: 200 }, (): [string, string] => [
		CATALOGUE[Math.floor(next() * CATALOGUE.length)].toLowerCase(),
		CATALOGUE[Math.floor(next() * CATALOGUE.length)].toLowerCase(),
	]),
];

for (const [a, b] of pairs) {
	const got = editDistance(a, b);
	const want = reference(a, b);
	if (got !== want) {
		console.log(`editDistance(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}, expected ${want}`);
		process.exit(1);
	}
}

const workload = pairs.slice(-200);
function bestMs(distance: (a: string, b: string) => number): number {
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 5; round++) {
		const started = performance.now();
		for (const [a, b] of workload) distance(a, b);
		best = Math.min(best, performance.now() - started);
	}
	return best;
}
const speedup = bestMs(original) / bestMs(editDistance);
if (speedup < REQUIRED_SPEEDUP) {
	console.log(`only ${speedup.toFixed(1)}x faster (needs ${REQUIRED_SPEEDUP}x)`);
	process.exit(1);
}
console.log(`distance ok: ${speedup.toFixed(1)}x`);
