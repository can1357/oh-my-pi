import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme, setTheme, theme } from "@oh-my-pi/pi-tui/theme";
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

	it("sends the chart as an SVG image between the prose runs, recolored when the theme changes", async () => {
		setTableCharts("always");
		const component = new AssistantMessageComponent(answer(ANSWER));
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();

		const h = harness;
		expect(h.findAll(node => node.k === "md" || node.k === "image").map(node => node.k)).toEqual([
			"md",
			"image",
			"md",
		]);
		const blob = () => {
			const props = h.find(node => node.k === "image")?.p;
			const id = props && "blob" in props ? String(props.blob) : "";
			return new TextDecoder().decode(h.terminal.blobs.get(id));
		};
		const dark = blob();
		expect(dark).toStartWith("<svg");
		expect(dark).not.toContain("var(--");
		expect(dark).toContain(theme.getColorHex("accent"));

		await setTheme("light");
		await h.render();
		const light = blob();
		expect(light).toContain(theme.getColorHex("accent"));
		expect(light).not.toBe(dark);
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
