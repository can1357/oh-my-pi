/**
 * Layered settings store (global config, project, `--config` overlay, runtime overrides) with
 * background persistence. Values are typed and read through registry handles
 * (see `./registry`), declared next to their domain and collected by `./all-settings`:
 *
 *   cfgCompactionEnabled.get(settings);         // sync read
 *   cfgThemeDark.set(settings, "titanium");     // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type Api, type Model, modelKind } from "@oh-my-pi/pi-catalog/types";
import {
	expandTilde,
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	getProjectAgentDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
	procmgr,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { isLightTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { JSONC, YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { AgentStorage, type AgentStorageApi } from "../session/agent-storage";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-methods";
import { writeFileAtomically } from "../utils/atomic-file";
import { isRegisteredSearchEngine } from "../web/search/provider";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import {
	type AnySetting,
	all as allSettings,
	bindEffects,
	inheritWarnings,
	lookup as lookupSetting,
	resetRegistryForTest,
	settingValuesEqual,
	type ValueCacheEntry,
	type WarnState,
} from "./registry";
// Registers every setting before any instance is read (definitions live next to their domains).
import "./all-settings";
import { cfgDisabledProviders, cfgModelRoles, cfgModelRoleStorage } from "./model-settings";
import { cfgShellPath } from "../exec/settings";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Settings layer that supplies an effective value; see {@link Settings.getProvenance}. */
export type SettingProvenance = "env" | "runtime" | "overlay" | "project" | "global" | "default";

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
	/** Discovered project files to invalidate and watch, including filtered or temporarily missing sources. */
	sourcePaths: string[];
	/** Project warnings surfaced for this read; commit with the layer as `#projectSettingsWarningsSeen`. */
	warningsSeen: Set<string>;
};

/** A project-layer read before `disabledProviders` filtering; `#resolveProjectRead` merges it. */
type ProjectSettingsDiscovery = {
	cwd: string;
	quarantineInvalid: boolean;
	/** Project-level settings items in discovery order, disabled providers' items included. */
	items: SettingsCapabilityItem[];
	nativeModelRoles: unknown;
	fileSettings: RawSettings;
	warningsSeen: Set<string>;
};

/** `strict` rejects on any unreadable layer; `keep-last-good` keeps each failed layer's previous value. */
type PersistedReloadMode = "strict" | "keep-last-good";

/** Layer refreshes serialized by `Settings.#exclusive`: disk reloads and cwd re-scopes. */
type LayerRefreshKind = PersistedReloadMode | "rescope";

/** Quiet period after the last config-file event before the watcher reloads from disk. */
const CONFIG_WATCH_DEBOUNCE_MS = 200;

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
	/** Initial runtime overrides, keyed by setting id (legacy ids migrate; values are checked like `override`). */
	overrides?: Readonly<Record<string, unknown>>;
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

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed, replacing whatever non-record (a malformed `[]` included) is in the way.
 */
function setByPath(obj: RawSettings, segments: readonly string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!isRecord(current[segment])) current[segment] = {};
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/**
 * Assign `obj[key]` as an own property. Plain assignment of a parsed
 * `__proto__` key (an agent name, say) would replace the prototype instead,
 * silently dropping that entry.
 */
function setOwn(obj: RawSettings, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		obj[key] = value;
	}
}

/**
 * Removes the value at `segments`, pruning the parent objects the removal leaves empty. Every record on the
 * path below `obj` is replaced by a copy rather than edited: a merged view or a cached read may share it.
 */
function deleteByPath(obj: RawSettings, segments: readonly string[]): void {
	const containers: RawSettings[] = [obj];
	for (let i = 0; i < segments.length - 1; i++) {
		const next = containers[i][segments[i]];
		if (!isRecord(next)) return;
		containers.push(next);
	}
	if (!Object.hasOwn(containers[containers.length - 1], segments[containers.length - 1])) return;
	let replacement: RawSettings | undefined;
	for (let i = containers.length - 1; i >= 0; i--) {
		const container = i === 0 ? obj : { ...containers[i] };
		if (replacement) container[segments[i]] = replacement;
		else delete container[segments[i]];
		replacement = Object.keys(container).length > 0 ? container : undefined;
	}
}

/** Whether `prefix` is `segments` or the path of one of its ancestors. */
function isPathPrefix(prefix: readonly string[], segments: readonly string[]): boolean {
	return prefix.length <= segments.length && prefix.every((segment, i) => segment === segments[i]);
}

/**
 * Whether the pending global change at `segments`, captured as `mutation`, still applies to the config file read
 * as `current` at `generation`: the file is the generation the change was captured at, or holds the captured
 * value there apart from the subtrees at `written`, the paths the saving process writes itself. Those vouch for
 * their own subtrees: a whole record's captured value may hold a pending write of one of its entries, and an entry
 * of a record written whole was written at its latest value.
 */
function pendingChangeApplies(
	mutation: PendingYamlMutation | undefined,
	segments: readonly string[],
	current: RawSettings,
	generation: YamlGeneration,
	written: readonly (readonly string[])[],
): boolean {
	if (mutation === undefined || mutation.generation.kind === "unreadable") return false;
	if (yamlGenerationsMatch(mutation.generation, generation)) return true;
	const onDisk: RawSettings = { value: getByPath(current, segments) };
	const captured: RawSettings = { value: mutation.baseValue };
	for (const writtenPath of written) {
		if (isPathPrefix(writtenPath, segments)) return true;
		if (!isPathPrefix(segments, writtenPath)) continue;
		const inner = ["value", ...writtenPath.slice(segments.length)];
		deleteByPath(onDisk, inner);
		deleteByPath(captured, inner);
	}
	return Bun.deepEquals(onDisk.value, captured.value);
}

/**
 * @throws Error when a leaf of `layer` sits at a path that names no registered setting (typo guard
 * for constructor overrides).
 */
function assertKnownSettingPaths(layer: RawSettings, prefix = ""): void {
	for (const key in layer) {
		const id = prefix ? `${prefix}.${key}` : key;
		if (lookupSetting(id)) continue;
		const value = layer[key];
		if (!isRecord(value)) throw new Error(`Unknown setting "${id}"`);
		assertKnownSettingPaths(value, id);
	}
}

/** `project` as it merges over the global layer: `null` (cleared) model roles fall back to global. */
function projectLayerForMerge(project: RawSettings): RawSettings {
	const projectRoles = getByPath(project, ["modelRoles"]);
	if (!isRecord(projectRoles)) return project;

	let filteredRoles: Record<string, unknown> | undefined;
	for (const role in projectRoles) {
		if (!Object.hasOwn(projectRoles, role) || modelRoleValueFromUnknown(projectRoles[role]) !== undefined) continue;
		filteredRoles ??= { ...projectRoles };
		delete filteredRoles[role];
	}
	return filteredRoles ? { ...project, modelRoles: filteredRoles } : project;
}

/** One instance's own layers, lowest precedence first. */
interface OwnLayers {
	global: RawSettings;
	project: RawSettings;
	configOverlay: RawSettings;
	overrides: RawSettings;
}

/** The layers an {@link Settings.overlay} child writes locally; see {@link Settings.overlayLayers}. */
export type OverlayLayers = Readonly<Pick<OwnLayers, "global" | "overrides"> & { derived: boolean }>;

/**
 * Copy of one instance's own layers and scope, from which a worker-thread {@link Settings.mirror}
 * is built and kept current ({@link Settings.mirrorState}, {@link Settings.applyMirrorState}).
 */
export interface SettingsMirrorState {
	/** Bumped on every own-layer change of the source; a mirror ignores states not newer than its last. */
	readonly generation: number;
	readonly cwd: string;
	readonly agentDir: string;
	readonly configFiles: readonly string[];
	readonly global: RawSettings;
	readonly project: RawSettings;
	readonly configOverlay: RawSettings;
	readonly overrides: RawSettings;
	readonly derived: boolean;
	readonly projectShellPathSource: string | undefined;
	readonly overlayShellPathSource: string | undefined;
}

/** A write made on a worker mirror, replayed on its main-thread instance; settings travel by id. */
export type SettingsMirrorWrite =
	| { readonly op: "writeValue"; readonly id: string; readonly value: unknown; readonly layer: "global" | "override" }
	| { readonly op: "unsetGlobalValue"; readonly id: string }
	| { readonly op: "writeEntry"; readonly id: string; readonly key: string; readonly value: unknown }
	| { readonly op: "writeMember"; readonly id: string; readonly item: string; readonly member: boolean }
	| { readonly op: "pinDefaultValue"; readonly id: string }
	| { readonly op: "clearOverrideValue"; readonly id: string }
	| { readonly op: "setModelRole"; readonly role: string; readonly modelId: string | undefined }
	| { readonly op: "setProjectModelRole"; readonly role: string; readonly modelId: string }
	| { readonly op: "clearProjectModelRole"; readonly role: string }
	| { readonly op: "overrideModelRoles"; readonly roles: ReadOnlyDict<string> };

/** A disk or scope operation a worker mirror runs on its main-thread instance. */
export type SettingsMirrorRefresh =
	| { readonly op: "flush" }
	| { readonly op: "reloadFromDisk"; readonly includeParents: boolean }
	| { readonly op: "reloadForCwd"; readonly cwd: string };

/**
 * The main-thread instance behind a worker {@link Settings.mirror}. Mirrors never write locally:
 * every write and disk operation goes through here (the main instance is the single writer) and
 * the mirror adopts the state it returns.
 */
export interface SettingsMirrorSource {
	/** Applies `write` on the main instance (the worker blocks until it is done); returns its state afterwards. */
	write(write: SettingsMirrorWrite): SettingsMirrorState;
	/** Runs `refresh` on the main instance; resolves with its state afterwards. */
	refresh(refresh: SettingsMirrorRefresh): Promise<SettingsMirrorState>;
	/** The main instance's {@link Settings.cloneForCwd}, received as a mirror. */
	cloneForCwd(cwd: string): Promise<Settings>;
	/** The main instance's {@link Settings.getStorage}, as a remote handle; absent keeps the parent's (or none). */
	readonly storage?: AgentStorageApi | null;
}

/** A persisted layer re-read from disk: its new value, the file(s) it came from, and the read-side state it commits. */
interface LayerRefresh {
	layer: "global" | "project" | "configOverlay";
	settings: RawSettings;
	source: string;
	commit(): void;
}

/**
 * Dotted-path prefixes that name settings groups (e.g. "tui" for "tui.*").
 * A prefix may simultaneously be a schema leaf; those accept their declared
 * value shape and are excluded from shadow detection.
 */
let groupOnlyPrefixes: Readonly<Record<string, true>> | undefined;

function settingsGroupOnlyPrefixes(): Readonly<Record<string, true>> {
	if (groupOnlyPrefixes) return groupOnlyPrefixes;
	const prefixes: Record<string, true> = {};
	for (const { id } of allSettings()) {
		for (let dot = id.indexOf("."); dot !== -1; dot = id.indexOf(".", dot + 1)) {
			prefixes[id.slice(0, dot)] = true;
		}
	}
	for (const { id } of allSettings()) delete prefixes[id];
	groupOnlyPrefixes = prefixes;
	return prefixes;
}

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
		if (!Object.hasOwn(settingsGroupOnlyPrefixes(), path)) {
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

/** Receives the setting whose effective value changed (see {@link Settings.onEffectiveChange}). */
type SettingChangeListener = (setting: AnySetting) => void;

/** Calls each listener with `setting`; a throwing listener is logged and never blocks the rest. */
function runChangeListeners(listeners: ReadonlySet<SettingChangeListener>, setting: AnySetting): void {
	// Snapshot: a listener may unsubscribe itself or others mid-dispatch.
	for (const listener of Array.from(listeners)) {
		try {
			listener(setting);
		} catch (error) {
			logger.warn("Settings: effective-change listener failed", { path: setting.id, error: String(error) });
		}
	}
}

/** Path prefixes a path-scoped array entry names under `path`, `paths`, `pathPrefix`, `pathPrefixes`. */
function pathScopePrefixes(entry: Record<string, unknown>): string[] {
	return [
		...stringArrayFromUnknown(entry.path),
		...stringArrayFromUnknown(entry.paths),
		...stringArrayFromUnknown(entry.pathPrefix),
		...stringArrayFromUnknown(entry.pathPrefixes),
	];
}

/**
 * Default entries an object-item path-scoped `list` keeps: a non-empty list of only scoped entries
 * adds to the setting's default (the built-in interceptor rules) rather than replacing it, so this
 * returns that default; any unscoped entry makes the list replace it, so this returns `[]`.
 * Read by {@link resolvePathScopedArray} and by layered merges, which must keep that meaning once a
 * higher layer prepends unscoped entries onto a scoped-only lower list.
 */
function scopedListDefault(setting: AnySetting, list: readonly unknown[]): readonly unknown[] {
	const { definition } = setting;
	if (definition.type !== "array" || definition.pathScoped?.itemType !== "object" || list.length === 0) return [];
	return list.some(entry => isRecord(entry) && pathScopePrefixes(entry).length === 0) ? [] : definition.default;
}

/**
 * Appends the object `entries` that apply at `cwd` to `resolved`.
 * An entry naming no path prefix (none of the scope keys, or only unusable values such as YAML's
 * `path: ~` = null) is unscoped and passes through unchanged. A scoped entry whose prefix covers `cwd`
 * contributes its remaining fields as an inline rule, then its nested `values`/`items`/`valuesKey`
 * entries resolved the same way, so no rule it carries is dropped inside its scope.
 */
function resolvePathScopedObjects(
	entries: readonly unknown[],
	valuesKey: string,
	cwd: string,
	resolved: unknown[],
): void {
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const prefixes = pathScopePrefixes(entry);
		if (prefixes.length === 0) {
			resolved.push(entry);
			continue;
		}
		if (!prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const {
			path: _path,
			paths: _paths,
			pathPrefix: _prefix,
			pathPrefixes: _prefixes,
			values,
			items,
			[valuesKey]: nested,
			...inlineRule
		} = entry;
		if (Object.keys(inlineRule).length > 0) resolved.push(inlineRule);
		for (const list of [values, items, nested]) {
			if (Array.isArray(list)) resolvePathScopedObjects(list, valuesKey, cwd, resolved);
		}
	}
}

/** Value `setting` has in the `merged` layers, path-scoped entries resolved for `cwd`; `null` counts as unset. */
function configuredValue(merged: RawSettings, setting: AnySetting, cwd: string): unknown {
	const value = getByPath(merged, setting.segments);
	if (value === undefined || value === null) return undefined;
	return resolvePathScopedArray(setting, value, cwd) ?? value;
}

function resolvePathScopedArray(setting: AnySetting, value: unknown, cwd: string): unknown[] | undefined {
	const scope = setting.definition.pathScoped;
	if (!scope || !Array.isArray(value)) return undefined;

	const resolved: unknown[] = [];
	if (scope.itemType === "object") {
		resolvePathScopedObjects(value, scope.valuesKey, cwd, resolved);
		resolved.push(...scopedListDefault(setting, value));
		return resolved;
	}

	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!isRecord(entry)) continue;

		const prefixes = pathScopePrefixes(entry);
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		resolved.push(
			...stringArrayFromUnknown(entry.values),
			...stringArrayFromUnknown(entry.items),
			...stringArrayFromUnknown(entry[scope.valuesKey]),
		);
	}
	return resolved;
}

