import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { HookEditorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-editor";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { CURSOR_MARKER, isFocusable, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createTui(): TUI {
	return {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TUI;
}

function renderText(component: HookEditorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function renderLines(component: HookEditorComponent, width = 120): string[] {
	return Bun.stripANSI(component.render(width).join("\n")).split("\n");
}

function largePasteText(): string {
	return Array.from({ length: 11 }, (_, index) => `pasted line ${index + 1}`).join("\n");
}

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		addChild: (child: unknown) => void;
	};
};

function createControllerContext() {
	const editor = { id: "core-editor" };
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TestContext["ui"] & {
		setFocus: Mock<any>;
		requestRender: Mock<any>;
	};
	const ctx = {
		editor,
		editorContainer,
		ui,
		// `InteractiveModeContext.session` is required; the controller reads
		// `isStreaming` to decide whether a blocking prompt needs an alert.
		session: { isStreaming: false },
		hookEditor: undefined,
	} as unknown as TestContext;

	return { ctx, editor, editorContainer, ui };
}

describe("HookEditorComponent default (hook) mode", () => {
	it("inserts a newline on Enter instead of submitting immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\n");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("c");
		component.handleInput("d");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits the current text on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "line 1\nline 2", onSubmit, onCancel);

		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits Ctrl+Enter variants with NumLock or keypad Enter metadata", () => {
		const variants = ["\x1b[13;133u", "\x1b[57414;5u", "\x1b[57414;133u"];

		for (const variant of variants) {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

			component.handleInput(variant);

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("draft");
			expect(onCancel).not.toHaveBeenCalled();
		}
	});

	it("submits LF-prefixed modified Enter sequences", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

		component.handleInput("\n\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("draft");
		expect(onCancel).not.toHaveBeenCalled();
	});
	it("submits the current text on Ctrl+Q (Windows Terminal fallback for #2118)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "line 1\nline 2", onSubmit, onCancel);

		// Ctrl+Q raw byte (0x11). Windows Terminal cannot deliver a distinct
		// Ctrl+Enter, so app.message.followUp also binds Ctrl+Q (#1903), and the
		// hook editor must honor it for the same reason.
		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("keeps Ctrl+Q working after Enter inserts a newline (Windows Terminal)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);

		component.handleInput("a");
		component.handleInput("b");
		// Windows Terminal sends bare `\r` for both Enter and Ctrl+Enter; the
		// hook editor must treat `\r` as a newline and reserve Ctrl+Q for submit.
		component.handleInput("\r");
		component.handleInput("c");
		component.handleInput("d");
		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("expands large paste markers when submitting on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);
		const pasted = largePasteText();

		component.handleInput(`\x1b[200~${pasted}\x1b[201~`);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("HookEditorComponent prompt-style mode", () => {
	it("submits on plain Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on alternate Enter encodings recognized by the key matcher", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\x1bOM");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits when a terminal reports plain Enter as LF", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("absorbs enhanced-paste payloads delivered via pasteText (kitty OSC 5522 routing)", () => {
		// Regression: pasting into the ask tool's "Other" editor on OSC 5522
		// terminals routed the payload to the hidden main prompt, because the
		// enhanced-paste focus routing only targets components exposing a
		// `pasteText` hook and the dialog wrapper had none (#2127 contract).
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});
		const pasted = largePasteText();

		component.pasteText(pasted);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("expands large paste markers when submitting on Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});
		const pasted = largePasteText();

		component.handleInput(`\x1b[200~${pasted}\x1b[201~`);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("inserts newline on Shift+Enter instead of submitting", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\x1b[13;2~");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("b");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a\nb");
	});

	it("submits on the Ctrl+Enter chord in prompt-style mode (#3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("x");
		component.handleInput("y");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("xy");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on Ctrl+Q in prompt-style mode (Windows Terminal fallback, #3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		// Windows Terminal swallows Ctrl+Enter, so app.message.followUp also binds
		// Ctrl+Q (#1903). The ask tool's prompt-style editor missed this chord
		// before #3353 — users hit Ctrl+Enter expecting submit, got nothing.
		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("draft");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("renders prompt-style editor with rounded overlay chrome", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const rendered = renderText(component);
		const lines = renderLines(component);

		expect(lines[0]).toMatch(/^╭─ Prompt .*╮$/);
		expect(lines.at(-1)).toMatch(/^╰.*╯$/);
		expect(lines.some(line => line.includes("> "))).toBe(true);
		expect(rendered).toContain("enter or ctrl+q submit  esc cancel");
		expect(rendered).not.toContain("shift+enter newline");
		expect(rendered).toContain("ctrl+g external editor");
	});

	it("anchors the hardware cursor while entering an Other response", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});
		if (!isFocusable(component)) throw new Error("Hook editor must forward focus to its inner editor");

		component.focused = true;
		component.setUseTerminalCursor?.(true);

		expect(component.render(120).some(line => line.includes(CURSOR_MARKER))).toBe(true);
	});

	it("keeps the prompt gutter visible after typing in prompt-style mode", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		for (const char of "hello") {
			component.handleInput(char);
		}

		const lines = renderLines(component);

		expect(lines.some(line => line.includes("> hello"))).toBe(true);
		expect(lines.some(line => line.includes("hello") && !line.includes(">"))).toBe(false);
	});

	it("aligns wrapped prompt-style continuation rows under the text column", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", "abcdefghijklm", vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const lines = renderLines(component, 12);

		expect(lines.some(line => line.includes("> abcdef"))).toBe(true);
		const continuation = lines.find(line => line.includes("ghijkl"));
		expect(continuation).toBeDefined();
		expect(continuation).not.toContain(">");
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels on app.interrupt in prompt-style mode even when remapped", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"app.interrupt": "ctrl+c",
			}),
		);
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x03");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("renders the title in the border, detail lines, hint, and prompt gutter", () => {
		const title = "◆ Other (type your own)\nEnter your response:";
		const component = new HookEditorComponent(createTui(), title, "不太清楚，", vi.fn(), vi.fn(), {
			promptStyle: true,
		});
		const lines = renderLines(component);

		// First title line insets into the top border row.
		expect(lines[0]).toContain("Other (type your own)");
		// Remaining title lines, gutter, and hint are body rows.
		const content = component.renderContent(80).map(line => Bun.stripANSI(line));
		expect(content.some(line => line.startsWith("Enter your response:"))).toBe(true);
		expect(content.some(line => line.startsWith("> "))).toBe(true);
		expect(content.some(line => line.includes("esc cancel"))).toBe(true);
	});
});

