import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";

// Drives the real editor submit handler through the builtin slash dispatch
// path. Before #3148 only a handful of commands recorded their text (each
// added it inside its own handler); everything else returned `true` from
// executeBuiltinSlashCommand and the controller returned before any
// addToHistory call. The fix centralizes recording after dispatch, with a
// secret filter (shouldSkipHistory) for credential-bearing commands.
function makeCtx() {
	const addToHistory = vi.fn();
	const handleMCPCommand = vi.fn(async () => {});
	let text = "";
	const editor = {
		onSubmit: undefined as undefined | ((t: string) => Promise<void>),
		getText: () => text,
		setText: (t: string) => {
			text = t;
		},
		addToHistory,
		pendingImages: [] as unknown[],
		pendingImageLinks: [] as unknown[],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			text = "";
		},
	};
	const ctx = {
		editor,
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
		},
		focusedAgentId: undefined,
		collabGuest: undefined,
		handleHotkeysCommand: vi.fn(),
		handleMCPCommand,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, editor, addToHistory, handleMCPCommand };
}

function controllerFor(ctx: InteractiveModeContext) {
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return controller;
}

describe("input controller — slash command history (#3148)", () => {
	it("records a plain handled command (/hotkeys) that has no per-handler history call", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/hotkeys");

		expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
	});

	it("records a non-secret /mcp subcommand", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp list");

		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp list");
		expect(addToHistory).toHaveBeenCalledWith("/mcp list");
	});

	it("does NOT record /mcp add with a --token (would leak the bearer token)", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv --url http://x --token sk-secret123");

		// Command still executes...
		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp add srv --url http://x --token sk-secret123");
		// ...but the secret-bearing text is kept out of recallable history.
		expect(addToHistory).not.toHaveBeenCalled();
	});
});
