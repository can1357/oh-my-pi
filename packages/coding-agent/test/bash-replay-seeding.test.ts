/**
 * Regression: replaying a persisted bash execution must seed the recorded
 * output as the completed snapshot. `appendOutput()` applies the live
 * STREAMING_LINE_CAP (last 100 lines) to bound memory while a command runs, so
 * feeding it the persisted output truncated every resumed session's bash block
 * to its tail permanently — Ctrl+O could not expand it back and the footer's
 * hidden-line count was computed from the capped array.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { isSettingsInitialized, resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

/**
 * Take the process-wide settings singleton — the module-level `settings` proxy
 * `UiHelpers.addMessageToChat()` reads throws without it — but only when no
 * other test file owns it yet.
 *
 * `Settings.init()` is memoized: it adopts an existing instance instead of
 * creating one, so an unconditional call here would silently run against
 * another file's settings (and its cwd). `resetSettingsForTest()` empties the
 * singleton for everyone, so a file that only adopted it must not clear it:
 * the owner would then see "Settings not initialized" mid-run. The returned
 * lease releases only what this file created.
 */
async function acquireSettings(): Promise<() => void> {
	if (isSettingsInitialized()) return () => {};
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	return () => resetSettingsForTest();
}

describe("UiHelpers bash replay seeding", () => {
	let releaseSettings: (() => void) | undefined;

	beforeAll(async () => {
		releaseSettings = await acquireSettings();
		await initTheme();
	});

	afterAll(() => {
		releaseSettings?.();
		releaseSettings = undefined;
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

	it("leaves a settings singleton it did not create in place", async () => {
		// Another test file may own the process-wide settings singleton. A lease
		// that only adopted it must not clear it: `resetSettingsForTest()` empties
		// the singleton for every file, and the owner would then fail with
		// "Settings not initialized" — the cross-file leak this file used to
		// cause by resetting unconditionally.
		const foreignRelease = await acquireSettings();
		foreignRelease();
		expect(isSettingsInitialized()).toBe(true);
	});
});
