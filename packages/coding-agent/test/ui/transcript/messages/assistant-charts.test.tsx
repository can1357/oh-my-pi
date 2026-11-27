/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Charts follow chartable tables in Tern and graphics-capable terminals.
 * A table still being written is not charted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isSettled, signal } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import {
	chartFence,
	lookupTableChart,
	setTableCharts,
	splitTableCharts,
} from "../../../../src/session/transcript/table-chart";
import { Transcript } from "../../../../src/ui/shell/transcript";
import { DEFAULT_FIGURE_CELL, figureWorkSettled } from "../../../../src/ui/transcript/figures/svg";
import { AssistantMessageBlock } from "../../../../src/ui/transcript/messages/assistant-message";
import { nativeShell } from "../../../helpers/native-shell";
import { KITTY } from "../figures/harness";
import "../../../../src/ui/styles/messages";

const TABLE =
	"| Model | Latency (ms) |\n| --- | --- |\n| alpha | 120 |\n| beta | 340 |\n| gamma | 95 |\n| delta | 610 |\n| epsilon | 220 |\n";
const REPLY = `Latencies:\n\n${TABLE}\nDelta is the slowest.\n\n\`\`\`ts\nif (x) {\n\treturn 1;\n}\n\`\`\``;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp: 1,
	} as AssistantMessage;
}

/** A reference before the charted table whose definition comes after it. */
const REFERENCED = `See [details][d].\n\n${TABLE}\nMore.\n\n[d]: https://example.com/x\n`;

afterEach(() => setTableCharts("off"));

describe("table charts", () => {
	test("a table worth charting ends its run of prose and is followed by its chart", () => {
		setTableCharts("always");
		const segments = splitTableCharts(REPLY, false);
		expect(segments.map(segment => segment.kind)).toEqual(["markdown", "chart", "markdown"]);
		const chart = segments[1]!;
		const svg = chart.kind === "chart" ? lookupTableChart(chart.table) : null;
		expect(typeof svg === "string" && svg.startsWith("<svg ")).toBe(true);
		expect(chartFence("<svg/>")).toBe("```svg\n<svg/>\n```");
	});

	test("a table still being written, or with nothing to plot, stays in its prose; so does every table when off", () => {
		setTableCharts("always");
		expect(splitTableCharts(`Latencies:\n\n${TABLE}`, true).map(segment => segment.kind)).toEqual(["markdown"]);
		expect(
			splitTableCharts("| name | note |\n| --- | --- |\n| a | x |\n| b | y |\n", false).map(segment => segment.kind),
		).toEqual(["markdown"]);
		setTableCharts("off");
		expect(splitTableCharts(REPLY, false)).toEqual([{ kind: "markdown", text: REPLY }]);
	});
});

describe("a reply's table charts in Tern", () => {
	async function show(text: string, options: { tableCharts: boolean; transient?: boolean }) {
		const ui = await nativeShell();
		const message = signal<AssistantMessage | undefined>(reply(text));
		ui.shell.transcript.append(() => (
			<AssistantMessageBlock
				model={{
					message,
					transient: options.transient === true,
					finalized: options.transient !== true,
					tableCharts: options.tableCharts,
					now: () => 0,
				}}
			/>
		));
		const prose = (slot: string): string => String(ui.node("md", slot).p.text);
		return { ui, message, prose };
	}

	test("sends the prose up to the table, the chart as an svg figure, then the rest", async () => {
		setTableCharts("always");
		const { ui, prose } = await show(REPLY, { tableCharts: true });
		await using _ = ui;
		expect(prose("t0")).toBe(`Latencies:\n\n${TABLE.trimEnd()}`);
		expect(prose("t0.1")).toStartWith("```svg\n<svg ");
		expect(prose("t0.1")).toEndWith("</svg>\n```");
		// The lexed prose after the chart has its tabs expanded.
		expect(prose("t0.2")).toBe("Delta is the slowest.\n\n```ts\nif (x) {\n    return 1;\n}\n```");
	});

	test("sends the reply as written when charts are off or the view shows none", async () => {
		setTableCharts("off");
		const off = await show(REPLY, { tableCharts: true });
		{
			await using _ = off.ui;
			expect(off.prose("t0")).toBe(REPLY);
		}
		setTableCharts("always");
		const hidden = await show(REPLY, { tableCharts: false });
		await using _ = hidden.ui;
		expect(hidden.prose("t0")).toBe(REPLY);
	});

	test("while a table streams, its finished rows are sent and the row being written is held", async () => {
		setTableCharts("always");
		const partial = "Latencies:\n\n| Model | Latency (ms) |\n| --- | --- |\n| alpha | 120 |\n| beta |";
		const { ui, prose } = await show(partial, { tableCharts: true, transient: true });
		await using _ = ui;
		expect(prose("t0")).toBe("Latencies:\n\n| Model | Latency (ms) |\n| --- | --- |\n| alpha | 120 |");
	});

	test("prose before a chart carries the reference definitions written after it", async () => {
		setTableCharts("always");
		const { ui, prose } = await show(REFERENCED, { tableCharts: true });
		await using _ = ui;
		expect(prose("t0")).toStartWith("[d]: https://example.com/x\n\nSee [details][d].");
	});
});

