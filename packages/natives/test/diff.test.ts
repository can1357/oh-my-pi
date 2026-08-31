import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DiffSide,
	DiffStream,
	diffLineRuns,
	diffLines,
	diffWords,
	type PatchHunk,
	structuredPatchHunks,
} from "@oh-my-pi/pi-natives";

function applyHunks(oldText: string, hunks: PatchHunk[]): string {
	if (hunks.length === 0) return oldText;
	const oldLines = oldText.split("\n");
	const resultLines: string[] = [];
	let oldIdx = 0;
	let removeEofNewline = false;

	for (const hunk of hunks) {
		const targetOldIdx = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
		while (oldIdx < targetOldIdx && oldIdx < oldLines.length) {
			resultLines.push(oldLines[oldIdx]!);
			oldIdx++;
		}
		for (let i = 0; i < hunk.lines.length; i++) {
			const line = hunk.lines[i]!;
			if (line.startsWith("\\ No newline at end of file")) {
				const prevLine = hunk.lines[i - 1];
				if (prevLine && (prevLine.startsWith("+") || prevLine.startsWith(" "))) {
					removeEofNewline = true;
				}
				continue;
			}
			if (line.startsWith("-")) {
				oldIdx++;
			} else if (line.startsWith("+")) {
				resultLines.push(line.slice(1));
			} else if (line.startsWith(" ")) {
				resultLines.push(line.slice(1));
				oldIdx++;
			}
		}
	}
	while (oldIdx < oldLines.length) {
		resultLines.push(oldLines[oldIdx]!);
		oldIdx++;
	}

	if (removeEofNewline && resultLines[resultLines.length - 1] === "") {
		resultLines.pop();
	}
	return resultLines.join("\n");
}

function verifyDiffInvariants(oldText: string, newText: string) {
	// 1. diffLines reconstruction
	const lineChanges = diffLines(oldText, newText);
	let reconstructedOld = "";
	let reconstructedNew = "";
	for (const change of lineChanges) {
		if (change.removed) {
			reconstructedOld += change.value;
		} else if (change.added) {
			reconstructedNew += change.value;
		} else {
			reconstructedOld += change.value;
			reconstructedNew += change.value;
		}
	}
	expect(reconstructedOld).toBe(oldText);
	expect(reconstructedNew).toBe(newText);

	// 2. structuredPatchHunks reconstruction
	for (const context of [0, 3, 4]) {
		const hunks = structuredPatchHunks(oldText, newText, context);
		const patchedText = applyHunks(oldText, hunks);
		expect(patchedText).toBe(newText);
	}

	// 3. diffLineRuns counts
	const oldLineCount = oldText.split("\n").length;
	const newLineCount = newText.split("\n").length;
	const runs = diffLineRuns(oldText, newText);
	let sumOld = 0;
	let sumNew = 0;
	for (const run of runs) {
		if (run.removed) sumOld += run.count;
		else if (run.added) sumNew += run.count;
		else {
			sumOld += run.count;
			sumNew += run.count;
		}
	}
	expect(sumOld).toBe(oldLineCount);
	expect(sumNew).toBe(newLineCount);
}

/** Deterministic LCG so failures are reproducible. */
function makeRng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomText(rng: () => number, lines: number, opts: { crlf?: boolean; unicode?: boolean } = {}) {
	const words = opts.unicode
		? ["alpha", "béta", "γάμμα", "デルタ", "🚀rocket", "ω"]
		: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
	const eol = opts.crlf ? "\r\n" : "\n";
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const n = 1 + Math.floor(rng() * 4);
		const parts: string[] = [];
		for (let j = 0; j < n; j++) parts.push(words[Math.floor(rng() * words.length)]!);
		out.push(parts.join(" "));
	}
	let text = out.join(eol);
	if (rng() > 0.5) text += eol;
	return text;
}

function mutate(rng: () => number, text: string, density: number) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const roll = rng();
		if (roll < density / 3) lines[i] = `${lines[i]} edited`;
		else if (roll < (density * 2) / 3) {
			lines.splice(i, 1);
			i--;
		} else if (roll < density) lines.splice(i, 0, `inserted ${Math.floor(rng() * 1000)}`);
	}
	return lines.join("\n");
}

