/**
 * Behavioral regression tests for the prompt-suggestions example extension.
 *
 * Uses the real CustomEditor and autocomplete pipeline with deferred model
 * responses, so keyboard and rendering regressions exercise the actual editor.
 *
 * `harness.key(data)` reproduces the production input order from
 * `TUI#handleInput`: raw-terminal extension listeners first, then the focused
 * editor. `harness.rawInput(data)` delivers bytes to the listeners only, as
 * happens when an overlay holds focus.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "bun:test";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CURSOR_MARKER, getKeybindings, TUI, type AutocompleteItem, type AutocompleteProvider } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/keybindings";
import { isKittyProtocolActive, setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import type { EditorTheme } from "@oh-my-pi/pi-tui/components/editor";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import promptSuggestionsExtension, {
	cleanSuggestion,
	extractRecentTurns,
} from "../examples/extensions/prompt-suggestions";

const RENDER_WIDTH = 60;
const MAIN_SESSION_ID = "main-session-fixture";

/** Conversation that ends in a successful final assistant stop. */
const FINISHED_CONVERSATION: unknown[] = [
	{ role: "user", content: "先介绍时间线，之后我会问如何导入素材" },
	{ role: "assistant", content: [{ type: "text", text: "时间线排列素材。" }], stopReason: "stop" },
];

