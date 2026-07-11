import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleRenameCommand = vi.fn(async () => {});
	const showError = vi.fn();
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleRenameCommand,
		showError,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				showError,
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

	it("handles a blank /rename invocation without error", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/rename   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith("Usage: /rename <title>");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleRenameCommand).not.toHaveBeenCalled();
	});
});
