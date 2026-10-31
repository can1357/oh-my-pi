/**
 * Regression: replaying a persisted bash execution must seed the recorded
 * output as the completed snapshot. `appendOutput()` applies the live
 * STREAMING_LINE_CAP (last 100 lines) to bound memory while a command runs, so
 * feeding it the persisted output truncated every resumed session's bash block
 * to its tail permanently — Ctrl+O could not expand it back and the footer's
 * hidden-line count was computed from the capped array.
 *
 * The suite drives the mode context's OWN settings, never the process-wide
 * settings singleton: installing or resetting that singleton would leak state
 * into (and out of) the other test files.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { isSettingsInitialized } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** Past both the 100-line streaming cap and the 20-line collapsed preview. */
const REPLAY_LINES = Array.from({ length: 250 }, (_, index) => `line-${index}`);
const REPLAY_OUTPUT = REPLAY_LINES.join("\n");
const HIDDEN_LINES = REPLAY_LINES.length - 20;

function bashMessage(output: string): AgentMessage {
	return {
		role: "bashExecution",
		command: "seq 1 250",
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
	} as unknown as AgentMessage;
}

describe("UiHelpers bash replay seeding", () => {
	/** Whether the process-wide settings singleton existed before this suite. */
	let singletonBefore = false;

	beforeAll(async () => {
		singletonBefore = isSettingsInitialized();
		await initTheme();
	});

	it("keeps every line of a >100-line result after expansion", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.addMessageToChat(bashMessage(REPLAY_OUTPUT));
		const component = ctx.chatContainer.children.find(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		if (!component) throw new Error("Expected a bash execution component in the transcript");

		const collapsed = Bun.stripANSI(component.render(120).join("\n"));
		expect(collapsed).toContain(`… ${HIDDEN_LINES} more lines`);

		component.setExpanded(true);
		const rendered = Bun.stripANSI(component.render(120).join("\n"))
			.split("\n")
			.map(line => line.trim());
		for (const line of REPLAY_LINES) {
			expect(rendered).toContain(line);
		}
	});

	it("leaves the process-wide settings singleton alone", () => {
		// The suite reads the mode context's own settings, so it neither
		// installs nor clears the process-wide singleton: a file that resets it
		// takes the settings away from whichever file owns it, and one that
		// installs it hands its in-memory cwd and settings to every later file.
		expect(isSettingsInitialized()).toBe(singletonBefore);
	});
});
