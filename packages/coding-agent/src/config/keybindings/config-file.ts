/**
 * The user's `keybindings.yml`: reading it (and the legacy `.yaml`/`.json`
 * spellings), migrating pre-namespace action names, writing the migrated
 * YAML back, and merging the default profile's bindings under a named
 * profile's.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getActiveProfile, getProfileRootDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { JSONC, YAML } from "bun";
import { KEYBINDINGS, type Keybinding } from "./app-keybindings";
import type { KeyId } from "./key-id";

/** Action id → the chord or chords the user bound it to (`undefined` keeps the default). */
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

/** Controls inherited keybinding lookup when creating a manager for a named profile. */
export interface KeybindingsCreateOptions {
	/** Default-profile agent directory whose keybindings are merged before profile-specific bindings. */
	inheritedAgentDir?: string;
}

/** Old unqualified action names → their namespaced ids. */
const NAME_MIGRATIONS = {
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
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	toggleSessionNamedFilter: "app.session.togglePath",
} as const satisfies Record<string, Keybinding>;

const KEYBINDINGS_YML = "keybindings.yml";
const KEYBINDINGS_YAML = "keybindings.yaml";
const LEGACY_KEYBINDINGS_JSON = "keybindings.json";

/** The chord-valued entries of a parsed config file; anything else is dropped. */
function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (typeof value !== "object" || value === null) return {};
	const record = value as Record<string, unknown>;
	const config: KeybindingsConfig = {};
	for (const key in record) {
		const entry = record[key];
		if (entry === undefined) config[key] = undefined;
		else if (typeof entry === "string") config[key] = entry as KeyId;
		else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) config[key] = entry as KeyId[];
	}
	return config;
}

/** `raw` with old action names renamed, and whether any were. */
function migrateNames(raw: unknown): { config: KeybindingsConfig; migrated: boolean } {
	const config: KeybindingsConfig = {};
	let migrated = false;
	const parsed = toKeybindingsConfig(raw);
	for (const key in parsed) {
		const value = parsed[key];
		if (Object.hasOwn(NAME_MIGRATIONS, key)) {
			config[NAME_MIGRATIONS[key as keyof typeof NAME_MIGRATIONS]] = value;
			migrated = true;
		} else {
			config[key] = value;
		}
	}
	return { config, migrated };
}

/** `config` in {@link KEYBINDINGS} order, unknown actions last. */
function orderConfig(config: KeybindingsConfig): KeybindingsConfig {
	const ordered: KeybindingsConfig = {};
	for (const key in KEYBINDINGS) {
		if (config[key] !== undefined) ordered[key] = config[key];
	}
	for (const key in config) {
		if (!(key in ordered)) ordered[key] = config[key];
	}
	return ordered;
}

/** The parsed file, or null when it is missing or unreadable (logged). */
function readRawConfig(filePath: string): unknown {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		if (filePath.endsWith(".json")) return JSONC.parse(content);
		if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) return YAML.parse(content);
		throw new Error(`Unsupported keybindings config extension: ${filePath}`);
	} catch (error) {
		if (isEnoent(error)) return null;
		logger.warn("Failed to parse keybindings config", { path: filePath, error: String(error) });
		return null;
	}
}

function writeConfig(filePath: string, config: KeybindingsConfig): boolean {
	try {
		fs.writeFileSync(filePath, stringifyYamlConfig(config), "utf-8");
		logger.debug("Migrated keybindings config", { path: filePath });
		return true;
	} catch (error) {
		logger.warn("Failed to write migrated keybindings config", { path: filePath, error: String(error) });
		return false;
	}
}

/** Where `agentDir`'s bindings are read from (`.yml`, then `.yaml`, then legacy `.json`) and migrated to. */
function configPaths(agentDir: string): { readPath: string; writeBackPath: string } {
	const ymlPath = path.join(agentDir, KEYBINDINGS_YML);
	if (fs.existsSync(ymlPath)) return { readPath: ymlPath, writeBackPath: ymlPath };
	const yamlPath = path.join(agentDir, KEYBINDINGS_YAML);
	if (fs.existsSync(yamlPath)) return { readPath: yamlPath, writeBackPath: yamlPath };
	const jsonPath = path.join(agentDir, LEGACY_KEYBINDINGS_JSON);
	if (fs.existsSync(jsonPath)) return { readPath: jsonPath, writeBackPath: ymlPath };
	return { readPath: ymlPath, writeBackPath: ymlPath };
}

/**
 * Load one config file, migrating old names. With a `writeBackPath`, a
 * migrated (or legacy JSON) config is written there as YAML; `persistedPath`
 * is the file later reloads read.
 */
export function loadKeybindingsFile(
	filePath: string,
	writeBackPath?: string,
): { config: KeybindingsConfig; persistedPath: string } {
	const raw = readRawConfig(filePath);
	if (raw === null) return { config: {}, persistedPath: filePath };
	const { config, migrated } = migrateNames(raw);
	if (writeBackPath !== undefined && (migrated || writeBackPath !== filePath)) {
		const persistedPath = writeConfig(writeBackPath, orderConfig(config)) ? writeBackPath : filePath;
		return { config, persistedPath };
	}
	return { config, persistedPath: filePath };
}

/** A named profile's bindings over the default profile's, action by action. */
export function mergeKeybindingsConfig(inherited: KeybindingsConfig, profile: KeybindingsConfig): KeybindingsConfig {
	return { ...inherited, ...profile };
}

function inheritedAgentDirOf(agentDir: string, options: KeybindingsCreateOptions): string | undefined {
	const inherited =
		options.inheritedAgentDir ?? (getActiveProfile() ? path.join(getProfileRootDir(undefined), "agent") : undefined);
	if (!inherited || path.resolve(inherited) === path.resolve(agentDir)) return undefined;
	return inherited;
}

/**
 * The user bindings for `agentDir`: its own file over the default profile's
 * (when a named profile is active or `options.inheritedAgentDir` is given).
 * Only `agentDir`'s file is migrated on disk; the inherited one is read-only.
 */
export function loadKeybindingsConfig(
	agentDir: string,
	options: KeybindingsCreateOptions = {},
): { config: KeybindingsConfig; profilePath: string; inheritedPath: string | undefined } {
	const own = configPaths(agentDir);
	const profile = loadKeybindingsFile(own.readPath, own.writeBackPath);
	const inheritedDir = inheritedAgentDirOf(agentDir, options);
	if (!inheritedDir) return { config: profile.config, profilePath: profile.persistedPath, inheritedPath: undefined };
	// A named-profile process never writes migration output into the default profile's dir;
	// that file migrates when the default profile itself launches.
	const inherited = loadKeybindingsFile(configPaths(inheritedDir).readPath);
	return {
		config: mergeKeybindingsConfig(inherited.config, profile.config),
		profilePath: profile.persistedPath,
		inheritedPath: inherited.persistedPath,
	};
}

/** Migrate legacy keybinding names and JSON configuration in an agent directory. */
export function migrateKeybindingsConfigFile(agentDir: string): void {
	const { readPath, writeBackPath } = configPaths(agentDir);
	loadKeybindingsFile(readPath, writeBackPath);
}
