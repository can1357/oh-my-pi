import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { anchoredRows, RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { type Block, type PaintImages, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ensureTheme } from "../../src/ui/theme/service";
import { ToolBlock, type ToolCall } from "../../src/ui/transcript/tool-block";
import { toolCall } from "../helpers/tool-text";

const restoreTheme = currentTheme();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	ensureTheme();
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
	resetSettingsForTest();
});

/** The block, painted at a fixed height (the transcript's viewport allocation) when given. */
function paint(call: ToolCall, height: number | undefined, images?: PaintImages): Block {
	const env = staticEnvironment(currentTheme(), images ? { images } : {});
	return createRoot(dispose => {
		try {
			const [node] = resolveChildren(() => ToolBlock({ call }))();
			return renderBlock(node!, 80, { env, height });
		} finally {
			dispose();
		}
	});
}

function text(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");
}

function taskCall(): ToolCall {
	return toolCall({
		name: "task",
		args: {
			context: lines("- Shared rule", 20),
			tasks: Array.from({ length: 3 }, (_, i) => ({ name: `Agent${i}`, task: `Task number ${i}` })),
		},
	});
}

describe("tool block viewport allocation", () => {
	it("fills a tall allocation with the card's head and newest rows instead of a 2-row stub", () => {
		const full = text(paint(taskCall(), undefined).rows).filter(row => row.trim().length > 0);
		expect(full.length).toBeGreaterThan(10);

		const rows = text(paint(taskCall(), 8).rows);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toBe(full[0]);
		expect(rows.slice(1)).toEqual(full.slice(-7));
		expect(rows.at(-1)).toContain("╰");
	});

	it("keeps a boxed look's title row, not just its blank pad row", () => {
		const call = toolCall({
			name: "mcp__demo_search",
			args: { query: "x" },
			result: { content: [{ type: "text", text: lines("line", 30) }] },
			expanded: true,
		});
		const rows = text(paint(call, 8).rows);
		expect(rows).toHaveLength(8);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]).toContain("MCP");
	});

	it("keeps every row of a wrapped title", () => {
		const name = `inspect_${"very_long_segment_".repeat(5)}end`;
		const call = toolCall({
			name,
			args: { q: "x" },
			result: { content: [{ type: "text", text: lines("line", 30) }] },
			expanded: true,
		});
		const rows = text(paint(call, 8).rows);
		expect(rows).toHaveLength(8);
		// The title wraps past the first row; its tail must stay above the newest output.
		const title = rows.join("").replace(/\s+/g, "");
		expect(title).toContain(name);
		expect(rows.at(-2)).toContain("line 29");
	});

	it("never starts the tail inside an image, whose draw would move up over the head", () => {
		// SIXEL-style rows: three reserved rows, the draw on the last one moving up over them.
		const images: PaintImages = {
			rows: () => ({ rows: anchoredRows("\x1bPq~\x1b\\", 4), columns: 8, state: "image" }),
			cell: () => ({ w: 10, h: 20 }),
		};
		const call = toolCall({
			name: "bash",
			args: { command: "x" },
			result: {
				content: [
					{ type: "text", text: lines("out", 30) },
					{ type: "image", data: PNG, mimeType: "image/png" },
				],
			},
			expanded: true,
		});

		// Head plus three tail rows: the 4-row image cannot fit, so it is dropped whole and the rows above it fill in.
		const { rows } = paint(call, 4, images);
		expect(rows).toHaveLength(4);
		expect(text(rows)[1]).toContain("out 29");
		expect(text(rows)[0]).toContain("╭");
		rows.forEach((row, at) => {
			const up = Number(/\x1b\[(\d+)A/.exec(row)?.[1] ?? 0);
			for (let above = at - up; above < at; above++) expect(rows[above]?.trim()).toBe(RESERVED_ROW);
		});
	});

	it("keeps an image fallback's label and skips the reserved rows that draw nothing", () => {
		// A demoted image on a graphics terminal: its fallback label, then reserved rows for its box.
		let label = "";
		const images: PaintImages = {
			rows: (_source, request) => {
				label = Bun.stripANSI(request.fallback);
				return { rows: [request.fallback, RESERVED_ROW, RESERVED_ROW], columns: 8, state: "fallback" };
			},
			cell: () => ({ w: 10, h: 20 }),
		};
		const call = toolCall({
			name: "bash",
			args: { command: "x" },
			result: {
				content: [
					{ type: "text", text: lines("out", 30) },
					{ type: "image", data: PNG, mimeType: "image/png" },
				],
			},
			expanded: true,
		});

		// Head plus two tail rows: exactly the room the two reserved rows would take.
		const rows = paint(call, 3, images).rows;
		expect(rows).toHaveLength(3);
		expect(label).not.toBe("");
		expect(text(rows).at(-1)).toContain(label);
		expect(rows.filter(row => row.trim() === RESERVED_ROW)).toEqual([]);
	});

	it("keeps a running agent's newest rows clickable when its row run starts above the cut", () => {
		const progress = {
			index: 0,
			id: "0-Alpha",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "Do it",
			recentTools: [],
			recentOutput: lines("output", 12).split("\n"),
			toolCount: 0,
			requests: 1,
			tokens: 10,
			durationMs: 1000,
		};
		const call = toolCall({
			name: "task",
			args: { context: lines("- rule", 10), tasks: [{ name: "Alpha", task: "Do it" }] },
			result: {
				content: [{ type: "text", text: "" }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] },
			} as never,
			partial: true,
			expanded: true,
		});

		// Head plus seven tail rows: the agent's output rows above the closing edge.
		const { rows, hits } = paint(call, 8);
		expect(
			text(rows)
				.slice(1, -1)
				.every(row => row.includes("output")),
		).toBe(true);
		expect(hits?.map(({ row, height, item }) => ({ row, height, item }))).toEqual([
			{ row: 1, height: 6, item: "0-Alpha" },
		]);
	});

	it("keeps the 2-row frame edge when only two rows are allocated", () => {
		const rows = text(paint(taskCall(), 2).rows);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("╭─");
		expect(rows[1]?.trim()).toBe("╰");
	});
});
