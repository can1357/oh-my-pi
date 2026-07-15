import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	setKeybindings,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@pk-nerdsaver-ai/pi-tui";
import { getAgentDir, isEnoent, logger } from "@pk-nerdsaver-ai/pi-utils";
import { JSONC, YAML } from "bun";

/**
 * Application-level keybindings (coding agent specific).
 * Values are always `true` — used for declaration merging.
 */
interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.display.reset": true;
	"app.thinking.cycle": true;
	"app.thinking.toggle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.selectTemporary": true;
	"app.tools.expand": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.retry": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.clipboard.pasteTextRaw": true;
	"app.clipboard.copyLine": true;
	"app.clipboard.copyPrompt": true;
	"app.agents.hub": true;
	"app.session.backgrounds": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.session.observe": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.plan.toggle": true;
	"app.composer.mode.cycle": true;
	"app.history.search": true;
	"app.stt.toggle": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@pk-nerdsaver-ai/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

/**
 * Resolve default image-paste shortcuts for the current terminal platform.
 */
export function getDefaultPasteImageKeys(platform: NodeJS.Platform = process.platform): KeyId[] {
	return platform === "win32" ? ["ctrl+v", "alt+v"] : ["ctrl+v"];
}

/**
 * All keybindings definitions: TUI + app-specific.
 */
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Interrupt current operation",
	},
	"app.clear": {
		defaultKeys: "ctrl+c",
		description: "Clear screen or cancel",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit application",
	},
	"app.suspend": {
		defaultKeys: "ctrl+z",
		description: "Suspend application",
	},
	"app.display.reset": {
		defaultKeys: "ctrl+l",
		description: "Reset terminal display",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking mode",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": {
		defaultKeys: "alt+m",
		description: "Select model",
	},
	"app.model.selectTemporary": {
		defaultKeys: "alt+p",
		description: "Select temporary model for current session",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand tools",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.followUp": {
		// Ctrl+Enter is preserved for terminals that deliver it (Kitty/iTerm2/WezTerm/Ghostty),
		// but Windows Terminal does not emit a distinct event for Ctrl+Enter — Ctrl+Q is listed
		// first so the default binding works there without remapping (#1903).
		defaultKeys: ["ctrl+q", "ctrl+enter"],
		description: "Send follow-up message",
	},
	"app.retry": {
		defaultKeys: "alt+r",
		description: "Retry last failed assistant turn",
	},
	"app.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Dequeue message",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: getDefaultPasteImageKeys(),
		description: "Paste image or text from clipboard",
	},
	"app.clipboard.pasteTextRaw": {
		defaultKeys: ["ctrl+shift+v", "alt+shift+v"],
		description: "Paste text from clipboard as raw text (no collapse)",
	},
	"app.clipboard.copyLine": {
		defaultKeys: "alt+shift+l",
		description: "Copy current line",
	},
	"app.clipboard.copyPrompt": {
		defaultKeys: "alt+shift+c",
		description: "Copy prompt",
	},
	"app.session.new": {
		defaultKeys: [],
		description: "Create new session",
	},
	"app.session.tree": {
		defaultKeys: [],
		description: "Show session tree",
	},
	"app.session.fork": {
		defaultKeys: [],
		description: "Fork session",
	},
	"app.session.resume": {
		defaultKeys: [],
		description: "Resume session",
	},
	"app.agents.hub": {
		defaultKeys: "alt+a",
		description: "Open the agent hub",
	},
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Open the agent hub",
	},
	"app.session.backgrounds": {
		defaultKeys: "ctrl+shift+b",
		description: "Open the agent hub (background sessions)",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort order",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session (non-invasive)",
	},
	"app.tree.foldOrUp": {
		defaultKeys: ["ctrl+left", "alt+left"],
		description: "Fold or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold or move down",
	},
	"app.plan.toggle": {
		defaultKeys: "alt+shift+p",
		description: "Toggle plan mode",
	},
	"app.composer.mode.cycle": {
		defaultKeys: "alt+shift+m",
		description: "Cycle composer work mode (Ask / Build / Plan)",
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search history",
	},
	"app.stt.toggle": {
		defaultKeys: [],
		description: "Toggle speech-to-text (default gesture: hold Space)",
	},
} as const satisfies KeybindingDefinitions;

/**
 * Migration map from old keybinding names to new namespaced IDs.
 */
const KEYBINDING_NAME_MIGRATIONS = {
	// App-specific (old names)
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	displayReset: "app.display.reset",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	selectModelTemporary: "app.model.selectTemporary",
	togglePlanMode: "app.plan.toggle",
	historySearch: "app.history.search",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	retry: "app.retry",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	pasteTextRaw: "app.clipboard.pasteTextRaw",
	copyLine: "app.clipboard.copyLine",
	copyPrompt: "app.clipboard.copyPrompt",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	observeSessions: "app.session.observe",
	toggleSTT: "app.stt.toggle",
	// TUI editor (old names for backward compatibility)
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	// TUI input (old names for backward compatibility)
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	// TUI select (old names for backward compatibility)
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	// Upstream additional migrations
	toggleSessionNamedFilter: "app.session.togglePath",
} as const satisfies Record<string, Keybinding>;

