import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleTanCommand = vi.fn(async (_work: string, _images?: ImageContent[]) => true);
	const clearDraft = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleTanCommand,
		clearDraft,
		addToHistory,
		runtime: {
			ctx: {
				editor: { clearDraft, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleTanCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/tan slash command", () => {
	it("routes the full work item through the tan handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan add a changelog note", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.clearDraft).toHaveBeenCalled();
		expect(harness.handleTanCommand).toHaveBeenCalledWith("add a changelog note", undefined);
	});

	it("preserves the raw multi-word suffix after /tan", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/tan    investigate why prompt cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleTanCommand).toHaveBeenCalledWith(
			"investigate why prompt cache reuse matters here",
			undefined,
		);
	});

	it("handles a blank /tan invocation without error", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.clearDraft).toHaveBeenCalled();
		expect(harness.handleTanCommand).toHaveBeenCalledWith("", undefined);
	});
});
