import { beforeAll, describe, expect, it } from "bun:test";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Box } from "../src/components/box";
import { Disclosure } from "../src/components/disclosure";
import { Markdown } from "../src/components/markdown";
import { Table } from "../src/components/table";
import { Text } from "../src/components/text";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { setThemeInstance, theme } from "../src/theme";
import { getMarkdownTheme } from "../src/theme/theme";
import { loadThemeSync } from "../src/theme/loader";

const CX: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

beforeAll(() => {
	// Truecolor keeps every theme token distinct so reverse-mapped styling is deterministic.
	setThemeInstance(loadThemeSync("dark", { mode: "truecolor" }));
});

function props(described: NativeNode | null): Record<string, unknown> {
	if (!described) throw new Error("expected a native node");
	return (described.p ?? {}) as Record<string, unknown>;
}

describe("Markdown.describe streaming", () => {
	it("keeps the node while unchanged and grows the same md node append-only while streaming", () => {
		const markdown = new Markdown("# Title\n\nFirst", 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		const first = markdown.describe(CX);
		expect(markdown.describe(CX)).toBe(first);

		markdown.setText("# Title\n\nFirst and then the parser");
		const second = markdown.describe(CX);
		expect(second).not.toBe(first);
		expect(second.k).toBe("md");
		expect(second.key).toBe(first.key);
		expect(props(second).stream).toBe(true);
		const before = props(first).text as string;
		const after = props(second).text as string;
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toBe(" and then the parser");

		markdown.transientRenderCache = false;
		expect(props(markdown.describe(CX)).stream).toBeUndefined();
	});
});

describe("Box.describe", () => {
	it("maps background fills to card tone and role", () => {
		const errorBox = new Box(1, 1, t => theme.bg("toolErrorBg", t));
		expect(errorBox.describe(CX).k).toBe("card");
		expect(props(errorBox.describe(CX))).toMatchObject({ tone: "error", role: "omp.tool", inset: true });

		const userBox = new Box(1, 1, t => theme.bg("userMessageBg", t));
		expect(props(userBox.describe(CX))).toMatchObject({ tone: "user", role: "omp.user" });
	});

	it("maps a border colour to the ring tone and drops glyph chrome", () => {
		const bordered = new Box(1, 0, undefined, {
			chars: theme.boxRound,
			color: t => theme.fg("borderAccent", t),
		});
		const described = bordered.describe(CX);
		expect(described.k).toBe("card");
		expect(props(described).tone).toBe("accent");
		expect(props(described).inset).toBeUndefined();
		expect(JSON.stringify(described)).not.toMatch(/[╭╮╰╯│─]/);
	});

	it("is a plain col without border or background and rebuilds only when children change", () => {
		const box = new Box();
		const child = new Text("hello");
		box.addChild(child);
		const first = box.describe(CX);
		expect(first.k).toBe("col");
		expect(first.c).toEqual([child]);
		expect(box.describe(CX)).toBe(first);
		box.addChild(new Text("more"));
		expect(box.describe(CX)).not.toBe(first);
	});
});

describe("Table.describe", () => {
	it("keeps column priorities, alignment and truncation, with escape-free cells", () => {
		const table = new Table(
			[
				[{ text: "src/a.ts" }, { text: "12", style: t => theme.fg("success", t) }],
				[{ text: "src/b.ts" }, { text: "3" }],
			],
			[
				{ width: 30, align: "left", overflow: "truncate", priority: 2 },
				{ width: 6, align: "right", overflow: "allow", priority: 0 },
			],
		);
		const described = table.describe(CX);
		const p = props(described) as {
			cols: { id: string; priority: number; align: string; truncate?: string }[];
			rows: { cells: Record<string, string | TspSpan[]> }[];
		};
		expect(p.cols.map(col => [col.priority, col.align, col.truncate])).toEqual([
			[2, "start", "end"],
			[0, "end", undefined],
		]);
		expect(p.rows[0]!.cells[p.cols[1]!.id]).toEqual([{ t: "12", s: "success" }]);
		expect(JSON.stringify(described)).not.toContain("\x1b");
	});
});

describe("Text.describe", () => {
	it("turns theme-styled ANSI into token spans with no escapes", () => {
		const styled = `\x1b[1m${theme.fg("accent", "Bash")}\x1b[22m ${theme.fg("muted", "ls -la")}`;
		const described = new Text(styled).describe(CX);
		expect(JSON.stringify(described)).not.toContain("\x1b");
		expect(props(described).spans).toEqual([
			{ t: "Bash", s: "accent strong" },
			{ t: " " },
			{ t: "ls -la", s: "muted" },
		]);
	});
});

describe("Disclosure.handleNativeEvent", () => {
	it("mirrors a terminal toggle into the expanded state and the described section", () => {
		const disclosure = new Disclosure({ summary: new Text("Summary"), body: () => new Text("Details") });
		expect(props(disclosure.describe(CX)).collapsed).toBe(true);
		disclosure.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(disclosure.expanded).toBe(true);
		const expanded = disclosure.describe(CX);
		expect(props(expanded).collapsed).toBe(false);
		expect(expanded.c).toHaveLength(2);
	});
});