/**
 * Check if a key is a legacy keybinding name.
 */
function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (typeof value !== "object" || value === null) {
		return {};
	}

	const config: KeybindingsConfig = {};
	for (const [key, val] of Object.entries(value)) {
		if (val === undefined) {
			config[key] = undefined;
		} else if (typeof val === "string") {
			config[key] = val as KeyId;
		} else if (Array.isArray(val) && val.every(v => typeof v === "string")) {
			config[key] = val as KeyId[];
		}
	}
	return config;
}

/**
 * Migrate old keybinding names to new namespaced IDs.
 * Returns both the migrated config and a flag indicating if migration occurred.
 */
function migrateKeybindingNames(rawConfig: unknown): {
	config: KeybindingsConfig;
	migrated: boolean;
} {
	const config = toKeybindingsConfig(rawConfig);
	const migrated: KeybindingsConfig = {};
	let didMigrate = false;

	for (const [key, value] of Object.entries(config)) {
		if (isLegacyKeybindingName(key)) {
			const newKey = KEYBINDING_NAME_MIGRATIONS[key];
			migrated[newKey] = value;
			didMigrate = true;
		} else {
			// Already a new-style key
			migrated[key] = value;
		}
	}

	return { config: migrated, migrated: didMigrate };
}

/**
 * Order keybindings config to match KEYBINDINGS key order.
 */
function orderKeybindingsConfig(config: KeybindingsConfig): KeybindingsConfig {
	const ordered: KeybindingsConfig = {};
	for (const key of Object.keys(KEYBINDINGS)) {
		const value = config[key];
		if (value !== undefined) {
			ordered[key] = value;
		}
	}
	// Add any remaining keys that aren't in KEYBINDINGS
	for (const key of Object.keys(config)) {
		if (!(key in ordered)) {
			ordered[key] = config[key];
		}
	}
	return ordered;
}

const KEYBINDINGS_YML = "keybindings.yml";
const KEYBINDINGS_YAML = "keybindings.yaml";
const LEGACY_KEYBINDINGS_JSON = "keybindings.json";

interface KeybindingsConfigPaths {
	readPath: string;
	writeBackPath: string;
}

/**
 * Load raw config from a file synchronously.
 * Returns parsed JSON/YAML or null if file doesn't exist or is invalid.
 */
function loadRawConfig(filePath: string): unknown {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		if (filePath.endsWith(".json")) {
			return JSONC.parse(content);
		}
		if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
			return YAML.parse(content);
		}
		throw new Error(`Unsupported keybindings config extension: ${filePath}`);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		logger.warn("Failed to parse keybindings config", { path: filePath, error: String(error) });
		return null;
	}
}

function writeKeybindingsConfig(filePath: string, config: KeybindingsConfig): boolean {
	try {
		fs.writeFileSync(filePath, YAML.stringify(config, null, 2), "utf-8");
		logger.debug("Migrated keybindings config", { path: filePath });
		return true;
	} catch (error) {
		logger.warn("Failed to write migrated keybindings config", { path: filePath, error: String(error) });
		return false;
	}
}

function resolveKeybindingsConfigPaths(agentDir: string): KeybindingsConfigPaths {
	const ymlPath = path.join(agentDir, KEYBINDINGS_YML);
	if (fs.existsSync(ymlPath)) {
		return { readPath: ymlPath, writeBackPath: ymlPath };
	}

	const yamlPath = path.join(agentDir, KEYBINDINGS_YAML);
	if (fs.existsSync(yamlPath)) {
		return { readPath: yamlPath, writeBackPath: yamlPath };
	}

	const jsonPath = path.join(agentDir, LEGACY_KEYBINDINGS_JSON);
	if (fs.existsSync(jsonPath)) {
		return { readPath: jsonPath, writeBackPath: ymlPath };
	}

	return { readPath: ymlPath, writeBackPath: ymlPath };
}

/**
 * Load and migrate keybindings config.
 * Legacy JSON is read for compatibility, but successful write-back goes to YAML.
 */
function loadKeybindingsConfig(
	filePath: string,
	writeBackPath: string | undefined,
): {
	config: KeybindingsConfig;
	persistedPath: string;
} {
	const rawConfig = loadRawConfig(filePath);

	if (rawConfig === null) {
		return { config: {}, persistedPath: filePath };
	}

	const { config: migratedConfig, migrated } = migrateKeybindingNames(rawConfig);
	const shouldWriteBack = writeBackPath !== undefined && (migrated || writeBackPath !== filePath);
	if (shouldWriteBack) {
		const ordered = orderKeybindingsConfig(migratedConfig);
		const persistedPath = writeKeybindingsConfig(writeBackPath, ordered) ? writeBackPath : filePath;
		return { config: migratedConfig, persistedPath };
	}

	return { config: migratedConfig, persistedPath: filePath };
}

