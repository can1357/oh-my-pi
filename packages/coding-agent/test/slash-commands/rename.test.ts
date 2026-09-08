import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleRenameCommand = vi.fn(async () => {});
	const showStatus = vi.fn();
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleRenameCommand,
		showStatus,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				showStatus,
				handleRenameCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/rename slash command", () => {
	it("routes the title through the rename handler and saves the full command to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/rename my session", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleRenameCommand).toHaveBeenCalledWith("my session");
	});

	it("reports usage for blank input without renaming", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/rename   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /rename <title>");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleRenameCommand).not.toHaveBeenCalled();
	});
});
