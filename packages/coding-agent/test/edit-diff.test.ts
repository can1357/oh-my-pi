import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	forkClipboard,
	formatHashlineHeader,
	InMemorySnapshotStore,
	missingSnapshotTagMessage,
} from "@oh-my-pi/hashline";
import {
	adjustIndentation,
	computeEditDiff,
	computeHashlineDiff,
	DEFAULT_FUZZY_THRESHOLD,
	findMatch,
	replaceText,
} from "@oh-my-pi/pi-coding-agent/edit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("findMatch", () => {
	describe("exact matching", () => {
		test("finds exact match", () => {
			const content = "line1\nline2\nline3";
			const target = "line2";
			const result = findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBe(1);
			expect(result.match!.startLine).toBe(2);
		});

		test("reports multiple occurrences", () => {
			const content = "foo\nbar\nfoo";
			const target = "foo";
			const result = findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeUndefined();
			expect(result.occurrences).toBe(2);
		});

		test("returns empty for no match", () => {
			const content = "line1\nline2";
			const target = "notfound";
			const result = findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeUndefined();
			expect(result.occurrences).toBeUndefined();
		});
	});

	describe("tab/space normalization", () => {
		test("matches tabs in file with spaces in target", () => {
			const content = "\tfoo\n\t\tbar\n\tbaz";
			const target = "  foo\n    bar\n  baz";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches spaces in file with tabs in target", () => {
			const content = "  foo\n    bar\n  baz";
			const target = "\tfoo\n\t\tbar\n\tbaz";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches different space counts with same relative structure", () => {
			const content = "   foo\n      bar\n   baz";
			const target = "  foo\n    bar\n  baz";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches single line with different indentation", () => {
			const content = 'prefix\n\t\t\t"value",\nsuffix';
			const target = '          "value",';
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});
	});

	describe("fallback for inconsistent indentation", () => {
		test("matches despite one line with wrong indentation in file", () => {
			const content = "\t\t\tline1\n\t\t\tline2\n\t\tline3\n\t\t\tline4";
			const target = "      line1\n      line2\n      line3\n      line4";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches when target has consistent indent but file varies", () => {
			const content = "  a\n    b\n   c\n    d";
			const target = "  a\n    b\n    c\n    d";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
		});
	});

	describe("content matching", () => {
		test("collapses internal whitespace", () => {
			const content = "foo   bar    baz";
			const target = "foo bar baz";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		});

		test("matches with trailing whitespace differences", () => {
			const content = "line1  \nline2\t";
			const target = "line1\nline2";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeDefined();
		});
	});

	describe("threshold behavior", () => {
		test("respects custom similarity threshold", () => {
			const content = "function foo() {}";
			const target = "function bar() {}";
			const strictResult = findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.99,
			});
			expect(strictResult.match).toBeUndefined();

			const lenientResult = findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.7,
			});
			expect(lenientResult.match).toBeDefined();
		});

		test("reports fuzzyMatches count when multiple above threshold", () => {
			const content = "  item1\n  item2\n  item3";
			const target = "  itemX";
			const result = findMatch(content, target, {
				allowFuzzy: true,
				threshold: 0.7,
			});
			expect(result.fuzzyMatches).toBeGreaterThan(1);
		});
	});

	describe("edge cases", () => {
		test("handles empty target", () => {
			const content = "some content";
			const result = findMatch(content, "", { allowFuzzy: true });
			expect(result).toEqual({});
		});

		test("handles empty lines in content", () => {
			const content = "line1\n\nline3";
			const target = "line1\n\nline3";
			const result = findMatch(content, target, { allowFuzzy: false });
			expect(result.match).toBeDefined();
			expect(result.match!.confidence).toBe(1);
		});

		test("handles target longer than content", () => {
			const content = "short";
			const target = "this is much longer than the content";
			const result = findMatch(content, target, { allowFuzzy: true });
			expect(result.match).toBeUndefined();
		});
	});
});