type ImageProtocol = NonNullable<TerminalCapabilities["images"]>;

function terminalReply(protocol: ImageProtocol, { live = false, text = REPLY } = {}) {
	const capabilities = () => ({ ...KITTY, images: protocol });
	const images = new TerminalImages({ capabilities });
	const theme = loadThemeSync("dark");
	const env = staticEnvironment(theme, { images: driverImages(images, capabilities) });
	const transcript = new Transcript();
	const finalized = signal(!live);
	const figureCell = signal<typeof DEFAULT_FIGURE_CELL | undefined>(DEFAULT_FIGURE_CELL);
	const block = transcript.append(() => (
		<AssistantMessageBlock
			model={{ message: reply(text), finalized, transient: live, tableCharts: true, figureCell }}
		/>
	));
	return { block, finalized, figureCell, images, paint: () => paintNode(env, block.node, 80), transcript };
}

const protocols: [ImageProtocol, RegExp][] = [
	["kitty", /\x1b_Ga=p/],
	["iterm", /\x1b\]1337;File=/],
	["sixel", /\x1bP[\d;]*q/],
];

test.each(protocols)("paints a table's chart before following prose on %s", async (protocol, draw) => {
	setTableCharts("always");
	const { block, images, paint, transcript } = terminalReply(protocol);
	try {
		transcript.settle(block);
		await figureWorkSettled();
		paint();
		await images.whenEncoded();
		const output = paint().rows.join("\n");
		const tableEnd = output.indexOf("epsilon");
		const image = output.search(draw);
		expect(tableEnd).toBeGreaterThanOrEqual(0);
		expect(image).toBeGreaterThan(tableEnd);
		expect(output.indexOf("Delta is the slowest.")).toBeGreaterThan(image);
	} finally {
		transcript.clear();
	}
});

test("terminal prose before a chart resolves a reference defined after it", async () => {
	setTableCharts("always");
	const { block, paint, transcript } = terminalReply("kitty", { text: REFERENCED });
	try {
		transcript.settle(block);
		await figureWorkSettled();
		const output = stripEscapes(paint().rows.join("\n"));
		expect(output).toContain("See details");
		expect(output).not.toContain("[details][d]");
	} finally {
		transcript.clear();
	}
});

test("keeps prose after a waiting smart chart out of terminal scrollback", async () => {
	const judge = Promise.withResolvers<void>();
	setTableCharts("smart", request => judge.promise.then(() => request.guess));
	const { block, finalized, figureCell, paint, transcript } = terminalReply("kitty", { live: true });
	try {
		const before = paint();
		expect(before.rows.join("\n")).toContain("Delta is the slowest.");
		expect(before.rows.slice(0, before.stable ?? 0).join("\n")).not.toContain("Delta is the slowest.");
		finalized.set(true);
		transcript.settle(block);
		expect(isSettled(block.node)).toBe(false);

		const chart = splitTableCharts(REPLY, false).find(segment => segment.kind === "chart")!;
		judge.resolve();
		await lookupTableChart(chart.table);
		paint();
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
		expect(paint().rows.join("\n")).toMatch(/epsilon[\s\S]*\x1b_Ga=p[\s\S]*Delta is the slowest/);

		figureCell.set(undefined);
		const plain = paint().rows.join("\n");
		expect(plain).toMatch(/epsilon[\s\S]*Delta is the slowest/);
		expect(plain).not.toMatch(/\x1b_Ga=p|<svg/);
	} finally {
		judge.resolve();
		transcript.clear();
	}
});
