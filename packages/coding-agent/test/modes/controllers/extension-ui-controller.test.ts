import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { type Component, Container, isFocusable, type OverlayOptions, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../../src/extensibility/extensions";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { HookEditorComponent } from "../../../src/modes/components/hook-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
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

describe("ExtensionUiController clipboard input", () => {
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

		// Cancelling the nested prompt restores the ask surface; the draft editor
		// must be remounted so routed input lands on a visible surface.
		promptEditor?.handleInput?.("\x1b");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		// The dialog's prompt-active latch clears when the awaited onPrompt
		// promise settles; yield a microtask before routing the next key.
		await Promise.resolve();
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

	it("falls back to the full-cover defaults when overlayOptions is absent", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.custom<void>(() => new Container(), { overlay: true });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
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
