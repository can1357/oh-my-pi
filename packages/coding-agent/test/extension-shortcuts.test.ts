import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	getKeybindings,
	type KeyId,
	setKeybindings,
	type KeybindingsManager as TuiKeybindingsManager,
} from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { logger } from "@oh-my-pi/pi-utils";

const noop = (): void => {};

/** Loads `factories` as `ext-0`, `ext-1`, … and initializes the runner as a mode controller would, with `keybindings` as the session's keymap. */
async function loadRunner(
	keybindings: KeybindingsManager | undefined,
	...factories: Array<(pi: ExtensionAPI) => void>
) {
	const runtime = new ExtensionRuntime();
	const apis: ExtensionAPI[] = [];
	const extensions: Extension[] = [];
	for (const [index, factory] of factories.entries()) {
		const extension = await loadExtensionFromFactory(
			pi => {
				apis.push(pi);
				factory(pi);
			},
			process.cwd(),
			new EventBus(),
			runtime,
			`ext-${index}`,
		);
		extensions.push(extension);
	}
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		{} as ModelRegistry,
	);
	runner.initialize(
		{
			sendMessage: noop,
			sendUserMessage: async () => {},
			appendEntry: noop,
			setLabel: noop,
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: noop,
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: noop,
			hasPendingMessages: () => false,
			shutdown: noop,
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
			keybindings,
		},
	);
	return { runner, apis };
}

let loadedKeybindings: TuiKeybindingsManager;

beforeEach(() => {
	loadedKeybindings = getKeybindings();
	vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
	setKeybindings(loadedKeybindings);
	vi.restoreAllMocks();
});

