import { describe, expect, spyOn, test } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";

describe("extension owner-local builtin commands", () => {
	test("executes a builtin lookup in the owning interactive session without forwarding unknown input", async () => {
		let contextActions: ExtensionContextActions | undefined;
		const extensionRunner = {
			initialize(
				_actions: ExtensionActions,
				captured: ExtensionContextActions,
				_commandActions?: ExtensionCommandContextActions,
				_ui?: ExtensionUIContext,
			): void {
				contextActions = captured;
			},
		};
		const ctx = {
			session: { extensionRunner },
			sessionManager: {
				getSessionFile: () => "C:/sessions/active.jsonl",
				getCwd: () => "C:/dev/project",
				getSessionName: () => "Active",
			},
			settings: {},
			refreshSlashCommandState: async () => {},
		} as unknown as InteractiveModeContext;
		new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, false);

		const result = await contextActions?.executeBuiltinCommand?.("/not-a-real-builtin");

		expect(result).toEqual({ handled: false, output: [] });
	});

	test("returns busy while an owner-local builtin is in flight", async () => {
		let contextActions: ExtensionContextActions | undefined;
		const extensionRunner = {
			initialize(
				_actions: ExtensionActions,
				captured: ExtensionContextActions,
				_commandActions?: ExtensionCommandContextActions,
				_ui?: ExtensionUIContext,
			): void {
				contextActions = captured;
			},
		};
		const gate = Promise.withResolvers<void>();
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			await gate.promise;
			return new Response(JSON.stringify({ entries: [] }));
			// Bare async fn lacks Bun's `fetch.preconnect` static; the mock never uses it.
		}) as unknown as typeof fetch);
		const ctx = {
			session: { extensionRunner, isStreaming: false, queuedMessageCount: 0 },
			sessionManager: {
				getSessionFile: () => "C:/sessions/active.jsonl",
				getCwd: () => "C:/dev/project",
				getSessionName: () => "Active",
			},
			settings: {
				get: (path: string) => (path === "hub.relayUrl" ? "https://relay.example/h" : "account-token"),
			},
			refreshSlashCommandState: async () => {},
		} as unknown as InteractiveModeContext;
		new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, false);
		try {
			const first = contextActions?.executeBuiltinCommand?.("/hub list");
			await Promise.resolve();

			const second = await contextActions?.executeBuiltinCommand?.("/hub list");

			expect(second).toEqual({ handled: true, output: [], busy: true });
			gate.resolve();
			expect(await first).toEqual({ handled: true, output: ["No hub sessions are available to this account."] });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("rejects an interactive submission while an owner-local builtin is in flight", async () => {
		let contextActions: ExtensionContextActions | undefined;
		let extensionActions: ExtensionActions | undefined;
		const extensionRunner = {
			initialize(
				actions: ExtensionActions,
				captured: ExtensionContextActions,
				_commandActions?: ExtensionCommandContextActions,
				_ui?: ExtensionUIContext,
			): void {
				extensionActions = actions;
				contextActions = captured;
			},
			hasHandlers: () => false,
		};
		const gate = Promise.withResolvers<void>();
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			await gate.promise;
			return new Response(JSON.stringify({ entries: [] }));
			// Bare async fn lacks Bun's `fetch.preconnect` static; the mock never uses it.
		}) as unknown as typeof fetch);
		let submittedText = "/hotkeys";
		let handledHotkeys = false;
		let sentMessages = 0;
		const statuses: string[] = [];
		const editor = {
			onSubmit: undefined as undefined | ((text: string) => Promise<void>),
			getText: () => submittedText,
			setText: (text: string) => {
				submittedText = text;
			},
			addToHistory: () => {},
			clearDraft: () => {
				submittedText = "";
			},
			pendingImages: [] as unknown[],
			pendingImageLinks: [] as unknown[],
		};
		const ctx = {
			editor,
			session: {
				extensionRunner,
				isStreaming: false,
				isCompacting: false,
				queuedMessageCount: 0,
				sendUserMessage: async () => {
					sentMessages += 1;
				},
			},
			sessionManager: {
				getSessionFile: () => "C:/sessions/active.jsonl",
				getCwd: () => "C:/dev/project",
				getSessionName: () => "Active",
			},
			settings: {
				get: (path: string) => (path === "hub.relayUrl" ? "https://relay.example/h" : "account-token"),
			},
			focusedAgentId: undefined,
			collabGuest: undefined,
			pendingImages: [] as unknown[],
			pendingImageLinks: [] as unknown[],
			handleHotkeysCommand: () => {
				handledHotkeys = true;
			},
			showStatus: (message: string) => {
				statuses.push(message);
			},
			showError: (message: string) => {
				statuses.push(message);
			},
			ui: { requestRender: () => {} },
			refreshSlashCommandState: async () => {},
		} as unknown as InteractiveModeContext;
		new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, false);
		const inputController = new InputController(ctx);
		inputController.setupEditorSubmitHandler();
		try {
			const ownerCommand = contextActions?.executeBuiltinCommand?.("/hub list");
			await Promise.resolve();
			expect(contextActions?.isIdle()).toBe(false);

			await inputController.handleFollowUp();
			expect(handledHotkeys).toBe(false);

			editor.onSubmit?.(submittedText);
			await Promise.resolve();
			expect(handledHotkeys).toBe(false);

			extensionActions?.sendUserMessage("voice turn");
			expect(sentMessages).toBe(0);
			expect(submittedText).toBe("/hotkeys");
			expect(statuses).toEqual([
				"Busy: Hub session handoff is in progress.",
				"Busy: Hub session handoff is in progress.",
				"Extension sendUserMessage blocked while an owner command is in progress.",
			]);
			expect(contextActions?.isIdle()).toBe(false);
			gate.resolve();
			await ownerCommand;
			expect(contextActions?.isIdle()).toBe(true);
		} finally {
			gate.resolve();
			fetchSpy.mockRestore();
		}
	});
});