describe("native diff correctness", () => {
	test.skipIf(typeof DiffStream !== "function")("streamed chunks produce the exact complete-file hunks", async () => {
		const oldText = "same\nold 🚀\ntail\n";
		const newText = "same\nnew 🚀\ntail\n";
		const encoder = new TextEncoder();
		const oldBytes = encoder.encode(oldText);
		const newBytes = encoder.encode(newText);
		const stream = new DiffStream();
		stream.pushBytes(DiffSide.Old, oldBytes.subarray(0, 11));
		stream.pushBytes(DiffSide.Old, oldBytes.subarray(11));
		stream.pushBytes(DiffSide.New, newBytes.subarray(0, 11));
		stream.pushBytes(DiffSide.New, newBytes.subarray(11));
		expect(stream.progress().stableCommonLines).toBe(1);
		stream.finishSide(DiffSide.Old);
		stream.finishSide(DiffSide.New);

		const result = await stream.finish(3);
		expect(result.hunks).toEqual(structuredPatchHunks(oldText, newText, 3));
		expect(stream.text(DiffSide.Old)).toBe(oldText);
		expect(stream.text(DiffSide.New)).toBe(newText);
		expect(stream.lines(DiffSide.New, 1, 1)).toEqual(["new 🚀"]);
	});

	test.skipIf(typeof DiffStream !== "function")(
		"native file open streams complete lines without a JS file read",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-diff-stream-"));
			const file = path.join(dir, "source.txt");
			try {
				await Bun.write(file, "first\nsecond\n");
				const stream = new DiffStream();
				stream.finishSide(DiffSide.Old);
				await stream.openFile(DiffSide.New, file, 1024);
				expect(stream.progress()).toMatchObject({ newDone: true, newLines: 2, tooLarge: false });
				expect(stream.lines(DiffSide.New, 0)).toEqual(["first", "second"]);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	test("fixed edge cases", () => {
		verifyDiffInvariants("", "");
		verifyDiffInvariants("", "a\nb\n");
		verifyDiffInvariants("a\nb\n", "");
		verifyDiffInvariants("same\ntext\n", "same\ntext\n");
		verifyDiffInvariants("a\nb\nc", "a\nx\nc");
		verifyDiffInvariants("a\r\nb\r\nc\r\n", "a\r\nx\r\nc\r\n");
		verifyDiffInvariants("a\nb\n", "a\r\nb\r\n");
		verifyDiffInvariants("líne ünicode 🚀\nsecond\n", "líne ünicode 🚀\nsécond\n");
		verifyDiffInvariants("lone\rcarriage\n", "lone\rreturn\n");
		// A legitimate embedded NUL is content, not a terminator.
		verifyDiffInvariants("a\u0000\nb\n", "a\u0000\nc\n");
	});

	test("word diff behavior", () => {
		const changes = diffWords("foo bar baz", "foo qux baz");
		expect(changes).toEqual([
			{ value: "foo ", count: 1, added: false, removed: false },
			{ value: "bar", count: 1, added: false, removed: true },
			{ value: "qux", count: 1, added: true, removed: false },
			{ value: " baz", count: 1, added: false, removed: false },
		]);
	});

	test("ill-formed UTF-16 is legal content, preserved code unit for code unit", () => {
		const a = "a\ud800b";
		const b = "a\ud801b";
		// Distinct lone surrogates must survive the N-API round trip untouched
		// (UTF-8 conversion would collapse both into U+FFFD and report "no
		// change") and diff as distinct content.
		expect(diffLines(a, b)).toEqual([
			{ value: a, count: 1, added: false, removed: true },
			{ value: b, count: 1, added: true, removed: false },
		]);
		expect(diffWords("alpha \ud800 beta", "alpha \ud801 beta")).toEqual([
			{ value: "alpha ", count: 1, added: false, removed: false },
			{ value: "\ud800", count: 1, added: false, removed: true },
			{ value: "\ud801", count: 1, added: true, removed: false },
			{ value: " beta", count: 1, added: false, removed: false },
		]);
		expect(diffLineRuns(a, b)).toEqual([
			{ count: 1, added: false, removed: true },
			{ count: 1, added: true, removed: false },
		]);
		expect(structuredPatchHunks(a, b, 3).length).toBeGreaterThan(0);
		verifyDiffInvariants(a, b);
	});

	test("seeded random word diffs reconstruct the new text exactly", () => {
		// Token pool stresses word/whitespace boundary rules: repeated and
		// mixed whitespace, tabs, newlines, punctuation runs, Latin extended,
		// non-Latin scripts, emoji (surrogate pairs), digits, and lone
		// surrogates.
		const tokens = [
			"word",
			"Wörter",
			"naïve",
			"λέξη",
			"слово",
			"単語",
			"🚀",
			"👍🏽",
			"can't",
			"co-op",
			"...",
			"!?",
			";",
			"(x)",
			"42",
			"3.14",
			" ",
			"  ",
			"\t",
			" \t ",
			"\n",
			"\n\n",
			" \n ",
			"\ud800",
			"\udc00",
		];
		const rng = makeRng(0xd1ff);
		const build = (len: number) => {
			let s = "";
			for (let i = 0; i < len; i++) s += tokens[Math.floor(rng() * tokens.length)];
			return s;
		};
		for (let round = 0; round < 200; round++) {
			const a = build(Math.floor(rng() * 40));
			const b = build(Math.floor(rng() * 40));
			const changes = diffWords(a, b);
			// Common tokens carry the new text's whitespace and the post-pass
			// dedupes boundary whitespace, so the kept+added side concatenates
			// back to the new text byte for byte...
			expect(
				changes
					.filter(c => !c.removed)
					.map(c => c.value)
					.join(""),
			).toBe(b);
			// ...while the kept+removed side preserves all non-whitespace
			// content of the old text in order.
			const oldSide = changes
				.filter(c => !c.added)
				.map(c => c.value)
				.join("");
			expect(oldSide.replace(/\s+/gu, "")).toBe(a.replace(/\s+/gu, ""));
		}
	});

	test("seeded random documents", () => {
		const rng = makeRng(0xc0ffee);
		for (let round = 0; round < 30; round++) {
			const crlf = round % 3 === 1;
			const unicode = round % 4 === 2;
			const base = randomText(rng, 5 + Math.floor(rng() * 120), { crlf, unicode });
			verifyDiffInvariants(base, mutate(rng, base, round % 2 === 0 ? 0.01 : 0.2));
		}
	});

	test("10k-line document", () => {
		const rng = makeRng(0xbeef);
		const base = randomText(rng, 10_000);
		verifyDiffInvariants(base, mutate(rng, base, 0.01));
	});
});