const TINY_FIXTURE = buildModel({
	id: "tiny-fixture",
	name: "Tiny Fixture",
	api: "anthropic-messages",
	provider: "fixture",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

/** Real AssistantMessage shape; the extension only reads stopReason + content. */
function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		timestamp: Date.now(),
		provider: "fixture",
		model: TINY_FIXTURE.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

interface DeferredRequest {
	model: Model;
	options: SimpleStreamOptions;
	resolve: (message: AssistantMessage) => void;
}

type SessionEventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

/**
 * Drain the microtask chains the code under test settles on (the extension's
 * then/catch/finally pipeline and the editor's promise-based autocomplete
 * queue — none of them use timers). No wall-clock waits.
 */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Harness {
	/** The real editor the extension's factory produced (focused in the TUI). */
	editor: CustomEditor;
	/** The built-in autocomplete provider the extension wraps. */
	baseProvider: AutocompleteProvider;
	/** Deferred completeSimple requests, in launch order. */
	deferred: DeferredRequest[];
	/** ctx.modelRegistry.resolver invocations (credential binding). */
	resolverCalls: Array<{ model: Model; sessionId: string }>;
	/** Captured deadline callbacks installed via ctx.setTimeout. */
	deadlines: Array<() => void>;
	/** setWidget keys the extension nudged (invisible repaints). */
	widgetCalls: string[];
	/** Editor submit callback (a spy, to prove Tab never submits). */
	onSubmit: Mock<(text: string) => void>;
	/** Production keystroke order: extension listeners, then focused editor. */
	key: (data: string) => void;
	/** Raw bytes to the extension listeners only (overlay holds focus). */
	rawInput: (data: string) => unknown;
	/** Simulate the controller clearing extension input listeners. */
	clearInput: () => void;
	/** Host-style programmatic editor text (ctx.ui.setEditorText). */
	setText: (text: string) => void;
	/** Fire agent_end; extra fields override the finished-conversation event. */
	end: (overrides?: { messages?: unknown[]; willContinue?: boolean }) => void;
	/** Fire a session lifecycle event that must rebind input listeners. */
	switchSession: () => void;
	/** Run a registered /command against the fixture context. */
	command: (name: string, args: string) => Promise<void>;
	/** What the composer would paint for an empty buffer (wrapped provider). */
	hint: () => string | null;
	/** Plain-text render of the actual editor at a fixed width. */
	renderPlain: () => string;
	dispose: () => void;
}

function createHarness(options: { slashItems?: AutocompleteItem[] } = {}): Harness {
	const deferred: DeferredRequest[] = [];
	const resolverCalls: Array<{ model: Model; sessionId: string }> = [];
	const deadlines: Array<() => void> = [];
	const widgetCalls: string[] = [];
	const events: Record<string, SessionEventHandler> = {};
	const commands: Record<string, { handler: (args: string, ctx: ExtensionContext) => unknown }> = {};

	// The built-in provider the extension's factory wraps. Slash completions are
	// only served when a test asks for them; everything else stays quiet.
	const baseProvider: AutocompleteProvider = {
		getSuggestions: async lines =>
			options.slashItems && lines[0]?.startsWith("/") ? { items: options.slashItems, prefix: "/" } : null,
		applyCompletion: (_lines, _cursorLine, _cursorCol, item) => ({
			lines: [item.value],
			cursorLine: 0,
			cursorCol: item.value.length,
		}),
		getInlineHint: () => null,
	};

	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	let editor: CustomEditor | undefined;
	let inputListener: ((data: string) => unknown) | undefined;
	let wrappedProvider: AutocompleteProvider | null = null;

	const ctx = {
		hasUI: true,
		models: { resolve: (role: string) => (role === "@tiny" ? TINY_FIXTURE : undefined) },
		modelRegistry: {
			resolver: (model: Model, sessionId: string) => {
				resolverCalls.push({ model, sessionId });
				return "fixture-api-key";
			},
		},
		sessionManager: { getSessionId: () => MAIN_SESSION_ID },
		hasPendingMessages: () => false,
		setTimeout: (callback: () => void, _ms: number) => {
			deadlines.push(callback);
			return {};
		},
		clearTimer: (_handle: unknown) => {},
		ui: {
			getEditorText: () => editor?.getText() ?? "",
			setEditorText: (text: string) => editor?.setText(text),
			setWidget: (key: string, _content: unknown) => {
				widgetCalls.push(key);
			},
			notify: () => {},
			onTerminalInput: (handler: (data: string) => unknown) => {
				inputListener = handler;
				return () => {
					if (inputListener === handler) inputListener = undefined;
				};
			},
			setEditorComponent: (
				factory: (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor,
			) => {
				editor = factory(tui, getEditorTheme(), getKeybindings());
				editor.onSubmit = onSubmit;
				tui.addChild(editor);
				tui.setFocus(editor);
			},
			addAutocompleteProvider: (factory: (base: AutocompleteProvider) => AutocompleteProvider) => {
				wrappedProvider = factory(baseProvider);
				editor?.setAutocompleteProvider(wrappedProvider);
			},
		},
	};
	const extensionCtx = ctx as unknown as ExtensionContext;
	const onSubmit = vi.fn((_text: string): void => {});

	vi.spyOn(piAi, "completeSimple").mockImplementation((model, _context, options) => {
		const { promise, resolve } = Promise.withResolvers<AssistantMessage>();
		deferred.push({ model, options: options ?? {}, resolve });
		return promise;
	});

	const api = {
		on: (name: string, handler: SessionEventHandler) => {
			events[name] = handler;
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			commands[name] = command;
		},
		logger: { debug: () => {}, warn: () => {} },
		setLabel: () => {},
	} as unknown as ExtensionAPI;

	promptSuggestionsExtension(api);
	events.session_start?.({}, extensionCtx);
	if (!editor) throw new Error("fixture failed to install the extension editor");
	if (!wrappedProvider) throw new Error("fixture failed to install the wrapped autocomplete provider");
	const installedEditor = editor;

	return {
		editor: installedEditor,
		baseProvider,
		deferred,
		resolverCalls,
		deadlines,
		widgetCalls,
		onSubmit,
		key: data => {
			inputListener?.(data);
			installedEditor.handleInput(data);
		},
		rawInput: data => inputListener?.(data),
		clearInput: () => {
			inputListener = undefined;
		},
		setText: text => ctx.ui.setEditorText(text),
		end: (overrides = {}) => {
			events.agent_end?.({ messages: FINISHED_CONVERSATION, willContinue: false, ...overrides }, extensionCtx);
		},
		switchSession: () => events.session_switch?.({}, extensionCtx),
		command: async (name, args) => {
			await commands[name]?.handler(args, extensionCtx);
		},
		hint: () => {
			const lines = installedEditor.getText().split("\n");
			return wrappedProvider?.getInlineHint?.(lines, lines.length - 1, lines.at(-1)!.length) ?? null;
		},
		renderPlain: () =>
			installedEditor
				.render(RENDER_WIDTH)
				.map(line => Bun.stripANSI(line.replaceAll(CURSOR_MARKER, "")))
				.join("\n"),
		dispose: () => tui.stop(),
	};
}

describe("prompt-suggestions extension", () => {
	let kittyProtocolWasActive: boolean | undefined;
	const harnesses: Harness[] = [];

	beforeAll(async () => {
		kittyProtocolWasActive = isKittyProtocolActive();
		await initTheme();
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		setKittyProtocolActive(kittyProtocolWasActive ?? false);
	});

	function setup(options?: { slashItems?: AutocompleteItem[] }): Harness {
		const harness = createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	/** Resolve the newest pending request and land the ghost. */
	async function showGhost(harness: Harness, suggestion: string): Promise<void> {
		harness.deferred.at(-1)!.resolve(assistantText(suggestion));
		await flush();
	}

	it("renders the ghost beside the cursor, keeps it out of the buffer, and Tab accepts without submitting", async () => {
		const harness = setup();
		harness.end();
		expect(harness.deferred).toHaveLength(1);
		await showGhost(harness, "如何导入素材？");

		expect(harness.hint()).toBe("如何导入素材？");
		// The ghost is painted by the real editor render but is not buffer text.
		expect(harness.renderPlain()).toContain("如何导入素材？");
		expect(harness.editor.getText()).toBe("");
		// Landing the ghost nudges an invisible repaint.
		expect(harness.widgetCalls).toContain("prompt-suggestions.repaint");

		harness.key("\t");
		expect(harness.editor.getText()).toBe("如何导入素材？");
		expect(harness.hint()).toBeNull();
		expect(harness.onSubmit).not.toHaveBeenCalled();
	});

	it("accepts a displayed prediction via CSI-u Tab on kitty-protocol terminals", async () => {
		const harness = setup();
		harness.end();
		await showGhost(harness, "导入素材");

		setKittyProtocolActive(true);
		try {
			harness.key("\x1b[9u");
			expect(harness.editor.getText()).toBe("导入素材");
		} finally {
			setKittyProtocolActive(kittyProtocolWasActive ?? false);
		}
	});

	it("prevents a late response from resurrecting the ghost after typing and clearing", async () => {
		const harness = setup();
		harness.end();
		const request = harness.deferred[0]!;

		harness.key("x");
		expect(harness.editor.getText()).toBe("x");
		harness.key("\x7f"); // backspace through the real editor
		expect(harness.editor.getText()).toBe("");

		request.resolve(assistantText("旧预测"));
		await flush();
		expect(harness.hint()).toBeNull();
		expect(harness.editor.getText()).toBe("");
		expect(request.options.signal?.aborted).toBe(true);
	});

	it("suppresses the tiny-model call entirely when turned off", async () => {
		const harness = setup();
		await harness.command("suggestions", "off");
		harness.end();
		expect(harness.deferred).toHaveLength(0);
	});

	it("treats whitespace drafts as non-empty and never overwrites them via Tab", async () => {
		const harness = setup();
		harness.end();
		await showGhost(harness, "导入素材");

		harness.setText(" ");
		expect(harness.hint()).toBeNull();
		harness.key("\t");
		expect(harness.editor.getText()).toBe(" ");
	});

	it("invalidates the prediction when Tab lands during generation", async () => {
		const harness = setup();
		harness.end();
		const request = harness.deferred[0]!;

		harness.key("\t"); // ghost not shown yet: Tab must not reserve it
		request.resolve(assistantText("导入素材"));
		await flush();
		expect(harness.hint()).toBeNull();
	});

	it("never generates for continuations, errors, or missing stop reasons", () => {
		const harness = setup();
		harness.end({ willContinue: true });
		harness.end({
			messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error" }],
		});
		harness.end({
			messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: undefined }],
		});
		expect(harness.deferred).toHaveLength(0);
	});

	it("rejects an in-flight result when the session changes", async () => {
		const harness = setup();
		harness.end();
		const request = harness.deferred[0]!;

		harness.switchSession();
		request.resolve(assistantText("上一会话"));
		await flush();
		expect(harness.hint()).toBeNull();
	});

	it("re-binds the terminal listener after a session switch cleared input listeners", async () => {
		const harness = setup();
		harness.end();
		harness.clearInput(); // controller tore down extension listeners
		harness.switchSession();
		harness.end();

		await showGhost(harness, "新会话预测");
		harness.key("\t");
		expect(harness.editor.getText()).toBe("新会话预测");
	});

	it("rejects an expired request even when the provider ignores the abort", async () => {
		const harness = setup();
		harness.end();
		expect(harness.deadlines).toHaveLength(1);

		harness.deadlines[0]!(); // deadline fires: abort the controller
		harness.deferred[0]!.resolve(assistantText("过期预测"));
		await flush();
		expect(harness.hint()).toBeNull();
		expect(harness.deferred[0]!.options.signal?.aborted).toBe(true);
	});

	it("keeps the tiny request transport session distinct while credentials stay session-bound", () => {
		const harness = setup();
		harness.end();
		expect(harness.deferred).toHaveLength(1);

		// Credentials resolve through the main session id (auth affinity).
		expect(harness.resolverCalls).toHaveLength(1);
		expect(harness.resolverCalls[0]!.sessionId).toBe(MAIN_SESSION_ID);
		expect(harness.resolverCalls[0]!.model).toBe(TINY_FIXTURE);
		expect(harness.deferred[0]!.options.apiKey).toBe("fixture-api-key");
		// Prediction transport must never reuse the main provider conversation.
		expect(harness.deferred[0]!.options.sessionId).not.toBe(MAIN_SESSION_ID);
		// The resolved role's model is the one that was called.
		expect(harness.deferred[0]!.model).toBe(TINY_FIXTURE);
	});

	it("does not offer or accept an invisible ghost under the IME-safe bordered hardware-cursor layout", async () => {
		const harness = setup();
		// Mirror the host's post-factory configuration (interactive-mode.ts):
		// hardware cursor + IME-safe cursor layout on the default boxed shape.
		harness.editor.setUseTerminalCursor(true);
		harness.editor.setImeSafeCursorLayout(true);
		harness.end();

		harness.deferred[0]!.resolve(assistantText("不可见预测"));
		await flush();

		// The provider wrapper never offers the ghost in this mode…
		expect(harness.hint()).toBeNull();
		// …and the real editor render does not paint it after the cursor.
		expect(harness.renderPlain()).not.toContain("不可见预测");
		expect(harness.editor.getText()).toBe("");

		// Tab must fall through to the editor's native completion pipeline
		// (which consults getSuggestions) instead of accepting the ghost.
		const getSuggestions = vi.spyOn(harness.baseProvider, "getSuggestions");
		harness.key("\t");
		await flush();
		expect(getSuggestions).toHaveBeenCalled();
		expect(harness.editor.getText()).toBe("");
		expect(harness.hint()).toBeNull();
	});

	it("still shows and accepts the ghost when side borders are off, even with the hardware cursor and IME-safe layout", async () => {
		const harness = setup();
		harness.editor.setUseTerminalCursor(true);
		harness.editor.setImeSafeCursorLayout(true);
		harness.editor.setBorderVisible(false); // side borders off: ghost stays visible
		harness.end();

		await showGhost(harness, "可见预测");
		expect(harness.hint()).toBe("可见预测");
		expect(harness.renderPlain()).toContain("可见预测");

		harness.key("\t");
		expect(harness.editor.getText()).toBe("可见预测");
	});

	it("does not consume Tab while an overlay holds focus, and leaves the composer untouched", async () => {
		const harness = setup();
		harness.end();
		await showGhost(harness, "导入素材");

		const result = harness.rawInput("\t");
		expect(result).toBeUndefined(); // listener never consumes overlay input
		expect(harness.editor.getText()).toBe("");
		expect(harness.hint()).toBe("导入素材"); // ghost survives the overlay Tab
	});

	it("lets the composer's own autocomplete keep priority over predicted text", async () => {
		const harness = setup({ slashItems: [{ value: "/cmd", label: "/cmd" }] });
		harness.end();
		await showGhost(harness, "导入素材");

		// Open the composer's real autocomplete. This drives the editor
		// directly — the production window where editor state changes without a
		// preceding raw-input event (the guard exists for exactly this shape).
		harness.editor.handleInput("/");
		await flush();
		expect(harness.editor.isShowingAutocomplete()).toBe(true);
		expect(harness.editor.getText()).toBe("/");

		// Host-style programmatic clear: the buffer is empty again while the
		// composer autocomplete is still showing, and the ghost is once more
		// eligible for display.
		harness.setText("");
		expect(harness.hint()).toBe("导入素材");

		harness.key("\t");
		// Tab drove the composer's autocomplete (which found its state stale
		// against the cleared buffer and cancelled) — the ghost was NOT pasted.
		expect(harness.editor.getText()).toBe("");
		expect(harness.hint()).toBeNull();
		expect(harness.editor.isShowingAutocomplete()).toBe(false);
	});

	it("keeps a displayed prediction across terminal protocol replies but not across typed input", async () => {
		const harness = setup();
		harness.end();
		await showGhost(harness, "协议过滤");

		// XTWINOPS cell-size report, SGR mouse report, and a CPR reply are
		// terminal answers, not keystrokes — none may cancel the ghost.
		harness.rawInput("\x1b[6;24;96t");
		harness.rawInput("\x1b[<0;33;11M");
		harness.rawInput("\x1b[12;40R");
		expect(harness.hint()).toBe("协议过滤");

		// The CSI 1;<n>R shape is a modified-F3 keystroke, not a reply.
		harness.rawInput("\x1b[1;3R");
		expect(harness.hint()).toBeNull();

		// And a freshly displayed ghost still dies on ordinary typing.
		harness.end();
		await showGhost(harness, "再次预测");
		harness.key("x");
		expect(harness.editor.getText()).toBe("x");
		expect(harness.hint()).toBeNull();
	});
});

describe("prompt-suggestions pure helpers", () => {
	it("bounds the context and excludes tools, thinking, images, and injected messages", () => {
		const result = extractRecentTurns([
			{ role: "user", content: "x".repeat(12_000) },
			{ role: "user", injected: true, content: "PRIVATE_INJECTION" },
			{ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING" },
					{ type: "image", data: "PRIVATE_IMAGE" },
					{ type: "text", text: "正常回复" },
				],
				stopReason: "stop",
			},
		]);
		expect(result.reduce((total, turn) => total + turn.text.length, 0)).toBeLessThanOrEqual(8_000);
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		expect(result.at(-1)!.text).toBe("正常回复");
	});

	it("keeps short Chinese and file paths without English sentence heuristics", () => {
		expect(cleanSuggestion("继续")).toBe("继续");
		expect(cleanSuggestion("检查 src/main.ts 和 src/config.ts")).toBe("检查 src/main.ts 和 src/config.ts");
	});
});