describe("extension shortcuts", () => {
	it("reports the first holder of a chord in any spelling, matching what gets bound", async () => {
		const {
			runner,
			apis: [first, second],
		} = await loadRunner(
			undefined,
			pi => {
				pi.registerShortcut("alt+ctrl+x", { handler: noop });
				pi.registerShortcut("ctrl+shift+p", { handler: noop });
				pi.registerShortcut("alt+h", { handler: noop });
			},
			noop,
		);

		// Another spelling of ext-0's chord; the owner itself sees no conflict.
		expect(second!.getShortcutConflict("ctrl+alt+x")).toEqual({ kind: "extension", extensionPath: "ext-0" });
		expect(first!.getShortcutConflict("ctrl+alt+x")).toBeUndefined();
		// Reserved (as `shift+ctrl+p`) outranks app.model.cycleBackward on the same chord.
		expect(second!.getShortcutConflict("ctrl+shift+p")).toEqual({ kind: "reserved" });
		// The default app.ask.hide chord outranks ext-0's registration of it.
		expect(second!.getShortcutConflict("alt+h")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });
		// An editing key: a shortcut on it would take yank-pop away from the editor.
		expect(second!.getShortcutConflict("alt+y")).toEqual({ kind: "keybinding", keybindings: ["tui.editor.yankPop"] });
		expect(second!.getShortcutConflict("alt+u")).toBeUndefined();
		// The reserved chord is dropped from binding whatever its spelling; the rest bind as registered.
		expect([...runner.getShortcuts().keys()]).toEqual(["alt+ctrl+x", "alt+h"]);
	});

	it("matches an uppercase-letter chord the way it is bound, lowercased", async () => {
		// A JavaScript extension can pass what the `KeyId` type rejects; omp binds `ctrl+C` as `ctrl+c`.
		const {
			runner,
			apis: [, second],
		} = await loadRunner(
			undefined,
			pi => {
				pi.registerShortcut("ctrl+C" as KeyId, { handler: noop });
				pi.registerShortcut("alt+X" as KeyId, { handler: noop });
			},
			noop,
		);
		expect([...runner.getShortcuts().keys()]).toEqual(["alt+x"]);
		expect(second!.getShortcutConflict("alt+x")).toEqual({ kind: "extension", extensionPath: "ext-0" });
	});

	it("binds only the last registration of a chord in any spelling, and reports that one", async () => {
		const {
			runner,
			apis: [first, , third],
		} = await loadRunner(
			undefined,
			pi => pi.registerShortcut("alt+ctrl+x", { handler: noop }),
			pi => {
				pi.registerShortcut("ctrl+alt+x", { handler: noop });
				pi.registerShortcut("?", { handler: noop });
			},
			pi => pi.registerShortcut("shift+?", { handler: noop }),
		);
		// One editor handler per chord, so the reported holder is the one that fires.
		const bound = [...runner.getShortcuts()].map(([key, shortcut]) => [key, shortcut.extensionPath]);
		expect(bound).toEqual([
			["ctrl+alt+x", "ext-1"],
			["shift+?", "ext-2"],
		]);
		expect(third!.getShortcutConflict("alt+ctrl+x")).toEqual({ kind: "extension", extensionPath: "ext-1" });
		expect(first!.getShortcutConflict("?")).toEqual({ kind: "extension", extensionPath: "ext-2" });
	});

	it("answers from its own session's keymap, never another session's remap", async () => {
		// An interactive session loads the user's remap, which also becomes the process-global keymap.
		const remapped = KeybindingsManager.inMemory({ "app.ask.hide": "alt+u" });
		setKeybindings(remapped);
		const interactive = (await loadRunner(remapped, pi => pi.registerShortcut("alt+h", { handler: noop }), noop))
			.apis[1]!;
		// An RPC or SDK session in the same process has no keymap of its own.
		const headless = (await loadRunner(undefined, pi => pi.registerShortcut("alt+h", { handler: noop }), noop))
			.apis[1]!;

		expect(interactive.getShortcutConflict("alt+u")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });
		expect(interactive.getShortcutConflict("alt+h")).toEqual({ kind: "extension", extensionPath: "ext-0" });
		expect(headless.getShortcutConflict("alt+h")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });
		expect(headless.getShortcutConflict("alt+u")).toBeUndefined();
	});

	it("drops a fallback chord from its default action once a remap claims it", async () => {
		// `shift+up` is app.message.dequeue's macOS fallback; the editor stops binding it to dequeue after this remap.
		const api = (await loadRunner(KeybindingsManager.inMemory({ "app.ask.hide": "shift+up" }), noop)).apis[0]!;
		expect(api.getShortcutConflict("shift+up")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });
	});

	it("reports the chord an emptied approve or follow-up binding falls back to", async () => {
		// Approval and follow-up stay reachable on Ctrl+Enter when the user empties their key lists.
		const keymap = KeybindingsManager.inMemory({ "app.approval.approve": [], "app.message.followUp": [] });
		const api = (await loadRunner(keymap, noop)).apis[0]!;
		expect(api.getShortcutConflict("ctrl+enter")).toEqual({
			kind: "keybinding",
			keybindings: ["app.approval.approve", "app.message.followUp"],
		});
	});

	it("treats a shifted symbol and its bare spelling as one key, as the keymap does", async () => {
		// The keymap matches a bare `?` binding on `shift+?` too, and so does a bare `?` shortcut.
		const bare = (await loadRunner(KeybindingsManager.inMemory({ "app.ask.hide": "?" }), noop)).apis[0]!;
		expect(bare.getShortcutConflict("shift+?")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });
		const shifted = (await loadRunner(KeybindingsManager.inMemory({ "app.ask.hide": "shift+?" }), noop)).apis[0]!;
		expect(shifted.getShortcutConflict("?")).toEqual({ kind: "keybinding", keybindings: ["app.ask.hide"] });

		const second = (await loadRunner(undefined, pi => pi.registerShortcut("?", { handler: noop }), noop)).apis[1]!;
		expect(second.getShortcutConflict("shift+?")).toEqual({ kind: "extension", extensionPath: "ext-0" });
	});
});