/**
 * Upper bound on symlink hops while resolving a dangling config chain by hand.
 * `realpath()` already rejects a fully-linked cycle with ELOOP; this caps the
 * manual walk so a chain that turns cyclic AFTER realpath reported ENOENT (a
 * concurrent retarget mid-walk) surfaces a bounded ELOOP instead of spinning
 * forever. Matches Linux's MAXSYMLINKS (40).
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Split a dangling symlink target into the physical path segments the flush
 * walk should follow. Three platform-correctness rules that a naive
 * `target.split(/[\\/]+/)` gets wrong:
 *
 *  1. Root double-count. An ABSOLUTE target seeds the accumulator at
 *     `parse(target).root` — `C:\` on Windows, the `\\server\share\` prefix of
 *     a UNC path, `/` on POSIX. The root must therefore be STRIPPED from the
 *     string before splitting; otherwise it is re-emitted as a leading segment
 *     and `C:\managed\final.yml` resolves to `C:\` + `C:` + `managed` + … =
 *     `C:\C:\managed\final.yml`, so the flush fails against a dangling absolute
 *     link on Windows. (POSIX escaped this by luck: the leading `/` splits to an
 *     empty leading segment that the walk already skips.) A RELATIVE target
 *     seeds at the link's real parent dir and keeps every segment unchanged.
 *  2. Separator set. `\` is a separator only on Windows. On POSIX it is a valid
 *     filename character, so a target literally named `managed\config.yml` must
 *     stay ONE segment, not two. Split on the platform separator set: `/` only
 *     on POSIX, `/` or `\` on Windows. Keyed off `pathApi.sep` so the rule is
 *     driven by the platform, not a hardcoded cross-platform class.
 *  3. Dot segments. POSIX follows each component physically, so `..` stays a
 *     raw segment and the walk pops the REAL parent of whatever `alias`
 *     resolved to. Windows collapses `.` and `..` inside a symlink target
 *     lexically before following any component: `alias\..\final.yml` names the
 *     link directory's `final.yml` even when `alias` is a directory link, and
 *     `missing\..\final.yml` never consults `missing`. Only a leading `..` of a
 *     relative target still pops the link's real parent, and a trailing
 *     separator survives to demand a directory. Walking raw `..` segments there
 *     writes a file the link never reads — possibly an unrelated one — so the
 *     Windows target is normalized first.
 *
 * `pathApi` is injectable so the platform-specific behavior is testable off the
 * host OS (drive with `path.win32` / `path.posix`); it defaults to the host.
 */
