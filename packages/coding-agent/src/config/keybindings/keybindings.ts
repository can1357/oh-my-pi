/**
 * The resolved keymap: every action's default chords, overridden action by
 * action by the user's `keybindings.yml`, matched against pi-tui key events.
 */
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { setWidgetKeymap, type WidgetAction, type WidgetKeymap } from "@oh-my-pi/pi-tui/term/keymap";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { KEYBINDINGS, type Keybinding } from "./app-keybindings";
import {
	type KeybindingsConfig,
	type KeybindingsCreateOptions,
	loadKeybindingsConfig,
	loadKeybindingsFile,
	mergeKeybindingsConfig,
} from "./config-file";
import { canonicalKeyId, type KeyId } from "./key-id";
import type { KeybindingDefinition } from "./tui-keybindings";

/** A chord the user bound to more than one action. */
export interface KeybindingConflict {
	key: KeyId;
	keybindings: Keybinding[];
}

/**
 * Default chords that give way to a user remap: when another action's user
 * binding claims one and the user left this action at its defaults, the
 * chord is dropped from it. Ctrl+Q backs up Ctrl+Enter for follow-up, which
 * Windows Terminal cannot deliver (#1903); Shift+Up backs up Alt+Up for
 * dequeue, which macOS Terminal.app consumes. The fullscreen transcript's
 * reading keys take chords the editor and other actions may be given.
 */
const YIELDING_DEFAULTS: Partial<Record<Keybinding, KeyId | readonly KeyId[]>> = {
	"app.message.followUp": "ctrl+q",
	"app.message.dequeue": "shift+up",
	"app.transcript.pageUp": "pageUp",
	"app.transcript.pageDown": "pageDown",
	"app.transcript.top": "alt+home",
	"app.transcript.bottom": "alt+end",
	"app.transcript.lineUp": "alt+k",
	"app.transcript.lineDown": "alt+j",
	"app.transcript.previousUser": "alt+pageUp",
	"app.transcript.nextUser": "alt+pageDown",
	"app.transcript.copyHighlight": "alt+c",
	"app.transcript.find": "alt+/",
};

/** Chords lowercased (config chords are case-insensitive) and deduplicated, in configured order. */
function normalizeKeys(keys: KeyId | readonly KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const result: KeyId[] = [];
	for (const key of typeof keys === "string" ? [keys] : keys) {
		const lower = key.toLowerCase() as KeyId;
		if (!result.includes(lower)) result.push(lower);
	}
	return result;
}

/** The `tui.*` action each pi-tui widget action follows. */
const WIDGET_ACTIONS: Readonly<Record<WidgetAction, Keybinding>> = {
	"select.up": "tui.select.up",
	"select.down": "tui.select.down",
	"select.pageUp": "tui.select.pageUp",
	"select.pageDown": "tui.select.pageDown",
	"select.confirm": "tui.select.confirm",
	"select.cancel": "tui.select.cancel",
	"editor.selectAll": "tui.editor.selectAll",
	"editor.cursorUp": "tui.editor.cursorUp",
	"editor.cursorDown": "tui.editor.cursorDown",
	"editor.cursorLeft": "tui.editor.cursorLeft",
	"editor.cursorRight": "tui.editor.cursorRight",
	"editor.cursorWordLeft": "tui.editor.cursorWordLeft",
	"editor.cursorWordRight": "tui.editor.cursorWordRight",
	"editor.cursorLineStart": "tui.editor.cursorLineStart",
	"editor.cursorLineEnd": "tui.editor.cursorLineEnd",
	"editor.pageUp": "tui.editor.pageUp",
	"editor.pageDown": "tui.editor.pageDown",
	"editor.deleteCharBackward": "tui.editor.deleteCharBackward",
	"editor.deleteCharForward": "tui.editor.deleteCharForward",
	"editor.deleteWordBackward": "tui.editor.deleteWordBackward",
	"editor.deleteWordForward": "tui.editor.deleteWordForward",
	"editor.deleteToLineStart": "tui.editor.deleteToLineStart",
	"editor.deleteToLineEnd": "tui.editor.deleteToLineEnd",
	"editor.yank": "tui.editor.yank",
	"editor.yankPop": "tui.editor.yankPop",
	"editor.undo": "tui.editor.undo",
	"editor.newLine": "tui.input.newLine",
};

function isKeybinding(id: string): id is Keybinding {
	return Object.hasOwn(KEYBINDINGS, id);
}

