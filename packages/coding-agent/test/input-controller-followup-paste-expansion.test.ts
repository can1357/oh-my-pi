/**
 * Regression: queuing a follow-up message (Ctrl+Q / Ctrl+Enter → `app.message.followUp`)
 * with a collapsed `[Paste #N, +X lines]` marker must expand the marker to its stored text
 * before dispatch, identical to the Enter path. Previously `handleFollowUp` read raw
 * `getText()` so the model received the literal marker string and the paste was silently
 * dropped (issue #3737).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface PromptOptionsLike {
	streamingBehavior?: "steer" | "followUp";
}

describe("InputController.handleFollowUp paste-marker expansion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("expands [Paste #N] markers to their stored text before dispatch while streaming", async () => {
		const expanded = "line1\nline2\nline3\nline4\nline5";
		let editorText = "[Paste #1, +5 lines]";
		const prompt = vi.fn(async (_text: string, _options?: PromptOptionsLike) => {});
		const ctx = {
			editor: {
				setText(text: string) {
					editorText = text;
				},
				getText: () => editorText,
				getExpandedText: () => editorText.replace(/\[Paste #1(?:, (?:\+\d+ lines|\d+ chars))?\]/g, expanded),
				addToHistory: vi.fn(),
				pendingImages: [],
				pendingImageLinks: [],
				clearDraft(text?: string) {
					if (text !== undefined) this.addToHistory(text);
					this.setText("");
				},
			},
			ui: { requestRender: vi.fn() },
			skillCommands: new Map<string, string>(),
			session: {
				isStreaming: true,
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
		} as unknown as InteractiveModeContext;

		await new InputController(ctx).handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe(expanded);
		expect(call[0]).not.toContain("[Paste #");
		expect(call[1]?.streamingBehavior).toBe("followUp");
	});

	it("expands [Paste #N] markers when idle (not streaming)", async () => {
		const expanded = "queued-paste-body\nspans multiple lines";
		let editorText = "[Paste #2, +2 lines]";
		const prompt = vi.fn(async (_text: string, _options?: PromptOptionsLike) => {});
		const ctx = {
			editor: {
				setText(text: string) {
					editorText = text;
				},
				getText: () => editorText,
				getExpandedText: () => editorText.replace(/\[Paste #2(?:, (?:\+\d+ lines|\d+ chars))?\]/g, expanded),
				addToHistory: vi.fn(),
				pendingImages: [],
				pendingImageLinks: [],
				clearDraft(text?: string) {
					if (text !== undefined) this.addToHistory(text);
					this.setText("");
				},
			},
			ui: { requestRender: vi.fn() },
			skillCommands: new Map<string, string>(),
			session: {
				isStreaming: false,
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
		} as unknown as InteractiveModeContext;

		await new InputController(ctx).handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe(expanded);
		expect(call[0]).not.toContain("[Paste #");
		expect(call[1]?.streamingBehavior).toBeUndefined();
	});
});
