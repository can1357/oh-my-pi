import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleMoveCommand = vi.fn(async () => {});
	const showError = vi.fn();
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleMoveCommand,
		showError,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				showError,
				handleMoveCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/move slash command", () => {
	it("routes the path through the move handler and saves the full command to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/move /tmp/project", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMoveCommand).toHaveBeenCalledWith("/tmp/project");
	});

	it("routes a blank /move invocation to the interactive move handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/move   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMoveCommand).toHaveBeenCalledWith(undefined);
	});
});
