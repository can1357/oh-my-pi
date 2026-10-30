import { describe, expect, test } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import {
	describeJsonTree,
	formatArgsInline,
	JSON_TREE_INLINE_LEN,
	renderJsonTreeLines,
} from "@oh-my-pi/pi-tui/tools/json-tree";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

/** The top-level rows of `value`'s described tree: label text, and whether it expands. */
function treeRows(value: unknown): { text: string; expands: boolean }[] {
	const tree = describeJsonTree(value, { hiddenRootKeys: [] });
	if (tree.k !== "tree") throw new Error(`expected a tree, got ${tree.k}`);
	return (tree.p?.nodes ?? []).map(item => ({
		text: typeof item.label === "string" ? item.label : item.label.map(part => part.t).join(""),
		expands: (item.children?.length ?? 0) > 0,
	}));
}

describe("small JSON containers", () => {
	// Python's `Counter.most_common()` prints tuples of tuples: one row per pair,
	// not five rows of bracketed indices.
	const counts = [
		[[3, "daemon_wire_decode"], 121],
		[[6, "vt"], 98],
	];

	test("show whole on one tree row", () => {
		expect(treeRows(counts)).toEqual([
			{ text: '0: [[3, "daemon_wire_decode"], 121]', expands: false },
			{ text: '1: [[6, "vt"], 98]', expands: false },
		]);
		expect(treeRows({ args: { stream: 0, "line count": 70, empty: [] } })).toEqual([
			{ text: 'args: {stream: 0, "line count": 70, empty: []}', expands: false },
		]);
	});

	test("expand once their one-line form passes the budget", () => {
		const fits = "x".repeat(JSON_TREE_INLINE_LEN - 4);
		expect(treeRows([[fits], [`${fits}x`]])).toEqual([
			{ text: `0: ["${fits}"]`, expands: false },
			{ text: "1 [1]", expands: true },
		]);
	});

	test("align their indices like line numbers", () => {
		const rows = treeRows(Array.from({ length: 11 }, (_, i) => [i]));
		expect([rows[0]?.text, rows[10]?.text]).toEqual([" 0: [0]", "10: [10]"]);
	});

	test("show whole on one terminal row", async () => {
		const theme = (await getThemeByName("dark"))!;
		const { lines } = renderJsonTreeLines(counts, theme, { maxDepth: 2, maxLines: 10, maxScalarLen: 60 });
		const plain = lines.map(line => Bun.stripANSI(line).trimEnd());
		expect(plain).toHaveLength(2);
		expect(plain[0]).toEndWith(' 0: [[3, "daemon_wire_decode"], 121]');
		expect(plain[1]).toEndWith(' 1: [[6, "vt"], 98]');
	});
});

describe("formatArgsInline", () => {
	test("a trailing scalar grows into the available width instead of a fixed cap", () => {
		// Regression: the value used to be hard-capped at 24 columns, so a long
		// note was truncated even when the card had plenty of room (issue: advise
		// preview cut to `note="Your “stric…"`).
		const note = "x".repeat(200);
		const narrow = formatArgsInline({ severity: "concern", note }, 40);
		const wide = formatArgsInline({ severity: "concern", note }, 120);
		expect(Bun.stringWidth(wide)).toBeGreaterThan(Bun.stringWidth(narrow) + 40);
		// Both stay within their budget.
		expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(40);
		expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(120);
	});

	test("every key stays visible even when a leading value is long", () => {
		const out = formatArgsInline({ path: "x".repeat(200), pattern: "needle", limit: 5 }, 80);
		expect(out).toContain("path=");
		expect(out).toContain("pattern=");
		expect(out).toContain("limit=");
		expect(Bun.stringWidth(out)).toBeLessThanOrEqual(80);
	});

	test("short values render fully without truncation markers", () => {
		expect(formatArgsInline({ a: "x", b: 5, c: true }, 80)).toBe('a="x", b=5, c=true');
	});

	test("hidden meta keys are skipped", () => {
		const out = formatArgsInline({ [INTENT_FIELD]: "noise", __partialJson: "{}", path: "src/foo.ts" }, 80);
		expect(out).toBe('path="src/foo.ts"');
	});
});
