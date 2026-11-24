/**
 * Regression: queuing a follow-up message (Ctrl+Q / Ctrl+Enter → `app.message.followUp`)
 * with a collapsed `[Paste #N, +X lines]` marker must expand the marker to its stored text
 * before dispatch, identical to the Enter path. Previously `handleFollowUp` read the raw
 * draft text so the model received the literal marker string and the paste was silently
 * dropped (issue #3737).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";

interface PromptOptionsLike {
	streamingBehavior?: "steer" | "followUp";
}

function createContext(isStreaming: boolean, pasted: string) {
	const composer = new Composer();
	// A paste over the collapse threshold lands as a `[Paste #N, +L lines]` marker.
	expect(composer.field.handlers.onPaste?.({ text: pasted })).toBe(true);
	expect(composer.text()).toMatch(/^\[Paste #\d+, \+\d+ lines\]$/);
	const prompt = vi.fn(async (_text: string, _options?: PromptOptionsLike) => {});
	const ctx = {
		composer,
		skillCommands: new Map<string, string>(),
		session: {
			isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
		},
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		sessionManager: { getSessionId: () => "session", getLeafId: () => null },
	} as unknown as InteractiveModeContext;
	return { ctx, prompt };
}

const LINES = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");

describe("InputController.handleFollowUp paste-marker expansion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("expands [Paste #N] markers to their stored text before dispatch while streaming", async () => {
		const { ctx, prompt } = createContext(true, LINES);

		await new InputController(ctx).handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe(LINES);
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(ctx.composer.text()).toBe("");
	});

	it("expands [Paste #N] markers when idle (not streaming)", async () => {
		const { ctx, prompt } = createContext(false, LINES);

		await new InputController(ctx).handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe(LINES);
		expect(call[1]?.streamingBehavior).toBeUndefined();
	});
});
