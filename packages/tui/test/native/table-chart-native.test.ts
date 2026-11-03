import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./tsp-harness";

const ANSWER = `Where the time goes:

| Section | Time |
|---|---|
| generate_analysis | 10879 ms |
| git_commit | 20.5 ms |
| collect_context | 1.2 s |
| everything else | 9 ms |

The API call dominates.`;

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

describe("table charts on a TSP terminal", () => {
	let harness: TspHarness | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(async () => {
		harness?.stop();
		harness = undefined;
		setNativeRendering(false);
		setTableCharts("off");
		await setTheme("dark");
	});

	it("sends the chart between the prose runs as an svg fence the terminal colors, whatever omp's theme", async () => {
		setTableCharts("always");
		const component = new AssistantMessageComponent(answer(ANSWER));
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();

		const h = harness;
		const texts = () =>
			h
				.findAll(node => node.k === "md" || node.k === "image")
				.map(node => (node.k === "md" && node.p && "text" in node.p ? String(node.p.text) : node.k));
		const [before, chart, after] = texts();
		expect(texts()).toHaveLength(3);
		expect(before).toEndWith("| everything else | 9 ms |");
		expect(after).toBe("The API call dominates.");
		// Tern resolves the figure tokens in the palette it shows, so omp's theme must not leak into the fence.
		expect(chart).toMatch(/^```svg\n<svg [^>]*aria-label="[^"]*bar chart of[^"]*"[^]*<\/svg>\n```$/);
		expect(chart).toContain('fill="var(--c1)"');
		expect(chart).not.toMatch(/(?:fill|stroke|stop-color)="#/);

		await setTheme("light");
		await h.render();
		expect(texts()[1]).toBe(chart);
		expect(h.errors).toEqual([]);
	});

	it("sends a subagent's answer as one md node without a chart", async () => {
		setTableCharts("always");
		const component = new AssistantMessageComponent(answer(ANSWER));
		component.setTableChartsVisible(false);
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();
		expect(harness.findAll(node => node.k === "md" || node.k === "image").map(node => node.k)).toEqual(["md"]);
	});
});