describe("adjustIndentation", () => {
	test("adds indentation when actualText is more indented than oldText", () => {
		const oldText = "foo\nbar";
		const actualText = "    foo\n    bar";
		const newText = "foo\nbaz\nbar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n    baz\n    bar");
	});

	test("removes indentation when actualText is less indented", () => {
		const oldText = "        foo\n        bar";
		const actualText = "    foo\n    bar";
		const newText = "        foo\n        baz";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n    baz");
	});

	test("preserves empty lines", () => {
		const oldText = "foo\n\nbar";
		const actualText = "    foo\n\n    bar";
		const newText = "foo\n\nbaz";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    foo\n\n    baz");
	});

	test("returns unchanged when indentation matches", () => {
		const oldText = "    foo";
		const actualText = "    foo";
		const newText = "    bar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    bar");
	});

	test("uses tab from actualText when adding indentation", () => {
		const oldText = "foo";
		const actualText = "\t\tfoo";
		const newText = "bar";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("\t\tbar");
	});

	test("handles mixed content with different indent levels", () => {
		const oldText = "if (x) {\n  return y;\n}";
		const actualText = "    if (x) {\n      return y;\n    }";
		const newText = "if (x) {\n  return z;\n}";
		const result = adjustIndentation(oldText, actualText, newText);
		expect(result).toBe("    if (x) {\n      return z;\n    }");
	});

	test("does not go negative on removal", () => {
		const oldText = "    foo";
		const actualText = "foo";
		const newText = "  bar";
		const result = adjustIndentation(oldText, actualText, newText);
		// Should remove up to 4 chars, but line only has 2, so remove 2
		expect(result).toBe("bar");
	});
});

describe("replaceText", () => {
	test("does not re-match inserted text while replacing all fuzzy source matches", () => {
		const oldText = "a".repeat(50);
		const firstActual = `${"a".repeat(49)}b`;
		const secondActual = `${"a".repeat(44)}cccccc`;
		const newText = `${oldText}\nexpanded`;

		expect(
			replaceText(`${firstActual}\n${secondActual}`, oldText, newText, {
				all: true,
				fuzzy: true,
				threshold: 0.8,
			}),
		).toEqual({
			content: `${newText}\n${newText}`,
			count: 2,
		});
	});
});

