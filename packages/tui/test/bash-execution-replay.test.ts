/**
 * Regression: a replayed bash block must seed the recorded output as the
 * completed snapshot, not through the live streaming path. `appendOutput()`
 * applies STREAMING_LINE_CAP (last 100 lines) to bound memory while a command
 * runs, so feeding it the persisted output left every resumed / rewound block
 * permanently truncated to its tail — Ctrl+O expanded to the same 100 lines and
 * the footer under-reported the hidden count by ~9900 lines.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent, STREAMING_LINE_CAP } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { PREVIEW_LINES } from "@oh-my-pi/pi-tui/chat/execution-shared";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getThemeByName, initTheme, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
/** Past both the streaming cap and the 20-row collapsed preview. */
const REPLAY_LINES = Array.from({ length: 250 }, (_, index) => `line-${index}`);
const REPLAY_OUTPUT = REPLAY_LINES.join("\n");
/** Rows the collapsed preview hides but the expanded view still delivers. */
const HIDDEN_LINES = REPLAY_LINES.length - PREVIEW_LINES;
/** Same, for the tail window the live streaming cap retains. */
const CAPPED_HIDDEN_LINES = STREAMING_LINE_CAP - PREVIEW_LINES;
/** Rows the live streaming cap discarded, unrecoverable by any means. */
const DROPPED_LINES = REPLAY_LINES.length - STREAMING_LINE_CAP;

let darkTheme: Theme;

beforeAll(async () => {
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

	it("keeps the live streaming cap and reports dropped rows apart from the recoverable tail", () => {
		const component = new BashExecutionComponent("seq 1 10000", ui, false);
		component.appendOutput(REPLAY_OUTPUT);

		// The cap is live-output only: the tail is retained, the head is gone.
		const streamed = component.getOutput().split("\n");
		expect(streamed).toHaveLength(STREAMING_LINE_CAP);
		expect(streamed).toContain("line-249");

		// Completion without a full snapshot (error/abort path) leaves the
		// retained tail, so the rows the footer counts stay recoverable and the
		// expand hint must stay.
		component.setComplete(0, false);
		const collapsed = rowsOf(component).join("\n");
		expect(collapsed).toContain(`… ${CAPPED_HIDDEN_LINES} more lines`);
		expect(collapsed).toContain("to expand");
		// The rows above the cap are gone for good, and the footer names them
		// without advertising expand for them.
		expect(collapsed).toContain(`… ${DROPPED_LINES} earlier lines dropped`);

		// Expansion reaches the retained tail but not the dropped head.
		component.setExpanded(true);
		const expanded = rowsOf(component).join("\n");
		expect(expanded).toContain(`… ${DROPPED_LINES} earlier lines dropped`);
		expect(expanded).toContain("line-249");
		expect(expanded).not.toContain("line-0");
		expect(expanded).not.toContain("to expand");
	});

	it("reports the partial line a throttled chunk lost", () => {
		// A chunk rejected by the throttle merges its first segment into the
		// retained last row, and that segment is discarded: the row on screen
		// lost its tail. The loss is a fragment loss whether or not the chunk
		// also contributed whole rows, so the footer has to name it — the
		// retained row is not the intact line it looks like.
		const component = new BashExecutionComponent("seq 1 10", ui, false);
		component.appendOutput("kept-");
		// Inside the 50 ms gate: the chunk is rejected whole.
		component.appendOutput("suffix\nnext");
		// The error path settles without a final snapshot.
		component.setComplete(undefined, false);

		const rows = rowsOf(component).join("\n");
		expect(rows).toContain("lines skipped in output");
		expect(rows).toContain("partial output skipped in output");
	});
});

describe("ChatTranscriptBuilder bash replay", () => {
	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	function replayBash(bash: AgentMessage): { builder: ChatTranscriptBuilder; component: BashExecutionComponent } {
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
		return { builder, component };
	}

	it("seeds the recorded output whole so expansion reveals every line", () => {
		const { builder, component } = replayBash({
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

		// Toggled through the builder, the way the rewind / copy / agent
		// transcript views do: only registered components follow it.
		builder.setExpanded(true);
		const rendered = rowsOf(component);
		for (const line of REPLAY_LINES) {
			expect(rendered).toContain(line);
		}
	});

	it("emits no output pane for an empty recorded result", () => {
		const { component } = replayBash({
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(component.getOutput()).toBe("");
		// No output pane: the only rendered rows are the frame's borders and the
		// command header, so there is neither a preview nor a status line.
		const rows = rowsOf(component);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toBe("$ true");
	});
});