function physicalTargetSegments(target: string, pathApi: typeof path = path): string[] {
	const windows = pathApi.sep === "\\";
	const separator = windows ? /[\\/]+/ : /\/+/;
	const spelled = windows ? pathApi.normalize(target) : target;
	const body = pathApi.isAbsolute(spelled) ? spelled.slice(pathApi.parse(spelled).root.length) : spelled;
	return body.split(separator);
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorageApi | null = null;

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
	/** Project files to invalidate and watch, including filtered or temporarily missing sources. */
	#projectSourcePaths: string[] = [];
	/** Capability warnings already surfaced for the current project scope; reloads stay quiet. */
	#projectSettingsWarningsSeen = new Set<string>();
	/** Explicit config overlay that most recently supplied shellPath. */
	#overlayShellPathSource: string | undefined;
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Settings whose runtime override is a soft-pinned default ({@link pinDefaultValue}). */
	#softPins = new Set<AnySetting>();
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};
	/** Monotonic revision of merged layers and cwd-scoped resolution. */
	#revision = 0;
	/**
	 * Registry-owned memo of handle and derivation values for this instance, indexed by
	 * `Derived.slot` and validated against {@link revision}; see `config/registry.ts`.
	 */
	readonly valueCache: (ValueCacheEntry | undefined)[] = [];
	/** Registry-owned warn-once diagnostics of this instance; see `config/registry.ts`. */
	readonly warnState: WarnState = { invalid: new Map(), items: new Map() };
	/** Change listeners bucketed by the `slot` of the setting they observe ({@link onEffectiveChange}). */
	#changeListeners: (Set<SettingChangeListener> | undefined)[] = [];
	/** Forwarders of every change into live {@link overlay} children. */
	#childForwarders = new Set<SettingChangeListener>();
	/** Instance this overlay reads through to ({@link overlay}); overlays never persist or write back. */
	#parent: Settings | undefined;
	/** A subagent-derived view inherits its parent's grant authority; host-created overlays do not. */
	#derived = false;
	/** Parent {@link revision} `#merged` was last built from; any other parent revision re-merges. */
	#syncedParentRevision = -1;
	/** Project-free view returned by {@link grantAuthority}, valid while {@link revision} is unchanged. */
	#grantView: { revision: number; view: Settings } | undefined;

	/**
	 * Global-layer paths written during this session (for partial save), keyed by
	 * `JSON.stringify(segments)`: a record entry key may itself contain dots.
	 */
	#modified = new Map<string, readonly string[]>();
	/** Individual project model roles modified during this session */
	#modifiedProjectModelRoles = new Set<string>();
	/** Individual global model roles modified during this session (for partial save) */
	#modifiedGlobalModelRoles = new Set<string>();
	/** On-disk generations and prior values observed before each pending global mutation, keyed like {@link #modified}. */
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
	/** In-flight layer refresh; concurrent strict reloads share it, others queue behind it. */
	#activeReload?: { kind: LayerRefreshKind; promise: Promise<void> };
	/** Whether {@link startWatching} is active. */
	#watchingFiles = false;
	/** Directory watchers for config sources, keyed by directory, with the basenames that trigger a reload. */
	#fileWatchers = new Map<string, { watcher: fs.FSWatcher; names: Set<string> }>();
	/** Debounce timer for watcher-triggered reloads. */
	#watchReloadTimer?: NodeJS.Timeout;

	/** Whether to persist changes */
	#persist: boolean;
	/** Main-thread instance this worker mirror replicates; set only by {@link Settings.mirror}. */
	#mirror: SettingsMirrorSource | undefined;
	/** {@link SettingsMirrorState.generation} this mirror last adopted; `-1` before the first. */
	#mirrorGeneration = -1;
	/** Bumped by every own-layer or scope rebuild; reported as {@link SettingsMirrorState.generation}. */
	#layerGeneration = 0;
	/** Observers of own-layer and scope changes ({@link onLayersChange}). */
	#layerListeners = new Set<() => void>();

	/**
	 * `projection`: a derived read-only view of another instance ({@link grantAuthority}), not a
	 * session's settings; it stays out of the registry so legacy {@link findScopedSettings}
	 * lookups never resolve to it.
	 */
	private constructor(options: SettingsOptions = {}, { projection = false }: { projection?: boolean } = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
		if (options.configFiles) configFiles.push(...options.configFiles);
		this.#configFiles = configFiles.map(file => path.resolve(this.#cwd, expandTilde(file)));
		this.#persist = !options.inMemory && options.readOnly !== true;
		if (!projection) liveSettingsInstances.add(new WeakRef(this));
		if (options.overrides) this.#overrides = this.#overrideLayer(options.overrides);
	}

	/**
	 * Runtime-override layer for dotted constructor `overrides`: legacy ids migrate first, then every
	 * path must belong to a registered setting and every value is normalized and checked like a
	 * handle `override`. `undefined` values are skipped; `null` stays as an unset tombstone.
	 *
	 * @throws Error on an unknown setting or a value its definition rejects.
	 */
	#overrideLayer(overrides: Readonly<Record<string, unknown>>): RawSettings {
		const raw: RawSettings = {};
		for (const key in overrides) {
			const value = overrides[key];
			if (value !== undefined) setByPath(raw, key.split("."), value);
		}
		const layer = this.#migrateRawSettings(raw);
		assertKnownSettingPaths(layer);
		for (const setting of allSettings()) {
			const value = getByPath(layer, setting.segments);
			if (value === undefined || value === null) continue;
			const normalized = setting.definition.normalize ? setting.definition.normalize(value) : value;
			setting.assertWritable(normalized);
			setByPath(layer, setting.segments, normalized);
		}
		return layer;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`. Rejects (never throws) on an invalid
	 * override or configuration.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const promise = Promise.try(() => new Settings(options).#load());
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				clearBoundSettingsMethods();
				globalInstancePromise = Promise.resolve(instance);
				bindEffects(instance);
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
		return Promise.try(() => new Settings({ ...options, readOnly: true }).#loadReadOnly());
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		return Promise.try(() => new Settings(options).#load());
	}

	/**
	 * Create an in-memory settings instance without affecting the global singleton.
	 * A supplied storage handle remains shared for runtime data while setting overrides stay non-persistent.
	 */
	static isolated(
		overrides: Readonly<Record<string, unknown>> = {},
		options: { storage?: AgentStorageApi | null } = {},
	): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#storage = options.storage ?? null;
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * The operator or SDK host's authority for model grants: a read-only view of the global,
	 * `--config` and runtime layers (an overlay's own over its parent's) without any project layer,
	 * because repository settings files are writable by the agent. Only subagent-derived overlays
	 * delegate to their parent's authority, so a host's own overlay remains authoritative.
	 */
	grantAuthority(): Settings {
		if (this.#derived && this.#parent) return this.#parent.grantAuthority();
		const revision = this.revision;
		if (this.#grantView?.revision === revision) return this.#grantView.view;
		const view = new Settings({ inMemory: true, cwd: this.#cwd, agentDir: this.#agentDir }, { projection: true });
		view.#storage = this.#storage;
		view.#global = this.#operatorLayers();
		inheritWarnings(view, this);
		view.#rebuildMerged();
		this.#grantView = { revision, view };
		return view;
	}

	/** Global, `--config` and runtime layers merged over an overlay parent's, skipping every project layer. */
	#operatorLayers(): RawSettings {
		const own = this.#mergeOwnLayers({ ...this.#ownLayers(), project: {} });
		return this.#parent ? this.#deepMerge(this.#parent.#operatorLayers(), own) : own;
	}

	/**
	 * Child view: reads fall through to this instance live (a later edit here reaches the
	 * child and its listeners), while overrides and later writes stay local and non-persistent.
	 * Use `derived: true` for subagent-injected settings, which must not grant models.
	 * Plain overlays are host-created authority boundaries.
	 *
	 * @throws Error when `overrides` names an unknown setting or a value its definition rejects.
	 */
	overlay(overrides: Readonly<Record<string, unknown>> = {}, options: { derived?: boolean } = {}): Settings {
		const child = new Settings({ inMemory: true, cwd: this.#cwd, agentDir: this.#agentDir, overrides });
		child.#storage = this.#storage;
		child.#parent = this;
		child.#derived = options.derived ?? false;
		inheritWarnings(child, this);
		child.#rebuildMerged();
		// The parent holds only a weak reference, so a discarded child is collected without an
		// explicit dispose; its listener unsubscribes on the next parent change.
		const ref = new WeakRef(child);
		const forward: SettingChangeListener = setting => {
			const target = ref.deref();
			if (!target) {
				this.#childForwarders.delete(forward);
				return;
			}
			target.#applyParentChange(setting);
		};
		this.#childForwarders.add(forward);
		return child;
	}

	/**
	 * Deep copy of this {@link overlay}'s own layers (its `set` and `override` writes). Passing it to
	 * {@link restoreOverlay} on the same parent rebuilds an equivalent child, so a holder can keep
	 * this plain data instead of the live child with its merged view, memoized values and listeners.
	 */
	overlayLayers(): OverlayLayers {
		return structuredClone({ global: this.#global, overrides: this.#overrides, derived: this.#derived });
	}

	/** {@link overlay} of this instance whose own layers are `layers` (from {@link overlayLayers}). */
	restoreOverlay(layers: OverlayLayers): Settings {
		const child = this.overlay({}, { derived: layers.derived });
		child.#global = structuredClone(layers.global);
		child.#overrides = structuredClone(layers.overrides);
		child.#rebuildMerged();
		return child;
	}

	/** Re-merges after a parent change and forwards it unless the child's own layers pin the value. */
	#applyParentChange(setting: AnySetting): void {
		this.#syncParent();
		const own = getByPath(this.#mergeOwnLayers(this.#ownLayers()), setting.segments);
		if (own !== undefined && (typeof own !== "object" || own === null || Array.isArray(own))) return;
		this.#notifyChange(setting);
	}

	/** Re-merges an overlay whose parent changed since the last merge (every parent write bumps its revision). */
	#syncParent(): void {
		if (this.#parent && this.#parent.revision !== this.#syncedParentRevision) this.#remerge();
	}

	/** Merged layers, re-merged first when the parent moved on. */
	#mergedView(): RawSettings {
		this.#syncParent();
		return this.#merged;
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

	/** Return the initialized or in-flight global settings without starting a writable load. */
	static get current(): Promise<Settings> | null {
		return globalInstancePromise;
	}

	/**
	 * Worker thread: in-memory replica of a main-thread instance, seeded from its {@link mirrorState}
	 * and kept current by {@link applyMirrorState}. It never opens agent.db, config files or locks.
	 * Reads, `onEffectiveChange` listeners, {@link revision} and child {@link overlay}s behave as on
	 * the source; every write and disk operation on the mirror itself goes to `source` (the main
	 * instance stays the single writer), while overlays created from the mirror keep their writes
	 * local like any overlay. A mirror of an overlay is an overlay of `parent`, its parent's mirror.
	 */
	static mirror(source: SettingsMirrorSource, state: SettingsMirrorState, parent?: Settings): Settings {
		const instance = parent
			? parent.overlay({}, { derived: state.derived })
			: new Settings({ inMemory: true, cwd: state.cwd, agentDir: state.agentDir });
		instance.#mirror = source;
		if (source.storage !== undefined) instance.#storage = source.storage;
		instance.applyMirrorState(state);
		return instance;
	}

	/**
	 * Worker bootstrap only: makes `instance`, the {@link mirror} of the main thread's global
	 * settings, this thread's global singleton (`settings`, {@link instance}, {@link current},
	 * unscoped {@link findScopedSettings}) and the driver of process-wide effects, without
	 * {@link init} loading anything.
	 *
	 * @throws Error when `instance` is not a mirror.
	 */
	static installGlobalMirror(instance: Settings): void {
		if (!instance.#mirror) throw new Error("Settings.installGlobalMirror expects a worker mirror");
		if (globalInstance === instance) return;
		releaseGlobalMirrorEffects?.();
		globalInstance = instance;
		globalInstancePromise = Promise.resolve(instance);
		clearBoundSettingsMethods();
		releaseGlobalMirrorEffects = bindEffects(instance);
	}

	/** Whether this instance is a worker {@link mirror} of a main-thread instance. */
	get isMirror(): boolean {
		return this.#mirror !== undefined;
	}

	/** Instance this {@link overlay} reads through to; `undefined` for a root instance. */
	overlayParent(): Settings | undefined {
		return this.#parent;
	}

	/** Main thread: copy of this instance's own layers and scope, for building or refreshing a worker {@link mirror}. */
	mirrorState(): SettingsMirrorState {
		return {
			generation: this.#layerGeneration,
			cwd: this.#cwd,
			agentDir: this.#agentDir,
			configFiles: [...this.#configFiles],
			global: structuredClone(this.#global),
			project: structuredClone(this.#project),
			configOverlay: structuredClone(this.#configOverlay),
			overrides: structuredClone(this.#overrides),
			derived: this.#derived,
			projectShellPathSource: this.#projectShellPathSource,
			overlayShellPathSource: this.#overlayShellPathSource,
		};
	}

	/**
	 * Worker mirror: adopts a newer {@link mirrorState} of the main instance, then notifies change
	 * listeners (and overlay children) of every setting whose effective value changed, like a disk
	 * reload. A state not newer than the last adopted one is ignored.
	 *
	 * @throws Error when this instance is not a {@link mirror}.
	 */
	applyMirrorState(state: SettingsMirrorState): void {
		if (!this.#mirror) throw new Error("Settings.applyMirrorState expects a worker mirror");
		if (state.generation <= this.#mirrorGeneration) return;
		const previous = this.#mirrorGeneration < 0 ? undefined : this.#snapshot();
		this.#mirrorGeneration = state.generation;
		this.#cwd = state.cwd;
		this.#agentDir = state.agentDir;
		this.#configFiles = [...state.configFiles];
		this.#global = structuredClone(state.global);
		this.#project = structuredClone(state.project);
		this.#configOverlay = structuredClone(state.configOverlay);
		this.#overrides = structuredClone(state.overrides);
		this.#derived = state.derived;
		this.#projectShellPathSource = state.projectShellPathSource;
		this.#overlayShellPathSource = state.overlayShellPathSource;
		this.#rebuildMerged();
		if (previous) this.#fireChangesSince(previous);
	}

	/**
	 * Calls `listener` synchronously after every rebuild of this instance's own layers or scope
	 * (writes, reloads, re-scopes; not a parent's changes). Returns the unsubscribe.
	 */
	onLayersChange(listener: () => void): () => void {
		this.#layerListeners.add(listener);
		return () => {
			this.#layerListeners.delete(listener);
		};
	}

	/** Replays `write` on the main instance behind this mirror and adopts the resulting state. */
	#forward(mirror: SettingsMirrorSource, write: SettingsMirrorWrite): void {
		this.applyMirrorState(mirror.write(write));
	}

	/** Runs `refresh` on the main instance behind this mirror and adopts the resulting state. */
	async #forwardRefresh(mirror: SettingsMirrorSource, refresh: SettingsMirrorRefresh): Promise<void> {
		this.applyMirrorState(await mirror.refresh(refresh));
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Registry plumbing behind `Setting.get`: the configured value of `id` across all layers
	 * (path-scoped entries resolved for this cwd), or `undefined` when unset — the handle
	 * supplies the default. Read settings through their handles, not this.
	 *
	 * A configured `null` is treated as unset: YAML writes `null` for a key left
	 * without a value (`fallbackChains:`), and no schema entry has a null
	 * default, so returning it verbatim would hand callers a value the schema
	 * says is impossible (#13183).
	 */
	rawValue(setting: AnySetting): unknown {
		return configuredValue(this.#mergedView(), setting, this.#cwd);
	}

	/**
	 * Whether `setting` has an explicitly configured value (global config, project
	 * config, or runtime override) rather than falling back to the schema default.
	 * A configured `null` counts as unset, like in {@link rawValue}.
	 */
	isConfigured(setting: AnySetting): boolean {
		const value = getByPath(this.#mergedView(), setting.segments);
		return value !== undefined && value !== null;
	}

	/**
	 * Layer supplying the effective value of `setting`, in merge precedence order:
	 * runtime override → config overlay → project → global → (overlay parent) → schema default.
	 * A value that merges to `null` is unset and reports `"default"`.
	 */
	getProvenance(setting: AnySetting): SettingProvenance {
		if (!this.isConfigured(setting)) return "default";
		const segments = setting.segments;
		if (getByPath(this.#overrides, segments) !== undefined) return "runtime";
		if (getByPath(this.#configOverlay, segments) !== undefined) return "overlay";
		if (getByPath(projectLayerForMerge(this.#project), segments) !== undefined) return "project";
		if (getByPath(this.#global, segments) !== undefined) return "global";
		return this.#parent?.getProvenance(setting) ?? "default";
	}

	/**
	 * Whether a runtime override — a CLI flag, a session-only write, an SDK override — sets `setting`
	 * here or on an overlay parent. Such an override outranks the setting's environment variable; a
	 * soft-pinned protocol default does not.
	 */
	hasRuntimeOverride(setting: AnySetting): boolean {
		const own = getByPath(this.#overrides, setting.segments);
		if (own !== undefined && own !== null) return !this.#softPins.has(setting);
		return this.#parent?.hasRuntimeOverride(setting) ?? false;
	}

	/**
	 * Registry plumbing behind `Setting.set` / `Setting.override`: writes `value` for `setting` to the
	 * global layer (persisted in the background; releases a soft pin, see {@link pinDefaultValue}) or
	 * the runtime-override layer, then notifies change listeners (process-wide effects apply
	 * synchronously). On an {@link overlay} both layers are local to the overlay.
	 *
	 * @throws Error when the value does not fit the definition's type or fails its `items`/`validate` check.
	 */
	writeValue(setting: AnySetting, value: unknown, layer: "global" | "override"): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "writeValue", id: setting.id, value, layer });
		setting.assertWritable(value);
		if (layer === "override" && setting === cfgModelRoles) {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		if (layer === "override") this.#softPins.delete(setting);
		const prev = setting.get(this);
		// Re-setting the persisted global value is a no-op for config.yml: staging it would still
		// queue a full re-read, rewrite, fsync, and rename of the file.
		const persistGlobal = layer === "global" && !this.#globalWriteIsNoop(setting.segments, value);
		if (layer === "global") {
			if (persistGlobal) this.#stageGlobal(setting.segments, value);
			this.#releaseSoftPin(setting);
		} else {
			setByPath(this.#overrides, setting.segments, value);
		}
		this.#rebuildMerged();
		if (persistGlobal) this.#queueSave();
		this.#fireIfChanged(setting, prev);
	}

	/**
	 * Registry plumbing behind `Setting.unset`: removes `setting` from the global layer (the removal
	 * is persisted in the background) and releases its soft pin, so the remaining layers — or else
	 * the default — supply the value.
	 */
	unsetGlobalValue(setting: AnySetting): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "unsetGlobalValue", id: setting.id });
		const current = getByPath(this.#global, setting.segments);
		if (current === undefined && !this.#softPins.has(setting)) return;
		const prev = setting.get(this);
		this.#releaseSoftPin(setting);
		if (current !== undefined) this.#stageGlobal(setting.segments, undefined);
		this.#rebuildMerged();
		if (current !== undefined) this.#queueSave();
		this.#fireIfChanged(setting, prev);
	}

	/**
	 * Registry plumbing behind `Setting.setEntry`: writes `value` as the `key` entry of record `setting`
	 * in the global layer (`undefined` removes the entry). The record's other entries, and every entry
	 * another layer supplies, stay untouched, and only that entry is persisted; otherwise like a global
	 * {@link writeValue}.
	 *
	 * @throws Error when `setting` is not a record or the entry fails the definition's `validate` check.
	 */
	writeEntry(setting: AnySetting, key: string, value: unknown): void {
		if (setting.type !== "record") throw new Error(`Setting ${setting.id} is not a record`);
		if (this.#mirror) return this.#forward(this.#mirror, { op: "writeEntry", id: setting.id, key, value });
		if (value !== undefined) setting.assertWritable({ [key]: value });
		const record = getByPath(this.#global, setting.segments);
		// An entry re-set to its persisted value stages nothing (no config.yml rewrite).
		const staged =
			value !== undefined
				? !this.#globalWriteIsNoop([...setting.segments, key], value)
				: isRecord(record) && Object.hasOwn(record, key);
		if (!staged && !this.#softPins.has(setting)) return;
		const prev = setting.get(this);
		this.#releaseSoftPin(setting);
		if (staged) {
			// Replace rather than mutate the record: the merged view and cached reads may share it.
			if (isRecord(record)) setByPath(this.#global, setting.segments, { ...record });
			this.#stageGlobal([...setting.segments, key], value);
		}
		this.#rebuildMerged();
		if (staged) this.#queueSave();
		this.#fireIfChanged(setting, prev);
	}

	/**
	 * Registry plumbing behind `Setting.setMember`: adds (`member`) or removes `item` in list `setting`
	 * of the global layer, seeded from the default when that layer has no list, so the persisted list
	 * changes by that item only; otherwise like a global {@link writeValue}.
	 *
	 * @throws Error when `setting` is not a list or the resulting list fails its `items`/`validate` check.
	 */
	writeMember(setting: AnySetting, item: string, { member }: { member: boolean }): void {
		if (setting.type !== "array") throw new Error(`Setting ${setting.id} is not a list`);
		if (this.#mirror) return this.#forward(this.#mirror, { op: "writeMember", id: setting.id, item, member });
		const list = getByPath(this.#global, setting.segments);
		const base: readonly unknown[] = Array.isArray(list) ? list : (setting.default as readonly unknown[]);
		const present = base.includes(item);
		if (present === member && !this.#softPins.has(setting)) return;
		let next = [...base];
		if (present !== member) next = member ? [...base, item] : base.filter(entry => entry !== item);
		this.writeValue(setting, next, "global");
	}

	/**
	 * Applies `value` at `segments` of the global layer (`undefined` removes it) and queues that path —
	 * a setting, or one entry of a record setting — for the next save.
	 */
	#stageGlobal(segments: readonly string[], value: unknown): void {
		const key = JSON.stringify(segments);
		this.#captureGlobalMutation(key, this.#modifiedPathMutations, getByPath(this.#global, segments));
		if (value === undefined) deleteByPath(this.#global, segments);
		else setByPath(this.#global, segments, value);
		this.#persistedMutationGeneration++;
		this.#modified.set(key, segments);
	}

	/** Drops `setting`'s soft-pinned default override, if any (the caller rebuilds the merged view). */
	#releaseSoftPin(setting: AnySetting): void {
		if (!this.#softPins.delete(setting)) return;
		deleteByPath(this.#overrides, setting.segments);
	}

	/**
	 * Registry plumbing behind `Setting.pinDefault`: overrides `setting` with its default unless a
	 * layer configures it, keeping the override soft — a global write or unset of the setting, or a
	 * disk reload or re-scope that makes a persisted layer configure it, drops it, and an explicit
	 * override/clear ends it.
	 */
	pinDefaultValue(setting: AnySetting): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "pinDefaultValue", id: setting.id });
		const value = setting.default;
		if (value === undefined || this.isConfigured(setting)) return;
		this.writeValue(setting, value, "override");
		this.#softPins.add(setting);
	}

	/**
	 * Removes from `layers.overrides` (replaced by a copy) every soft pin the persisted `layers`
	 * (global, project, `--config` overlay, parent) now configure; returns the settled settings.
	 */
	#settlePins(layers: OwnLayers): AnySetting[] {
		if (this.#softPins.size === 0) return [];
		const persisted = this.#mergeOverParent(this.#mergeOwnLayers({ ...layers, overrides: {} }));
		const settled = [...this.#softPins].filter(setting => {
			const value = getByPath(persisted, setting.segments);
			return value !== undefined && value !== null;
		});
		if (settled.length === 0) return settled;
		layers.overrides = structuredClone(layers.overrides);
		for (const setting of settled) deleteByPath(layers.overrides, setting.segments);
		return settled;
	}

	/** Registry plumbing behind `Setting.clearOverride`: drops the runtime override of `setting`. */
	clearOverrideValue(setting: AnySetting): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "clearOverrideValue", id: setting.id });
		if (setting === cfgModelRoles) {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		this.#softPins.delete(setting);
		if (getByPath(this.#overrides, setting.segments) === undefined) return;
		const prev = setting.get(this);
		deleteByPath(this.#overrides, setting.segments);
		this.#rebuildMerged();
		this.#fireIfChanged(setting, prev);
	}

	/** Effective value of every setting (in registration order), captured before a bulk layer refresh. */
	#snapshot(): unknown[] {
		return allSettings().map(setting => setting.get(this));
	}

	/**
	 * Notifies change listeners for every setting whose effective value differs from
	 * `previous` (disk reload, save-time merge, project re-scope).
	 */
	#fireChangesSince(previous: readonly unknown[]): void {
		const settings = allSettings();
		for (let i = 0; i < previous.length; i++) {
			const setting = settings[i];
			if (!settingValuesEqual(setting.get(this), previous[i])) this.#notifyChange(setting);
		}
	}

	#fireIfChanged(setting: AnySetting, prev: unknown): void {
		if (!Object.is(setting.get(this), prev)) this.#notifyChange(setting);
	}

	/** Runs the listeners observing `setting`, then forwards the change to overlay children. */
	#notifyChange(setting: AnySetting): void {
		const listeners = this.#changeListeners[setting.slot];
		if (listeners) runChangeListeners(listeners, setting);
		if (this.#childForwarders.size > 0) runChangeListeners(this.#childForwarders, setting);
	}

	/**
	 * Registry plumbing behind `Derived.listen` and `effect`: calls `listener` synchronously
	 * whenever the effective value of one of `sources` changes in this instance. Returns the
	 * unsubscribe. Consumers observe settings through handles instead.
	 */
	onEffectiveChange(sources: readonly AnySetting[], listener: SettingChangeListener): () => void {
		for (const source of sources) (this.#changeListeners[source.slot] ??= new Set()).add(listener);
		return () => {
			for (const source of sources) this.#changeListeners[source.slot]?.delete(listener);
		};
	}

	/** Set once this instance is discarded; background saves become no-ops. */
	#savesCancelled = false;

	/**
	 * Drop pending debounced saves and refuse any further background writes.
	 * Used when an instance is being discarded (test teardown): an armed timer
	 * or a chained in-flight save on a dropped instance would otherwise fire
	 * later and race the successor's file locks. Also stops config-file watching.
	 */
	cancelPendingSaves(): void {
		this.#savesCancelled = true;
		this.stopWatching();
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = undefined;
	}

	/**
	 * Apply on-disk edits live: watch the directories holding config.yml, the
	 * project settings files, and `--config` overlays, and run a debounced
	 * keep-last-good reload (a file that fails to parse or validate keeps its
	 * layer's last good values; a single value this build cannot read keeps its
	 * last good value). Arming a watch also schedules one reload, so
	 * edits that landed before it went live are not lost. Only the persisting
	 * process-global instance watches; other instances ignore the call. Stopped
	 * by {@link stopWatching} / {@link cancelPendingSaves}.
	 */
	startWatching(): void {
		if (this.#watchingFiles || !this.#persist || this.#savesCancelled || globalInstance !== this) return;
		this.#watchingFiles = true;
		this.#syncFileWatchers();
	}

	/** Stop config-file watching started by {@link startWatching}; idempotent. */
	stopWatching(): void {
		this.#watchingFiles = false;
		clearTimeout(this.#watchReloadTimer);
		this.#watchReloadTimer = undefined;
		for (const { watcher } of this.#fileWatchers.values()) watcher.close();
		this.#fileWatchers.clear();
	}

	/** Directory → basenames whose events should trigger a reload, for every current config source. */
	#configWatchTargets(): Map<string, Set<string>> {
		const targets = new Map<string, Set<string>>();
		const addTarget = (dir: string, name: string) => {
			const names = targets.get(dir);
			if (names) names.add(name);
			else targets.set(dir, new Set([name]));
		};
		const addFile = (file: string) => {
			// Walk physically so every symlink hop (including profile/ancestor
			// directory links) is observed, not just the logical file and final
			// realpath. Physical directory keys also re-arm a watch after retargeting.
			const absolute = path.resolve(file);
			let dir = path.parse(absolute).root;
			let segments = physicalTargetSegments(absolute);
			let hops = 0;
			while (segments.length > 0) {
				const segment = segments.shift()!;
				if (segment === "" || segment === ".") continue;
				if (segment === "..") {
					dir = path.dirname(dir);
					continue;
				}
				const current = path.join(dir, segment);
				if (segments.length === 0) addTarget(dir, segment);
				try {
					if (fs.lstatSync(current).isSymbolicLink()) {
						addTarget(dir, segment);
						if (++hops > MAX_SYMLINK_HOPS) return;
						const target = fs.readlinkSync(current);
						if (path.isAbsolute(target)) dir = path.parse(target).root;
						segments = [...physicalTargetSegments(target), ...segments];
					} else {
						dir = current;
					}
				} catch {
					// Watch the nearest existing parent, even when several
					// directories or a symlink's referent are missing.
					addTarget(dir, segment);
					return;
				}
			}
		};
		for (const filename of MAIN_CONFIG_FILENAMES) addFile(path.join(this.#agentDir, filename));
		const projectCwd = path.resolve(this.#cwd);
		const projectConfigDir = getProjectAgentDir(projectCwd);
		addFile(path.join(projectConfigDir, "config.yml"));
		addFile(path.join(projectConfigDir, "settings.json"));
		addFile(path.join(projectCwd, ".claude", "settings.json"));
		for (const file of this.#projectSourcePaths) addFile(file);
		for (const file of this.#configFiles) addFile(file);
		return targets;
	}

	/**
	 * Reconcile directory watchers with the current config sources. Watching
	 * directories (not files) keeps atomic rename-over writes observable.
	 */
	#syncFileWatchers(): void {
		if (!this.#watchingFiles) return;
		const targets = this.#configWatchTargets();
		let armed = false;
		for (const [dir, entry] of this.#fileWatchers) {
			if (targets.has(dir)) continue;
			entry.watcher.close();
			this.#fileWatchers.delete(dir);
		}
		for (const [dir, names] of targets) {
			const existing = this.#fileWatchers.get(dir);
			if (existing) {
				// A newly followed target can share a directory with the old one.
				// Events for its name were filtered out while the reload was reading
				// the files, so reconcile once even though no new watch was opened.
				for (const name of names) {
					if (!existing.names.has(name)) {
						armed = true;
						break;
					}
				}
				existing.names = names;
				continue;
			}
			let watcher: fs.FSWatcher;
			try {
				watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
					const entry = this.#fileWatchers.get(dir);
					if (!entry || entry.watcher !== watcher) return;
					if (filename && !entry.names.has(path.basename(filename.toString()))) return;
					this.#scheduleWatchReload();
				});
			} catch (error) {
				if (!isEnoent(error))
					logger.debug("Settings: cannot watch config directory", { dir, error: String(error) });
				continue;
			}
			watcher.on("error", error => {
				logger.debug("Settings: config directory watcher failed", { dir, error: String(error) });
				watcher.close();
				if (this.#fileWatchers.get(dir)?.watcher === watcher) this.#fileWatchers.delete(dir);
			});
			this.#fileWatchers.set(dir, { watcher, names });
			armed = true;
		}
		// The sources were last read before a watch or name was added. Bun also
		// arms macOS FSEvents asynchronously, so a write in between may raise no
		// event. Re-read once; the next sync adds nothing new, so it settles.
		if (armed) this.#scheduleWatchReload();
	}

	#scheduleWatchReload(): void {
		if (!this.#watchingFiles) return;
		clearTimeout(this.#watchReloadTimer);
		this.#watchReloadTimer = setTimeout(() => {
			this.#watchReloadTimer = undefined;
			void this.#reloadFromWatch();
		}, CONFIG_WATCH_DEBOUNCE_MS);
		this.#watchReloadTimer.unref();
	}

	async #reloadFromWatch(): Promise<void> {
		if (!this.#watchingFiles) return;
		try {
			await this.#exclusive("keep-last-good", () => this.#reloadPersistedLayers("keep-last-good"));
		} catch (error) {
			logger.warn("Settings: failed to apply on-disk config change", { error: String(error) });
		}
		// Sources may have appeared, moved, or vanished; re-target the watchers.
		this.#syncFileWatchers();
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#mirror) return this.#forwardRefresh(this.#mirror, { op: "flush" });
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
			await this.#chainSave();
		}
		if (this.#modifiedProjectModelRoles.size > 0) {
			await this.#saveProjectNow();
		}
	}

	/**
	 * Independent instance scoped to `cwd`: same global, `--config` overlay, and runtime layers, the
	 * project layer re-read for `cwd` (persisted instances). An {@link overlay} clones its parent for
	 * `cwd` and re-applies its own layers on top, so inherited values carry over.
	 *
	 * @throws Error when a configured value fails its definition's `validate` check.
	 */
	async cloneForCwd(cwd: string): Promise<Settings> {
		if (this.#mirror) return this.#mirror.cloneForCwd(cwd);
		let cloned: Settings;
		if (this.#parent) {
			cloned = (await this.#parent.cloneForCwd(cwd)).overlay({}, { derived: this.#derived });
			cloned.#project = structuredClone(this.#project);
		} else {
			cloned = new Settings({
				cwd,
				agentDir: this.#agentDir,
				inMemory: !this.#persist,
			});
			cloned.#storage = this.#storage;
			cloned.#configPath = this.#configPath;
			cloned.#project = this.#persist
				? cloned.#adoptProjectRead(await cloned.#readProjectSettings(true), {
						global: this.#global,
						configOverlay: this.#configOverlay,
						overrides: this.#overrides,
					})
				: structuredClone(this.#project);
			if (!this.#persist) cloned.#projectShellPathSource = this.#projectShellPathSource;
			cloned.#configFiles = [...this.#configFiles];
			cloned.#overlayShellPathSource = this.#overlayShellPathSource;
		}
		cloned.#global = structuredClone(this.#global);
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		// A soft-pinned default yields to a value the clone's own scope configures.
		cloned.#softPins = new Set(this.#softPins);
		const layers = { ...cloned.#ownLayers(), overrides: this.#buildOriginalOverrides() };
		for (const setting of cloned.#settlePins(layers)) cloned.#softPins.delete(setting);
		cloned.#overrides = layers.overrides;
		cloned.#rebuildMerged();
		inheritWarnings(cloned, this);
		cloned.#validateAll();
		return cloned;
	}

	/**
	 * Re-read the current global, project, and explicit overlay layers from disk
	 * without replacing this instance or discarding runtime overrides. An in-memory
	 * overlay has no layers of its own on disk; `includeParents` reloads the persisted
	 * settings behind it, keeping the overlay's own overrides.
	 *
	 * All sources are loaded and validated before any live layer is replaced, so
	 * readers never observe a partially refreshed or invalid configuration.
	 * Concurrent callers share the same reload.
	 *
	 * @throws Error when a source fails to load or a value fails its definition's
	 * `validate` check; the previous layers stay in effect.
	 */
	async reloadFromDisk(options?: { includeParents?: boolean }): Promise<void> {
		if (this.#mirror) {
			return this.#forwardRefresh(this.#mirror, {
				op: "reloadFromDisk",
				includeParents: options?.includeParents === true,
			});
		}
		if (options?.includeParents && this.#parent) await this.#parent.reloadFromDisk(options);
		if (!this.#persist) return;
		await this.#exclusive("strict", () => this.#reloadPersistedLayers("strict"));
	}

	/**
	 * Run one disk reload at a time, also serialized with {@link reloadForCwd}
	 * (which holds the same slot). Concurrent strict reloads share the in-flight
	 * one; anything else queues behind the active refresh so it never misses a
	 * write or scope change that landed after that refresh read the files.
	 */
	async #exclusive(kind: LayerRefreshKind, refresh: () => Promise<void>): Promise<void> {
		for (;;) {
			const active = this.#activeReload;
			if (!active) break;
			if (kind === "strict" && active.kind === "strict") return active.promise;
			await active.promise.catch(() => {});
		}
		const entry = { kind, promise: refresh() };
		this.#activeReload = entry;
		try {
			await entry.promise;
		} finally {
			if (this.#activeReload === entry) this.#activeReload = undefined;
		}
	}

	async #reloadPersistedLayers(mode: PersistedReloadMode): Promise<void> {
		const keepLastGood = mode === "keep-last-good";
		for (;;) {
			try {
				await this.flush();
			} catch (error) {
				// The failed writes stay pending for the next flush and are re-applied over the
				// layers read below, so an unwritable config never blocks a reload or reverts them.
				logger.warn("Settings: reloading over unsaved changes", { error: String(error) });
			}
			const mutationGeneration = this.#persistedMutationGeneration;

			const [globalResult, projectResult, overlayResult] = await Promise.allSettled([
				this.#readExistingMainYaml(false),
				this.#readProjectSettings(false, { rejectNewWarnings: keepLastGood }),
				this.#readConfigOverlays(false),
			]);
			if (mutationGeneration !== this.#persistedMutationGeneration) continue;
			for (const result of [globalResult, projectResult, overlayResult]) {
				if (result.status === "fulfilled") continue;
				if (!keepLastGood) throw result.reason;
				logger.warn("Settings: keeping last good config; on-disk change failed to load", {
					error: String(result.reason),
				});
			}

			const refreshed: LayerRefresh[] = [];
			if (globalResult.status === "fulfilled") {
				const { configPath } = globalResult.value;
				// A config this instance moved aside as malformed reads as missing until a save
				// recreates it; keep the last good layer instead of rebuilding it from pending writes.
				const quarantined = this.#configPath !== null && this.#quarantinedYamlTargets.has(this.#configPath);
				const settings = globalResult.value.settings ?? (quarantined ? structuredClone(this.#global) : {});
				this.#applyPendingGlobalWrites(settings);
				refreshed.push({
					layer: "global",
					settings,
					source: configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]),
					commit: () => {
						this.#configPath = configPath;
					},
				});
			}
			if (overlayResult.status === "fulfilled") {
				const { settings, shellPathSource } = overlayResult.value;
				refreshed.push({
					layer: "configOverlay",
					settings,
					source: this.#configFiles.join(", "),
					commit: () => {
						this.#overlayShellPathSource = shellPathSource;
					},
				});
			}

			// Accept global and overlay edits before resolving the project read: a rejected layer
			// cannot disable a provider in the project layer. Strict mode validates the final set.
			let layers = this.#ownLayers();
			const adopted: LayerRefresh[] = [];
			for (const refresh of refreshed) {
				if (keepLastGood) this.#keepReadableValues(refresh.settings, layers[refresh.layer], refresh.source);
				const trial: OwnLayers = { ...layers, [refresh.layer]: refresh.settings };
				if (keepLastGood && !this.#acceptsLayers(trial, refresh.source)) continue;
				layers = trial;
				adopted.push(refresh);
			}
			if (projectResult.status === "fulfilled") {
				const project = this.#resolveProjectRead(projectResult.value, layers);
				this.#applyPendingProjectWrites(project.settings);
				const source = project.sourcePaths.join(", ") || getProjectAgentDir(this.#cwd);
				const trial: OwnLayers = { ...layers, project: project.settings };
				if (!keepLastGood || this.#acceptsLayers(trial, source)) {
					layers = trial;
					adopted.push({
						layer: "project",
						settings: project.settings,
						source,
						commit: () => this.#commitProjectRead(project),
					});
				}
			}
			const settled = this.#settlePins(layers);
			if (!keepLastGood) this.#validateAll(this.#mergeOverParent(this.#mergeOwnLayers(layers)), this.#cwd);

			const previous = this.#snapshot();
			for (const refresh of adopted) refresh.commit();
			this.#global = layers.global;
			this.#project = layers.project;
			this.#configOverlay = layers.configOverlay;
			this.#overrides = layers.overrides;
			for (const setting of settled) this.#softPins.delete(setting);
			this.#rebuildMerged();
			this.#fireChangesSince(previous);
			return;
		}
	}

	/**
	 * Keeps, in a re-read layer `fresh`, the value the `live` layer holds for each setting whose new
	 * on-disk value this build cannot read (an enum value a newer omp added, a wrong type) while its
	 * old value was readable. Reading an unreadable value falls back to the default, so a config
	 * written for another version would otherwise move a running session to a value neither config
	 * chose — and rebuild every tool description and prompt derived from it, losing the session's
	 * prompt cache. The file keeps the edit; instances loading it fresh read it as before.
	 */
	#keepReadableValues(fresh: RawSettings, live: RawSettings, source: string): void {
		for (const setting of allSettings()) {
			const next = getByPath(fresh, setting.segments);
			if (next === undefined || next === null || setting.accepts(next)) continue;
			const kept = getByPath(live, setting.segments);
			if (kept === undefined || kept === null || !setting.accepts(kept)) continue;
			setByPath(fresh, setting.segments, structuredClone(kept));
			logger.warn("Settings: keeping last good value; on-disk value is invalid", {
				path: source,
				setting: setting.id,
				value: next,
				kept,
			});
		}
	}

	/**
	 * Whether `layers`, as they would be committed (soft pins they configure dropped), pass every
	 * definition's `validate` check; otherwise logs that the last good config stays, naming `source`.
	 */
	#acceptsLayers(layers: OwnLayers, source: string): boolean {
		const committed = { ...layers };
		this.#settlePins(committed);
		try {
			this.#validateAll(this.#mergeOverParent(this.#mergeOwnLayers(committed)), this.#cwd);
			return true;
		} catch (error) {
			logger.warn("Settings: keeping last good config; on-disk change is invalid", {
				path: source,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: reload the
	 * project layer (`.claude/settings.yml` etc.) from `cwd`, re-resolve
	 * path-scoped settings against it, and notify listeners (and process-wide
	 * effects: theme, symbols, …) of every value the new scope changes. Global
	 * settings and runtime overrides are preserved.
	 *
	 * Unlike {@link cloneForCwd}, this mutates the live instance, so every holder
	 * (the `settings` proxy, the active session, controllers) observes the new
	 * project scope without swapping references — used when the process changes
	 * directory mid-run (`/move`, cross-project resume). No-op when `cwd` is
	 * already the current scope. Serialized with disk reloads.
	 *
	 * @throws Error when a value configured for the new scope fails its definition's
	 * `validate` check; the instance then stays on its previous scope.
	 */
	async reloadForCwd(cwd: string): Promise<void> {
		if (this.#mirror) return this.#forwardRefresh(this.#mirror, { op: "reloadForCwd", cwd });
		const normalized = path.normalize(cwd);
		for (let active = this.#activeReload; active; active = this.#activeReload) {
			await active.promise.catch(() => {});
		}
		// Holds the refresh slot while running inline (not through `#exclusive`): callers resume
		// right after listeners are notified, as consumers sequencing a move (memory rebind) expect.
		const settled = Promise.withResolvers<void>();
		settled.promise.catch(() => {});
		const entry = { kind: "rescope" as const, promise: settled.promise };
		this.#activeReload = entry;
		try {
			if (normalized === this.#cwd) return;
			await this.flush();
			const read = this.#persist ? await this.#readProjectSettings(true, { cwd: normalized }) : undefined;
			const layers = {
				global: this.#global,
				configOverlay: this.#configOverlay,
				overrides:
					this.#savedRuntimeModelRoleOverrides.size === 0 ? this.#overrides : this.#buildOriginalOverrides(),
			};
			const project = read ? this.#resolveProjectRead(read, layers) : undefined;
			const candidate: OwnLayers = { ...layers, project: project?.settings ?? this.#project };
			const settledPins = this.#settlePins(candidate);
			this.#validateAll(this.#mergeOverParent(this.#mergeOwnLayers(candidate)), normalized);

			const previous = this.#snapshot();
			this.#cwd = normalized;
			this.#overrides = candidate.overrides;
			for (const setting of settledPins) this.#softPins.delete(setting);
			this.#savedRuntimeModelRoleOverrides.clear();
			if (project) {
				this.#project = project.settings;
				this.#commitProjectRead(project);
			}
			this.#rebuildMerged();
			this.#fireChangesSince(previous);
			this.#syncFileWatchers();
		} catch (error) {
			settled.reject(error);
			throw error;
		} finally {
			if (this.#activeReload === entry) this.#activeReload = undefined;
			settled.resolve();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorageApi | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	/** Resolved absolute paths of the config overlays supplied to this instance. */
	getConfigFiles(): readonly string[] {
		return [...this.#configFiles];
	}

	/**
	 * Monotonic revision for consumers caching derived effective settings.
	 * Changes after every merged-layer or cwd-scope rebuild, including overlays
	 * and path-scoped array re-resolution.
	 */
	get revision(): number {
		this.#syncParent();
		return this.#revision;
	}

	/**
	 * Raw global settings layer (`config.yml`/`config.yaml`), deep-cloned.
	 *
	 * Exposes arbitrary namespaced keys (e.g. an extension's own `piVim` block)
	 * that the typed, schema-bound {@link get} cannot reach. Used by the legacy
	 * pi `SettingsManager` shim to match upstream Pi's `getGlobalSettings()`.
	 * The clone means callers cannot mutate internal state. An {@link overlay}
	 * reports its parent's layer with the overlay's own writes merged on top.
	 */
	getGlobalSettings(): RawSettings {
		const own = structuredClone(this.#global);
		return this.#parent ? this.#deepMerge(this.#parent.getGlobalSettings(), own) : own;
	}

	/**
	 * Raw project settings layer (`.claude/settings.yml`, `.omp/config.yml`,
	 * etc.), deep-cloned. Companion to {@link getGlobalSettings} for the legacy
	 * pi `SettingsManager` shim's `getProjectSettings()`; an {@link overlay}
	 * likewise reports its parent's layer under its own.
	 */
	getProjectSettings(): RawSettings {
		const own = structuredClone(this.#project);
		return this.#parent ? this.#deepMerge(this.#parent.getProjectSettings(), own) : own;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		return procmgr.getShellConfig(cfgShellPath.get(this), { configSource: this.#shellPathSource() });
	}

	/** Where the effective `shellPath` comes from, for error messages; an overlay defers to its parent. */
	#shellPathSource(): string {
		if (Object.hasOwn(this.#overrides, "shellPath")) return "the runtime settings override";
		if (Object.hasOwn(this.#configOverlay, "shellPath")) {
			return this.#overlayShellPathSource ?? "the active config overlay";
		}
		if (Object.hasOwn(this.#project, "shellPath")) {
			return this.#projectShellPathSource ?? "the active project configuration";
		}
		if (this.#parent && !Object.hasOwn(this.#global, "shellPath")) return this.#parent.#shellPathSource();
		return this.#configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
	}

	/**
	 * Provenance of the effective `extensions` array for extension-root
	 * sub-discovery. `"project"` only when a project settings provider owns it
	 * (any of `.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`,
	 * … — all merged into the project layer) and no higher user-level layer (a
	 * `--config` overlay or a runtime override) replaces it; otherwise `"user"`.
	 * Callers pass this into {@link EffectiveExtensionRoots.configuredLevel} so
	 * discovery labels roots by the authority that produced them rather than
	 * re-deriving provenance from a partial disk scan. An {@link overlay} whose
	 * own layers leave `extensions` alone reports its parent's level.
	 */
	extensionsSourceLevel(): "user" | "project" {
		if (Object.hasOwn(this.#overrides, "extensions")) return "user";
		if (Object.hasOwn(this.#configOverlay, "extensions")) return "user";
		if (Object.hasOwn(this.#project, "extensions")) return "project";
		if (this.#parent && !Object.hasOwn(this.#global, "extensions")) return this.#parent.extensionsSourceLevel();
		return "user";
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
		const prev = cfgModelRoles.get(this);
		setByPath(this.#overrides, ["modelRoles"], next);
		this.#rebuildMerged();
		this.#fireIfChanged(cfgModelRoles, prev);
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
	 * Produce a deep copy of `#overrides` with original process-wide model-role
	 * overrides restored (temporarily replaced by project edits), for
	 * {@link cloneForCwd} and {@link reloadForCwd}. All remaining captures are
	 * valid because superseding operations (late `overrideModelRoles`,
	 * global-mode `setModelRole`, whole-map `override`/`clearOverride`)
	 * invalidate the affected captures at the point of supersession.
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
		const prev = cfgModelRoles.get(this);
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		const current: Record<string, unknown> = isRecord(projectRoles) ? { ...projectRoles } : {};
		current[role] = modelId;
		setByPath(this.#project, ["modelRoles"], current);
		this.#modifiedProjectModelRoles.add(role);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#fireIfChanged(cfgModelRoles, prev);
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
		if (this.#mirror) return this.#forward(this.#mirror, { op: "setModelRole", role, modelId });
		const prev = cfgModelRoles.get(this);
		// Re-setting the persisted role (or clearing an absent one) stages no config.yml rewrite;
		// the runtime-override sync below still applies.
		if (!this.#globalWriteIsNoop(["modelRoles", role], modelId)) {
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
		}
		this.#fireIfChanged(cfgModelRoles, prev);
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
		if (cfgModelRoleStorage.get(this) !== "project") return false;
		if (!this.#savedRuntimeModelRoleOverrides.has(role)) return false;
		return !!this.getProjectModelRole(role);
	}
	/**
	 * Set a model role in the current project's settings layer.
	 */
	setProjectModelRole(role: ModelRole | string, modelId: string): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "setProjectModelRole", role, modelId });
		this.#setProjectModelRoleValue(role, modelId);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}
	/**
	 * Clear a model role from the current project's settings layer.
	 */
	clearProjectModelRole(role: ModelRole | string): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "clearProjectModelRole", role });
		this.#setProjectModelRoleValue(role, null);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, undefined);
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = cfgModelRoles.get(this);
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}
	/**
	 * Get a model role from only the global settings layer (an {@link overlay}'s own, else its parent's).
	 */
	getGlobalModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#global)[role];
		return modelId || this.#parent?.getGlobalModelRole(role);
	}

	/**
	 * Get a model role from only the current project settings layer (an {@link overlay}'s own, else its parent's).
	 */
	getProjectModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#project)[role];
		return modelId || this.#parent?.getProjectModelRole(role);
	}

	/**
	 * Report which layer actually supplies the effective model role across
	 * full merge precedence (runtime override → config overlay → project →
	 * global → default). Unlike {@link getModelRoleSource}, this accounts
	 * for runtime and config-overlay layers and detects ownership by key
	 * presence rather than normalized value, so a `null` tombstone in the
	 * overlay or runtime layer correctly blocks lower layers. The project
	 * layer is checked through {@link projectLayerForMerge} because a
	 * project null is a cleared value (falls back to global), not a
	 * tombstone.
	 */
	getModelRoleProvenance(role: ModelRole | string): SettingProvenance {
		if (this.#modelRoleLayerOwns(this.#overrides, role)) return "runtime";
		if (this.#modelRoleLayerOwns(this.#configOverlay, role)) return "overlay";
		if (this.#modelRoleLayerOwns(projectLayerForMerge(this.#project), role)) return "project";
		if (this.#modelRoleLayerOwns(this.#global, role)) return "global";
		return this.#parent?.getModelRoleProvenance(role) ?? "default";
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
	 * Raw `modelPresets` entry for `name` from the highest-precedence layer that
	 * defines it (runtime override → config overlay → project → global), whole —
	 * same-name entries are NOT deep-merged across layers. A `null` entry on a
	 * tombstoning layer (runtime, overlay) hides the preset; a `null` anywhere
	 * else counts as unset. Falls back to the parent chain like the model-role
	 * layer helpers.
	 */
	getOwnedModelPreset(
		name: string,
	): { entry: unknown; source: "runtime" | "overlay" | "project" | "global" } | undefined {
		const layers = [
			{ layer: this.#overrides, source: "runtime", tombstone: true },
			{ layer: this.#configOverlay, source: "overlay", tombstone: true },
			{ layer: projectLayerForMerge(this.#project), source: "project", tombstone: false },
			{ layer: this.#global, source: "global", tombstone: false },
		] as const;
		for (const { layer, source, tombstone } of layers) {
			const presets = getByPath(layer, ["modelPresets"]);
			if (!isRecord(presets) || !Object.hasOwn(presets, name)) continue;
			const entry = presets[name];
			if (entry === null || entry === undefined) {
				if (tombstone) return undefined;
				continue;
			}
			return { entry, source };
		}
		return this.#parent?.getOwnedModelPreset(name);
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = cfgModelRoles.get(this);
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
		if (this.#mirror) return this.#forward(this.#mirror, { op: "overrideModelRoles", roles: { ...roles } });
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
				this.#savedRuntimeModelRoleOverrides.delete(role);
			}
		}
		this.#setRuntimeModelRoleOverrides(next);
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
			this.#readProjectSettings(true),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;

		this.#configOverlay = await this.#loadConfigOverlays();
		// Global and overlay `disabledProviders` decide which providers feed the project layer.
		this.#project = this.#adoptProjectRead(projectResult.value);

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#validateAll();
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
			this.#readProjectSettings(true),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;
		if (globalResult.value) {
			this.#global = globalResult.value;
		}

		this.#configOverlay = await this.#loadConfigOverlays();
		this.#project = this.#adoptProjectRead(projectResult.value);
		this.#rebuildMerged();
		this.#validateAll();
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

	/**
	 * Whether a global write of `value` at `segments` would leave config.yml unchanged: the global
	 * layer already holds it and so does the file on disk (unparseable, legacy-shaped, or externally
	 * edited files report false, so the write is staged and the save re-reads and merges as usual).
	 */
	#globalWriteIsNoop(segments: readonly string[], value: unknown): boolean {
		if (!settingValuesEqual(getByPath(this.#global, segments), value)) return false;
		if (!this.#persist || !this.#configPath) return true;
		let source: string;
		try {
			source = fs.readFileSync(this.#configPath, "utf8");
		} catch (error) {
			return isEnoent(error) && value === undefined;
		}
		let onDisk: unknown;
		try {
			onDisk = YAML.parse(source);
		} catch {
			return false;
		}
		return settingValuesEqual(isRecord(onDisk) ? getByPath(onDisk, segments) : undefined, value);
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

		// realpath fails for a dangling symlink. Resolve its target so recreating
		// a quarantined config repairs the target without replacing the
		// user-managed link. Walk the symlink chain hop by hop: realpath already
		// handled the case where every referent exists, so we only reach here when
		// the final referent is missing. Follow each existing intermediate link
		// until the referent is a non-symlink or does not exist, so the write
		// lands on the final target and preserves every intermediate link instead
		// of clobbering one into a regular file.
		try {
			if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
				let current = filePath;
				for (let hops = 0; ; hops++) {
					// realpath() rejects a fully-linked cycle up front, so we only
					// reach the manual walk on a chain that dangles today. It can
					// still turn cyclic mid-walk if another process retargets an
					// intermediate link, at which point readlink() would alternate
					// forever. Cap the hops and surface an ELOOP so a cycle has
					// bounded behavior instead of hanging flush().
					if (hops >= MAX_SYMLINK_HOPS) {
						const cyclic = new Error(
							`ELOOP: symlink chain for ${filePath} exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle)`,
						) as Error & { code?: string };
						cyclic.code = "ELOOP";
						throw cyclic;
					}
					let target: string;
					try {
						target = await fs.promises.readlink(current);
					} catch (error) {
						if (!isEnoent(error)) throw error;
						// An intermediate link vanished mid-walk: it was confirmed a
						// symlink by the lstat below on the prior hop, then removed
						// before this readlink. Land on the deepest hop we resolved
						// rather than collapsing to the chain head, which would let the
						// atomic rename replace the first user-managed symlink.
						return current === filePath ? path.resolve(filePath) : current;
					}
					// Resolve the target one physical segment at a time so an
					// intermediate directory symlink is followed by the filesystem
					// BEFORE a later `..` pops its PHYSICAL parent. Both absolute and
					// relative targets take the same walk: normalizing the whole
					// string up front (path.resolve) collapses `alias/..` lexically
					// to the anchor, but a POSIX kernel follows `alias` first and then
					// pops its real parent, so the two disagree whenever an alias
					// precedes a `..` — the lexical result can escape to an unrelated
					// sibling and let the write clobber a foreign file. Windows does
					// collapse them lexically; physicalTargetSegments() applies the
					// host's rule. An absolute target seeds the accumulator at its
					// filesystem anchor; a relative one seeds at the link's REAL
					// parent dir.
					let acc: string;
					if (path.isAbsolute(target)) {
						acc = path.parse(target).root;
					} else {
						const lexicalDir = path.dirname(current);
						acc = lexicalDir;
						try {
							acc = await fs.promises.realpath(lexicalDir);
						} catch (error) {
							if (!isEnoent(error)) throw error;
						}
					}
					// realpath() on the deepest existing prefix keeps `acc` canonical so
					// each `..` pops the real parent. Once a NAMED component does not
					// exist on disk the walk is FROZEN: the remainder is joined
					// lexically, but nothing past the miss was physically traversable,
					// so any construct that requires ENTERING the frozen component — a
					// `..`, or a trailing `/` or `/.` that demands it be a directory —
					// cannot be satisfied by the filesystem and must surface ENOTDIR
					// rather than lexically landing a regular file at a mislocated path.
					let frozen = false;
					for (const segment of physicalTargetSegments(target)) {
						if (segment === "" || segment === ".") {
							if (frozen) {
								// A trailing `/` (empty segment) or `/.` demands the
								// preceding component be a traversable directory. Before the
								// freeze that component was confirmed on disk, so the
								// requirement holds and the segment is inert. After the
								// freeze the component is a nonexistent/dangling name that
								// can never be a directory (`config.yml -> missing/`):
								// dropping the segment and writing a regular file there
								// mislocates and falsely reports success while the logical
								// config path stays unusable with ENOTDIR. Surface it.
								const notDir = new Error(
									`ENOTDIR: symlink target requires an unresolved component to be a directory for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							// The walk is not frozen, so `acc` was resolved by realpath()
							// and exists on disk — but existence is not enough. A trailing
							// `/` or `/.` demands `acc` be a directory, and a concurrent
							// process can win a TOCTOU race: the initial realpath(filePath)
							// saw the target missing, then the target was created as a
							// REGULAR FILE before this segment walk reached it, so
							// realpath(candidate) succeeded and left `frozen` false. The
							// preceding component is now a regular file, not a directory,
							// and dropping the segment would land the atomic rename on top
							// of it while the logical config path is really ENOTDIR. Verify
							// the requirement holds instead of assuming it.
							let accStat: fs.Stats;
							try {
								accStat = await fs.promises.stat(acc);
							} catch (error) {
								// `acc` was resolved by realpath() moments ago, but a
								// concurrent process can remove the component between that
								// realpath and this stat (`config.yml -> dir/../final.yml`
								// while `dir` is deleted). The trailing `/` or `/.` still
								// requires `acc` to be a traversable directory, and that
								// requirement provably cannot hold once the component is
								// gone. Surface ENOTDIR here instead of letting the ENOENT
								// reach the outer catch, which would swallow it and return
								// the chain head — clobbering config.yml itself.
								if (!isEnoent(error)) throw error;
								const notDir = new Error(
									`ENOTDIR: symlink target requires a directory but ${acc} is gone for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							if (!accStat.isDirectory()) {
								const notDir = new Error(
									`ENOTDIR: symlink target requires a directory but ${acc} is not one for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							continue;
						}
						if (segment === "..") {
							if (frozen) {
								// `..` after a component that could not be physically
								// traversed — a missing name or a dangling symlink — whether
								// the `..` follows it immediately (`link/..`) or after further
								// lexical names (`missing/child/..`). The kernel cannot take
								// the parent of a path it never entered: `missing/child/..`
								// fails because `missing` was never a directory to descend,
								// so the lexically appended `child` is not a real component to
								// pop. Popping and continuing would leave `acc` on a
								// mislocated path and land a regular file there while
								// reporting success. Surface the ENOTDIR the filesystem
								// raises instead.
								const notDir = new Error(
									`ENOTDIR: cannot resolve '..' past an unresolved component in symlink target for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							// `acc` was resolved by realpath() and exists on disk, but a
							// `..` demands it be a traversable directory to pop its parent.
							// A concurrent process can win a TOCTOU race: the initial
							// realpath(filePath) saw the component missing, then it was
							// created as a REGULAR FILE before realpath(candidate) reached
							// it, so that call succeeded and left `frozen` false. The
							// kernel cannot take the parent of `regularfile/..` — it fails
							// with ENOTDIR — so lexically popping and continuing would let
							// the atomic rename land on a mislocated sibling
							// (`config.yml -> racetarget/../victim.yml`) while the logical
							// config path is really ENOTDIR. Verify before popping.
							let accStat: fs.Stats;
							try {
								accStat = await fs.promises.stat(acc);
							} catch (error) {
								// `acc` was resolved by realpath() moments ago, but a
								// concurrent process can remove the component between that
								// realpath and this stat. The `..` still requires `acc` to
								// be a traversable directory to pop its parent, and that
								// requirement provably cannot hold once the component is
								// gone. Surface ENOTDIR here instead of letting the ENOENT
								// reach the outer catch, which would swallow it and return
								// the chain head — clobbering config.yml itself.
								if (!isEnoent(error)) throw error;
								const notDir = new Error(
									`ENOTDIR: symlink target requires a directory but ${acc} is gone for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							if (!accStat.isDirectory()) {
								const notDir = new Error(
									`ENOTDIR: symlink target requires a directory but ${acc} is not one for ${filePath}`,
								) as Error & { code?: string };
								notDir.code = "ENOTDIR";
								throw notDir;
							}
							acc = path.dirname(acc);
							continue;
						}
						if (frozen) {
							acc = path.join(acc, segment);
							continue;
						}
						const candidate = path.join(acc, segment);
						try {
							acc = await fs.promises.realpath(candidate);
						} catch (error) {
							if (!isEnoent(error)) throw error;
							acc = candidate;
							frozen = true;
						}
					}
					const resolved = acc;
					let nextIsSymlink = false;
					try {
						nextIsSymlink = (await fs.promises.lstat(resolved)).isSymbolicLink();
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					if (!nextIsSymlink) return resolved;
					current = resolved;
				}
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

	/**
	 * `rejectNewWarnings` fails the read (without logging the warnings) when a
	 * project settings file newly fails to parse, so a keep-last-good reload can
	 * retain the previous project layer. `cwd` (default: the current scope)
	 * selects the project to read. The read leaves the project fields untouched:
	 * the caller commits the result (`#commitProjectRead`, `warningsSeen`
	 * included) only when it adopts the layer.
	 */
	async #readProjectSettings(
		quarantineInvalid: boolean,
		options: { rejectNewWarnings?: boolean; cwd?: string } = {},
	): Promise<ProjectSettingsDiscovery> {
		const cwd = options.cwd ?? this.#cwd;
		// Resolve once: capability discovery, fs-cache invalidation, and the
		// warning prefix below must all derive from the same absolute scope so
		// relative cwds (e.g. ".") produce absolute provider paths that match.
		const discoveryCwd = path.resolve(cwd);
		const projectConfigDir = getProjectAgentDir(cwd);
		const projectConfigPath = path.join(projectConfigDir, "config.yml");
		invalidateCapabilityFsCache(projectConfigPath);
		invalidateCapabilityFsCache(path.join(projectConfigDir, "settings.json"));
		invalidateCapabilityFsCache(path.join(discoveryCwd, ".claude", "settings.json"));
		for (const sourcePath of this.#projectSourcePaths) invalidateCapabilityFsCache(sourcePath);
		let projectItems: SettingsCapabilityItem[] = [];
		let rejectedWarnings: string[] | undefined;
		let warningsSeen = this.#projectSettingsWarningsSeen;
		try {
			const result = await loadCapability(settingsCapability.id, {
				cwd: discoveryCwd,
				includeDisabledProviders: true,
			});
			// `loadCapability` aggregates warnings across every level, but this
			// method only merges project items — user-level parse failures belong
			// to the global layer and would misattribute here. Warnings embed
			// their source file's absolute path, so keep only warnings rooted at
			// the discovery cwd (a bare substring would over-match relative
			// scopes such as `cwd: "."` and sibling dir prefixes). Remember what
			// was surfaced so reloads stay quiet while new failures still log.
			// Level attribution below the path layer (e.g. a user-scoped dir
			// mounted inside the project) needs warning metadata from the
			// providers, which `LoadResult.warnings` does not carry.
			const cwdRoot = discoveryCwd.endsWith(path.sep) ? discoveryCwd : discoveryCwd + path.sep;
			const projectWarnings = (result.warnings ?? []).filter(warning => warning.includes(cwdRoot));
			const newWarnings = projectWarnings.filter(warning => !this.#projectSettingsWarningsSeen.has(warning));
			if (options.rejectNewWarnings && newWarnings.length > 0) {
				rejectedWarnings = newWarnings;
			} else {
				for (const warning of newWarnings) logger.warn(`Settings: ${warning}`);
				warningsSeen = new Set(projectWarnings);
				projectItems = (result.items as SettingsCapabilityItem[]).filter(item => item.level === "project");
			}
		} catch {
			projectItems = [];
			// Capability discovery is best-effort; the native project config below
			// remains authoritative for its model-role layer and must not be hidden.
		}
		if (rejectedWarnings) {
			throw new Error(`Project settings failed to parse: ${rejectedWarnings.join("; ")}`);
		}
		// A native config this instance moved aside reads as missing until a save recreates it;
		// keep its last good contents, as `#saveProjectNow` does.
		const nativeProject = quarantineInvalid
			? await this.#loadYaml(projectConfigPath)
			: (this.#unwrapYamlLoadResult(projectConfigPath, await this.#loadYamlIfPresent(projectConfigPath, false)) ??
				(this.#quarantinedYamlTargets.has(projectConfigPath) ? structuredClone(this.#projectFileSettings) : {}));
		return {
			cwd,
			quarantineInvalid,
			items: projectItems,
			nativeModelRoles: getByPath(nativeProject, ["modelRoles"]),
			fileSettings: structuredClone(nativeProject),
			warningsSeen,
		};
	}

	/**
	 * Merges a project read, leaving out items from providers `disabledProviders` disables. That
	 * setting may come from any layer, the project's own native config included, so it resolves
	 * over `layers` with the merged project; the read itself runs without waiting for them.
	 */
	#resolveProjectRead(read: ProjectSettingsDiscovery, layers: Omit<OwnLayers, "project">): ProjectSettingsReadResult {
		let project = this.#mergeProjectItems(read.items, read.nativeModelRoles);
		const disabled = this.#disabledProviderIds({ ...layers, project: project.settings }, read.cwd);
		if (read.items.some(item => disabled.has(item._source.provider))) {
			const filtered = this.#mergeProjectItems(
				read.items.filter(item => !disabled.has(item._source.provider)),
				read.nativeModelRoles,
			);
			const projectSwitch = getByPath(project.settings, cfgDisabledProviders.segments);
			if (projectSwitch !== undefined) {
				const remaining = this.#disabledProviderIds({ ...layers, project: filtered.settings }, read.cwd);
				// A project provider may disable itself; preserve only its switch when removing
				// its other settings would undo that decision. Do not pin a global/overlay switch.
				let changed = disabled.size !== remaining.size;
				if (!changed) {
					for (const id of disabled) {
						if (!remaining.has(id)) {
							changed = true;
							break;
						}
					}
				}
				if (changed) setByPath(filtered.settings, cfgDisabledProviders.segments, projectSwitch);
			}
			project = filtered;
		}
		return {
			settings: this.#migrateRawSettings(project.settings, read.quarantineInvalid),
			fileSettings: read.fileSettings,
			shellPathSource: project.shellPathSource,
			sourcePaths: [
				...new Set([
					...(read.cwd === this.#cwd ? this.#projectSourcePaths : []),
					...read.items.map(item => item.path),
				]),
			],
			warningsSeen: read.warningsSeen,
		};
	}

	/** Project-level settings `items` merged in discovery order, then the native project config's model roles. */
	#mergeProjectItems(
		items: readonly SettingsCapabilityItem[],
		nativeModelRoles: unknown,
	): { settings: RawSettings; sourcePaths: string[]; shellPathSource: string | undefined } {
		let settings: RawSettings = {};
		const sourcePaths: string[] = [];
		let shellPathSource: string | undefined;
		for (const item of items) {
			settings = this.#deepMerge(settings, dropSettingsGroupShadows(item.data as RawSettings, item.path), {
				arrays: "combine",
			});
			sourcePaths.push(item.path);
			if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
		}
		if (nativeModelRoles !== undefined) settings = this.#deepMerge(settings, { modelRoles: nativeModelRoles });
		return { settings, sourcePaths, shellPathSource };
	}

	/** Provider ids `disabledProviders` resolves to for `cwd` when `layers` are merged (over the overlay parent). */
	#disabledProviderIds(layers: OwnLayers, cwd: string): ReadonlySet<string> {
		const value = configuredValue(this.#mergeOverParent(this.#mergeOwnLayers(layers)), cfgDisabledProviders, cwd);
		return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
	}

	/** Resolves `read` over `layers` (default: this instance's own) and commits it; returns the project layer. */
	#adoptProjectRead(
		read: ProjectSettingsDiscovery,
		layers: Omit<OwnLayers, "project"> = this.#ownLayers(),
	): RawSettings {
		const result = this.#resolveProjectRead(read, layers);
		this.#commitProjectRead(result);
		return result.settings;
	}

	/** Adopts the read-side state of a project read whose layer is being committed. */
	#commitProjectRead(result: ProjectSettingsReadResult): void {
		this.#projectFileSettings = result.fileSettings;
		this.#projectShellPathSource = result.shellPathSource;
		this.#projectSourcePaths = result.sourcePaths;
		this.#projectSettingsWarningsSeen = result.warningsSeen;
	}

	async #readConfigOverlays(captureLegacyChangelogVersion = true): Promise<ConfigOverlayReadResult> {
		let shellPathSource: string | undefined;
		let settings: RawSettings = {};
		for (const filePath of this.#configFiles) {
			const overlay = await this.#loadOverlayYaml(filePath, captureLegacyChangelogVersion);
			settings = this.#deepMerge(settings, overlay, { arrays: "combine" });
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
		let migratedSettingsJson = false;

		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				migratedSettingsJson = true;
			} else {
				logger.warn("Settings: ignoring non-object legacy settings.json", { path: settingsJsonPath });
			}
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Settings: failed to read legacy settings.json", {
					path: settingsJsonPath,
					error: String(error),
				});
			}
		}

		try {
			const dbSettings = this.#storage instanceof AgentStorage ? this.#storage.getSettings() : null;
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch (error) {
			logger.warn("Settings: failed to read legacy agent.db settings", { error: String(error) });
		}

		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeYamlAtomically(this.#configPath, stringifyYamlConfig(settings));
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch (error) {
				logger.warn("Settings: failed to write migrated config.yml", {
					path: this.#configPath,
					error: String(error),
				});
				return;
			}

			if (migratedSettingsJson) {
				try {
					await fs.promises.rename(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch (error) {
					logger.warn("Settings: failed to archive settings.json after migration", {
						path: settingsJsonPath,
						error: String(error),
					});
				}
			}

			try {
				if (this.#storage instanceof AgentStorage) this.#storage.clearMigratedSettings();
			} catch (error) {
				logger.warn("Settings: failed to clear migrated agent.db settings", { error: String(error) });
			}
		}
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings, captureLegacyChangelogVersion = true): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}
		// doubleEscapeAction: legacy "branch" -> "rewind". The old branch backtrack
		// was superseded by the in-transcript rewind selector; "tree" survives as a
		// current action (opens the session tree) beside "rewind" and "none".
		if (raw.doubleEscapeAction === "branch") {
			raw.doubleEscapeAction = "rewind";
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

		// Remove the retired image-tool mode settings and preserve its request
		// timeout under the read image-question setting. Nested values win over
		// quoted-dotted legacy values; an existing new setting wins over both.
		const inspectImageObj = isRecord(raw.inspect_image) ? (raw.inspect_image as Record<string, unknown>) : undefined;
		const legacyQuestionTimeoutMs =
			typeof inspectImageObj?.timeoutMs === "number"
				? inspectImageObj.timeoutMs
				: typeof raw["inspect_image.timeoutMs"] === "number"
					? (raw["inspect_image.timeoutMs"] as number)
					: undefined;
		const imagesObj = isRecord(raw.images) ? (raw.images as Record<string, unknown>) : undefined;
		if (legacyQuestionTimeoutMs !== undefined && imagesObj?.questionTimeoutMs === undefined) {
			raw.images = { ...imagesObj, questionTimeoutMs: legacyQuestionTimeoutMs };
		}
		delete raw.inspect_image;
		delete raw["inspect_image.enabled"];
		delete raw["inspect_image.mode"];
		delete raw["inspect_image.timeoutMs"];

		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;

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
		// Handles nested and quoted-dotted sources, like the legacy image settings above.
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
		// Split the legacy combined isolation setting into enablement and backend.
		// Handle both nested YAML and quoted dotted keys. Explicit enabled and
		// backend values win; legacy backend names are normalized everywhere.
		const legacyIsolationBackends: Record<string, string> = {
			worktree: "rcopy",
			"fuse-overlay": "overlayfs",
			"fuse-projfs": "projfs",
		};
		const legacyIsolationModePath = ["task", "isolation", "mode"].join(".");
		const legacyIsolationMode =
			typeof isolationObj?.mode === "string"
				? isolationObj.mode
				: typeof raw[legacyIsolationModePath] === "string"
					? (raw[legacyIsolationModePath] as string)
					: undefined;
		const flatIsolationEnabled = raw["task.isolation.enabled"];
		const explicitIsolationEnabled =
			typeof isolationObj?.enabled === "boolean"
				? isolationObj.enabled
				: typeof flatIsolationEnabled === "boolean"
					? flatIsolationEnabled
					: undefined;
		if (legacyIsolationMode !== undefined || explicitIsolationEnabled !== undefined) {
			if (!isRecord(raw.task)) raw.task = {};
			const targetTask = raw.task as Record<string, unknown>;
			if (!isRecord(targetTask.isolation)) targetTask.isolation = {};
			const targetIsolation = targetTask.isolation as Record<string, unknown>;
			targetIsolation.enabled = explicitIsolationEnabled ?? legacyIsolationMode !== "none";
			delete targetIsolation.mode;
		}
		delete raw[legacyIsolationModePath];
		delete raw["task.isolation.enabled"];

		const rootIsolation = isRecord(raw.isolation) ? (raw.isolation as Record<string, unknown>) : undefined;
		const configuredBackend =
			typeof rootIsolation?.backend === "string"
				? rootIsolation.backend
				: typeof raw["isolation.backend"] === "string"
					? (raw["isolation.backend"] as string)
					: undefined;
		const derivedBackend =
			legacyIsolationMode === undefined || legacyIsolationMode === "none"
				? undefined
				: (legacyIsolationBackends[legacyIsolationMode] ?? legacyIsolationMode);
		const backend = configuredBackend ?? derivedBackend;
		if (backend !== undefined) {
			if (!rootIsolation) raw.isolation = {};
			(raw.isolation as Record<string, unknown>).backend = legacyIsolationBackends[backend] ?? backend;
		}
		delete raw["isolation.backend"];

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

		// find.enabled: boolean -> enum (auto | on | off). Preserve an explicit
		// choice; unset installs get `auto`, which enables `find` only when the
		// judge role resolves to a native System One model.
		const findObj = isRecord(raw.find) ? raw.find : undefined;
		if (findObj && typeof findObj.enabled === "boolean") {
			findObj.enabled = findObj.enabled ? "on" : "off";
		}
		if (typeof raw["find.enabled"] === "boolean") {
			raw["find.enabled"] = raw["find.enabled"] ? "on" : "off";
		}

		// spelling.autocomplete: boolean -> engine enum. `true` was the macOS
		// dictionary completion, which the cross-platform `auto` engine replaces.
		const spellingObj = isRecord(raw.spelling) ? raw.spelling : undefined;
		if (spellingObj && typeof spellingObj.autocomplete === "boolean") {
			spellingObj.autocomplete = spellingObj.autocomplete ? "auto" : "off";
		}
		if (typeof raw["spelling.autocomplete"] === "boolean") {
			raw["spelling.autocomplete"] = raw["spelling.autocomplete"] ? "auto" : "off";
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

		// Retired local title models (replaced by the LFM2.5/Falcon refresh) map to
		// their closest current equivalents. Without this a pinned retired key
		// passes through as a stale string and title generation silently skips
		// every turn instead of falling back (no online fallback by design).
		const RETIRED_TINY_TITLE_MODELS: Record<string, string> = {
			"lfm2-350m": "lfm2.5-350m",
			"lfm2-700m": "lfm2.5-350m",
			"qwen3-0.6b": "lfm2.5-350m",
			"qwen2.5-0.5b": "lfm2.5-230m",
			"gemma-270m": "falcon-h1-90m",
		};
		const migrateTinyModelValue = (value: unknown): string | undefined =>
			typeof value === "string" ? RETIRED_TINY_TITLE_MODELS[value] : undefined;
		// Quoted-dotted flat keys (`"providers.tinyModel"` in YAML/legacy JSON)
		// promote into the nested setting; nested wins when both are present.
		const flatTinyModel = migrateTinyModelValue(raw["providers.tinyModel"]);
		if (flatTinyModel !== undefined) {
			const providersRoot = isRecord(raw.providers) ? raw.providers : {};
			if (typeof providersRoot.tinyModel !== "string") providersRoot.tinyModel = flatTinyModel;
			raw.providers = providersRoot;
			delete raw["providers.tinyModel"];
		}
		if (providersObj) {
			const migrated = migrateTinyModelValue(providersObj.tinyModel);
			if (migrated !== undefined) providersObj.tinyModel = migrated;
		}

		// Legacy single saved-reset `autoRedeem` (boolean or tri-state) -> the 5h and
		// weekly window keys not set yet. The Fable window is new and stays `unset`.
		for (const group of ["codexResets", "claudeResets"] as const) {
			const nested = isRecord(raw[group]) ? raw[group] : undefined;
			const dotted = `${group}.autoRedeem`;
			const legacy = nested?.autoRedeem ?? raw[dotted];
			if (nested) delete nested.autoRedeem;
			delete raw[dotted];
			if (legacy === undefined) continue;
			const mode = typeof legacy === "boolean" ? (legacy ? "yes" : "no") : legacy;
			for (const key of ["autoRedeem5h", "autoRedeemWeekly"]) {
				if (nested?.[key] !== undefined || raw[`${group}.${key}`] !== undefined) continue;
				if (nested) nested[key] = mode;
				else raw[`${group}.${key}`] = mode;
			}
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
			// mentalModelRefreshIntervalMs removed: the mental-model block is now
			// frozen for the session lifetime rather than re-listed on a timer that
			// rewrote the cached prompt prefix mid-session (#11961).
			delete hindsightObj.mentalModelRefreshIntervalMs;
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

		// Migration for renamed settings grep.* from search.*. (`find.*` is no
		// longer migrated to `glob.*`: `find` is the semantic search tool now.)
		// 1. Nested settings: search -> grep (per-property merge to avoid clobbering)
		const ensureRawObject = (key: "grep"): Record<string, unknown> => {
			const current = raw[key];
			if (isRecord(current)) {
				return current;
			}
			const created: Record<string, unknown> = {};
			raw[key] = created;
			return created;
		};

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

		// task.completionProbeMs (poll period, 0 = off) → task.completionProbe
		// (on/off with a built-in backoff schedule). Mapped IN THE SAME LAYER so a
		// project-level `0` keeps overriding a global period; an explicit new key wins.
		{
			const taskObj = isRecord(raw.task) ? raw.task : undefined;
			const legacyProbeMs =
				taskObj && "completionProbeMs" in taskObj ? taskObj.completionProbeMs : raw["task.completionProbeMs"];
			if (typeof legacyProbeMs === "number") {
				const target = taskObj ?? {};
				if (!("completionProbe" in target) && !("task.completionProbe" in raw)) {
					target.completionProbe = legacyProbeMs > 0;
				}
				raw.task = target;
			}
			if (taskObj) delete taskObj.completionProbeMs;
			delete raw["task.completionProbeMs"];
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

		// Retired provider/model selectors now live in modelRoles plus explicit
		// retry chains. Read nested and quoted-dotted forms from the same layer;
		// an owned nested key wins even when its value is undefined. Every legacy
		// key is removed after inspection so it cannot leak back into config.yml.
		function migrateKindRoleSettings(): void {
			const providerSettings = isRecord(raw.providers) ? raw.providers : undefined;
			const ttsSettings = isRecord(raw.tts) ? raw.tts : undefined;
			const sttSettings = isRecord(raw.stt) ? raw.stt : undefined;
			const legacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): unknown =>
				root && Object.hasOwn(root, key) ? root[key] : raw[flatKey];
			const removeLegacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): void => {
				if (root) delete root[key];
				delete raw[flatKey];
			};
			const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

			const roles = isRecord(raw.modelRoles) ? raw.modelRoles : {};
			const retrySettings = isRecord(raw.retry) ? raw.retry : {};
			const fallbackChains = isRecord(retrySettings.fallbackChains) ? retrySettings.fallbackChains : {};
			let rolesChanged = false;
			let fallbackChainsChanged = false;
			const setRoleChain = (role: string, candidates: readonly string[]): void => {
				if (candidates.length === 0) return;
				if (!Object.hasOwn(roles, role)) {
					roles[role] = candidates[0];
					rolesChanged = true;
				}
				if (!Object.hasOwn(fallbackChains, role)) {
					fallbackChains[role] = candidates.slice(1);
					fallbackChainsChanged = true;
				}
			};

			const legacyWebSearch = legacy(providerSettings, "webSearch", "providers.webSearch");
			const legacyWebOrder = legacy(providerSettings, "webSearchOrder", "providers.webSearchOrder");
			const legacyWebExclude = legacy(providerSettings, "webSearchExclude", "providers.webSearchExclude");
			const legacyGeminiModel = legacy(providerSettings, "webSearchGeminiModel", "providers.webSearchGeminiModel");
			// Legacy settings named a provider; its swap target is the catalog's
			// resolved per-model policy (`web-search-model` / `image-model` / tts
			// seed kind), uniform across that provider's bundled rows.
			const bundledSelector = (
				provider: string,
				pick: (model: Model<Api>) => string | undefined,
			): string | undefined => {
				for (const model of getBundledModels(provider as GeneratedProvider)) {
					const id = pick(model);
					if (id) return `${provider}/${id}`;
				}
				return undefined;
			};
			const webSearchSelector = (provider: string): string[] => {
				const selector = bundledSelector(provider, model => model.webSearchModel);
				return selector ? [selector] : [];
			};
			const geminiSelectors = (model: string): string[] => [
				`google-gemini-cli/${model}`,
				`google-antigravity/${model}`,
				`google/${model}`,
			];
			const webSelectors = (provider: string, geminiModel: string): string[] => {
				switch (provider) {
					case "gemini":
						return geminiSelectors(geminiModel);
					case "anthropic":
						return webSearchSelector("anthropic");
					case "codex":
						return webSearchSelector("openai-codex");
					case "xai":
						return webSearchSelector("xai");
					case "auto":
						return [];
					default:
						return isRegisteredSearchEngine(provider) ? [`web/${provider}`] : [];
				}
			};
			const geminiModel =
				typeof legacyGeminiModel === "string" && legacyGeminiModel.trim()
					? legacyGeminiModel.trim()
					: (getBundledModels("google").find(model => model.webSearchModel)?.webSearchModel ?? "");
			const excludedWebProviders = new Set(
				Array.isArray(legacyWebExclude)
					? legacyWebExclude.filter(
							(value): value is string =>
								typeof value === "string" && webSelectors(value, geminiModel).length > 0,
						)
					: [],
			);
			const isWebSelectorExcluded = (selector: string): boolean => {
				if (excludedWebProviders.has("gemini") && geminiSelectors(geminiModel).includes(selector)) return true;
				if (excludedWebProviders.has("anthropic") && selector.startsWith("anthropic/")) return true;
				if (excludedWebProviders.has("codex") && selector.startsWith("openai-codex/")) return true;
				if (excludedWebProviders.has("xai") && (selector.startsWith("xai/") || selector.startsWith("xai-oauth/"))) {
					return true;
				}
				for (const provider of excludedWebProviders) {
					if (selector === `web/${provider}`) return true;
				}
				return false;
			};
			const orderedWebProviders = Array.isArray(legacyWebOrder)
				? legacyWebOrder
				: typeof legacyWebSearch === "string" && legacyWebSearch !== "auto"
					? [legacyWebSearch]
					: [];
			const orderedWebSelectors = orderedWebProviders.flatMap(value =>
				typeof value === "string" ? webSelectors(value, geminiModel) : [],
			);
			// The Gemini model only shapes an ordered `gemini` entry; the defaults hold no chat models.
			if (orderedWebSelectors.length > 0 || excludedWebProviders.size > 0) {
				setRoleChain(
					"web",
					dedupe([...orderedWebSelectors, ...roleDefaultModels().web]).filter(
						selector => !isWebSelectorExcluded(selector),
					),
				);
			}

			const legacyImage = legacy(providerSettings, "image", "providers.image");
			const legacyImageOrder = legacy(providerSettings, "imageOrder", "providers.imageOrder");
			const legacyImageProviders: Record<string, string> = {
				openai: "openai",
				"openai-codex": "openai-codex",
				antigravity: "google-antigravity",
				xai: "xai",
				gemini: "google",
				deepinfra: "deepinfra",
			};
			const imageSelector = (provider: string): string | undefined => {
				// OpenRouter rows carry no gemini image-model swap (the gemini class
				// binds to Google transports only), so its legacy target stays literal.
				if (provider === "openrouter") return "openrouter/google/gemini-3-pro-image";
				const catalogProvider = legacyImageProviders[provider];
				return catalogProvider ? bundledSelector(catalogProvider, model => model.imageModel) : undefined;
			};
			const orderedImageProviders = Array.isArray(legacyImageOrder)
				? legacyImageOrder
				: typeof legacyImage === "string" && legacyImage !== "auto"
					? [legacyImage]
					: [];
			const orderedImageSelectors = orderedImageProviders.flatMap(value =>
				typeof value === "string" ? (imageSelector(value) ?? []) : [],
			);
			if (orderedImageSelectors.length > 0) {
				setRoleChain("image", dedupe([...orderedImageSelectors, ...roleDefaultModels().image]));
			}

			const legacyTtsProvider = legacy(providerSettings, "tts", "providers.tts");
			const speechSelector =
				legacyTtsProvider === "local" || legacyTtsProvider === "xai" || legacyTtsProvider === "deepinfra"
					? bundledSelector(legacyTtsProvider, model => (modelKind(model) === "tts" ? model.id : undefined))
					: undefined;
			if (speechSelector) setRoleChain("speech", [speechSelector]);

			const legacySttModel = legacy(sttSettings, "modelName", "stt.modelName");
			const dictationSelector =
				legacySttModel === "fast" || legacySttModel === "whisper-base"
					? "local/whisper-base"
					: legacySttModel === "balanced" || legacySttModel === "whisper-small"
						? "local/whisper-small"
						: legacySttModel === "turbo" || legacySttModel === "whisper-large-v3-turbo"
							? "local/whisper-large-v3-turbo"
							: undefined;
			if (dictationSelector && !Object.hasOwn(roles, "dictation")) {
				roles.dictation = dictationSelector;
				rolesChanged = true;
			}

			const legacyJudgmentProvider = legacy(providerSettings, "judgmentProvider", "providers.judgmentProvider");
			const legacyAutoThinkingModel = legacy(providerSettings, "autoThinkingModel", "providers.autoThinkingModel");
			const legacyUnexpectedStopModel = legacy(
				providerSettings,
				"unexpectedStopModel",
				"providers.unexpectedStopModel",
			);
			const nonDefaultJudge =
				(typeof legacyJudgmentProvider === "string" && legacyJudgmentProvider !== "auto") ||
				(typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") ||
				(typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online");
			if (nonDefaultJudge) {
				const judgeCandidates: string[] = [];
				if (legacyJudgmentProvider !== "llm") judgeCandidates.push("typesafe/jev-1.14.0");
				if (typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") {
					judgeCandidates.push(`local/${legacyAutoThinkingModel}`);
				}
				if (typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online") {
					judgeCandidates.push(`local/${legacyUnexpectedStopModel}`);
				}
				judgeCandidates.push("@tiny", "@smol", "@default");
				setRoleChain("judge", dedupe(judgeCandidates));
			}

			const prependLocalRole = (role: "tiny" | "memory", model: unknown): void => {
				if (typeof model !== "string" || model === "online" || model.length === 0) return;
				const selector = `local/${model}`;
				const configured = typeof roles[role] === "string" ? roles[role] : undefined;
				const patterns = configured
					? configured
							.split(",")
							.map(pattern => pattern.trim())
							.filter(Boolean)
					: [];
				roles[role] = dedupe([selector, ...patterns]).join(",");
				rolesChanged = true;
			};
			prependLocalRole("tiny", legacy(providerSettings, "tinyModel", "providers.tinyModel"));
			prependLocalRole("memory", legacy(providerSettings, "memoryModel", "providers.memoryModel"));

			for (const key of [
				"webSearch",
				"webSearchOrder",
				"webSearchExclude",
				"webSearchGeminiModel",
				"image",
				"imageOrder",
				"tts",
				"judgmentProvider",
				"autoThinkingModel",
				"unexpectedStopModel",
				"tinyModel",
				"memoryModel",
			]) {
				removeLegacy(providerSettings, key, `providers.${key}`);
			}
			removeLegacy(ttsSettings, "localModel", "tts.localModel");
			removeLegacy(sttSettings, "modelName", "stt.modelName");

			if (rolesChanged) raw.modelRoles = roles;
			if (fallbackChainsChanged) {
				retrySettings.fallbackChains = fallbackChains;
				raw.retry = retrySettings;
			}
			if (providerSettings && Object.keys(providerSettings).length === 0) delete raw.providers;
			if (ttsSettings && Object.keys(ttsSettings).length === 0) delete raw.tts;
			if (sttSettings && Object.keys(sttSettings).length === 0) delete raw.stt;
		}
		migrateKindRoleSettings();

		// The old web-provider migration persisted this pair of fuzzy defaults.
		// Qualified selectors are now exact, so replace the pair without changing
		// independently configured selectors or other role chains.
		{
			const retry = isRecord(raw.retry) ? raw.retry : undefined;
			const chains = retry && isRecord(retry.fallbackChains) ? retry.fallbackChains : undefined;
			const web = chains?.web;
			if (chains && Array.isArray(web)) {
				const index = web.findIndex(
					(selector, i) => selector === "openai-codex/gpt-5.6" && web[i + 1] === "openai-codex/gpt-5.5",
				);
				if (index !== -1) {
					chains.web = [...web.slice(0, index), "openai-codex/gpt-5.6-sol", ...web.slice(index + 2)];
				}
			}
		}

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

		delete raw["hindsight.mentalModelRefreshIntervalMs"];

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

	async #writeYamlAtomically(filePath: string, content: string): Promise<void> {
		await writeFileAtomically(filePath, content);
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		// Debounce: wait 100ms for more changes
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#chainSave().catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	/**
	 * Runs {@link #saveNow} after the in-flight save, so saves never overlap: every global write
	 * made after a save's snapshot is still pending when that save adopts the file.
	 */
	#chainSave(): Promise<void> {
		const previousSave = this.#savePromise;
		const savePromise = previousSave ? previousSave.then(() => this.#saveNow()) : this.#saveNow();
		this.#savePromise = savePromise;
		const settle = () => {
			if (this.#savePromise === savePromise) this.#savePromise = undefined;
		};
		savePromise.then(settle, settle);
		return savePromise;
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
				const writtenPaths: (readonly string[])[] = [];

				// Apply pending changes unless a newer file generation also
				// changed that setting. Disjoint external edits still merge.
				for (const [modKey, segments] of modifiedPaths) {
					const mutation = modifiedPathMutations.get(modKey);
					if (!pendingChangeApplies(mutation, segments, current, loaded.generation, writtenPaths)) {
						logger.warn("Settings: skipped stale change after external config edit", {
							path: configPath,
							setting: segments.join("."),
						});
						continue;
					}
					const value = getByPath(this.#global, segments);
					if (value === undefined) deleteByPath(current, segments);
					else setByPath(current, segments, value);
					writtenPaths.push(segments);
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

				if (shouldWrite) {
					// Merging pending changes can reproduce the file exactly (a change reverted before the
					// debounce fired, an external edit that already holds the value): leave it untouched.
					const content = stringifyYamlConfig(current);
					if (loaded.generation.kind !== "content" || loaded.generation.source !== content) {
						await this.#writeYamlAtomically(writePath, content);
					}
				}
				this.#quarantinedYamlTargets.delete(configPath);
				// This write changed the file only at `writtenPaths`. A change staged after this save's snapshot at
				// an overlapping path (the same one, an entry of a record written whole, or the reverse) is dropped
				// once the file holds its live value; otherwise, unless an external edit already conflicts with it,
				// it is rebased onto the file just written, so the next save doesn't take this write for such an edit.
				let writtenGeneration: YamlGeneration | undefined;
				for (const [modKey, segments] of this.#modified) {
					const overlapping = writtenPaths.some(
						other => isPathPrefix(other, segments) || isPathPrefix(segments, other),
					);
					if (!overlapping) continue;
					const written = getByPath(current, segments);
					const mutation = this.#modifiedPathMutations.get(modKey);
					if (settingValuesEqual(getByPath(this.#global, segments), written)) {
						this.#modified.delete(modKey);
						this.#modifiedPathMutations.delete(modKey);
					} else if (pendingChangeApplies(mutation, segments, current, loaded.generation, writtenPaths)) {
						writtenGeneration ??= this.#readYamlGeneration(configPath);
						this.#modifiedPathMutations.set(modKey, {
							generation: writtenGeneration,
							baseValue: structuredClone(written),
						});
					}
				}
				this.#adoptSavedGlobal(current, configPath);
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
			for (const [p, segments] of modifiedPaths) {
				this.#modified.set(p, segments);
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
			throw error;
		}
	}

	/**
	 * Adopts `saved` (config.yml as a save just wrote it) as the live global layer, first
	 * re-applying every global write still pending — made after that save's snapshot, since saves
	 * never overlap ({@link #chainSave}) — so a live value never regresses to its on-disk one. An
	 * invalid result keeps the live layer, which is last good and already holds the save's writes,
	 * like a keep-last-good reload; the file keeps the external edit for the user to fix.
	 * Notifies every setting whose effective value changed.
	 */
	#adoptSavedGlobal(saved: RawSettings, source: string): void {
		this.#applyPendingGlobalWrites(saved);
		this.#keepReadableValues(saved, this.#global, source);
		if (!this.#acceptsLayers({ ...this.#ownLayers(), global: saved }, source)) return;
		const previous = this.#snapshot();
		this.#global = saved;
		this.#rebuildMerged();
		this.#fireChangesSince(previous);
	}

	/** Re-applies every global write still pending a save onto `target`, a global layer read from disk. */
	#applyPendingGlobalWrites(target: RawSettings): void {
		if (this.#modifiedGlobalModelRoles.size > 0) {
			const liveRoles = getByPath(this.#global, ["modelRoles"]);
			const targetRoles = getByPath(target, ["modelRoles"]);
			const roles: Record<string, unknown> = isRecord(targetRoles) ? targetRoles : {};
			for (const role of this.#modifiedGlobalModelRoles) {
				if (isRecord(liveRoles) && Object.hasOwn(liveRoles, role)) roles[role] = liveRoles[role];
				else delete roles[role];
			}
			setByPath(target, ["modelRoles"], roles);
		}
		for (const segments of this.#modified.values()) {
			const value = getByPath(this.#global, segments);
			if (value === undefined) deleteByPath(target, segments);
			else setByPath(target, segments, value);
		}
	}

	/** Re-applies every project model role still pending a save onto `target`, a project layer read from disk. */
	#applyPendingProjectWrites(target: RawSettings): void {
		const liveRoles = getByPath(this.#project, ["modelRoles"]);
		for (const role of this.#modifiedProjectModelRoles) {
			setByPath(target, ["modelRoles", role], isRecord(liveRoles) ? liveRoles[role] : undefined);
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

		const projectConfigPath = path.join(getProjectAgentDir(this.#cwd), "config.yml");
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

				await this.#writeYamlAtomically(writePath, stringifyYamlConfig(projectSettings));
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

	/** Re-merges after a change to this instance's own layers or scope, then tells {@link onLayersChange} observers. */
	#rebuildMerged(): void {
		this.#remerge();
		this.#layerGeneration++;
		if (this.#layerListeners.size === 0) return;
		for (const listener of Array.from(this.#layerListeners)) {
			try {
				listener();
			} catch (error) {
				logger.warn("Settings: layer-change listener failed", { error: String(error) });
			}
		}
	}

	/** Rebuilds the merged view from the own layers over the parent's current view. */
	#remerge(): void {
		this.#revision++;
		if (this.#parent) this.#syncedParentRevision = this.#parent.revision;
		this.#merged = this.#mergeOverParent(this.#mergeOwnLayers(this.#ownLayers()));
	}

	#ownLayers(): OwnLayers {
		return {
			global: this.#global,
			project: this.#project,
			configOverlay: this.#configOverlay,
			overrides: this.#overrides,
		};
	}

	/** `layers` (global, project, `--config` overlay, runtime) merged in precedence order. */
	#mergeOwnLayers(layers: OwnLayers): RawSettings {
		let merged = this.#deepMerge(this.#deepMerge({}, layers.global), projectLayerForMerge(layers.project), {
			arrays: "layer",
		});
		merged = this.#deepMerge(merged, layers.configOverlay, { arrays: "layer" });
		return this.#deepMerge(merged, layers.overrides);
	}

	/** `own` merged over an overlay parent's current view (itself for a root instance). */
	#mergeOverParent(own: RawSettings): RawSettings {
		return this.#parent ? this.#deepMerge(this.#parent.#mergedView(), own) : own;
	}

	/**
	 * Checks every value configured in `merged` (path-scoped entries resolved for `cwd`) against its
	 * definition: `validate` throws, unknown `items` warn. Defaults to the live layers.
	 */
	#validateAll(merged: RawSettings = this.#mergedView(), cwd: string = this.#cwd): void {
		for (const setting of allSettings()) setting.checkConfigured(this, configuredValue(merged, setting, cwd));
	}

	/**
	 * `overrides` deep-merged over `base`. Keys follow the higher layer's order, then base-only keys:
	 * record order is meaningful to some consumers (`retry.fallbackChains` is searched in order).
	 * `arrays` decides how an array setting declaring `merge` combines with the lower value:
	 *  - `"replace"` (default): the higher array replaces it, like every other value.
	 *  - `"combine"`: the setting's `merge` strategy applies over the lower array as found.
	 *  - `"layer"`: as `"combine"`, and a lower layer leaving the setting unset (or `null`) contributes its default.
	 * `prefix` is the dotted path of `base`/`overrides` within the settings tree.
	 */
	#deepMerge(
		base: RawSettings,
		overrides: RawSettings,
		options: { readonly arrays?: "replace" | "combine" | "layer"; readonly prefix?: string } = {},
	): RawSettings {
		const { arrays = "replace", prefix = "" } = options;
		const result: RawSettings = {};
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = Object.hasOwn(base, key) ? base[key] : undefined;

			if (override === undefined) continue;
			const settingPath = prefix ? `${prefix}.${key}` : key;

			const isOverrideRecord = typeof override === "object" && override !== null && !Array.isArray(override);
			const isBaseRecord = typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal);
			if (
				isOverrideRecord &&
				(isBaseRecord ||
					(arrays === "layer" && baseVal === undefined && Object.hasOwn(settingsGroupOnlyPrefixes(), settingPath)))
			) {
				setOwn(
					result,
					key,
					this.#deepMerge((isBaseRecord ? baseVal : {}) as RawSettings, override as RawSettings, {
						arrays,
						prefix: settingPath,
					}),
				);
			} else if (arrays !== "replace" && Array.isArray(override)) {
				const setting = lookupSetting(settingPath);
				const strategy = setting?.definition.type === "array" ? setting.definition.merge : undefined;
				const fallbackBase =
					arrays === "layer" &&
					(baseVal === undefined || baseVal === null) &&
					override.length > 0 &&
					setting?.definition.type === "array"
						? setting.default
						: undefined;
				// A scoped-only lower list stands for its entries plus the default; keep that once higher entries join it.
				const effectiveBase = Array.isArray(baseVal)
					? setting
						? [...baseVal, ...scopedListDefault(setting, baseVal)]
						: baseVal
					: fallbackBase;
				if (override.length > 0 && strategy === "prepend" && Array.isArray(effectiveBase)) {
					setOwn(result, key, [...override, ...effectiveBase]);
				} else if (override.length > 0 && strategy === "append" && Array.isArray(effectiveBase)) {
					setOwn(result, key, [...effectiveBase, ...override]);
				} else {
					setOwn(result, key, override);
				}
			} else {
				setOwn(result, key, override);
			}
		}
		for (const key of Object.keys(base)) if (!Object.hasOwn(result, key)) setOwn(result, key, base[key]);
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Weak registry of every constructed instance except in-memory projections, so
 * `resetSettingsForTest` can disarm stray background saves on isolated
 * instances too and {@link findScopedSettings} can resolve a session by scope.
 * WeakRefs never retain instances; the set is cleared on every test reset.
 */
const liveSettingsInstances = new Set<WeakRef<Settings>>();

const activeSettingsScope = new AsyncLocalStorage<Settings>();

/**
 * Run extension-owned work with the settings instance of its active session.
 *
 * Legacy Pi extensions synchronously call `SettingsManager.create(ctx.cwd)`;
 * `cwd` alone cannot distinguish concurrent sessions that use different
 * settings for the same project. The async scope supplies that missing session
 * identity without process-global mutation.
 */
export function withActiveSettings<T>(instance: Settings | undefined, fn: () => T): T {
	return instance ? activeSettingsScope.run(instance, fn) : fn();
}

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();
/** Releases the effects hold {@link Settings.installGlobalMirror} took for the current global mirror. */
let releaseGlobalMirrorEffects: (() => void) | undefined;

function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Resolve the settings visible to a legacy Pi `SettingsManager.create()` call.
 *
 * An active extension session is authoritative because `cwd`/`agentDir` cannot
 * uniquely identify concurrent SDK sessions with per-session overrides. Outside
 * extension execution, the most recently constructed matching instance is the
 * best available scope; an unscoped lookup falls back to the global singleton.
 */
export function findScopedSettings(cwd?: string, agentDir?: string): Settings | undefined {
	const active = activeSettingsScope.getStore();
	if (active) return active;

	const wantCwd = cwd === undefined ? undefined : path.normalize(cwd);
	const wantAgentDir = agentDir === undefined ? undefined : path.normalize(agentDir);
	if (wantCwd === undefined && wantAgentDir === undefined) return globalInstance ?? undefined;

	let found: Settings | undefined;
	for (const ref of liveSettingsInstances) {
		const instance = ref.deref();
		if (
			instance &&
			(wantCwd === undefined || instance.getCwd() === wantCwd) &&
			(wantAgentDir === undefined || instance.getAgentDir() === wantAgentDir)
		) {
			found = instance;
		}
	}
	return found;
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
	releaseGlobalMirrorEffects = undefined;
	clearBoundSettingsMethods();
	// Effect-owned process state (theme, redaction, request limits, …) returns to its defaults.
	resetRegistryForTest(Settings.isolated());
}

/**
 * Exposes the dangling-symlink target segment splitter for platform-specific
 * tests: the root-double-count and POSIX-backslash bugs only reproduce with an
 * explicit `path.win32` / `path.posix` engine, which cannot be forced from the
 * host OS otherwise.
 * @internal
 */
export const __physicalTargetSegmentsForTesting = physicalTargetSegments;

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
