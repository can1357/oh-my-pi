import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleMemoryCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleMemoryCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleMemoryCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/memory slash command", () => {
	it("routes the full command text through the memory handler and saves it to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/memory view", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMemoryCommand).toHaveBeenCalledWith("/memory view");
	});

	it("preserves the raw command text for history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/memory    stats", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleMemoryCommand).toHaveBeenCalledWith("/memory    stats");
	});
});
