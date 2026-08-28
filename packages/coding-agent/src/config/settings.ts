/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import {
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
	procmgr,
	setWorktreesDir,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { JSONC, YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-methods";
import { AUTO_IMAGE_PROVIDER_ORDER, isImageProviderId } from "../tools/image-providers";
import { replaceFileAtomically } from "../utils/atomic-file";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { INSPECT_IMAGE_MODES } from "../utils/inspect-image-mode";
import { isSearchProviderId, SEARCH_PROVIDER_ORDER } from "../web/search/types";
import { stringifyYamlConfig } from "./config-file";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

type YamlContentGeneration = {
	kind: "content";
	source: string;
	mtimeNs: bigint;
	ctimeNs: bigint;
	inode: bigint;
	size: bigint;
};

type YamlGeneration = { kind: "missing" } | YamlContentGeneration | { kind: "unreadable" };

type PendingYamlMutation = {
	generation: YamlGeneration;
	baseValue: unknown;
};

type YamlLoadResult =
	| { kind: "missing" }
	| { kind: "loaded"; settings: RawSettings; generation: YamlContentGeneration }
	| { kind: "invalid"; error: unknown; generation: YamlContentGeneration; backupPath?: string }
	| { kind: "unreadable"; error: unknown };

type LockedYamlLoadResult = {
	settings: RawSettings | null;
	generation: YamlGeneration;
};

function yamlGenerationFromLoadResult(result: YamlLoadResult): YamlGeneration {
	switch (result.kind) {
		case "missing":
			return { kind: "missing" };
		case "loaded":
		case "invalid":
			return result.generation;
		case "unreadable":
			return { kind: "unreadable" };
	}
}

function yamlGenerationsMatch(left: YamlGeneration, right: YamlGeneration): boolean {
	switch (left.kind) {
		case "missing":
			return right.kind === "missing";
		case "content":
			return (
				right.kind === "content" &&
				left.source === right.source &&
				left.mtimeNs === right.mtimeNs &&
				left.ctimeNs === right.ctimeNs &&
				left.inode === right.inode &&
				left.size === right.size
			);
		case "unreadable":
			return false;
	}
}

type MainYamlReadResult = {
	settings: RawSettings | null;
	configPath: string | null;
};

type ProjectSettingsReadResult = {
	settings: RawSettings;
	fileSettings: RawSettings;
	shellPathSource: string | undefined;
};

type ConfigOverlayReadResult = {
	settings: RawSettings;
	shellPathSource: string | undefined;
};

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for config.yml/config.yaml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Read config sources without opening storage or writing migrations */
	readOnly?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
	/** Extra config.yml-style overlays loaded after global/project settings */
	configFiles?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

const SETTING_PATH_SEGMENTS: Record<SettingPath, readonly string[]> = Object.fromEntries(
	(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingPath => [settingPath, settingPath.split(".")]),
) as unknown as Record<SettingPath, readonly string[]>;

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/**
 * Dotted-path prefixes that name settings groups (e.g. "tui" for "tui.*").
 * A prefix may simultaneously be a schema leaf; those accept their declared
 * value shape and are excluded from shadow detection.
 */
const SETTINGS_GROUP_ONLY_PREFIXES: Readonly<Record<string, true>> = (() => {
	const prefixes: Record<string, true> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA)) {
		for (let dot = key.indexOf("."); dot !== -1; dot = key.indexOf(".", dot + 1)) {
			prefixes[key.slice(0, dot)] = true;
		}
	}
	for (const key of Object.keys(SETTINGS_SCHEMA)) delete prefixes[key];
	return prefixes;
})();

/**
 * Drop entries from capability-provided project settings whose non-object
 * value would shadow an entire settings group. `.claude/settings.json` is
 * shared with other tools, and a foreign leaf like `"tui": "fullscreen"`
 * deep-merges over omp's `tui` group, silently replacing every `tui.*`
 * setting for sessions rooted in that project. Values at schema leaves,
 * unknown keys, and well-formed nested objects pass through unchanged.
 */
export function dropSettingsGroupShadows(data: RawSettings, sourcePath: string, basePrefix = ""): RawSettings {
	const result: RawSettings = {};
	for (const key of Object.keys(data)) {
		const value = data[key];
		const path = basePrefix === "" ? key : `${basePrefix}.${key}`;
		if (!Object.hasOwn(SETTINGS_GROUP_ONLY_PREFIXES, path)) {
			result[key] = value;
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			logger.warn("Settings: ignoring project setting that would shadow a settings group", {
				setting: path,
				source: sourcePath,
			});
			continue;
		}
		result[key] = dropSettingsGroupShadows(value as RawSettings, sourcePath, path);
	}
	return result;
}

export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	return normalized;
}

export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const invalidProviders: string[] = [];
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
			invalidProviders.push(provider);
			continue;
		}
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	if (invalidProviders.length > 0) {
		throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
	}
	return normalized;
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);
type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function expandTilde(p: string): string {
	return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Migrate a v17 leaf rename that used to nest under a boolean parent path
 * (`dev.autoqa.consent` → `dev.autoqaConsent`, `todo.reminders.max` →
 * `todo.remindersMax`). Pre-rename configs left the leaf beneath the parent,
 * so the parent path resolved to an object and truthy checks like
 * `isAutoQaEnabled` treated a consent-only container as "enabled".
 *
 * Handles nested (`{ parent: { leaf } }`) and quoted-dotted (`"parent.leaf"`)
 * legacy sources. An explicit new key always wins; a separately configured
 * boolean parent is preserved; an irrecoverable object-valued parent (only ever
 * a container for the old leaf) is dropped so the schema default applies.
 */
function migrateNestedLeafRename(
	raw: RawSettings,
	root: string,
	parent: string,
	oldLeaf: string,
	newLeaf: string,
	isLeafValue: (value: unknown) => boolean,
): void {
	const rootObj = isRecord(raw[root]) ? (raw[root] as Record<string, unknown>) : undefined;
	const nestedParent = rootObj?.[parent];
	const flatParent = raw[`${root}.${parent}`];
	const oldParentPath = `${root}.${parent}`;

	const candidates = [
		rootObj?.[newLeaf],
		raw[`${root}.${newLeaf}`],
		isRecord(nestedParent) ? nestedParent[oldLeaf] : undefined,
		raw[`${oldParentPath}.${oldLeaf}`],
	];
	const resolvedLeaf = candidates.find(isLeafValue);

	const recoveredParent =
		typeof nestedParent === "boolean" ? nestedParent : typeof flatParent === "boolean" ? flatParent : undefined;

	const ensureRoot = (): Record<string, unknown> => {
		const current = raw[root];
		if (isRecord(current)) return current;
		const created: Record<string, unknown> = {};
		raw[root] = created;
		return created;
	};

	if (resolvedLeaf !== undefined) {
		const target = ensureRoot();
		if (!isLeafValue(target[newLeaf])) {
			target[newLeaf] = resolvedLeaf;
		}
	}

	// Strip legacy leaf sources (nested + flat dotted).
	delete raw[`${oldParentPath}.${oldLeaf}`];
	delete raw[`${root}.${newLeaf}`];
	if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		const parentObj = (raw[root] as Record<string, unknown>)[parent] as Record<string, unknown>;
		delete parentObj[oldLeaf];
		if (Object.keys(parentObj).length === 0) {
			delete (raw[root] as Record<string, unknown>)[parent];
		}
	}

	// The parent path must be a boolean or absent — never a leftover object.
	if (recoveredParent !== undefined) {
		const target = ensureRoot();
		if (typeof target[parent] !== "boolean") {
			target[parent] = recoveredParent;
		}
	} else if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		delete (raw[root] as Record<string, unknown>)[parent];
	}
	delete raw[oldParentPath];
	if (isRecord(raw[root]) && Object.keys(raw[root] as Record<string, unknown>).length === 0) {
		delete raw[root];
	}
}