export class KeybindingsManager {
	#userBindings: KeybindingsConfig;
	readonly #configPath: string | undefined;
	readonly #inheritedConfigPath: string | undefined;
	readonly #keys = new Map<Keybinding, KeyId[]>();
	/** Event ids each action answers to. */
	readonly #ids = new Map<Keybinding, Set<string>>();
	#conflicts: KeybindingConflict[] = [];

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string, inheritedConfigPath?: string) {
		this.#userBindings = userBindings;
		this.#configPath = configPath;
		this.#inheritedConfigPath = inheritedConfigPath;
		this.#rebuild();
	}

	/**
	 * Load the bindings for `agentDir` (merged over the default profile's under
	 * a named profile), migrating legacy files, and make the result the global
	 * keymap ({@link getKeybindings}).
	 */
	static create(agentDir: string = getAgentDir(), options: KeybindingsCreateOptions = {}): KeybindingsManager {
		const { config, profilePath, inheritedPath } = loadKeybindingsConfig(agentDir, options);
		const manager = new KeybindingsManager(config, profilePath, inheritedPath);
		setKeybindings(manager);
		return manager;
	}

	/** A keymap over `userBindings` without file persistence. */
	static inMemory(userBindings: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(userBindings);
	}

	/** Re-read the config files this keymap was created from (no-op for in-memory keymaps). */
	reload(): void {
		if (!this.#configPath) return;
		const inherited = this.#inheritedConfigPath ? loadKeybindingsFile(this.#inheritedConfigPath).config : {};
		this.setUserBindings(mergeKeybindingsConfig(inherited, loadKeybindingsFile(this.#configPath).config));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		this.#rebuild();
	}

	#rebuild(): void {
		this.#keys.clear();
		this.#ids.clear();
		const claims = new Map<KeyId, Keybinding[]>();
		for (const id in this.#userBindings) {
			if (!isKeybinding(id)) continue;
			for (const key of normalizeKeys(this.#userBindings[id])) {
				const claimants = claims.get(key);
				if (claimants) claimants.push(id);
				else claims.set(key, [id]);
			}
		}
		this.#conflicts = [];
		for (const [key, keybindings] of claims) {
			if (keybindings.length > 1) this.#conflicts.push({ key, keybindings });
		}
		// Event ids, so a claim spelled with other modifier order or case still takes the chord.
		const claimed = new Set([...claims.keys()].map(canonicalKeyId));
		for (const id in KEYBINDINGS) {
			const action = id as Keybinding;
			const userKeys = this.#userBindings[action];
			const definition: KeybindingDefinition = KEYBINDINGS[action];
			let keys = normalizeKeys(userKeys ?? definition.defaultKeys);
			const yielding = YIELDING_DEFAULTS[action];
			if (userKeys === undefined && yielding !== undefined) {
				const taken = new Set(
					normalizeKeys(yielding)
						.map(canonicalKeyId)
						.filter(key => claimed.has(key)),
				);
				if (taken.size > 0) keys = keys.filter(key => !taken.has(canonicalKeyId(key)));
			}
			this.#keys.set(action, keys);
			this.#ids.set(action, new Set(keys.map(canonicalKeyId)));
		}
		if (this === globalKeybindings) setWidgetKeymap(this.widgetKeymap());
	}

	/** The pi-tui widget keymap these bindings give (each widget action's `tui.*` keys as event ids). */
	widgetKeymap(): WidgetKeymap {
		const keymap: { [A in WidgetAction]?: string[] } = {};
		for (const id in WIDGET_ACTIONS) {
			const action = id as WidgetAction;
			keymap[action] = [...this.#ids.get(WIDGET_ACTIONS[action])!];
		}
		return keymap;
	}

	/** Whether `event` presses (or auto-repeats) a chord bound to `action`; releases never match. */
	matches(event: KeyEvent, action: Keybinding): boolean {
		return event.kind !== "release" && (this.#ids.get(action)?.has(event.id) ?? false);
	}

	/** Whether the key event id `id` (a press) is bound to `action`, for models handed bare key ids. */
	matchesId(id: string, action: Keybinding): boolean {
		return this.#ids.get(action)?.has(id) ?? false;
	}

	/** The chords bound to `action`, lowercased as configured, primary first; empty when unbound. */
	keysFor(action: Keybinding): KeyId[] {
		return [...(this.#keys.get(action) ?? [])];
	}

	/** Chords the user bound to more than one action (defaults never conflict). */
	conflicts(): KeybindingConflict[] {
		return this.#conflicts.map(conflict => ({ key: conflict.key, keybindings: [...conflict.keybindings] }));
	}

	/** Every action's effective chords: one chord as a string, several (or none) as an array. */
	resolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const [action, keys] of this.#keys) resolved[action] = keys.length === 1 ? keys[0] : [...keys];
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | undefined;

/**
 * Make `keybindings` the keymap {@link getKeybindings} returns, and the one
 * pi-tui widgets (lists, menus, settings, text fields) answer to; a reload of
 * it re-applies.
 */
export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
	setWidgetKeymap(keybindings.widgetKeymap());
}

/** The session keymap: the one {@link KeybindingsManager.create} loaded, or the defaults before that. */
export function getKeybindings(): KeybindingsManager {
	if (globalKeybindings) return globalKeybindings;
	const keybindings = KeybindingsManager.inMemory();
	setKeybindings(keybindings);
	return keybindings;
}
