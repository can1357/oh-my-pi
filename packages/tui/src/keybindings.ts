import { type KeyId, parseKey } from "./keys";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.jumpForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.editor.undo": true;
	"tui.editor.spellingSuggestions": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
}

export type Keybinding = keyof Keybindings;

// Re-export KeyId from keys.ts
export type { KeyId };

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace", "ctrl+backspace", "super+alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+delete", "alt+d", "super+alt+delete", "super+alt+d"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: ["ctrl+-", "ctrl+_"], description: "Undo" },
	"tui.editor.spellingSuggestions": {
		defaultKeys: "ctrl+.",
		description: "Show spelling replacements",
	},
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

const SHIFTED_SYMBOL_KEYS = new Set<string>([
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"{",
	"}",
	"|",
	":",
	"<",
	">",
	"?",
	"~",
]);

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;

function startsWithModifier(key: string, offset: number, modifier: string): boolean {
	if (key.length <= offset + modifier.length || key.charCodeAt(offset + modifier.length) !== 43) return false;
	for (let i = 0; i < modifier.length; i++) {
		const actual = key.charCodeAt(offset + i);
		const expected = modifier.charCodeAt(i);
		if (actual !== expected && actual !== expected - 32) return false;
	}
	return true;
}

function isAsciiUppercaseLetter(key: string): boolean {
	if (key.length !== 1) return false;
	const code = key.charCodeAt(0);
	return code >= 65 && code <= 90;
}

export function canonicalKeyId(key: string): string {
	let offset = 0;
	const modifiers: string[] = [];
	let foundModifier = true;

	while (foundModifier) {
		foundModifier = false;
		for (const modifier of MODIFIER_ORDER) {
			if (startsWithModifier(key, offset, modifier)) {
				modifiers.push(modifier);
				offset += modifier.length + 1;
				foundModifier = true;
				break;
			}
		}
	}
	const rawBase = key.slice(offset);
	const lowerBase = rawBase.toLowerCase();
	const base = lowerBase === "esc" ? "escape" : lowerBase === "return" ? "enter" : lowerBase;
	if (isAsciiUppercaseLetter(rawBase) && !modifiers.includes("shift")) {
		modifiers.push("shift");
	}

	if (modifiers.length === 0) return base;
	modifiers.sort(
		(left, right) =>
			MODIFIER_ORDER.indexOf(left as (typeof MODIFIER_ORDER)[number]) -
			MODIFIER_ORDER.indexOf(right as (typeof MODIFIER_ORDER)[number]),
	);
	return `${modifiers.join("+")}+${base}`;
}

export function addKeyAliases(keys: Set<string>, key: KeyId): void {
	const canonical = canonicalKeyId(key);
	keys.add(canonical);
	if (SHIFTED_SYMBOL_KEYS.has(canonical)) {
		keys.add(`shift+${canonical}`);
	}
}

const normalizeKeyId = (key: KeyId): KeyId => key.toLowerCase() as KeyId;

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		const normalized = normalizeKeyId(key);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}

export class KeybindingsManager {
	#definitions: KeybindingDefinitions;
	#userBindings: KeybindingsConfig;
	#keysById = new Map<Keybinding, KeyId[]>();
	#matchKeysById = new Map<Keybinding, Set<string>>();
	#conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.#definitions = definitions;
		this.#userBindings = userBindings;
		this.#rebuild();
	}

	#rebuild(): void {
		this.#keysById.clear();
		this.#matchKeysById.clear();
		this.#conflicts = [];

		const userClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.#userBindings)) {
			if (!(keybinding in this.#definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				claimants.add(keybinding as Keybinding);
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.#conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.#definitions)) {
			const userKeys = this.#userBindings[id];
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.#keysById.set(id as Keybinding, keys);
			const matchKeys = new Set<string>();
			for (const key of keys) {
				addKeyAliases(matchKeys, key);
			}
			this.#matchKeysById.set(id as Keybinding, matchKeys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const parsed = parseKey(data);
		if (parsed === undefined) return false;
		return this.matchesCanonical(canonicalKeyId(parsed), keybinding);
	}

	/**
	 * Set-lookup variant of {@link matches} for hot input paths: the caller
	 * parses `data` once (`parseKey` + `canonicalKeyId`) and probes many
	 * bindings without re-parsing the raw sequence per probe.
	 */
	matchesCanonical(canonical: string | undefined, keybinding: Keybinding): boolean {
		if (canonical === undefined) return false;
		return this.#matchKeysById.get(keybinding)?.has(canonical) ?? false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.#keysById.get(keybinding) ?? [])];
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.#definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.#conflicts.map(conflict => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		this.#rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.#userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.#definitions)) {
			const keys = this.#keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}