function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		resolved.push(...values);
	}

	return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	#configFiles: string[] = [];
	/** Global settings from config.yml/config.yaml */
	#global: RawSettings = {};
	/** Project settings from .claude/settings.yml etc */
	#project: RawSettings = {};
	/** Last successfully loaded native .omp/config.yml contents. */
	#projectFileSettings: RawSettings = {};
	/** Logical config paths whose malformed targets were moved aside. */
	#quarantinedYamlTargets = new Map<string, string>();
	/** Extra config.yml-style overlays passed by CLI */
	#configOverlay: RawSettings = {};
	/** Project settings file that most recently supplied shellPath. */
	#projectShellPathSource: string | undefined;
	/** Explicit config overlay that most recently supplied shellPath. */
	#overlayShellPathSource: string | undefined;
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};
	/** Cached resolved values from the merged view, including defaults/path scoping */
	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();
	/** Individual project model roles modified during this session */
	#modifiedProjectModelRoles = new Set<string>();
	/** Individual global model roles modified during this session (for partial save) */
	#modifiedGlobalModelRoles = new Set<string>();
	/** On-disk generations and prior values observed before each pending global mutation. */
	#modifiedPathMutations = new Map<string, PendingYamlMutation>();
	#modifiedGlobalModelRoleMutations = new Map<string, PendingYamlMutation>();
	/** Changes whenever a live API mutates a persisted layer. */
	#persistedMutationGeneration = 0;
	/**
	 * Original process-wide model-role overrides captured before a project edit
	 * temporarily replaced them via `#updateRuntimeModelRoleOverride`. Restored
	 * on `reloadForCwd` / `cloneForCwd` so destination projects never inherit the
	 * source-project value. Maps role → original override value (`undefined`
	 * when the role had no runtime override).
	 */
	#savedRuntimeModelRoleOverrides = new Map<string, string | undefined>();

	/** Legacy `lastChangelogVersion` captured from config.yml during migration (now a marker file). */
	#legacyLastChangelogVersion?: string;

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;
	#projectSaveTimer?: NodeJS.Timeout;
	#projectSavePromise?: Promise<void>;
	/** Coalesces concurrent persisted-layer refreshes into one atomic reload. */
	#reloadFromDiskPromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
		if (options.configFiles) configFiles.push(...options.configFiles);
		this.#configFiles = configFiles.map(file => path.resolve(this.#cwd, expandTilde(file)));
		this.#persist = !options.inMemory && options.readOnly !== true;
		liveSettingsInstances.add(new WeakRef(this));

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, key.split("."), value);
			}

			this.#overrides = this.#migrateRawSettings(this.#overrides);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				clearBoundSettingsMethods();
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				globalInstancePromise = null;
				clearBoundSettingsMethods();
				throw error;
			},
		);
	}

	/**
	 * Load effective settings from config.yml and project providers without
	 * opening agent.db, migrating legacy settings, or writing marker files.
	 */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	/**
	 * Create an in-memory settings instance without affecting the global singleton.
	 * A supplied storage handle remains shared for runtime data while setting overrides stay non-persistent.
	 */
	static isolated(
		overrides: Partial<Record<SettingPath, unknown>> = {},
		options: { storage?: AgentStorage | null } = {},
	): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#storage = options.storage ?? null;
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		if (this.#resolvedCache.has(path)) {
			return this.#resolvedCache.get(path) as SettingValue<P>;
		}

		const value = getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]);
		const resolved =
			value !== undefined ? (resolvePathScopedStringArray(path, value, this.#cwd) ?? value) : getDefault(path);
		this.#resolvedCache.set(path, resolved);
		return resolved as SettingValue<P>;
	}

	/**
	 * Whether `path` has an explicitly configured value (global config, project
	 * config, or runtime override) rather than falling back to the schema default.
	 */
	isConfigured(path: SettingPath): boolean {
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]) !== undefined;
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = path.split(".");
		this.#captureGlobalMutation(path, this.#modifiedPathMutations, getByPath(this.#global, segments));
		setByPath(this.#global, segments, value);
		this.#persistedMutationGeneration++;
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		if (path === "modelRoles") {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		if (path === "modelRoles") {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	/** Effective values of every setting that repartitions the Code Mode surface. */
	#codeModeSignalSnapshot(): unknown[] {
		return CODE_MODE_SIGNAL_PATHS.map(path => this.get(path));
	}

	/** Fires the Code Mode signal when a persisted-layer refresh changed the partition inputs. */
	#fireCodeModeChangeIfNeeded(previous: unknown[]): void {
		if (Bun.deepEquals(this.#codeModeSignalSnapshot(), previous)) return;
		codeModeSignal.fire();
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown): void {
		if (Object.is(value, prev)) return;
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
		if (CODE_MODE_SIGNAL_PATHS.includes(path)) {
			codeModeSignal.fire();
		}
	}

	/** Set once this instance is discarded; background saves become no-ops. */
	#savesCancelled = false;

	/**
	 * Drop pending debounced saves and refuse any further background writes.
	 * Used when an instance is being discarded (test teardown): an armed timer
	 * or a chained in-flight save on a dropped instance would otherwise fire
	 * later and race the successor's file locks.
	 */
	cancelPendingSaves(): void {
		this.#savesCancelled = true;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = undefined;
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#projectSaveTimer) {
			clearTimeout(this.#projectSaveTimer);
			this.#projectSaveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#projectSavePromise) {
			await this.#projectSavePromise;
		}
		if (this.#modified.size > 0 || this.#modifiedGlobalModelRoles.size > 0) {
			await this.#saveNow();
		}
		if (this.#modifiedProjectModelRoles.size > 0) {
			await this.#saveProjectNow();
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#configPath = this.#configPath;
		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		if (!this.#persist) cloned.#projectShellPathSource = this.#projectShellPathSource;
		cloned.#configFiles = [...this.#configFiles];
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overlayShellPathSource = this.#overlayShellPathSource;
		cloned.#overrides = this.#buildOriginalOverrides();
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
		return cloned;
	}

	/**
	 * Re-read the current global, project, and explicit overlay layers from disk
	 * without replacing this instance or discarding runtime overrides.
	 *
	 * All sources are loaded before any live layer is replaced, so readers never
	 * observe a partially refreshed configuration. Concurrent callers share the
	 * same reload.
	 */
	async reloadFromDisk(): Promise<void> {
		if (!this.#persist) return;
		if (this.#reloadFromDiskPromise) return this.#reloadFromDiskPromise;

		const reload = this.#reloadPersistedLayers();
		this.#reloadFromDiskPromise = reload;
		try {
			await reload;
		} finally {
			if (this.#reloadFromDiskPromise === reload) {
				this.#reloadFromDiskPromise = undefined;
			}
		}
	}

	async #reloadPersistedLayers(): Promise<void> {
		for (;;) {
			await this.flush();
			const mutationGeneration = this.#persistedMutationGeneration;
			const previousSignaledValues = {
				modelRoles: this.get("modelRoles"),
				sessionAccent: this.get("statusLine.sessionAccent"),
			};
			const previousCodeModeValues = this.#codeModeSignalSnapshot();
			const previousHookValues = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
				previousHookValues.set(key, this.get(key));
			}

			const [globalResult, projectResult, overlayResult] = await Promise.allSettled([
				this.#readExistingMainYaml(false),
				this.#readProjectSettings(false),
				this.#readConfigOverlays(false),
			]);
			if (mutationGeneration !== this.#persistedMutationGeneration) continue;
			if (globalResult.status === "rejected") throw globalResult.reason;
			if (projectResult.status === "rejected") throw projectResult.reason;
			if (overlayResult.status === "rejected") throw overlayResult.reason;

			this.#configPath = globalResult.value.configPath;
			this.#global = globalResult.value.settings ?? {};
			this.#project = projectResult.value.settings;
			this.#projectFileSettings = projectResult.value.fileSettings;
			this.#projectShellPathSource = projectResult.value.shellPathSource;
			this.#configOverlay = overlayResult.value.settings;
			this.#overlayShellPathSource = overlayResult.value.shellPathSource;
			this.#rebuildMerged();

			const nextModelRoles = this.get("modelRoles");
			if (!Bun.deepEquals(nextModelRoles, previousSignaledValues.modelRoles)) {
				this.#fireEffectiveSettingChanged("modelRoles", nextModelRoles, previousSignaledValues.modelRoles);
			}
			const nextSessionAccent = this.get("statusLine.sessionAccent");
			if (!Bun.deepEquals(nextSessionAccent, previousSignaledValues.sessionAccent)) {
				this.#fireEffectiveSettingChanged(
					"statusLine.sessionAccent",
					nextSessionAccent,
					previousSignaledValues.sessionAccent,
				);
			}
			this.#fireCodeModeChangeIfNeeded(previousCodeModeValues);
			for (const [key, previous] of previousHookValues) {
				const next = this.get(key);
				if (!Bun.deepEquals(next, previous)) {
					SETTING_HOOKS[key]?.(next, previous);
				}
			}
			return;
		}
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: reload the
	 * project layer (`.claude/settings.yml` etc.) from `cwd`, re-resolve
	 * path-scoped settings against it, and re-fire side-effect hooks (theme,
	 * symbols, tab width, …). Global settings and runtime overrides are preserved.
	 *
	 * Unlike {@link cloneForCwd}, this mutates the live instance, so every holder
	 * (the `settings` proxy, the active session, controllers) observes the new
	 * project scope without swapping references — used when the process changes
	 * directory mid-run (`/move`, cross-project resume). No-op when `cwd` is
	 * already the current scope.
	 */
	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		await this.flush();
		this.#restoreRuntimeModelRoleOverrides();
		const prevModelRoles = this.get("modelRoles");
		const prevCodeModeValues = this.#codeModeSignalSnapshot();
		this.#cwd = normalized;
		if (this.#persist) {
			this.#project = await this.#loadProjectSettings();
		}
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prevModelRoles);
		this.#fireCodeModeChangeIfNeeded(prevCodeModeValues);
		this.#fireAllHooks();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		let configSource = this.#configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		if (Object.hasOwn(this.#project, "shellPath")) {
			configSource = this.#projectShellPathSource ?? "the active project configuration";
		}
		if (Object.hasOwn(this.#configOverlay, "shellPath")) {
			configSource = this.#overlayShellPathSource ?? "the active config overlay";
		}
		if (Object.hasOwn(this.#overrides, "shellPath")) {
			configSource = "the runtime settings override";
		}
		return procmgr.getShellConfig(shell, { configSource });
	}

	/**
	 * Provenance of the effective `extensions` array for extension-root
	 * sub-discovery. `"project"` only when a project settings provider owns it
	 * (any of `.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`,
	 * … — all merged into the project layer) and no higher user-level layer (a
	 * `--config` overlay or a runtime override) replaces it; otherwise `"user"`.
	 * Callers pass this into {@link EffectiveExtensionRoots.configuredLevel} so
	 * discovery labels roots by the authority that produced them rather than
	 * re-deriving provenance from a partial disk scan.
	 */
	extensionsSourceLevel(): "user" | "project" {
		if (Object.hasOwn(this.#overrides, "extensions")) return "user";
		if (Object.hasOwn(this.#configOverlay, "extensions")) return "user";
		return Object.hasOwn(this.#project, "extensions") ? "project" : "user";
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "apply_patch", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#getEditVariantEntries();
		if (variants.length === 0) return null;

		const modelLower = model.toLowerCase();

		for (let i = 0; i < variants.length; i++) {
			const variant = variants[i];
			if (modelLower.includes(variant.patternLower)) {
				return variant.mode;
			}
		}
		return null;
	}

	#getEditVariantEntries(): readonly EditVariantEntry[] {
		if (this.#editVariantCache !== undefined) return this.#editVariantCache;

		const value = getByPath(this.#merged, ["edit", "modelVariants"]);
		if (!isRecord(value)) {
			this.#editVariantCache = [];
			return this.#editVariantCache;
		}

		const variants: EditVariantEntry[] = [];
		for (const pattern in value) {
			if (!Object.hasOwn(value, pattern)) continue;
			const rawMode = value[pattern];
			if (typeof rawMode !== "string") continue;
			const mode = normalizeEditMode(rawMode);
			if (mode) {
				variants.push({ patternLower: pattern.toLowerCase(), mode });
			}
		}

		this.#editVariantCache = variants;
		return variants;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRolesFromLayer(layer: RawSettings): Record<string, string> {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return {};

		const roles: Record<string, string> = {};
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) {
				roles[role] = modelId;
			}
		}
		return roles;
	}

	#modelRoleLayerOwns(layer: RawSettings, role: ModelRole | string): boolean {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return false;
		return Object.hasOwn(value, role);
	}

	/**
	 * Set the full `modelRoles` map on the runtime override layer without
	 * routing through the public {@link override} method. Internal callers
	 * (project edits, global fallback updates) use this so they can control
	 * capture invalidation independently of the whole-map replacement
	 * semantics that `override("modelRoles", …)` carries.
	 */
	#setRuntimeModelRoleOverrides(next: Record<string, string>): void {
		const prev = this.get("modelRoles");
		setByPath(this.#overrides, ["modelRoles"], next);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
	}

	#updateRuntimeModelRoleOverride(role: ModelRole | string, modelId: string | undefined): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;

		const nextRuntimeOverride = this.#modelRolesFromLayer(this.#overrides);
		if (modelId === undefined) {
			delete nextRuntimeOverride[role];
		} else {
			nextRuntimeOverride[role] = modelId;
		}
		this.#setRuntimeModelRoleOverrides(nextRuntimeOverride);
	}

	/**
	 * Capture the original process-wide override for `role` the first time a
	 * project edit temporarily replaces it, so the original can be restored on
	 * cwd changes. Subsequent edits in the same cwd must not overwrite the
	 * first captured value.
	 */
	#captureRuntimeModelRoleOverride(role: ModelRole | string): void {
		if (this.#savedRuntimeModelRoleOverrides.has(role)) return;
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;
		this.#savedRuntimeModelRoleOverrides.set(role, this.#modelRolesFromLayer(this.#overrides)[role]);
	}

	/**
	 * Restore original process-wide model-role overrides that were temporarily
	 * replaced by project edits, mutating `#overrides` in place without
	 * rebuilding. All remaining captures are valid because superseding
	 * operations (late `overrideModelRoles`, global-mode `setModelRole`,
	 * whole-map `override`/`clearOverride`) invalidate the affected captures
	 * at the point of supersession. Caller is responsible for `#rebuildMerged()`.
	 */
	#restoreRuntimeModelRoleOverrides(): void {
		if (this.#savedRuntimeModelRoleOverrides.size === 0) return;
		const runtimeRoles = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeRoles)) {
			this.#savedRuntimeModelRoleOverrides.clear();
			return;
		}
		for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
			if (originalValue === undefined) {
				delete runtimeRoles[role];
			} else {
				runtimeRoles[role] = originalValue;
			}
		}
		this.#savedRuntimeModelRoleOverrides.clear();
	}

	/**
	 * Produce a deep copy of `#overrides` with original process-wide model-role
	 * overrides restored, for use by {@link cloneForCwd}. All remaining
	 * captures are valid (see {@link #restoreRuntimeModelRoleOverrides}).
	 * Does not mutate the current instance's `#overrides`.
	 */
	#buildOriginalOverrides(): RawSettings {
		if (this.#savedRuntimeModelRoleOverrides.size === 0) {
			return structuredClone(this.#overrides);
		}
		const overrides = structuredClone(this.#overrides);
		const runtimeRoles = getByPath(overrides, ["modelRoles"]);
		if (!isRecord(runtimeRoles)) return overrides;
		for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
			if (originalValue === undefined) {
				delete runtimeRoles[role];
			} else {
				runtimeRoles[role] = originalValue;
			}
		}
		return overrides;
	}

	#setProjectModelRoleValue(role: ModelRole | string, modelId: string | null): void {
		const prev = this.get("modelRoles");
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		const current: Record<string, unknown> = isRecord(projectRoles) ? { ...projectRoles } : {};
		current[role] = modelId;
		setByPath(this.#project, ["modelRoles"], current);
		this.#modifiedProjectModelRoles.add(role);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
		this.#queueProjectSave();
	}

	/**
	 * Set a model role (helper for modelRoles record). Passing `undefined`
	 * clears the role from the persisted record and any runtime override.
	 *
	 * In project storage mode, when a project edit has temporarily replaced
	 * the process-wide runtime override for `role` and that override is still
	 * active (the runtime slot currently matches the project value), the
	 * global-layer write must not rewrite that runtime slot — otherwise the
	 * global fallback would immediately shadow the still-configured project
	 * role. The global layer is still persisted; only the runtime override is
	 * left untouched. The guard is precise so that a later clear, a late
	 * `overrideModelRoles`, or a storage-mode transition does not leave a
	 * stale skip in place.
	 */
	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const prev = this.get("modelRoles");
		const current = this.#modelRolesFromLayer(this.#global);
		this.#captureGlobalMutation(role, this.#modifiedGlobalModelRoleMutations, current[role]);
		if (modelId === undefined) {
			delete current[role];
		} else {
			current[role] = modelId;
		}
		// Persist per-role rather than marking the whole `modelRoles` path
		// modified: #saveNow merges only the changed role into the re-read
		// file, so a concurrent external edit to a sibling role is not
		// clobbered by this process's stale in-memory snapshot.
		setByPath(this.#global, ["modelRoles"], current);
		this.#modifiedGlobalModelRoles.add(role);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#queueSave();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
		if (this.isProjectModelRoleRuntimeOverrideActive(role)) {
			return;
		}
		this.#savedRuntimeModelRoleOverrides.delete(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}

	/**
	 * Whether `role`'s runtime override slot currently holds the temporary
	 * project-scoped value installed by a prior `setProjectModelRole`. Returns
	 * `false` when storage is not project-mode, no capture exists, or the
	 * project role was cleared. With explicit provenance invalidation, a
	 * surviving capture implies no external supersession occurred.
	 */
	isProjectModelRoleRuntimeOverrideActive(role: ModelRole | string): boolean {
		if (this.get("modelRoleStorage") !== "project") return false;
		if (!this.#savedRuntimeModelRoleOverrides.has(role)) return false;
		return !!this.getProjectModelRole(role);
	}
	/**
	 * Set a model role in the current project's settings layer.
	 */
	setProjectModelRole(role: ModelRole | string, modelId: string): void {
		this.#setProjectModelRoleValue(role, modelId);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}
	/**
	 * Clear a model role from the current project's settings layer.
	 */
	clearProjectModelRole(role: ModelRole | string): void {
		this.#setProjectModelRoleValue(role, null);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, undefined);
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}
	/**
	 * Get a model role from only the global settings layer.
	 */
	getGlobalModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#global)[role];
		return modelId || undefined;
	}

	/**
	 * Get a model role from only the current project settings layer.
	 */
	getProjectModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#project)[role];
		return modelId || undefined;
	}

	/**
	 * Report which layer actually supplies the effective model role across
	 * full merge precedence (runtime override → config overlay → project →
	 * global → default). Unlike {@link getModelRoleSource}, this accounts
	 * for runtime and config-overlay layers and detects ownership by key
	 * presence rather than normalized value, so a `null` tombstone in the
	 * overlay or runtime layer correctly blocks lower layers. The project
	 * layer is checked through {@link #projectSettingsForMerge} because a
	 * project null is a cleared value (falls back to global), not a
	 * tombstone.
	 */
	getModelRoleProvenance(role: ModelRole | string): "runtime" | "overlay" | "project" | "global" | "default" {
		if (this.#modelRoleLayerOwns(this.#overrides, role)) return "runtime";
		if (this.#modelRoleLayerOwns(this.#configOverlay, role)) return "overlay";
		if (this.#modelRoleLayerOwns(this.#projectSettingsForMerge(), role)) return "project";
		if (this.#modelRoleLayerOwns(this.#global, role)) return "global";
		return "default";
	}

	/**
	 * Get the persisted layer supplying a model role (project/global/default only).
	 */
	getModelRoleSource(role: ModelRole | string): "project" | "global" | "default" {
		if (this.getProjectModelRole(role)) return "project";
		if (this.getGlobalModelRole(role)) return "global";
		return "default";
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return {};

		const normalized: Record<string, string> = {};
		for (const role in roles) {
			if (!Object.hasOwn(roles, role)) continue;
			const modelId = modelRoleValueFromUnknown(roles[role]);
			if (modelId !== undefined) {
				normalized[role] = modelId;
			}
		}
		return normalized;
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
				this.#savedRuntimeModelRoleOverrides.delete(role);
			}
		}
		this.#setRuntimeModelRoleOverrides(next);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		// Project settings discovery is independent of the persist chain, while
		// the persist steps themselves remain sequential. Wait for both branches
		// to settle so simultaneous failures produce one catchable error without
		// abandoning the other rejection.
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#persist ? this.#loadGlobalSettings() : Promise.resolve(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}
	async #loadGlobalSettings(): Promise<void> {
		this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		} else {
			await this.#migrateFromLegacy();
			this.#global = await this.#loadYaml(this.#configPath!);
		}
		await this.#seedLastChangelogVersionMarker();
	}

	async #loadReadOnly(): Promise<Settings> {
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#loadExistingMainYaml(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;
		if (globalResult.value) {
			this.#global = globalResult.value;
		}

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#rebuildMerged();
		return this;
	}

	#readYamlGeneration(filePath: string): YamlGeneration {
		try {
			const source = fs.readFileSync(filePath, "utf8");
			const stat = fs.statSync(filePath, { bigint: true });
			return {
				kind: "content",
				source,
				mtimeNs: stat.mtimeNs,
				ctimeNs: stat.ctimeNs,
				inode: stat.ino,
				size: stat.size,
			};
		} catch (error) {
			return isEnoent(error) ? { kind: "missing" } : { kind: "unreadable" };
		}
	}

	#captureGlobalMutation(key: string, mutations: Map<string, PendingYamlMutation>, baseValue: unknown): void {
		if (!this.#persist || !this.#configPath) return;
		mutations.set(key, {
			generation: this.#readYamlGeneration(this.#configPath),
			baseValue: structuredClone(baseValue),
		});
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresentForStartup(filePath);
		return loaded ?? {};
	}

	async #loadYamlIfPresent(filePath: string, captureLegacyChangelogVersion = true): Promise<YamlLoadResult> {
		let content: string;
		let generation: YamlContentGeneration;
		try {
			content = await fs.promises.readFile(filePath, "utf8");
			const stat = await fs.promises.stat(filePath, { bigint: true });
			generation = {
				kind: "content",
				source: content,
				mtimeNs: stat.mtimeNs,
				ctimeNs: stat.ctimeNs,
				inode: stat.ino,
				size: stat.size,
			};
		} catch (error) {
			if (isEnoent(error)) return { kind: "missing" };
			return { kind: "unreadable", error };
		}

		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			return { kind: "invalid", error, generation };
		}
		if (parsed === null || parsed === undefined) {
			return { kind: "loaded", settings: {}, generation };
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				kind: "invalid",
				error: new Error("Settings YAML must contain a mapping at the document root"),
				generation,
			};
		}
		return {
			kind: "loaded",
			settings: this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion),
			generation,
		};
	}

	async #resolveYamlWritePath(filePath: string): Promise<string> {
		const quarantinedTarget = this.#quarantinedYamlTargets.get(filePath);
		if (quarantinedTarget) return quarantinedTarget;
		try {
			return await fs.promises.realpath(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		// realpath fails for a dangling symlink. Resolve its immediate target so
		// recreating a quarantined config repairs the target without replacing
		// the user-managed link.
		try {
			const stat = await fs.promises.lstat(filePath);
			if (stat.isSymbolicLink()) {
				const target = await fs.promises.readlink(filePath);
				return path.resolve(path.dirname(filePath), target);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return path.resolve(filePath);
	}

	async #withYamlWriteLock<T>(filePath: string, fn: (writePath: string) => Promise<T>): Promise<T> {
		const writePath = await this.#resolveYamlWritePath(filePath);
		return await withFileLock(writePath, async () => fn(writePath));
	}

	async #loadYamlIfPresentForStartup(filePath: string): Promise<RawSettings | null> {
		const result = await this.#loadYamlIfPresent(filePath);
		if (result.kind !== "invalid" || !this.#persist) {
			return this.#unwrapYamlLoadResult(filePath, result);
		}
		return await this.#withYamlWriteLock(filePath, async writePath => {
			const loaded = await this.#loadYamlIfPresentForWriteLocked(filePath, writePath, true);
			return loaded.settings;
		});
	}

	/**
	 * Read a YAML settings file while its write lock is held. Invalid files are
	 * moved aside before reporting failure, so a later write can never truncate
	 * the only copy of the user's configuration.
	 */
	async #loadYamlIfPresentForWriteLocked(
		filePath: string,
		writePath: string,
		rejectMissing = false,
	): Promise<LockedYamlLoadResult> {
		let result = await this.#loadYamlIfPresent(writePath);
		const generation = yamlGenerationFromLoadResult(result);
		if (result.kind === "missing" && rejectMissing) {
			throw new Error(
				`Settings config was invalid before locking and is now missing: ${filePath}; another process may have moved it aside`,
			);
		}
		if (result.kind === "invalid") {
			result = await this.#quarantineInvalidYamlLocked(writePath, result);
			this.#quarantinedYamlTargets.set(filePath, writePath);
		}
		return {
			settings: this.#unwrapYamlLoadResult(filePath, result),
			generation,
		};
	}

	async #quarantineInvalidYamlLocked(
		filePath: string,
		result: Extract<YamlLoadResult, { kind: "invalid" }>,
	): Promise<Extract<YamlLoadResult, { kind: "invalid" }>> {
		const backupPath = `${filePath}.broken-${Date.now()}-${process.pid}-${randomUUID()}`;
		try {
			await fs.promises.rename(filePath, backupPath);
		} catch (error) {
			throw new Error(
				`Settings config is invalid and could not be moved aside: ${filePath}; refusing to overwrite it: ${String(error)}`,
			);
		}
		logger.warn("Settings: moved invalid config aside", {
			path: filePath,
			backupPath,
			error: String(result.error),
		});
		return { ...result, backupPath };
	}

	#unwrapYamlLoadResult(filePath: string, result: YamlLoadResult): RawSettings | null {
		switch (result.kind) {
			case "missing":
				return null;
			case "loaded":
				return result.settings;
			case "invalid":
				throw new Error(
					`Settings config is invalid: ${filePath}${result.backupPath ? ` (moved to ${result.backupPath})` : ""}: ${String(result.error)}`,
				);
			case "unreadable":
				throw new Error(`Failed to read settings config ${filePath}: ${String(result.error)}`);
		}
	}

	async #readExistingMainYaml(quarantineInvalid: boolean): Promise<MainYamlReadResult> {
		if (!this.#configPath) return { settings: null, configPath: null };
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const loaded = quarantineInvalid
				? await this.#loadYamlIfPresentForStartup(configPath)
				: this.#unwrapYamlLoadResult(configPath, await this.#loadYamlIfPresent(configPath, false));
			if (loaded) return { settings: loaded, configPath };
		}
		return {
			settings: null,
			configPath: path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]),
		};
	}

	async #loadExistingMainYaml(): Promise<RawSettings | null> {
		const result = await this.#readExistingMainYaml(true);
		this.#configPath = result.configPath;
		return result.settings;
	}

	async #readProjectSettings(quarantineInvalid: boolean): Promise<ProjectSettingsReadResult> {
		let shellPathSource: string | undefined;
		let merged: RawSettings = {};
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, dropSettingsGroupShadows(item.data as RawSettings, item.path));
					if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
				}
			}
		} catch {
			shellPathSource = undefined;
			// Capability discovery is best-effort; the native project config below
			// remains authoritative for its model-role layer and must not be hidden.
		}
		const projectConfigPath = path.join(this.#cwd, ".omp", "config.yml");
		const nativeProject = quarantineInvalid
			? await this.#loadYaml(projectConfigPath)
			: (this.#unwrapYamlLoadResult(projectConfigPath, await this.#loadYamlIfPresent(projectConfigPath, false)) ??
				{});
		const nativeModelRoles = getByPath(nativeProject, ["modelRoles"]);
		if (nativeModelRoles !== undefined) {
			merged = this.#deepMerge(merged, { modelRoles: nativeModelRoles });
		}
		return {
			settings: this.#migrateRawSettings(merged, quarantineInvalid),
			fileSettings: structuredClone(nativeProject),
			shellPathSource,
		};
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		const result = await this.#readProjectSettings(true);
		this.#projectFileSettings = result.fileSettings;
		this.#projectShellPathSource = result.shellPathSource;
		return result.settings;
	}

	async #readConfigOverlays(captureLegacyChangelogVersion = true): Promise<ConfigOverlayReadResult> {
		let shellPathSource: string | undefined;
		let settings: RawSettings = {};
		for (const filePath of this.#configFiles) {
			const overlay = await this.#loadOverlayYaml(filePath, captureLegacyChangelogVersion);
			settings = this.#deepMerge(settings, overlay);
			if (Object.hasOwn(overlay, "shellPath")) shellPathSource = filePath;
		}
		return { settings, shellPathSource };
	}

	async #loadConfigOverlays(): Promise<RawSettings> {
		const result = await this.#readConfigOverlays();
		this.#overlayShellPathSource = result.shellPathSource;
		return result.settings;
	}

	/**
	 * Strict loader for explicit `--config` overlays: unlike `#loadYaml`,
	 * missing or malformed files are hard errors so a typo'd path cannot
	 * silently fall back to the persistent settings.
	 */
	async #loadOverlayYaml(filePath: string, captureLegacyChangelogVersion = true): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			throw new Error(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${String(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new Error(`Failed to parse config overlay ${filePath}: ${String(error)}`);
		}
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Config overlay must be a YAML mapping: ${filePath}`);
		}
		return this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch {}
			}
		} catch {}

		// 2. Migrate from agent.db
		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch {}

		// 3. Write merged settings
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeYamlAtomically(this.#configPath, settings);
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch {}
		}
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings, captureLegacyChangelogVersion = true): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// lastChangelogVersion moved out of config.yml into the
		// <agentDir>/last-changelog-version marker file so version bumps no
		// longer dirty user-tracked configs. Capture for marker seeding (see
		// #seedLastChangelogVersionMarker), then strip the key — the next
		// config save drops it from disk.
		if (captureLegacyChangelogVersion && typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;

		// collapseChangelog (boolean) -> startup.changelogMode (enum). Preserve
		// every explicit legacy choice while giving new installs the schema's
		// "summary" default: true -> summary, false -> expanded. A separately
		// configured new mode always wins.
		const startupObj = isRecord(raw.startup) ? (raw.startup as Record<string, unknown>) : undefined;
		const legacyCollapseChangelog = typeof raw.collapseChangelog === "boolean" ? raw.collapseChangelog : undefined;
		const flatChangelogMode = raw["startup.changelogMode"];
		const normalizedFlatChangelogMode =
			flatChangelogMode === "summary" || flatChangelogMode === "expanded" || flatChangelogMode === "hidden"
				? flatChangelogMode
				: undefined;
		if (legacyCollapseChangelog !== undefined || normalizedFlatChangelogMode !== undefined) {
			if (!startupObj) {
				raw.startup = {};
			}
			const target = raw.startup as Record<string, unknown>;
			if (target.changelogMode === undefined) {
				target.changelogMode =
					normalizedFlatChangelogMode ??
					(legacyCollapseChangelog !== undefined ? (legacyCollapseChangelog ? "summary" : "expanded") : undefined);
			}
		}
		delete raw.collapseChangelog;
		delete raw["startup.changelogMode"];

		// ask.timeout: ms -> seconds (if value > 1000, it's old ms format)
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				// Built-in defaults — just remove, let new defaults apply
				delete raw.theme;
			} else {
				// Custom theme — detect luminance to place in correct slot
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// inspect_image.enabled (boolean) -> inspect_image.mode (enum). Explicit
		// user choices are preserved: true -> "on", false -> "off". Configs with
		// no legacy key get the new "auto" default, which hides the tool for
		// models with native image input. Handles nested and quoted-dotted
		// ("inspect_image.enabled") sources; the target is always the nested
		// form, which is the only shape the resolver reads.
		const inspectImageObj = isRecord(raw.inspect_image) ? (raw.inspect_image as Record<string, unknown>) : undefined;
		const legacyEnabled =
			typeof inspectImageObj?.enabled === "boolean"
				? inspectImageObj.enabled
				: typeof raw["inspect_image.enabled"] === "boolean"
					? (raw["inspect_image.enabled"] as boolean)
					: undefined;
		if (legacyEnabled !== undefined) {
			if (!inspectImageObj) {
				raw.inspect_image = {};
			}
			const target = raw.inspect_image as Record<string, unknown>;
			const flatMode = raw["inspect_image.mode"];
			if (target.mode === undefined) {
				// A quoted-dotted explicit mode wins over the legacy boolean but
				// must be normalized into the nested form the resolver reads.
				target.mode =
					typeof flatMode === "string" && (INSPECT_IMAGE_MODES as readonly string[]).includes(flatMode)
						? flatMode
						: legacyEnabled
							? "on"
							: "off";
			}
			delete target.enabled;
			delete raw["inspect_image.enabled"];
			delete raw["inspect_image.mode"];
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		// task.simple: removed — the task tool no longer accepts a per-call
		// schema (workflows drive structured output via eval agent()) and the
		// batch/context shape is gated by task.batch instead.
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}

		// task.eager / todo.eager: boolean -> enum (default | preferred | always).
		// `true` reproduced the previous "on" behavior, which is now `always`.
		if (taskObj && typeof taskObj.eager === "boolean") {
			taskObj.eager = taskObj.eager ? "always" : "default";
		}
		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}

		// features.unexpectedStopDetection (boolean) -> enum none|mechanical|smart.
		// `true` reproduced the previous small-model-classified behavior, which is
		// now "smart"; `false` maps to "none" so explicitly disabled configs remain
		// off rather than inheriting the new "mechanical" default.
		// Handles nested and quoted-dotted sources, like inspect_image above.
		const featuresObj = isRecord(raw.features) ? (raw.features as Record<string, unknown>) : undefined;
		const legacyUnexpectedStop =
			typeof featuresObj?.unexpectedStopDetection === "boolean"
				? featuresObj.unexpectedStopDetection
				: typeof raw["features.unexpectedStopDetection"] === "boolean"
					? (raw["features.unexpectedStopDetection"] as boolean)
					: undefined;
		if (legacyUnexpectedStop !== undefined) {
			if (!featuresObj) {
				raw.features = {};
			}
			const target = raw.features as Record<string, unknown>;
			const current = target.unexpectedStopDetection;
			const currentIsMode = typeof current === "string" && ["none", "mechanical", "smart"].includes(current);
			if (!currentIsMode) {
				target.unexpectedStopDetection = legacyUnexpectedStop ? "smart" : "none";
			}
			delete raw["features.unexpectedStopDetection"];
		}
		// task.isolation.mode: legacy values from before the pi-iso PAL refactor.
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		// edit.mode: removed "atom" and "vim" variants map back to "hashline"
		const editObj = raw.edit as Record<string, unknown> | undefined;
		if (editObj) {
			if (editObj.mode === "atom" || editObj.mode === "vim") {
				editObj.mode = "hashline";
			}
			const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
			if (modelVariants && typeof modelVariants === "object" && !Array.isArray(modelVariants)) {
				for (const [pattern, variant] of Object.entries(modelVariants)) {
					if (variant === "atom" || variant === "vim") {
						modelVariants[pattern] = "hashline";
					}
				}
			}
		}
		if (raw["edit.mode"] === "atom" || raw["edit.mode"] === "vim") {
			raw["edit.mode"] = "hashline";
		}

		// compaction.strategy / compaction.remoteEnabled → compaction.methodOrder.
		// The old single strategy could not express a capability-dependent fallback
		// chain. Preserve explicit legacy intent while new installs use the
		// server → snapcompact → handoff → shake → soft default.
		const compactionObj = isRecord(raw.compaction) ? raw.compaction : undefined;
		const configuredMethodOrder = compactionObj?.methodOrder ?? raw["compaction.methodOrder"];
		const legacyStrategy = compactionObj?.strategy ?? raw["compaction.strategy"];
		const legacyRemoteEnabled = compactionObj?.remoteEnabled ?? raw["compaction.remoteEnabled"];
		if (!Array.isArray(configuredMethodOrder)) {
			const remoteEnabled = legacyRemoteEnabled !== false;
			const strategy = legacyStrategy === "shake-summary" ? "shake" : legacyStrategy;
			let methodOrder: CompactionMethod[] | undefined;
			switch (strategy) {
				case "context-full":
					methodOrder = remoteEnabled ? ["remote", "soft"] : ["soft"];
					break;
				case "handoff":
					methodOrder = remoteEnabled ? ["handoff", "remote", "soft"] : ["handoff", "soft"];
					break;
				case "shake":
					methodOrder = remoteEnabled ? ["shake", "remote", "soft"] : ["shake", "soft"];
					break;
				case "snapcompact":
					methodOrder = remoteEnabled ? ["snapcompact", "remote", "soft"] : ["snapcompact", "soft"];
					break;
				case "off":
					methodOrder = [];
					break;
				default:
					if (legacyRemoteEnabled === false) {
						methodOrder = DEFAULT_COMPACTION_METHOD_ORDER.filter(method => method !== "remote");
					}
			}
			if (methodOrder) {
				const root = compactionObj ?? {};
				root.methodOrder = methodOrder;
				raw.compaction = root;
			}
		} else if (!compactionObj || compactionObj.methodOrder === undefined) {
			const root = compactionObj ?? {};
			root.methodOrder = configuredMethodOrder;
			raw.compaction = root;
		}
		if (compactionObj) {
			delete compactionObj.strategy;
			delete compactionObj.remoteEnabled;
		}
		delete raw["compaction.strategy"];
		delete raw["compaction.remoteEnabled"];
		delete raw["compaction.methodOrder"];

		// snapcompact.systemPrompt: boolean -> scoped enum.
		const snapcompactObj = raw.snapcompact as Record<string, unknown> | undefined;
		if (snapcompactObj && typeof snapcompactObj.systemPrompt === "boolean") {
			snapcompactObj.systemPrompt = snapcompactObj.systemPrompt ? "all" : "none";
		}
		if (typeof raw["snapcompact.systemPrompt"] === "boolean") {
			raw["snapcompact.systemPrompt"] = raw["snapcompact.systemPrompt"] ? "all" : "none";
		}

		// inlineToolDescriptors: boolean -> enum (auto | on | off). The old
		// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
		// the user's explicit choice; new installs get the `auto` default that
		// turns it on only for Gemini models.
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}

		// statusLine: rename "plan_mode" segment to "mode"
		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
			for (const key of ["leftSegments", "rightSegments"] as const) {
				const segments = statusLineObj[key];
				if (Array.isArray(segments)) {
					statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
				}
			}
			const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
			if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
				segmentOptions.mode = segmentOptions.plan_mode;
				delete segmentOptions.plan_mode;
			}
		}

		// providers.parallelFetch (boolean) replaced by the providers.fetch reader
		// priority enum. The new default ("auto") supersedes both old values —
		// Parallel is now a deep fallback in the auto chain rather than the first
		// choice — so drop the legacy key (flat and nested) and let the enum
		// default apply.
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];

		// codexResets.autoRedeem: boolean -> tri-state enum.
		// Existing explicit false keeps the old "do not run" behavior; missing
		// config now falls through to the new "unset" default, which asks before
		// the first eligible spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}
		if (typeof raw["codexResets.autoRedeem"] === "boolean") {
			raw["codexResets.autoRedeem"] = raw["codexResets.autoRedeem"] ? "yes" : "no";
		}

		// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
		// enum if the latter hasn't been set yet. Idempotent: subsequent
		// migrations are no-ops once memory.backend is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
		const memoriesObj = raw.memories as Record<string, unknown> | undefined;
		if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
			const next = memoriesObj.enabled ? "local" : "off";
			const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
			memoryRoot.backend = next;
			raw.memory = memoryRoot;
		}

		// Rename the legacy local `mnemosyne` memory backend to `mnemopi`.
		// - `memory.backend: "mnemosyne"` now selects the renamed backend.
		// - the top-level `mnemosyne` settings object becomes `mnemopi`.
		// Idempotent: skips the object move once `mnemopi` is materialised.
		if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
			memoryBackendObj.backend = "mnemopi";
		}
		if ("mnemosyne" in raw && !("mnemopi" in raw)) {
			raw.mnemopi = raw.mnemosyne;
			delete raw.mnemosyne;
		}

		// hindsight: dynamicBankId/agentName -> scoping enum + bankId
		// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
		//   the legacy `agent::project::channel::user` tuple was per-project in
		//   practice — the channel/user env vars were rarely set).
		// - hindsight.agentName was only used as the agent slot in the legacy
		//   dynamic tuple; if the user customised it we surface it as the new
		//   bankId base when no explicit bankId is set.
		const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
		if (hindsightObj) {
			if ("dynamicBankId" in hindsightObj) {
				if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
					hindsightObj.scoping = "per-project";
				}
				delete hindsightObj.dynamicBankId;
			}
			if ("agentName" in hindsightObj) {
				const agentName = hindsightObj.agentName;
				if (
					!("bankId" in hindsightObj) &&
					typeof agentName === "string" &&
					agentName.trim().length > 0 &&
					agentName !== "omp"
				) {
					hindsightObj.bankId = agentName;
				}
				delete hindsightObj.agentName;
			}
		}

		// power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
		// / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
		// The enum is cumulative: each level adds the flags of all lower levels.
		// Migration picks the highest level whose condition is met, scanning from
		// most to least aggressive so a single enum value captures the old state.
		if (
			!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {})) &&
			raw["power.sleepPrevention"] === undefined
		) {
			const powerObj = raw.power as Record<string, unknown> | undefined;
			const getFlag = (key: string): boolean | undefined => {
				const nested = powerObj?.[key];
				const flat = raw[`power.${key}`];
				const value = nested ?? flat;
				return typeof value === "boolean" ? value : undefined;
			};
			const idle = getFlag("preventIdleSleep");
			const system = getFlag("preventSystemSleep");
			const user = getFlag("declareUserActive");
			const display = getFlag("preventDisplaySleep");
			const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
			if (anySet) {
				const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
				const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
				powerRoot.sleepPrevention = mode;
				raw.power = powerRoot;
			}
			// Clean up old keys (nested + flat)
			if (powerObj) {
				delete powerObj.preventIdleSleep;
				delete powerObj.preventSystemSleep;
				delete powerObj.declareUserActive;
				delete powerObj.preventDisplaySleep;
			}
			delete raw["power.preventIdleSleep"];
			delete raw["power.preventSystemSleep"];
			delete raw["power.declareUserActive"];
			delete raw["power.preventDisplaySleep"];
		}

		// Migration for renamed settings grep.* and glob.* from search.* and find.*:
		// 1. Nested settings: find -> glob, search -> grep (per-property merge to avoid clobbering)
		const ensureRawObject = (key: "glob" | "grep"): Record<string, unknown> => {
			const current = raw[key];
			if (isRecord(current)) {
				return current;
			}
			const created: Record<string, unknown> = {};
			raw[key] = created;
			return created;
		};

		if ("find" in raw) {
			const findObj = raw.find;
			if (isRecord(findObj)) {
				const globObj = ensureRawObject("glob");
				const findKeys: Array<"enabled"> = ["enabled"];
				for (const key of findKeys) {
					if (key in findObj && !(key in globObj)) {
						globObj[key] = findObj[key];
					}
				}
			}
			delete raw.find;
		}

		if ("search" in raw) {
			const searchObj = raw.search;
			if (isRecord(searchObj)) {
				const grepObj = ensureRawObject("grep");
				const searchKeys: Array<"enabled" | "contextBefore" | "contextAfter"> = [
					"enabled",
					"contextBefore",
					"contextAfter",
				];
				for (const key of searchKeys) {
					if (key in searchObj && !(key in grepObj)) {
						grepObj[key] = searchObj[key];
					}
				}
			}
			delete raw.search;
		}

		// 2. Flat settings keys: map them to the proper nested target so get/set resolves them correctly
		if ("find.enabled" in raw) {
			const globObj = ensureRawObject("glob");
			if (!("enabled" in globObj)) {
				globObj.enabled = raw["find.enabled"];
			}
			delete raw["find.enabled"];
		}
		if ("search.enabled" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("enabled" in grepObj)) {
				grepObj.enabled = raw["search.enabled"];
			}
			delete raw["search.enabled"];
		}
		if ("search.contextBefore" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextBefore" in grepObj)) {
				grepObj.contextBefore = raw["search.contextBefore"];
			}
			delete raw["search.contextBefore"];
		}
		if ("search.contextAfter" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextAfter" in grepObj)) {
				grepObj.contextAfter = raw["search.contextAfter"];
			}
			delete raw["search.contextAfter"];
		}

		// Also clean up any empty nested objects we might have created or left behind
		if (raw.glob && typeof raw.glob === "object" && Object.keys(raw.glob).length === 0) {
			delete raw.glob;
		}
		if (raw.grep && typeof raw.grep === "object" && Object.keys(raw.grep).length === 0) {
			delete raw.grep;
		}
		// readHashLines: removed. Hashline anchors are now driven solely by
		// edit.mode === "hashline"; the separate read toggle only ever produced
		// the incoherent "hashline edits without addressable anchors" state.
		delete raw.readHashLines;

		// serviceTier (single enum with scoped openai-only/claude-only sentinels)
		// → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
		// → tier.subagent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
		// dropped — per-family scoping is now expressed by the three tier settings.
		const tierObj = isRecord(raw.tier) ? raw.tier : {};
		let tierTouched = false;
		const setTier = (family: string, value: unknown): void => {
			if (value !== undefined && !(family in tierObj)) {
				tierObj[family] = value;
				tierTouched = true;
			}
		};
		if (typeof raw.serviceTier === "string") {
			switch (raw.serviceTier) {
				case "priority":
					setTier("openai", "priority");
					setTier("anthropic", "priority");
					setTier("google", "priority");
					break;
				case "openai-only":
					setTier("openai", "priority");
					break;
				case "claude-only":
					setTier("anthropic", "priority");
					break;
				case "auto":
				case "default":
				case "flex":
				case "scale":
					setTier("openai", raw.serviceTier);
					break;
			}
			delete raw.serviceTier;
		}
		const mapInheritTier = (value: unknown): unknown =>
			value === "openai-only" || value === "claude-only" ? "priority" : value;
		if ("serviceTierSubagent" in raw) {
			setTier("subagent", mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;

		// advisor.subagents (blanket advisor on every spawned subagent) → per-agent
		// task.agentAdvisor, migrated to the bundled generic `task` agent. An
		// explicit boolean maps to "on"/"off" IN THE SAME LAYER — migration runs
		// per file, so a project-level `false` must keep overriding a global
		// `true` after both layers migrate.
		{
			const advisorObj = isRecord(raw.advisor) ? raw.advisor : undefined;
			const legacySubagents =
				advisorObj && "subagents" in advisorObj ? advisorObj.subagents : raw["advisor.subagents"];
			if (typeof legacySubagents === "boolean") {
				const taskObj = isRecord(raw.task) ? raw.task : {};
				const agentAdvisor = isRecord(taskObj.agentAdvisor) ? taskObj.agentAdvisor : {};
				if (!("task" in agentAdvisor)) agentAdvisor.task = legacySubagents ? "on" : "off";
				taskObj.agentAdvisor = agentAdvisor;
				raw.task = taskObj;
			}
			if (advisorObj) delete advisorObj.subagents;
			delete raw["advisor.subagents"];
		}

		// Early per-agent toggles were persisted as booleans even though the
		// runtime record contract is "on"/"off"/model pattern. Normalize each
		// layer before merging so project-level false still overrides global true.
		{
			const taskObj = isRecord(raw.task) ? raw.task : undefined;
			if (taskObj) {
				for (const key of ["agentPrewalk", "agentAdvisor"]) {
					const overrides = isRecord(taskObj[key]) ? taskObj[key] : undefined;
					if (!overrides) continue;
					for (const agentName in overrides) {
						const value = overrides[agentName];
						if (typeof value === "boolean") overrides[agentName] = value ? "on" : "off";
					}
				}
			}
		}

		// v17 renames that used to nest under a boolean parent path:
		//   dev.autoqa.consent -> dev.autoqaConsent
		//   todo.reminders.max -> todo.remindersMax
		migrateNestedLeafRename(
			raw,
			"dev",
			"autoqa",
			"consent",
			"autoqaConsent",
			value => value === "unset" || value === "granted" || value === "denied",
		);
		migrateNestedLeafRename(
			raw,
			"todo",
			"reminders",
			"max",
			"remindersMax",
			value => typeof value === "number" && Number.isFinite(value),
		);

		// BM25 tool discovery removal: tools.discoveryMode / tools.essentialOverride /
		// mcp.discoveryMode / mcp.discoveryDefaultServers are gone with no
		// replacement (`tools.xdev` stays at its own default). Dead keys are
		// deleted so they stop lingering in config.yml.
		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj) {
			delete toolsObj.discoveryMode;
			delete toolsObj.essentialOverride;
		}
		delete raw["tools.discoveryMode"];
		delete raw["tools.essentialOverride"];
		const mcpObj = raw.mcp as Record<string, unknown> | undefined;
		if (mcpObj) {
			delete mcpObj.discoveryMode;
			delete mcpObj.discoveryDefaultServers;
		}
		delete raw["mcp.discoveryMode"];
		delete raw["mcp.discoveryDefaultServers"];

		// providers.webSearch / providers.image (single preferred provider) →
		// providers.webSearchOrder / providers.imageOrder (priority lists). A
		// concrete legacy choice becomes the head of the new list with every
		// remaining provider appended in its built-in order, so the old
		// preference stays #1 and the fallback chain is written out explicitly.
		// "auto" (or an unknown id) just drops the key — the default chain.
		const providerPrefsObj = raw.providers as Record<string, unknown> | undefined;
		const migrateProviderPreference = (
			legacyKey: string,
			orderKey: string,
			expand: (value: string) => string[] | undefined,
		): void => {
			const flatLegacyKey = `providers.${legacyKey}`;
			const legacy = providerPrefsObj?.[legacyKey] ?? raw[flatLegacyKey];
			if (legacy === undefined) return;
			const existingOrder = providerPrefsObj?.[orderKey] ?? raw[`providers.${orderKey}`];
			const orderAlreadySet = Array.isArray(existingOrder) && existingOrder.length > 0;
			if (!orderAlreadySet && typeof legacy === "string") {
				const expanded = expand(legacy);
				if (expanded) {
					const root = providerPrefsObj ?? {};
					root[orderKey] = expanded;
					raw.providers = root;
				}
			}
			if (providerPrefsObj) delete providerPrefsObj[legacyKey];
			delete raw[flatLegacyKey];
		};
		migrateProviderPreference("webSearch", "webSearchOrder", value =>
			value !== "auto" && isSearchProviderId(value)
				? [value, ...SEARCH_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);
		migrateProviderPreference("image", "imageOrder", value =>
			value !== "auto" && isImageProviderId(value)
				? [value, ...AUTO_IMAGE_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);

		// Consolidate the retired Exa suite toggles onto the sole remaining
		// provider switch. The old runtime required both `enabled` and
		// `enableSearch`, so preserve that AND semantics when both are present.
		// Researcher and Websets were removed with the standalone Exa tools.
		const exaObj = isRecord(raw.exa) ? raw.exa : undefined;
		const exaEnabledValues = [
			exaObj?.enabled,
			raw["exa.enabled"],
			exaObj?.enableSearch,
			raw["exa.enableSearch"],
		].filter((value): value is boolean => typeof value === "boolean");
		const hasFlatExaSetting =
			"exa.enabled" in raw ||
			"exa.enableSearch" in raw ||
			"exa.enableResearcher" in raw ||
			"exa.enableWebsets" in raw;
		if (exaObj || hasFlatExaSetting) {
			const exaRoot = exaObj ?? {};
			if (exaEnabledValues.length > 0) {
				exaRoot.enabled = exaEnabledValues.every(Boolean);
			}
			delete exaRoot.enableSearch;
			delete exaRoot.enableResearcher;
			delete exaRoot.enableWebsets;
			if (Object.keys(exaRoot).length > 0) {
				raw.exa = exaRoot;
			} else {
				delete raw.exa;
			}
			delete raw["exa.enabled"];
			delete raw["exa.enableSearch"];
			delete raw["exa.enableResearcher"];
			delete raw["exa.enableWebsets"];
		}

		// computer.backend and model-specific controller routing were removed
		// when the computer tool moved to one native desktop implementation.
		const computerObj = isRecord(raw.computer) ? raw.computer : undefined;
		if (computerObj && "backend" in computerObj) {
			delete computerObj.backend;
			if (Object.keys(computerObj).length === 0) {
				delete raw.computer;
			}
		}
		delete raw["computer.backend"];

		return raw;
	}

	/**
	 * One-time migration: seed the last-changelog-version marker file from the
	 * legacy config.yml key. An existing marker always wins — it is the newer
	 * source of truth.
	 */
	async #seedLastChangelogVersionMarker(): Promise<void> {
		const legacy = this.#legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(this.#agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	async #writeYamlAtomically(filePath: string, settings: RawSettings): Promise<void> {
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		let removeTemp = false;
		try {
			const handle = await fs.promises.open(tempPath, "wx", 0o600);
			removeTemp = true;
			try {
				await handle.writeFile(stringifyYamlConfig(settings), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await replaceFileAtomically(tempPath, filePath);
			removeTemp = false;
		} finally {
			if (removeTemp) {
				await fs.promises.rm(tempPath, { force: true }).catch(() => {});
			}
		}
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		// Debounce: wait 100ms for more changes
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			const previousSave = this.#savePromise;
			const savePromise = previousSave ? previousSave.then(() => this.#saveNow()) : this.#saveNow();
			this.#savePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#savePromise === savePromise) {
						this.#savePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || !this.#configPath) return;
		if (this.#modified.size === 0 && this.#modifiedGlobalModelRoles.size === 0) return;

		const configPath = this.#configPath;
		const modifiedPaths = [...this.#modified];
		const modifiedModelRoles = [...this.#modifiedGlobalModelRoles];
		const modifiedPathMutations = new Map(this.#modifiedPathMutations);
		const modifiedModelRoleMutations = new Map(this.#modifiedGlobalModelRoleMutations);
		const globalRolesAtStart = this.#modelRolesFromLayer(this.#global);
		const previousSignaledValues = {
			modelRoles: this.get("modelRoles"),
			sessionAccent: this.get("statusLine.sessionAccent"),
		};
		const previousCodeModeValues = this.#codeModeSignalSnapshot();
		const previousHookValues = new Map<SettingPath, unknown>();
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			previousHookValues.set(key, this.get(key));
		}
		this.#modified.clear();
		this.#modifiedGlobalModelRoles.clear();
		this.#modifiedPathMutations.clear();
		this.#modifiedGlobalModelRoleMutations.clear();

		try {
			await this.#withYamlWriteLock(configPath, async writePath => {
				// Re-read to preserve external changes. If this instance moved a
				// malformed file aside, recover from its last in-memory state
				// rather than recreating the config from only the pending path.
				const loaded = await this.#loadYamlIfPresentForWriteLocked(configPath, writePath);
				const current =
					loaded.settings ?? (this.#quarantinedYamlTargets.has(configPath) ? structuredClone(this.#global) : {});
				let shouldWrite = false;

				// Apply pending changes unless a newer file generation also
				// changed that setting. Disjoint external edits still merge.
				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const mutation = modifiedPathMutations.get(modPath);
					const canApply =
						mutation !== undefined &&
						mutation.generation.kind !== "unreadable" &&
						(yamlGenerationsMatch(mutation.generation, loaded.generation) ||
							Bun.deepEquals(getByPath(current, segments), mutation.baseValue));
					if (!canApply) {
						logger.warn("Settings: skipped stale change after external config edit", {
							path: configPath,
							setting: modPath,
						});
						continue;
					}
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
					shouldWrite = true;
				}

				// Merge only the model roles captured by this save. Then retain
				// any role changed while the async read/lock was pending before
				// replacing #global, so the follow-up save still sees its value.
				const latestGlobalRoles = this.#modelRolesFromLayer(this.#global);
				const rolesToPreserve = new Set(this.#modifiedGlobalModelRoles);
				for (const role in globalRolesAtStart) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				for (const role in latestGlobalRoles) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				const currentRoles = getByPath(current, ["modelRoles"]);
				const currentRoleValues: Record<string, unknown> = isRecord(currentRoles) ? currentRoles : {};
				const rolesToApply = modifiedModelRoles.filter(role => {
					const mutation = modifiedModelRoleMutations.get(role);
					const canApply =
						mutation !== undefined &&
						mutation.generation.kind !== "unreadable" &&
						(yamlGenerationsMatch(mutation.generation, loaded.generation) ||
							Bun.deepEquals(currentRoleValues[role], mutation.baseValue));
					if (canApply) return true;
					logger.warn("Settings: skipped stale change after external config edit", {
						path: configPath,
						setting: `modelRoles.${role}`,
					});
					return false;
				});
				if (rolesToApply.length > 0 || rolesToPreserve.size > 0) {
					const mergedRoles: Record<string, unknown> = { ...currentRoleValues };
					for (const role of rolesToApply) {
						if (Object.hasOwn(globalRolesAtStart, role)) {
							mergedRoles[role] = globalRolesAtStart[role];
						} else {
							delete mergedRoles[role];
						}
					}
					for (const role of rolesToPreserve) {
						if (Object.hasOwn(latestGlobalRoles, role)) {
							mergedRoles[role] = latestGlobalRoles[role];
						} else {
							delete mergedRoles[role];
						}
					}
					setByPath(current, ["modelRoles"], mergedRoles);
					shouldWrite = true;
				}

				// Update our global with any external changes we preserved.
				this.#global = current;
				if (shouldWrite) {
					await this.#writeYamlAtomically(writePath, this.#global);
				}
				this.#quarantinedYamlTargets.delete(configPath);
				// These pending roles were included in this write. Remove each
				// only if no newer local change arrived while the write was in flight.
				const globalRolesAfterWrite = this.#modelRolesFromLayer(this.#global);
				for (const role of rolesToPreserve) {
					if (latestGlobalRoles[role] === globalRolesAfterWrite[role]) {
						this.#modifiedGlobalModelRoles.delete(role);
						this.#modifiedGlobalModelRoleMutations.delete(role);
					}
				}
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			// A quarantined file is now missing by our own action, not because
			// another writer superseded the mutation. Retry against that state.
			const retryGeneration = this.#quarantinedYamlTargets.has(configPath)
				? this.#readYamlGeneration(configPath)
				: undefined;
			// Re-add failed paths for retry, retaining any newer mutation's generation.
			for (const p of modifiedPaths) {
				this.#modified.add(p);
				if (!this.#modifiedPathMutations.has(p)) {
					const mutation = modifiedPathMutations.get(p) ?? {
						generation: { kind: "unreadable" },
						baseValue: undefined,
					};
					this.#modifiedPathMutations.set(
						p,
						retryGeneration ? { ...mutation, generation: retryGeneration } : mutation,
					);
				}
			}
			for (const role of modifiedModelRoles) {
				this.#modifiedGlobalModelRoles.add(role);
				if (!this.#modifiedGlobalModelRoleMutations.has(role)) {
					const mutation = modifiedModelRoleMutations.get(role) ?? {
						generation: { kind: "unreadable" },
						baseValue: undefined,
					};
					this.#modifiedGlobalModelRoleMutations.set(
						role,
						retryGeneration ? { ...mutation, generation: retryGeneration } : mutation,
					);
				}
			}
			this.#rebuildMerged();
			throw error;
		}

		this.#rebuildMerged();
		const nextModelRoles = this.get("modelRoles");
		if (!Bun.deepEquals(nextModelRoles, previousSignaledValues.modelRoles)) {
			this.#fireEffectiveSettingChanged("modelRoles", nextModelRoles, previousSignaledValues.modelRoles);
		}
		const nextSessionAccent = this.get("statusLine.sessionAccent");
		if (!Bun.deepEquals(nextSessionAccent, previousSignaledValues.sessionAccent)) {
			this.#fireEffectiveSettingChanged(
				"statusLine.sessionAccent",
				nextSessionAccent,
				previousSignaledValues.sessionAccent,
			);
		}
		this.#fireCodeModeChangeIfNeeded(previousCodeModeValues);
		for (const [key, previous] of previousHookValues) {
			const next = this.get(key);
			if (!Bun.deepEquals(next, previous)) {
				SETTING_HOOKS[key]?.(next, previous);
			}
		}
	}
	#queueProjectSave(): void {
		if (!this.#persist) return;

		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = setTimeout(() => {
			this.#projectSaveTimer = undefined;
			const savePromise = this.#saveProjectNow();
			this.#projectSavePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background project save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#projectSavePromise === savePromise) {
						this.#projectSavePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveProjectNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || this.#modifiedProjectModelRoles.size === 0) return;

		const projectConfigPath = path.join(this.#cwd, ".omp", "config.yml");
		const modifiedModelRoles = [...this.#modifiedProjectModelRoles];
		this.#modifiedProjectModelRoles.clear();

		try {
			await fs.promises.mkdir(path.dirname(projectConfigPath), { recursive: true });
			await this.#withYamlWriteLock(projectConfigPath, async writePath => {
				const loaded = await this.#loadYamlIfPresentForWriteLocked(projectConfigPath, writePath);
				const projectSettings =
					loaded.settings ??
					(this.#quarantinedYamlTargets.has(projectConfigPath) ? structuredClone(this.#projectFileSettings) : {});

				const projectRoles = getByPath(this.#project, ["modelRoles"]);
				for (const role of modifiedModelRoles) {
					const value = isRecord(projectRoles) ? projectRoles[role] : undefined;
					setByPath(projectSettings, ["modelRoles", role], value);
				}

				await this.#writeYamlAtomically(writePath, projectSettings);
				this.#projectFileSettings = structuredClone(projectSettings);
				this.#quarantinedYamlTargets.delete(projectConfigPath);
			});
			invalidateCapabilityFsCache(projectConfigPath);
		} catch (error) {
			for (const role of modifiedModelRoles) {
				this.#modifiedProjectModelRoles.add(role);
			}
			throw error;
		}

		this.#rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#projectSettingsForMerge(): RawSettings {
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		if (!isRecord(projectRoles)) return this.#project;

		let filteredRoles: Record<string, unknown> | undefined;
		for (const role in projectRoles) {
			if (!Object.hasOwn(projectRoles, role) || modelRoleValueFromUnknown(projectRoles[role]) !== undefined)
				continue;
			filteredRoles ??= { ...projectRoles };
			delete filteredRoles[role];
		}
		return filteredRoles ? { ...this.#project, modelRoles: filteredRoles } : this.#project;
	}

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#projectSettingsForMerge());
		this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
		this.#editVariantCache = undefined;
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

/**
 * Minimal change-notification primitive backing the exported `on*Changed`
 * subscriptions. Holds a listener set, hands out unsubscribe closures, and
 * isolates errors so a single throwing listener can't abort the rest or bubble
 * out of `Settings.set()`.
 *
 * @typeParam A - argument tuple forwarded to each listener on `fire`.
 */
class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {}

	/** Subscribe `cb`; returns an unsubscribe function. */
	on(cb: (...args: A) => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	/**
	 * Invoke every listener with `args`. Iterates a snapshot so a listener may
	 * (un)subscribe mid-fire without re-entrancy — the Hindsight backend
	 * re-registers the fresh state's listener on every rebuild — and wraps each
	 * call so a throwing listener is logged and skipped instead of aborting the
	 * rest.
	 */
	fire(...args: A): void {
		for (const cb of [...this.#listeners]) {
			try {
				cb(...args);
			} catch (err) {
				logger.warn(`Settings: ${this.label} hook failed`, { error: String(err) });
			}
		}
	}
}

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value).catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
			});
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			appendOnlyModeSignal.fire(value);
		}
	},
	"providers.maxInFlightRequests": value => {
		configureProviderMaxInFlightRequests(validateProviderMaxInFlightRequests(value));
	},
	"secrets.enabled": value => {
		configureCredentialRedaction(value === true);
	},
	"hindsight.bankId": () => hindsightScopeSignal.fire(),
	"hindsight.bankIdPrefix": () => hindsightScopeSignal.fire(),
	"hindsight.scoping": () => hindsightScopeSignal.fire(),
	extendedContext: () => extendedContextSignal.fire(),
	"worktree.base": value => {
		const dir = typeof value === "string" && value.trim() ? value : undefined;
		// Always call so an unset/empty value clears a previously-applied override.
		// setWorktreesDir expands `~`, rejects relative paths, and returns the
		// applied absolute path (or undefined when cleared/rejected).
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
/** Fires when `provider.appendOnlyContext` changes at runtime. */
const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

/**
 * Subscribe to append-only mode setting changes.
 * Returns an unsubscribe function. Multiple sessions (main + subagents)
 * can register independently without overwriting each other.
 */
export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

/** Fires when any model role changes at runtime. */
const modelRolesSignal = new SettingSignal("modelRoles");

/** Subscribe to model role changes. Returns an unsubscribe function. */
export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

/** Fires when Code Mode activation or its direct keep-set changes at runtime. */
const codeModeSignal = new SettingSignal("providers.openai-codex.codeMode");

/**
 * Settings whose effective value changes the Code Mode tool partition. `edit.mode`
 * belongs here because it renames `EditTool` on the wire (`apply_patch` vs `edit`),
 * which the namespace metadata is keyed by.
 */
const CODE_MODE_SIGNAL_PATHS: readonly SettingPath[] = [
	"providers.openai-codex.codeMode",
	"providers.openai-codex.codeModeDirectTools",
	"eval.js",
	"edit.mode",
];

/** Subscribe to Code Mode setting changes. Returns an unsubscribe function. */
export const onCodeModeChanged = (cb: () => void) => codeModeSignal.on(cb);

/** Fires when `extendedContext` changes at runtime. */
const extendedContextSignal = new SettingSignal("extendedContext");

/**
 * Subscribe to extended-context setting changes. Sessions re-derive their
 * model's effective context window (the registry clamps premium long-context
 * models to the standard-pricing threshold while the setting is off).
 * Returns an unsubscribe function.
 */
export const onExtendedContextChanged = (cb: () => void) => extendedContextSignal.on(cb);

/** Fires when `statusLine.sessionAccent` changes at runtime. */
const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

/**
 * Subscribe to session-accent setting changes.
 * Returns an unsubscribe function. Callers should re-read settings in the callback.
 */
export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

/** Fires when any `hindsight.bankId` / `bankIdPrefix` / `scoping` value changes. */
const hindsightScopeSignal = new SettingSignal("hindsight scope");

/**
 * Subscribe to changes in the Hindsight bank-scoping settings. Lets the
 * Hindsight backend rebuild the active `HindsightSessionState` when the
 * operator switches `hindsight.bankId`, `hindsight.bankIdPrefix`, or
 * `hindsight.scoping` mid-session so subsequent retain/recall calls land in
 * the new bank instead of the one selected at session start.
 *
 * Returns an unsubscribe function. The callback receives no arguments — the
 * caller is expected to re-read the relevant settings via `Settings.get`.
 */
export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Weak registry of every constructed instance so `resetSettingsForTest` can
 * disarm stray background saves on isolated instances too. WeakRefs never
 * retain instances; the set is cleared on every test reset.
 */
const liveSettingsInstances = new Set<WeakRef<Settings>>();

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function resetSettingsForTest(): void {
	// Disarm every constructed instance's debounced saves — including isolated
	// (non-singleton) instances: an armed timer or chained in-flight save on a
	// dropped instance fires mid-way through the NEXT test and races its file
	// locks/spies (cross-file pollution).
	for (const ref of liveSettingsInstances) {
		ref.deref()?.cancelPendingSaves();
	}
	liveSettingsInstances.clear();
	globalInstance = null;
	globalInstancePromise = null;
	clearBoundSettingsMethods();
	configureProviderMaxInFlightRequests(undefined);
	configureCredentialRedaction(false);
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		if (boundSettingsInstance !== globalInstance) {
			clearBoundSettingsMethods();
			boundSettingsInstance = globalInstance;
		}
		const value = (globalInstance as unknown as Record<PropertyKey, unknown>)[prop];
		if (typeof value === "function") {
			const cached = boundSettingsMethods.get(prop);
			if (cached) return cached;
			const bound = value.bind(globalInstance);
			boundSettingsMethods.set(prop, bound);
			return bound;
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
