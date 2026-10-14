import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Component, Container, isFocusable, type OverlayOptions, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../../src/extensibility/extensions";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	let focused: Component | null = editor;
	editor.focused = true;
	const getFocused = () => focused;
	const setFocus = vi.fn((component: Component | null) => {
		if (focused && isFocusable(focused)) focused.focused = false;
		focused = component;
		if (focused && isFocusable(focused)) focused.focused = true;
	});
	const addAutocompleteProvider = vi.fn();
	const fakeHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
	};
	const showOverlay = vi.fn(() => fakeHandle);
	let uiContext: ExtensionUIContext | undefined;
	const steering: string[] = [];
	const sessionListeners = new Set<(event: { type: string; steering?: string[] }) => void>();
	const ctx = {
		editor,
		ui: {
			requestRender,
			getFocused,
			setFocus,
			showOverlay,
			terminal: { rows: 40, columns: 120 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
			getQueuedMessages: () => ({ steering: [...steering], followUp: [], liveSteered: 0 }),
			subscribe(listener: (event: { type: string; steering?: string[] }) => void) {
				sessionListeners.add(listener);
				return () => sessionListeners.delete(listener);
			},
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		getFocused,
		setFocus,
		showOverlay,
		fakeHandle,
		controller,
		inputController: (readText: () => Promise<string>) =>
			new InputController(ctx, { readImage: async () => null, readText }),
		/** Queue a user steer the way the session does: append, then emit `queue_update`. */
		queueSteer(text: string): void {
			steering.push(text);
			for (const listener of sessionListeners) listener({ type: "queue_update", steering: [...steering] });
		},
		/** Deliver the queued steering at the batch boundary: the queue empties. */
		deliverSteering(): void {
			steering.length = 0;
			for (const listener of sessionListeners) listener({ type: "queue_update", steering: [] });
		},
		handleInput(data: string): void {
			if (!focused?.handleInput) throw new Error("Expected a focused input component");
			focused.handleInput(data);
		},
		getPrompt(): HookEditorComponent {
			if (!(focused instanceof HookEditorComponent)) throw new Error("Expected the custom answer editor");
			return focused;
		},
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController Ask dialog input", () => {
	const questions: ExtensionAskDialogQuestion[] = [
		{ id: "answer", question: "Choose an answer?", options: [{ label: "Default" }] },
	];

	it("waits for clipboard text before advancing the custom answer exactly once", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog([
			{ id: "first", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
			{ id: "second", question: "Next answer?", options: [{ label: "Beta" }, { label: "Gamma" }] },
		]);
		harness.handleInput(" ");
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();

		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\r");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);

		clipboard.resolve("clipboard answer");
		expect(await paste).toBe(true);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [
				{ id: "first", selectedOptions: ["Alpha"], customInput: "clipboard answer" },
				{ id: "second", selectedOptions: ["Gamma"], customInput: undefined },
			],
		});
		expect(harness.editor.getText()).toBe("");
		expect(harness.getFocused()).toBe(harness.editor);
	});

	it("does not expose the Ask dialog before a custom answer is applied", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showAskDialog([
			{ id: "answer", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
		]);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("custom answer");

		harness.handleInput("\r");

		expect(harness.getFocused()).toBeInstanceOf(HookEditorComponent);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "custom answer" }],
		});
	});

	it("discards a cancelled prompt's late paste after a new custom editor opens", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const cancelledPrompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\x1b");
		await Promise.resolve();
		await Promise.resolve();

		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		expect(replacement).not.toBe(cancelledPrompt);
		harness.handleInput("replacement answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "replacement answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("discards an aborted Ask's late paste without touching the next Ask or hidden draft", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const abort = new AbortController();
		const pending = harness.controller.showAskDialog(questions, { signal: abort.signal });
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		abort.abort();
		expect(await pending).toBeUndefined();
		expect(harness.getFocused()).toBe(harness.editor);

		const next = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		harness.handleInput("next answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await next).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "next answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("keeps a failed clipboard read editable and discards its queued empty submit", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		await Promise.resolve();
		clipboard.reject(new Error("Clipboard unavailable"));

		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("typed after failure");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "typed after failure" }],
		});
		expect(harness.editor.getText()).toBe("");
	});
});

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("exposes the draft editor cursor while it proxies input, and drops it once cleared (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// The ask dialog holds TUI focus, but rendering it must mirror focus onto
		// the draft editor so its insertion cursor is visible.
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(true);

		// Once the draft clears, the ask controls take over and the editor cursor
		// must not linger.
		harness.editor.setText("");
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(false);
	});

	it("lets the clear action empty the draft and lift the ask guard (#6738)", () => {
		const harness = makeHarness();
		// Route Ctrl+C to the guard: keep app.clear on Ctrl+C but move the ask
		// cancel key off it, so Ctrl+C reaches draft editing instead of cancelling.
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		harness.editor.setActionKeys("app.clear", ["ctrl+c"]);
		let cleared = 0;
		// Mirror interactive wiring: app.clear (Ctrl+C) clears the draft.
		harness.editor.onClear = () => {
			cleared++;
			harness.editor.setText("");
		};
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+C is reserved by the base editor and never clears; the guard must
		// dispatch the configured clear action so the "finish or clear" hint works.
		ask?.handleInput?.("\x03");
		expect(cleared).toBe(1);
		expect(harness.editor.getText()).toBe("");

		// With the draft gone the guard releases: the next key reaches the ask
		// controls and submits the highlighted option.
		ask?.handleInput?.("\n");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("remounts the draft editor when the ask surface is restored after a nested prompt (#6738)", async () => {
		const harness = makeHarness();
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		// Draft submitted: the guard lifts and ask controls take input; open the
		// note prompt, which swaps the container to the nested editor.
		harness.editor.setText("");
		ask?.handleInput?.("n");
		const promptEditor = harness.editorContainer.children[0];
		expect(promptEditor).not.toBe(ask);

		// A failed async submission restores the draft while the nested prompt is
		// open, re-blocking the guard.
		harness.editor.setText("half typed prompt");

		// Cancelling the nested prompt settles its awaited state before restoring
		// the ask surface and remounting the guarded draft editor.
		promptEditor?.handleInput?.("\x1b");
		await Promise.resolve();
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		ask?.handleInput?.("!");
		expect(harness.editor.getText()).toBe("half typed prompt!");
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

describe("ExtensionUiController custom overlay", () => {
	// showHookCustom mounts the overlay in the `.then` of a Promise.try chain;
	// draining the microtask queue a few times settles it without real timers.
	const flushMicrotasks = async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	};

	it("forwards overlayOptions to showOverlay and invokes onHandle", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const onHandle = vi.fn();
		const overlayOptions: OverlayOptions = {
			anchor: "bottom-center",
			width: "85%",
			maxHeight: "55%",
			margin: { bottom: 1, left: 2, right: 2 },
		};

		ui.custom<void>(() => new Container(), { overlay: true, overlayOptions, onHandle });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
		expect(onHandle).toHaveBeenCalledTimes(1);
		expect(onHandle).toHaveBeenCalledWith(harness.fakeHandle);
	});

	it("resolves overlayOptions factories before showing the overlay", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const overlayOptions: OverlayOptions = { anchor: "top-right", width: 40 };
		const resolveOverlayOptions = vi.fn(() => overlayOptions);

		ui.custom<void>(() => new Container(), {
			overlay: true,
			overlayOptions: resolveOverlayOptions,
		});

		await flushMicrotasks();
		expect(resolveOverlayOptions).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
	});

	it("rejects and restores the editor when a custom factory fails", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const failure = new Error("custom factory failed");

		await expect(ui.custom(() => Promise.reject(failure))).rejects.toBe(failure);

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.setFocus).toHaveBeenLastCalledWith(harness.editor);
	});

	it("aborts a pending custom factory and disposes its late component", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.editor.setText("draft before factory");
		const controller = new AbortController();
		const factory = Promise.withResolvers<Container>();
		const component = new Container() as Container & { dispose: Mock<() => void> };
		component.dispose = vi.fn();

		const pending = ui.custom(() => factory.promise, { signal: controller.signal });
		harness.editor.setText("draft typed while factory is pending");
		controller.abort();

		await expect(pending).rejects.toBe(controller.signal.reason);
		factory.resolve(component);
		await flushMicrotasks();

		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("draft typed while factory is pending");
	});
});

