/**
 * Logical text of the transcript looks (`Block.text`): what a transcript selection copies. Each
 * variant paints a real look through the transcript's block wrapper and checks that the text
 * between the markers copies exactly (soft-wrapped rows joined), without the look's borders,
 * gutters or bullets, and that every painted row has an entry.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { jsx, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { type Block, paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { blockText, type RenderedTextRow } from "@oh-my-pi/pi-tui/term/text-layout";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../src/ui/styles/messages";
import "../../src/ui/styles/tools";
import "../../src/ui/styles/transcript/exec-run";
import "../../src/ui/styles/transcript/read-group";
import "../../src/ui/tools";
import { Transcript } from "../../src/ui/shell/transcript";
import { ExecRun, ExecRunBlock } from "../../src/ui/transcript/exec-run";
import { AssistantMessageBlock } from "../../src/ui/transcript/messages/assistant-message";
import { CustomMessageBlock, MessageFrame } from "../../src/ui/transcript/messages/frame";
import { NoticeLine } from "../../src/ui/transcript/messages/notices";
import { CompactionSummaryBlock } from "../../src/ui/transcript/messages/summaries";
import { UserMessage } from "../../src/ui/transcript/messages/user-message";
import { ReadGroup, ReadGroupBlock } from "../../src/ui/transcript/read-group";
import { ToolBlock } from "../../src/ui/transcript/tool-block";
import { toolCall } from "../helpers/tool-text";

const env = staticEnvironment(loadThemeSync("dark"), { now: 0 });

/** Wraps at the widths below; the tree glyphs are content and copy as written. */
const MARK = "MARK_START ├── alpha beta gamma delta epsilon zeta eta theta iota kappa lambda MARK_END";
const WIDTH = 40;

/** `factory`'s block as the terminal transcript paints it (its blank edges trimmed). */
function paintBlock(factory: () => JSXNode, width = WIDTH): Block {
	const transcript = new Transcript();
	const block = transcript.append(factory);
	return paintNode(env, block.node, width);
}

/** The cells of plain `row` from `column`, `width` cells wide. */
function cellsAt(row: string, column: number, width: number): string {
	let at = 0;
	let out = "";
	for (const char of row) {
		const cells = visibleWidth(char);
		if (at >= column && at + cells <= column + width) out += char;
		at += cells;
	}
	return out;
}

/** Checks every content row draws its text where it says, and returns the rows with text. */
function checkedRows(block: Block): { rows: string[]; text: readonly (RenderedTextRow | undefined)[] } {
	const text = blockText(block);
	expect(block.text).toBeDefined();
	expect(text.length).toBe(block.rows.length);
	const rows = block.rows.map(row => Bun.stripANSI(row));
	text.forEach((entry, index) => {
		if (!entry) return;
		for (const span of entry.spans ?? [entry]) {
			const shown = entry.line.text.slice(span.start, span.end);
			expect(cellsAt(rows[index]!, span.column, visibleWidth(shown))).toBe(shown);
		}
	});
	return { rows, text };
}

/** What selecting from `MARK_START` to `MARK_END` copies: the logical lines it spans, cut at the markers. */
function markedCopy(block: Block): string {
	const { rows, text } = checkedRows(block);
	const first = rows.findIndex(row => row.includes("MARK_START"));
	const last = rows.findIndex(row => row.includes("MARK_END"));
	expect(first).toBeGreaterThanOrEqual(0);
	expect(last).toBeGreaterThanOrEqual(first);
	const lines: string[] = [];
	let previous: RenderedTextRow["line"] | undefined;
	for (let row = first; row <= last; row++) {
		const entry = text[row];
		if (!entry || entry.line === previous) continue;
		previous = entry.line;
		lines.push(entry.line.text);
	}
	const joined = lines.join("\n");
	const start = joined.indexOf("MARK_START");
	const end = joined.indexOf("MARK_END");
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return joined.slice(start, end + "MARK_END".length);
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		provider: "p",
		model: "m",
		api: "x",
		timestamp: 0,
	} as AssistantMessage;
}

function assistantBlock(content: AssistantMessage["content"]): JSXNode {
	return AssistantMessageBlock({
		model: {
			message: signal<AssistantMessage | undefined>(assistant(content)),
			finalized: signal(true),
			expandThinking: signal(true),
			now: () => 0,
		},
	});
}

