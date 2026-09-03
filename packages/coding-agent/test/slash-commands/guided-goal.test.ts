import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(handler: () => Promise<boolean>) {
	const handleGuidedGoalCommand = vi.fn(handler);
	const clearDraft = vi.fn();
	return {
		handleGuidedGoalCommand,
		clearDraft,
		runtime: {
			ctx: {
				editor: { clearDraft } as unknown as InteractiveModeContext["editor"],
				handleGuidedGoalCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/guided-goal slash command", () => {
	it("clears the slash draft before the interview turn resolves", async () => {
		// The handler blocks for the whole kickoff turn (session.prompt resolves
		// only when the agent finishes asking its first question). Hold it open
		// to simulate that window.
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const harness = createRuntime(() => promise);
		const images: ImageContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
		const input = { images, imageLinks: ["file:///shot.png"] };

		const dispatched = executeBuiltinSlashCommand("/guided-goal ship the release", {
			...harness.runtime,
			input,
		});

		// The command text must be gone before the turn resolves, so an answer
		// typed while the first question streams is never wiped.
		expect(harness.clearDraft).toHaveBeenCalled();
		harness.clearDraft.mockClear();

		resolve(true);
		expect(await dispatched).toBe(true);
		expect(harness.clearDraft).not.toHaveBeenCalled();
		expect(harness.handleGuidedGoalCommand).toHaveBeenCalledWith("ship the release", input);
	});

	it("passes no objective for a bare invocation", async () => {
		const harness = createRuntime(async () => true);

		const handled = await executeBuiltinSlashCommand("/guided-goal   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleGuidedGoalCommand).toHaveBeenCalledWith(undefined, undefined);
	});
});
