/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Charts under the tables of a reply, as Tern is sent them: the prose splits after a charted table
 * and the chart follows as an ```svg figure; a table still being written is not charted, and its
 * finished rows are sent while the row in progress is held.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { signal } from "@oh-my-pi/pi-tui";
import {
	chartFence,
	lookupTableChart,
	setTableCharts,
	splitTableCharts,
} from "../../../../src/session/transcript/table-chart";
import { AssistantMessageBlock } from "../../../../src/ui/transcript/messages/assistant-message";
import { nativeShell } from "../../../helpers/native-shell";

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
});
