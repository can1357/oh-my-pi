import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleOmfgCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleOmfgCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleOmfgCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/omfg slash command", () => {
	it("routes the full complaint through the interactive omfg handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/omfg This guy used any again....", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleOmfgCommand).toHaveBeenCalledWith("This guy used any again....");
	});

	it("preserves the raw multi-word suffix after /omfg", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/omfg    stop making unchecked casts in generated TypeScript",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleOmfgCommand).toHaveBeenCalledWith("stop making unchecked casts in generated TypeScript");
	});

	it("handles a blank /omfg invocation without error", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/omfg   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleOmfgCommand).toHaveBeenCalledWith("");
	});
});