describe("transcript look text", () => {
	test("assistant prose copies a wrapped paragraph as one line", () => {
		const block = paintBlock(() => assistantBlock([{ type: "text", text: MARK }]));
		expect(block.rows.length).toBeGreaterThan(2);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("an assistant table cell copies without its borders", () => {
		const table = "| Name | Note |\n| --- | --- |\n| one | MARK_START cell text MARK_END |";
		const block = paintBlock(() => assistantBlock([{ type: "text", text: table }]), 80);
		expect(markedCopy(block)).toBe("MARK_START cell text MARK_END");
	});

	test("thinking copies its wrapped paragraph", () => {
		const block = paintBlock(() =>
			assistantBlock([
				{ type: "thinking", thinking: MARK },
				{ type: "text", text: "Answer." },
			]),
		);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("a user prompt copies without the bubble's fill", () => {
		const block = paintBlock(() => UserMessage({ model: { text: MARK } }));
		expect(markedCopy(block)).toBe(MARK);
	});

	test("a read preview copies a source line without its line number", () => {
		const group = new ReadGroup({ showContentPreview: true });
		group.updateArgs({ path: "notes.txt" }, "a");
		group.updateResult(
			{
				content: [{ type: "text", text: `${MARK}\nsecond` }],
				details: { displayContent: { text: `${MARK}\nsecond`, startLine: 1 } },
			},
			false,
			"a",
		);
		group.seal();
		const block = paintBlock(() => ReadGroupBlock({ group }) as unknown as JSXNode, 50);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("bash tool output copies a wrapped output line whole", () => {
		const call = toolCall({
			name: "bash",
			args: { command: "echo marks" },
			result: { content: [{ type: "text", text: `${MARK}\nnext` }] },
		});
		const block = paintBlock(() => ToolBlock({ call }));
		expect(markedCopy(block)).toBe(MARK);
	});

	test("selecting a line in a collapsed Bash preview does not copy the hidden prefix", () => {
		const output = `HIDDEN_PREFIX ${"wrapped output ".repeat(90)}VISIBLE_END`;
		const call = toolCall({
			name: "bash",
			args: { command: "echo result" },
			result: { content: [{ type: "text", text: output }] },
			expanded: false,
		});
		const { rows, text } = checkedRows(paintBlock(() => ToolBlock({ call })));
		expect(rows.join("\n")).not.toContain("HIDDEN_PREFIX");
		const last = rows.findIndex(row => row.includes("VISIBLE_END"));
		expect(last).toBeGreaterThanOrEqual(0);
		const selectedLine = text[last]!.line.text;
		expect(selectedLine).toEndWith("VISIBLE_END");
		expect(selectedLine).not.toContain("HIDDEN_PREFIX");
	});

	test("a generic tool card copies its output without the card padding", () => {
		const call = toolCall({
			name: "fixture_tool",
			args: { topic: "marks" },
			result: { content: [{ type: "text", text: MARK }] },
			expanded: true,
		});
		const block = paintBlock(() => ToolBlock({ call }));
		expect(markedCopy(block)).toBe(MARK);
	});

	test.each(["unified", "numbered"] as const)("a wrapped %s edit diff line copies as one logical line", kind => {
		const diff = kind === "unified" ? `@@ -1 +1 @@\n-old\n+${MARK}` : `-1|old\n+1|${MARK}`;
		const call = toolCall({
			name: "edit",
			args: { path: "fixture.txt" },
			result: { content: [{ type: "text", text: "updated" }], details: { diff, firstChangedLine: 1 } },
			expanded: true,
		});
		const block = paintBlock(() => ToolBlock({ call }));
		expect(block.rows.filter(row => Bun.stripANSI(row).includes("MARK")).length).toBeGreaterThan(0);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("a user-run command copies its wrapped output line", () => {
		const run = new ExecRun({ kind: "bash", source: "echo marks", excluded: false, now: () => 0 });
		run.appendOutput(`${MARK}\n`);
		run.setComplete(0, false);
		const block = paintBlock(() => ExecRunBlock({ run }));
		expect(markedCopy(block)).toBe(MARK);
	});

	test("an error notice copies its message", () => {
		const block = paintBlock(() => NoticeLine({ tone: "error", message: MARK }));
		expect(markedCopy(block)).toBe(MARK);
	});

	test("an expanded compaction summary copies its detail", () => {
		const block = paintBlock(() =>
			CompactionSummaryBlock({ message: { summary: MARK, tokensBefore: 1000 }, expanded: signal(true) }),
		);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("a collapsed compaction summary copies its label without the rules or hint", () => {
		const block = paintBlock(
			() => CompactionSummaryBlock({ message: { summary: MARK, tokensBefore: 1000 }, expanded: signal(false) }),
			80,
		);
		const { text } = checkedRows(block);
		const labels = text.filter(entry => entry !== undefined);
		expect(labels).toHaveLength(1);
		const label = labels[0]!.line.text;
		expect(label).toMatch(/compacted/i);
		expect(label).not.toMatch(/[─·]/);
	});

	test("a custom message card copies its body without the outline", () => {
		const block = paintBlock(() =>
			CustomMessageBlock({ message: { customType: "note", content: MARK }, expanded: signal(true) }),
		);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("an extension renderer's built-in nodes copy one cell in", () => {
		const block = paintBlock(() =>
			MessageFrame({
				message: { customType: "note", content: "unused" },
				role: "omp.custom",
				renderer: () => jsx("text", { spans: [{ t: MARK }], wrap: "word" }),
				expanded: signal(true),
			}),
		);
		expect(markedCopy(block)).toBe(MARK);
	});

	test("an extension's render-only rows copy literally", () => {
		const rows = ["MARK_START ├── alpha", "│   └── leaf MARK_END"];
		const block = paintBlock(() =>
			MessageFrame({
				message: { customType: "note", content: "unused" },
				role: "omp.custom",
				renderer: () => jsx("canvas", { paint: () => rows }),
				expanded: signal(true),
			}),
		);
		expect(markedCopy(block)).toBe(rows.join("\n"));
	});
});