describe("ExtensionUiController tool approval", () => {
	const prompt = {
		full: "Allow tool: bash\nCommand: rm -rf build",
		compact: "Allow tool: bash\nCommand: rm -rf build",
	};

	it("lets the composer steer while a call waits: the queued message denies the call", async () => {
		const harness = makeHarness();
		// A steer queued before the prompt appeared does not answer it.
		harness.queueSteer("earlier message");
		harness.editor.onSubmit = text => harness.queueSteer(text);
		const pending = harness.controller.showCollabAwareApproval(prompt);
		const [dialog] = harness.editorContainer.children;
		expect(harness.editorContainer.children).toEqual([dialog, harness.editor]);
		// Enter on an empty composer is swallowed: the dialog stays up (settling unmounts it synchronously).
		harness.handleInput("\r");
		expect(harness.editorContainer.children).toEqual([dialog, harness.editor]);
		for (const key of "keep the build dir") harness.handleInput(key);
		expect(harness.editor.getText()).toBe("keep the build dir");
		harness.handleInput("\r");
		expect(await pending).toBe(false);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.getFocused()).toBe(harness.editor);
	});

	it("one steer denies every approval of the batch, including those queued behind the shown one", async () => {
		const harness = makeHarness();
		harness.editor.onSubmit = text => harness.queueSteer(text);
		const first = harness.controller.showCollabAwareApproval(prompt);
		const second = harness.controller.showCollabAwareApproval({ ...prompt, full: "Allow tool: write" });
		for (const key of "stop") harness.handleInput(key);
		harness.handleInput("\r");
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("a steer also denies approvals its batch requests later, until it is delivered", async () => {
		const harness = makeHarness();
		harness.editor.onSubmit = text => harness.queueSteer(text);
		const first = harness.controller.showCollabAwareApproval(prompt);
		for (const key of "stop") harness.handleInput(key);
		harness.handleInput("\r");
		expect(await first).toBe(false);
		// An exclusive call asks only after the denied one settled; the steer is still queued.
		expect(await harness.controller.showCollabAwareApproval(prompt)).toBe(false);
		// Delivered at the batch boundary: the next turn's approvals ask again.
		harness.deliverSteering();
		void harness.controller.showCollabAwareApproval(prompt);
		expect(harness.editorContainer.children).toHaveLength(2);
	});

	it("attaches pasted images to the steer: clipboard and image-path pastes reach the composer, later keys wait", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<boolean>();
		const onPasteImage = vi.fn(() => clipboard.promise);
		const onPasteImagePath = vi.fn();
		harness.editor.onPasteImage = onPasteImage;
		harness.editor.onPasteImagePath = onPasteImagePath;
		void harness.controller.showCollabAwareApproval(prompt);
		// Image-only clipboard paste: the terminal sends an empty bracketed paste.
		harness.handleInput("\x1b[200~\x1b[201~");
		expect(onPasteImage).toHaveBeenCalledTimes(1);
		// Typed while the clipboard read is pending: held until the image lands.
		harness.handleInput("x");
		expect(harness.editor.getText()).toBe("");
		clipboard.resolve(true);
		await clipboard.promise;
		await Promise.resolve();
		expect(harness.editor.getText()).toBe("x");
		harness.handleInput("\x1b[200~/tmp/shot.png\x1b[201~");
		await Promise.resolve();
		expect(onPasteImagePath).toHaveBeenCalledWith("/tmp/shot.png");
	});

	it("sends a steer whose Enter arrived in a separate read while its image was still landing", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<void>();
		harness.editor.onPasteImage = async () => {
			await clipboard.promise;
			harness.editor.setText("[Image #1]");
			return true;
		};
		const onSubmit = vi.fn();
		harness.editor.onSubmit = onSubmit;
		void harness.controller.showCollabAwareApproval(prompt);
		harness.handleInput("\x1b[200~\x1b[201~");
		// The composer is still empty, yet this Enter belongs to the paste, not to the empty-composer guard.
		harness.handleInput("\r");
		clipboard.resolve();
		await clipboard.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).toHaveBeenCalledWith("[Image #1]");
	});

	it("lets ctrl+o reveal a single-line detail the row clips, even when compact and full match", () => {
		const harness = makeHarness();
		const command = `Allow tool: bash\nCommand: echo ok && ${"x".repeat(120)} && rm -rf ~`;
		void harness.controller.showCollabAwareApproval({ full: command, compact: command });
		const body = () =>
			stripVTControlCharacters(harness.editorContainer.children[0]!.render(60).join("\n")).replace(/[│\s]+/g, "");
		expect(body()).not.toContain("rm-rf~");
		harness.handleInput("\x0f");
		expect(body()).toContain("rm-rf~");
	});
});
