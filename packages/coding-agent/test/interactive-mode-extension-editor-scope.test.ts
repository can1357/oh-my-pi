/**
 * An extension's editor (`ctx.ui.setEditorComponent`) takes every keystroke the user types, and an
 * extension's autocomplete provider runs on each one. The factory the host is handed carries the
 * scope its session's code runs in (`rendererScope`); the host hands the editor input and focus
 * only inside it, and the moment it has gone swaps its own editor back in with the user's text —
 * before anything of the extension's runs, `capturesInput` included.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Scope {
	readonly live: boolean;
	run<T>(call: () => T): T;
}

/** A session scope the test retires, and whether code runs inside it now. */
interface OwnedScope {
	readonly scope: Scope;
	inside(): boolean;
	retire(): void;
}

function ownedScope(): OwnedScope {
	let live = true;
	let depth = 0;
	const scope: Scope = {
		get live() {
			return live;
		},
		run<T>(call: () => T): T {
			if (!live) throw new Error("scope retired");
			depth++;
			try {
				return call();
			} finally {
				depth--;
			}
		},
	};
	return {
		scope,
		inside: () => depth > 0,
		retire: () => {
			live = false;
		},
	};
}

/** The text an editor holds, read through the host's own method so a test reads nothing of the
 *  extension's. */
function textOf(editor: CustomEditor): string {
	return CustomEditor.prototype.getText.call(editor);
}

describe("an extension's editor and autocomplete provider", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let refreshSpy: { mockRestore(): void };

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-scope-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Installs an extension editor that records every call the host makes into it. */
	function installExtensionEditor(owner: OwnedScope) {
		const calls: Array<[string, boolean]> = [];
		class ExtensionEditor extends CustomEditor {
			override capturesInput(data: string): boolean {
				calls.push(["capturesInput", owner.inside()]);
				return super.capturesInput(data);
			}
			override handleInput(data: string): void {
				calls.push(["handleInput", owner.inside()]);
				super.handleInput(data);
			}
			override getText(): string {
				calls.push(["getText", owner.inside()]);
				return super.getText();
			}
			override setUseTerminalCursor(useTerminalCursor: boolean): void {
				calls.push(["setUseTerminalCursor", owner.inside()]);
				super.setUseTerminalCursor(useTerminalCursor);
			}
			override render(width: number): readonly string[] {
				calls.push(["render", owner.inside()]);
				return super.render(width);
			}
		}
		const factory = Object.assign(
			(_tui: unknown, editorTheme: ConstructorParameters<typeof CustomEditor>[0]) =>
				new ExtensionEditor(editorTheme),
			{ rendererScope: owner.scope },
		);
		mode.setEditorComponent(factory);
		return { calls, ExtensionEditor };
	}

	it("a live extension editor takes input and focus normally, inside its session's scope", () => {
		mode.editor.setText("draft ");
		const owner = ownedScope();
		const { calls, ExtensionEditor } = installExtensionEditor(owner);
		expect(mode.editor).toBeInstanceOf(ExtensionEditor);
		expect(textOf(mode.editor)).toBe("draft ");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.focused).toBe(true);

		calls.length = 0;
		mode.ui.injectDebugInput("a");
		mode.ui.injectDebugInput("b");
		expect(textOf(mode.editor)).toBe("draft ab");
		expect(calls.some(([where]) => where === "handleInput")).toBe(true);
		// Input dispatch runs inside the scope. The host's own direct calls (`getText` from its input
		// listeners, the composer's `render`) are the stated limitation: outside it while live.
		expect(calls.filter(([where, inside]) => !inside && where !== "getText" && where !== "render")).toEqual([]);
		const dispatched = calls.filter(([where]) => where === "handleInput" || where === "capturesInput");
		expect(dispatched.every(([, inside]) => inside)).toBe(true);
	});

	it("syncs the cursor mode into a focused extension editor inside its scope", () => {
		const owner = ownedScope();
		const { calls } = installExtensionEditor(owner);
		calls.length = 0;
		mode.ui.setFocus(null);
		mode.ui.setFocus(mode.editor);
		expect(calls).toContainEqual(["setUseTerminalCursor", true]);
		expect(calls.filter(([, inside]) => !inside)).toEqual([]);
	});

	it("once the session has gone, the next keystroke reaches the host's own editor, with the user's text, and nothing of the extension's runs", () => {
		mode.editor.setText("draft ");
		const owner = ownedScope();
		const { calls, ExtensionEditor } = installExtensionEditor(owner);
		mode.ui.injectDebugInput("a");

		calls.length = 0;
		owner.retire();
		mode.ui.injectDebugInput("b");
		mode.ui.injectDebugInput("c");
		expect(calls).toEqual([]);
		expect(mode.editor).not.toBeInstanceOf(ExtensionEditor);
		expect(mode.editor).toBeInstanceOf(CustomEditor);
		expect(textOf(mode.editor)).toBe("draft abc");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.focused).toBe(true);
		expect(mode.getEditorComponent()).toBeUndefined();
	});

	it("once the session has gone, a frame swaps the host's editor in before drawing the extension's", () => {
		mode.editor.setText("kept draft");
		const owner = ownedScope();
		const { calls, ExtensionEditor } = installExtensionEditor(owner);
		calls.length = 0;
		owner.retire();
		mode.ui.renderNow();
		expect(mode.editor).not.toBeInstanceOf(ExtensionEditor);
		expect(textOf(mode.editor)).toBe("kept draft");
		expect(calls).toEqual([]);
	});

	it("an extension editor whose factory is refused because the session has gone is the host's editor", () => {
		mode.editor.setText("draft");
		const owner = ownedScope();
		owner.retire();
		const factory = Object.assign(() => undefined as unknown as CustomEditor, { rendererScope: owner.scope });
		mode.setEditorComponent(factory);
		expect(mode.editor).toBeInstanceOf(CustomEditor);
		expect(textOf(mode.editor)).toBe("draft");
		expect(mode.getEditorComponent()).toBeUndefined();
	});

	it("runs an extension's autocomplete provider inside its scope, and once the session has gone completes with the host's", async () => {
		const owner = ownedScope();
		const installed: AutocompleteProvider[] = [];
		const setProvider = mode.editor.setAutocompleteProvider.bind(mode.editor);
		vi.spyOn(mode.editor, "setAutocompleteProvider").mockImplementation(provider => {
			installed.push(provider);
			setProvider(provider);
		});
		refreshSpy.mockRestore();
		await mode.refreshSlashCommandState(tempDir.path());
		const where: boolean[] = [];
		let base: AutocompleteProvider | undefined;
		const factory = Object.assign(
			(current: AutocompleteProvider): AutocompleteProvider => {
				base = current;
				return {
					async getSuggestions() {
						where.push(owner.inside());
						return { items: [{ value: "ext", label: "ext" }], prefix: "" };
					},
					applyCompletion: current.applyCompletion.bind(current),
				};
			},
			{ rendererScope: owner.scope },
		);
		mode.addAutocompleteProvider(factory);
		const provider = installed.at(-1);
		if (!provider || !base) throw new Error("the extension provider was not installed");
		expect(await provider.getSuggestions(["x"], 0, 1)).toEqual({
			items: [{ value: "ext", label: "ext" }],
			prefix: "",
		});
		expect(where).toEqual([true]);

		owner.retire();
		const fallback = vi.spyOn(base, "getSuggestions");
		await provider.getSuggestions(["x"], 0, 1);
		await Promise.resolve();
		expect(where).toEqual([true]);
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(installed.at(-1)).toBe(base);
	});
});
