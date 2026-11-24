/** A bash call's shell presentation across its result frames. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import "../../../src/ui/tools";
import { ToolCall } from "../../../src/ui/transcript/tool-block";

describe("a bash call's shell presentation", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-tool-shell-trace-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(() => {
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("keeps showing what a stopped command ran once its last result arrives without a trace", async () => {
		const command = "for n in 1 2; do echo $n; done";
		const run = await executeBash(command, { cwd: tempDir.path(), timeout: 5000, onTrace: () => {} });
		const call = new ToolCall({ id: "run1", name: "bash", args: { command } });
		const presentation = () => call.state().renderContext?.shellPresentation as ShellVizPresentation;
		call.setExecutionStarted();
		// Before the first trace the engine presents the command as written: nothing ran yet.
		expect(presentation().timeline.length).toBe(0);
		call.updateResult({ content: [{ type: "text", text: "1" }], details: { trace: run.trace } }, true);
		const steps = presentation().timeline.length;
		expect(steps).toBeGreaterThan(0);
		call.updateResult({ content: [{ type: "text", text: "Command aborted" }], isError: true }, false);
		expect(presentation().timeline.length).toBe(steps);
		expect(presentation().output).toBe("Command aborted");
	});
});
