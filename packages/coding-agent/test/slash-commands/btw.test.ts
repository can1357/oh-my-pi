import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleBtwCommand = vi.fn(async (_question: string, _images?: ImageContent[]) => true);
	const clearDraft = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleBtwCommand,
		clearDraft,
		addToHistory,
		runtime: {
			ctx: {
				editor: { clearDraft, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleBtwCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/btw slash command", () => {
	it("preserves the raw multi-word suffix after /btw", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/btw    explain why the cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("explain why the cache reuse matters here", undefined);
	});

	it("handles a blank /btw invocation without error", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.clearDraft).toHaveBeenCalled();
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("", undefined);
	});
});