function migrateKeybindingsConfigFile(agentDir: string): void {
	const { readPath, writeBackPath } = resolveKeybindingsConfigPaths(agentDir);
	loadKeybindingsConfig(readPath, writeBackPath);
}

const FOLLOW_UP_KEYBINDING: AppKeybinding = "app.message.followUp";
const WINDOWS_FOLLOW_UP_FALLBACK_KEY: KeyId = "ctrl+q";
function keyListIncludes(keys: KeyId | KeyId[] | undefined, target: KeyId): boolean {
	if (keys === undefined) return false;
	const keyList = Array.isArray(keys) ? keys : [keys];
	for (const key of keyList) {
		if (key.toLowerCase() === target) return true;
	}
	return false;
}

function userBindingClaimsKey(config: KeybindingsConfig, target: KeyId, except: Keybinding): boolean {
	for (const [keybinding, keys] of Object.entries(config)) {
		if (!(keybinding in KEYBINDINGS)) continue;
		if (keybinding === except) continue;
		if (keyListIncludes(keys, target)) return true;
	}
	return false;
}

function removeKey(keys: KeyId[], target: KeyId): KeyId[] {
	return keys.filter(key => key !== target);
}

function keyConfigValue(keys: KeyId[]): KeyId | KeyId[] {
	if (keys.length === 1) {
		const key = keys[0];
		if (key !== undefined) return key;
	}
	return [...keys];
}

/**
 * Manages all keybindings (app + TUI).
 * Extends the TUI KeybindingsManager with app-specific functionality.
 */
export class KeybindingsManager extends TuiKeybindingsManager {
	#configPath: string | undefined;
	#userBindings: KeybindingsConfig;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.#configPath = configPath;
		this.#userBindings = userBindings;
	}

	/**
	 * Create from config file at agentDir/keybindings.yml.
	 * Legacy keybindings.json is migrated to keybindings.yml on load.
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const { readPath, writeBackPath } = resolveKeybindingsConfigPaths(agentDir);
		const { config: userBindings, persistedPath } = KeybindingsManager.#loadFromFile(readPath, writeBackPath);
		const manager = new KeybindingsManager(userBindings, persistedPath);
		// Set globally so getKeybindings() returns this manager
		setKeybindings(manager);
		return manager;
	}

	/**
	 * Create an in-memory keybindings manager without file persistence.
	 */
	static inMemory(userBindings: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(userBindings);
	}

	/**
	 * Reload keybindings from the config file.
	 */
	reload(): void {
		if (!this.#configPath) return;
		const { config } = KeybindingsManager.#loadFromFile(this.#configPath);
		this.setUserBindings(config);
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		super.setUserBindings(userBindings);
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		const keys = super.getKeys(keybinding);
		if (keybinding === FOLLOW_UP_KEYBINDING) {
			if (this.#userBindings[FOLLOW_UP_KEYBINDING] !== undefined) return keys;
			if (!userBindingClaimsKey(this.#userBindings, WINDOWS_FOLLOW_UP_FALLBACK_KEY, FOLLOW_UP_KEYBINDING)) {
				return keys;
			}
			return removeKey(keys, WINDOWS_FOLLOW_UP_FALLBACK_KEY);
		}
		return keys;
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved = super.getResolvedBindings();
		resolved[FOLLOW_UP_KEYBINDING] = keyConfigValue(this.getKeys(FOLLOW_UP_KEYBINDING));
		return resolved;
	}

	/**
	 * Get the effective resolved bindings (defaults + user overrides).
	 */
	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	/**
	 * Get display string for a keybinding (e.g., "ctrl+c/escape").
	 */
	getDisplayString(keybinding: Keybinding): string {
		const keys = this.getKeys(keybinding);
		return formatKeyHints(keys.length === 0 ? [] : keys);
	}

	/**
	 * Load user bindings from a file, migrating old names if needed.
	 */
	static #loadFromFile(
		filePath: string,
		writeBackPath?: string,
	): { config: KeybindingsConfig; persistedPath: string } {
		return loadKeybindingsConfig(filePath, writeBackPath);
	}
}

/**
 * Key hint formatting utilities for UI labels.
 */
const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
};

const KEY_LABELS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

function formatKeyPart(part: string): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const label = KEY_LABELS[lower];
	if (label) return label;
	if (part.length === 1) return part.toUpperCase();
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function formatKeyHint(key: KeyId): string {
	return key.split("+").map(formatKeyPart).join("+");
}

export function formatKeyHints(keys: KeyId | KeyId[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKeyHint).join("/");
}

export type { Keybinding, KeybindingsConfig, KeyId };
export { migrateKeybindingsConfigFile };
