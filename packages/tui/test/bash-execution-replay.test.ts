/**
 * Regression: a replayed bash block must seed the recorded output as the
 * completed snapshot, not through the live streaming path. `appendOutput()`
 * applies STREAMING_LINE_CAP (last 100 lines) to bound memory while a command
 * runs, so feeding it the persisted output left every resumed / rewound block
 * permanently truncated to its tail — Ctrl+O expanded to the same 100 lines and
 * the footer under-reported the hidden count by ~9900 lines.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { getThemeByName, initTheme, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
/** Past both the 100-line streaming cap and the 20-line collapsed preview. */
const REPLAY_LINES = Array.from({ length: 250 }, (_, index) => `line-${index}`);
const REPLAY_OUTPUT = REPLAY_LINES.join("\n");
const HIDDEN_LINES = REPLAY_LINES.length - 20;

let darkTheme: Theme;

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected dark theme");
	darkTheme = loaded;
});

/** Rendered rows, ANSI-stripped and trimmed so line equality is exact. */
function rowsOf(component: BashExecutionComponent, width = 120): string[] {
	return Bun.stripANSI(component.render(width).join("\n"))
		.split("\n")
		.map(line => line.trim());
}

describe("BashExecutionComponent replay seeding", () => {
	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	it("keeps every line of a >100-line replayed result after expansion", () => {
		const component = new BashExecutionComponent("seq 1 250", ui, false);
		// The replay path: seed the persisted output as the completed snapshot.
		component.setComplete(0, false, { output: REPLAY_OUTPUT });

		expect(component.getOutput().split("\n")).toHaveLength(REPLAY_LINES.length);

		component.setExpanded(true);
		const rendered = rowsOf(component);
		for (const line of REPLAY_LINES) {
			expect(rendered).toContain(line);
		}
	});

	it("reports the true hidden-line count and keeps advertising expand", () => {
		const component = new BashExecutionComponent("seq 1 250", ui, false);
		component.setComplete(0, false, { output: REPLAY_OUTPUT });

		const rendered = rowsOf(component).join("\n");
		expect(rendered).toContain(`… ${HIDDEN_LINES} more lines`);
		expect(rendered).toContain("to expand");
		// The collapsed preview still shows only the tail window.
		expect(rowsOf(component)).toContain("line-249");
		expect(rowsOf(component)).not.toContain("line-0");
	});

	it("keeps the live streaming cap and stops advertising expand for dropped rows", () => {
		const component = new BashExecutionComponent("seq 1 10000", ui, false);
		component.appendOutput(REPLAY_OUTPUT);

		// The cap is live-output only: the tail is retained, the head is gone.
		const streamed = component.getOutput().split("\n");
		expect(streamed.length).toBeLessThanOrEqual(101);
		expect(streamed).toContain("line-249");

		// Completion without a full snapshot (error/abort path) cannot recover
		// the rows above the cap, so the footer must not promise ctrl+o.
		component.setComplete(0, false);
		const collapsed = rowsOf(component).join("\n");
		expect(collapsed).toContain("more lines");
		expect(collapsed).not.toContain("to expand");

		component.setExpanded(true);
		const expanded = rowsOf(component).join("\n");
		expect(expanded).not.toContain("to expand");
	});
});

describe("ChatTranscriptBuilder bash replay", () => {
	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	function replayBash(bash: AgentMessage): BashExecutionComponent {
		const builder = new ChatTranscriptBuilder({
			ui,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		builder.rebuild([
			{ type: "message", id: "m1", parentId: null, timestamp: new Date(0).toISOString(), message: bash },
		]);
		const component = builder.container.children.find(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		if (!component) throw new Error("Expected a bash execution component");
		return component;
	}

	it("seeds the recorded output whole so expansion reveals every line", () => {
		const component = replayBash({
			role: "bashExecution",
			command: "seq 1 250",
			output: REPLAY_OUTPUT,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		} as unknown as AgentMessage);

		const collapsed = rowsOf(component).join("\n");
		expect(collapsed).toContain(`… ${HIDDEN_LINES} more lines`);
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const rendered = rowsOf(component);
		for (const line of REPLAY_LINES) {
			expect(rendered).toContain(line);
		}
	});

	it("emits no output pane for an empty recorded result", () => {
		const component = replayBash({
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(component.getOutput()).toBe("");
		expect(rowsOf(component).join("\n")).not.toContain("more lines");
	});
});