describe("computeHashlineDiff", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-diff-hashline-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	test("returns no-op error for unchanged content when move is absent", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const line = "unchanged content";
		await Bun.write(sourcePath, `${line}\n`);

		// `PUT 1-1:` with the same line in the body is a true no-op: the edit
		// fires through computeHashlineDiff but produces identical content.
		const text = `${line}\n`;
		const snapshotStore = new InMemorySnapshotStore();
		const tag = snapshotStore.record(sourcePath, text);
		const input = `${formatHashlineHeader(sourcePath, tag)}\nPUT 1-1:\n+${line}\n`;
		const result = await computeHashlineDiff({ input }, tempDir, snapshotStore);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("No changes would be made");
		}
	});

	test("accepts hashline input edits", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const text = "first\n";
		await Bun.write(sourcePath, text);

		const snapshotStore = new InMemorySnapshotStore();
		const tag = snapshotStore.record(sourcePath, text);
		const result = await computeHashlineDiff(
			{ input: `${formatHashlineHeader(sourcePath, tag)}\nPUT >$:\n+second` },
			tempDir,
			snapshotStore,
		);
		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("second");
		}
	});

	test("previews a same-file CUT + PASTE as the moved content", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const text = "l1\nl2\nl3\n";
		await Bun.write(sourcePath, text);

		const snapshotStore = new InMemorySnapshotStore();
		const tag = snapshotStore.record(sourcePath, text);
		const result = await computeHashlineDiff(
			{ input: `${formatHashlineHeader(sourcePath, tag)}\nCUT 1-1\nPUT >$` },
			tempDir,
			snapshotStore,
		);
		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("-1|l1");
			expect(result.diff).toContain("+3|l1");
		}
	});

	test("previews a PASTE from a forked session register without touching the source", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const text = "l1\n";
		await Bun.write(sourcePath, text);

		const snapshotStore = new InMemorySnapshotStore();
		const tag = snapshotStore.record(sourcePath, text);
		// Mirror the streaming-strategy contract: the session register is forked
		// once per preview frame; sections then thread the fork in patch order.
		const sessionRegister = { lines: ["carried"] };
		const result = await computeHashlineDiff(
			{ input: `${formatHashlineHeader(sourcePath, tag)}\nPUT >$` },
			tempDir,
			snapshotStore,
			{ clipboard: forkClipboard(sessionRegister) },
		);
		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("|carried");
		}
		expect(sessionRegister.lines).toEqual(["carried"]);
	});

	test("streams paste rows in the natural-order preview", async () => {
		const sourcePath = path.join(tempDir, "source.txt");
		const text = "l1\nl2\nl3\n";
		await Bun.write(sourcePath, text);

		const snapshotStore = new InMemorySnapshotStore();
		const tag = snapshotStore.record(sourcePath, text);
		const result = await computeHashlineDiff(
			{ input: `${formatHashlineHeader(sourcePath, tag)}\nCUT 2-2\nPUT <1` },
			tempDir,
			snapshotStore,
			{ streaming: true, skipHashValidation: true },
		);
		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("-2|l2");
			expect(result.diff).toContain("+1|l2");
		}
	});

	test("rejects a tagless head/tail insert in the preview path, matching apply", async () => {
		const relativePath = "source.txt";
		await Bun.write(path.join(tempDir, relativePath), "first\n");

		// A tagless `PUT >$:` carries no anchored edit, yet the apply path
		// (Patcher.prepare) rejects it for the missing mandatory tag. The
		// preview/diff path MUST emit the SAME rejection so a successful preview
		// never precedes a failing apply.
		const result = await computeHashlineDiff(
			{ input: `[${relativePath}]\nPUT >$:\n+second` },
			tempDir,
			new InMemorySnapshotStore(),
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toBe(missingSnapshotTagMessage(relativePath));
		}
	});
	test("returns a handled error when the source path is a local URL", async () => {
		const result = await computeHashlineDiff(
			{ input: "[local://PLAN.md]\nPUT >$:\n+x" },
			tempDir,
			new InMemorySnapshotStore(),
		);

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain('internal scheme "local://"');
		}
	});

	// A 16-bit snapshot tag can collide across two different file states. The
	// preview mirrors Patcher's apply-time behavior: tag equality with the
	// live content is trusted as-is — a colliding retained snapshot must not
	// reject the preview, since a forced re-read would mint the very same tag.
	test("previews onto live content when the tag matches a colliding retained snapshot", async () => {
		// Both texts hash to `1D84` (pinned in hashline's collision tests).
		const SNAPSHOT_TEXT = "line one 263\nline two 4471\n";
		const LIVE_TEXT = "line one 410\nline two 6970\n";
		const sourcePath = path.join(tempDir, "source.txt");
		await Bun.write(sourcePath, LIVE_TEXT);

		const snapshotStore = new InMemorySnapshotStore();
		// Anchors were minted against SNAPSHOT_TEXT; the live file is the
		// colliding LIVE_TEXT. The tag still matches live, so the SWAP lands
		// on live line 2.
		const tag = snapshotStore.record(sourcePath, SNAPSHOT_TEXT);

		const result = await computeHashlineDiff(
			{ input: `${formatHashlineHeader(sourcePath, tag)}\nPUT 2-2:\n+edited live` },
			tempDir,
			snapshotStore,
		);

		expect("diff" in result).toBe(true);
		if ("diff" in result) {
			expect(result.diff).toContain("edited live");
		}
	});
});

describe("computeEditDiff", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-diff-edit-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	test("returns a handled error when the source path is a local URL", async () => {
		const result = await computeEditDiff("local:/PLAN.md", "old", "new", tempDir);

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain('internal scheme "local://"');
		}
	});
});