describe("ExtensionUiController hook editor abort", () => {
	it("hides the hook editor and resolves undefined when the caller aborts", async () => {
		const { ctx, editor, editorContainer, ui } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();
		const controllerWithAbort = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		const promise = controllerWithAbort.showHookEditor("Prompt", "draft", { signal: abortController.signal });

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		abortController.abort();
		await Bun.sleep(0);

		expect(editorContainer.children).toEqual([editor]);
		expect(ctx.hookEditor).toBeUndefined();
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);

		const pending = Symbol("pending");
		const result = await Promise.race([promise, Bun.sleep(20).then(() => pending)]);
		expect(result).toBeUndefined();
	});

	it("forwards editorOptions to HookEditorComponent", async () => {
		const { ctx, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const controllerWithOptions = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		// Start the editor with promptStyle
		const promise = controllerWithOptions.showHookEditor("Ask prompt", undefined, undefined, {
			promptStyle: true,
		});

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		// The component should be a HookEditorComponent in prompt-style mode.
		// Verify by sending Enter — it should submit, not insert newline.
		const hookEditor = ctx.hookEditor!;
		hookEditor.handleInput("test-text".split("").join(""));
		hookEditor.handleInput("\r");

		// The promise should resolve since Enter submits in prompt-style mode.
		const result = await promise;
		// Result depends on what the editor captured. The key thing is it resolved.
		expect(result).toBeDefined();
	});
});

describe("ExtensionUiController dialog serialization", () => {
	type SelectorController = {
		showHookSelector: (
			title: string,
			options: string[],
			dialogOptions?: { signal?: AbortSignal },
		) => Promise<string | undefined>;
	};

	it("queues a second selector instead of clobbering the open one", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as SelectorController;

		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		// First dialog is presented synchronously on the shared surface.
		const componentA = ctx.hookSelector;
		expect(componentA).toBeDefined();
		expect(editorContainer.children).toEqual([componentA]);

		const promiseB = controller.showHookSelector("B", ["b1", "b2"], { signal: abortB.signal });
		// The second request must NOT swap itself into the surface while A is open —
		// that orphaning is exactly the hang this serialization fixes.
		expect(ctx.hookSelector).toBe(componentA);
		expect(editorContainer.children).toEqual([componentA]);

		// Resolving A hands the surface to the queued B.
		abortA.abort();
		await Bun.sleep(0);
		expect(await promiseA).toBeUndefined();
		const componentB = ctx.hookSelector;
		expect(componentB).toBeDefined();
		expect(componentB).not.toBe(componentA);
		expect(editorContainer.children).toEqual([componentB]);

		// Resolving B restores the core editor.
		abortB.abort();
		await Bun.sleep(0);
		expect(await promiseB).toBeUndefined();
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});

	it("never presents a queued selector whose signal aborts before its turn", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as SelectorController;

		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = controller.showHookSelector("A", ["a1"], { signal: abortA.signal });
		const componentA = ctx.hookSelector;
		const promiseB = controller.showHookSelector("B", ["b1"], { signal: abortB.signal });

		// Abort the queued B before A releases the surface.
		abortB.abort();
		expect(await promiseB).toBeUndefined();
		// A is untouched and still owns the surface.
		expect(ctx.hookSelector).toBe(componentA);
		expect(editorContainer.children).toEqual([componentA]);

		// When A resolves, the skipped B must not be shown — surface returns to editor.
		abortA.abort();
		await Bun.sleep(0);
		expect(await promiseA).toBeUndefined();
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});
	it("dismisses a confirmation and restores the editor when its signal aborts", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();

		const result = controller.showHookConfirm("High-risk command", "Allow this command?", {
			signal: abortController.signal,
		});
		expect(ctx.hookSelector).toBeDefined();

		abortController.abort();

		expect(await result).toBe(false);
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});
});
