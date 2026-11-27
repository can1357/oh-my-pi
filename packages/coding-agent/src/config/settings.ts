/**
 * Layered settings (global config, project, `--config` overlay, runtime overrides). The global and
 * project config files belong to the settings store (`./settings-store`, reached through
 * `settingsLink()`): an instance reads, follows and writes them there and holds no file state of its
 * own; only `--config` overlays are read here. Values are typed and read through registry handles
 * (see `./registry`), declared next to their domain and collected by `./all-settings`:
 *
 *   cfgCompactionEnabled.get(settings);         // sync read
 *   cfgThemeDark.set(settings, "titanium");     // sync write, saved by the store
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { pollFile } from "@oh-my-pi/pi-natives/file-poll";
import {
	expandTilde,
	getAgentDbPath,
	getAgentDir,
	getProjectAgentDir,
	getProjectDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
	pathIsWithinLexical,
	procmgr,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import type { ModelRole } from "../config/model-roles";
import { disposeSettingsLinkForTest, type SettingsSubscription, settingsLink } from "../daemon/modules/settings";
import { cfgShellPath } from "../exec/settings";
import { AgentStorage, type AgentStorageApi } from "../session/agent-storage";
import { deleteByPath, getByPath, type RawSettings, setByPath, setOwn, settingValuesEqual } from "./raw-settings";
import {
	type AnySetting,
	all as allSettings,
	bindEffects,
	inheritWarnings,
	lookup as lookupSetting,
	resetRegistryForTest,
	type ValueCacheEntry,
	type WarnState,
} from "./registry";
// Registers every setting before any instance is read (definitions live next to their domains).
import "./all-settings";
import { cfgDisabledProviders, cfgModelRoles, cfgModelRoleStorage } from "./model-settings";
import { migrateRawSettings } from "./settings-migrations";
import type {
	GlobalDocState,
	ProjectDocState,
	ProjectSettingsItem,
	SettingsDocUpdate,
	SettingsWrite,
} from "./settings-store";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Settings layer that supplies an effective value; see {@link Settings.getProvenance}. */
export type SettingProvenance = "env" | "runtime" | "overlay" | "project" | "global" | "default";

/** A project layer resolved from the store's project document. */
type ProjectSettingsReadResult = {
	settings: RawSettings;
	shellPathSource: string | undefined;
	/** Files that fed the layer, named in log messages. */
	sourcePaths: string[];
};

/** Layer refreshes serialized by `Settings.#exclusive`: strict reloads, watched `--config` overlay reloads, cwd re-scopes. */
type LayerRefreshKind = "strict" | "keep-last-good" | "rescope";

/** Quiet period after the last `--config` overlay change before re-reading the overlays. */
const CONFIG_WATCH_DEBOUNCE_MS = 200;
/** Stat-poll interval for `--config` overlays while {@link Settings.startWatching} is active. */
const CONFIG_POLL_INTERVAL_MS = 500;

type ConfigOverlayReadResult = {
	settings: RawSettings;
	shellPathSource: string | undefined;
};

/** State of a global-document update (the protocol types `state` by the subscription's document kind). */
function globalStateOf(update: SettingsDocUpdate): GlobalDocState {
	return update.state as GlobalDocState;
}

/** State of a project-document update. */
function projectStateOf(update: SettingsDocUpdate): ProjectDocState {
	return update.state as ProjectDocState;
}

/**
 * Closes the store subscriptions of instances dropped without {@link Settings.cancelPendingSaves}
 * (a discarded `cloneForCwd` result): the link reaches an instance only weakly, so collecting it
 * must still release its documents in the store.
 */
const subscriptionFinalizer = new FinalizationRegistry<SettingsSubscription>(subscription => subscription.close());

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
	| { readonly op: "overrideModelRoles"; readonly roles: ReadOnlyDict<string> }
	| {
			readonly op: "overrideModelRolesWhole";
			readonly roles: ReadOnlyDict<string | null>;
			readonly untrusted: boolean;
	  };

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
 * value would shadow an entire settings group. A leaf like `"tui": "fullscreen"`
 * would deep-merge over omp's `tui` group, silently replacing every `tui.*`
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
	return pathIsWithinLexical(normalizePathPrefix(prefix), path.resolve(cwd));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
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
	/** Project settings from .omp/config.yml etc */
	#project: RawSettings = {};
	/** Open global document in the settings store; persisting root instances only. */
	#globalSub: SettingsSubscription | undefined;
	/** Open project document of the current cwd in the settings store; persisting root instances only. */
	#projectSub: SettingsSubscription | undefined;
	/** Last global-document state received from the store (a snapshot's too). */
	#globalState: GlobalDocState | undefined;
	/** Last project-document state received from the store (a snapshot's too). */
	#projectState: ProjectDocState | undefined;
	/** Project-document state the live project layer was last built from; none once a local write moved the layer past it. */
	#projectAdopted: ProjectDocState | undefined;
	/** A strict reload is collecting store states: pushes are recorded, and adopted by the reload — keep-last-good if it fails. */
	#strictReloading = false;
	/** Rejected values and errors already logged while a layer keeps its last good state; see {@link #divergenceIsNew}. */
	#divergenceLogged = new Map<string, string>();
	/** A write of this instance is being handed to the link: pushes are recorded, not adopted. */
	#sending = false;
	/** Extra config.yml-style overlays passed by CLI */
	#configOverlay: RawSettings = {};
	/** Project settings file that most recently supplied shellPath. */
	#projectShellPathSource: string | undefined;
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
	 * Original process-wide model-role overrides captured before a project edit
	 * temporarily replaced them via `#updateRuntimeModelRoleOverride`. Restored
	 * on `reloadForCwd` / `cloneForCwd` so destination projects never inherit the
	 * source-project value. Maps role → original override value (`undefined`
	 * when the role had no runtime override).
	 */
	#savedRuntimeModelRoleOverrides = new Map<string, string | null | undefined>();
	/**
	 * Runtime model-role overrides seeded by {@link overrideModelRolesWhole} from an
	 * untrusted source (a project config's preset): they route this process's session
	 * but are excluded from {@link grantAuthority}, so an untrusted preset never widens
	 * operator-owned model grants. Any later write through a role mutator removes the
	 * role from this set, re-owning it.
	 */
	#untrustedRuntimeModelRoles = new Set<string>();

	/** In-flight layer refresh; concurrent strict reloads share it, others queue behind it. */
	#activeReload?: { kind: LayerRefreshKind; promise: Promise<void> };
	/** Whether {@link startWatching} is active. */
	#watchingFiles = false;
	/** Disposers of the stat polls on `--config` overlay files, keyed by resolved path. */
	#overlayPolls = new Map<string, () => void>();
	/** Debounce timer for poll-triggered overlay reloads. */
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
		const layer = migrateRawSettings(raw);
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
		const layers = { ...this.#ownLayers(), project: {} };
		if (this.#untrustedRuntimeModelRoles.size > 0) {
			const roles = getByPath(this.#overrides, ["modelRoles"]);
			if (isRecord(roles)) {
				// A project preset's values route the session but never grant: drop them so the
				// operator's own layers resurface in the authority view.
				const operatorRoles: Record<string, unknown> = {};
				for (const [role, value] of Object.entries(roles)) {
					if (!this.#untrustedRuntimeModelRoles.has(role)) operatorRoles[role] = value;
				}
				layers.overrides = { ...this.#overrides, modelRoles: operatorRoles };
			}
		}
		const own = this.#mergeOwnLayers(layers);
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
	 * and kept current by {@link applyMirrorState}. It never opens agent.db or settings-store documents.
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
	 * Raw value of `setting` beneath this instance's own runtime overrides: the `--config` overlay,
	 * project and global layers over an overlay parent's view. An override deep-merges over a record
	 * here, so `cfg://` session writes check it before removing record entries. `null` counts as unset.
	 */
	underlyingValue(setting: AnySetting): unknown {
		const layers = this.#mergeOwnLayers({ ...this.#ownLayers(), overrides: {} });
		return configuredValue(this.#mergeOverParent(layers), setting, this.#cwd);
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
	 * global layer (sent to the settings store, which persists it; releases a soft pin, see
	 * {@link pinDefaultValue}) or the runtime-override layer, then notifies change listeners
	 * (process-wide effects apply synchronously). On an {@link overlay} both layers are local to the overlay.
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
		if (layer === "global") {
			// A local-only layer skips re-setting the value it already holds; with a store every write
			// is sent. A soft pin is no persisted value, so a pinned setting is always written.
			if (this.#softPins.has(setting) || !this.#globalWriteIsNoop(setting.segments, value)) {
				this.#stageGlobal(setting.segments, value);
			}
			this.#releaseSoftPin(setting);
		} else {
			setByPath(this.#overrides, setting.segments, value);
		}
		this.#rebuildMerged();
		this.#fireIfChanged(setting, prev);
	}

	/**
	 * Registry plumbing behind `Setting.unset`: removes `setting` from the global layer (the store
	 * persists the removal) and releases its soft pin, so the remaining layers — or else the
	 * default — supply the value.
	 */
	unsetGlobalValue(setting: AnySetting): void {
		if (this.#mirror) return this.#forward(this.#mirror, { op: "unsetGlobalValue", id: setting.id });
		const staged = !this.#globalWriteIsNoop(setting.segments, undefined);
		if (!staged && !this.#softPins.has(setting)) return;
		const prev = setting.get(this);
		this.#releaseSoftPin(setting);
		if (staged) this.#stageGlobal(setting.segments, undefined);
		this.#rebuildMerged();
		this.#fireIfChanged(setting, prev);
	}

	/**
	 * Registry plumbing behind `Setting.setEntry`: writes `value` as the `key` entry of record `setting`
	 * in the global layer (`undefined` removes the entry). The record's other entries, and every entry
	 * another layer supplies, stay untouched, and only that entry is sent to the store; otherwise like a
	 * global {@link writeValue}.
	 *
	 * @throws Error when `setting` is not a record or the entry fails the definition's `validate` check.
	 */
	writeEntry(setting: AnySetting, key: string, value: unknown): void {
		if (setting.type !== "record") throw new Error(`Setting ${setting.id} is not a record`);
		if (this.#mirror) return this.#forward(this.#mirror, { op: "writeEntry", id: setting.id, key, value });
		if (value !== undefined) setting.assertWritable({ [key]: value });
		// On a local-only layer, an entry re-set to its value (or an absent one removed) stages nothing.
		const staged = !this.#globalWriteIsNoop([...setting.segments, key], value);
		if (!staged && !this.#softPins.has(setting)) return;
		const prev = setting.get(this);
		this.#releaseSoftPin(setting);
		if (staged) {
			// Replace rather than mutate the record: the merged view and cached reads may share it.
			const record = getByPath(this.#global, setting.segments);
			if (isRecord(record)) setByPath(this.#global, setting.segments, { ...record });
			this.#stageGlobal([...setting.segments, key], value);
		}
		this.#rebuildMerged();
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
		// The store, when there is one, judges a no-op itself (see #globalWriteIsNoop).
		if (present === member && this.#globalSub === undefined && !this.#softPins.has(setting)) return;
		let next = [...base];
		if (present !== member) next = member ? [...base, item] : base.filter(entry => entry !== item);
		this.writeValue(setting, next, "global");
	}

	/**
	 * Sends the write of `value` at `segments` of the global document (`undefined` removes it) — a
	 * setting, or one entry of a record setting — to the store, and applies it to the live global layer
	 * right away, so reads never wait for the store.
	 */
	#stageGlobal(segments: readonly string[], value: unknown): void {
		this.#send(this.#globalSub, [
			value === undefined ? { segments: [...segments], remove: true } : { segments: [...segments], value },
		]);
		if (value === undefined) deleteByPath(this.#global, segments);
		else setByPath(this.#global, segments, value);
	}

	/**
	 * Whether a global write of `value` at `segments` (`undefined`: a removal) can be skipped here.
	 * Never with a global subscription: the store alone can compare the write against config.yml,
	 * which another process may have changed since this instance last heard from it, so every write
	 * is sent and the store decides. Without one the layer is local to this instance, and a write of
	 * the value it already holds changes nothing.
	 */
	#globalWriteIsNoop(segments: readonly string[], value: unknown): boolean {
		if (this.#globalSub !== undefined) return false;
		if (!settingValuesEqual(getByPath(this.#global, segments), value)) return false;
		const stored = this.#storeGlobal();
		return stored === undefined || settingValuesEqual(getByPath(stored.settings, segments), value);
	}

	/**
	 * Hands `writes` to `subscription`, the store document they belong to (none: the layer is local to
	 * this instance). The link reconciles its state synchronously; an update it raises meanwhile is only
	 * recorded, because the caller applies the same write to the live layer and notifies listeners itself.
	 */
	#send(subscription: SettingsSubscription | undefined, writes: readonly SettingsWrite[]): void {
		if (!subscription) return;
		// The caller applies the write to the live layer, which then is no longer the build of the
		// adopted state: a push of that state (the write reverted on disk) has to be adopted again.
		if (subscription === this.#projectSub) this.#projectAdopted = undefined;
		this.#sending = true;
		try {
			subscription.write(writes);
		} finally {
			this.#sending = false;
		}
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
			this.#untrustedRuntimeModelRoles.clear();
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
	 * `previous` (disk reload, store push, project re-scope).
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

	/** Set once this instance is discarded; it no longer reaches the settings store. */
	#savesCancelled = false;

	/**
	 * Detach this instance from the settings store: its documents are closed and later writes stay
	 * local. Used when an instance is being discarded (test teardown). Writes already sent are the
	 * store's to save; nothing is pending here. Also stops config-file watching.
	 */
	cancelPendingSaves(): void {
		this.#savesCancelled = true;
		this.stopWatching();
		this.#closeSubscriptions();
	}

	/**
	 * Follow on-disk edits live. Asks the settings store to send this instance what it sees change in
	 * config.yml and the project settings files — the store targets pushes per peer, and without this
	 * request sends only the states this instance caused (its writes, its reloads) — and starts
	 * stat-polling the `--config` overlays, which this instance re-reads itself after a debounce.
	 * Whether watching or not, every state the store pushes is adopted on arrival, and like a re-read
	 * overlay applied keep-last-good (a state that fails to load or validate keeps its layer's last
	 * good values; a single value this build cannot read keeps its last good value). Arming an overlay
	 * poll also schedules one re-read, so edits that landed before it went live are not lost. Only the
	 * persisting process-global instance watches; other instances ignore the call. Stopped by
	 * {@link stopWatching} / {@link cancelPendingSaves}.
	 */
	startWatching(): void {
		if (this.#watchingFiles || !this.#persist || this.#savesCancelled || globalInstance !== this) return;
		this.#watchingFiles = true;
		this.#globalSub?.watch(true);
		this.#projectSub?.watch(true);
		this.#syncOverlayPolls();
	}

	/** Stop config-file watching started by {@link startWatching}; idempotent. */
	stopWatching(): void {
		if (this.#watchingFiles) {
			this.#globalSub?.watch(false);
			this.#projectSub?.watch(false);
		}
		this.#watchingFiles = false;
		clearTimeout(this.#watchReloadTimer);
		this.#watchReloadTimer = undefined;
		for (const stop of this.#overlayPolls.values()) stop();
		this.#overlayPolls.clear();
	}

	/** Reconcile the stat polls with the `--config` overlay files; missing ones are polled too, so their creation is seen. */
	#syncOverlayPolls(): void {
		if (!this.#watchingFiles) return;
		const files = new Set(this.#configFiles);
		for (const [file, stop] of this.#overlayPolls) {
			if (files.has(file)) continue;
			stop();
			this.#overlayPolls.delete(file);
		}
		let armed = false;
		for (const file of files) {
			if (this.#overlayPolls.has(file)) continue;
			this.#overlayPolls.set(
				file,
				pollFile(file, () => this.#scheduleOverlayReload(), CONFIG_POLL_INTERVAL_MS),
			);
			armed = true;
		}
		// The overlays were last read before a new poll took its first stat,
		// which is its baseline: a write in between raises no change. Re-read
		// once; the next sync adds nothing new, so it settles.
		if (armed) this.#scheduleOverlayReload();
	}

	#scheduleOverlayReload(): void {
		if (!this.#watchingFiles) return;
		clearTimeout(this.#watchReloadTimer);
		this.#watchReloadTimer = setTimeout(() => {
			this.#watchReloadTimer = undefined;
			void this.#reloadOverlaysFromWatch();
		}, CONFIG_WATCH_DEBOUNCE_MS);
		this.#watchReloadTimer.unref();
	}

	async #reloadOverlaysFromWatch(): Promise<void> {
		if (!this.#watchingFiles) return;
		try {
			await this.#exclusive("keep-last-good", async () => {
				let overlay: ConfigOverlayReadResult;
				try {
					overlay = await this.#readConfigOverlays();
				} catch (error) {
					logger.warn("Settings: keeping last good config; on-disk change failed to load", {
						error: String(error),
					});
					return;
				}
				this.#adoptLive({ overlay });
			});
		} catch (error) {
			logger.warn("Settings: failed to apply on-disk config change", { error: String(error) });
		}
	}

	/** Makes `subscription` this instance's open `kind` document and adopts every state the store pushes for it. */
	#attach(kind: "global" | "project", subscription: SettingsSubscription): void {
		if (kind === "global") this.#globalSub = subscription;
		else this.#projectSub = subscription;
		// Weak: the link outlives discarded instances (see `subscriptionFinalizer`).
		const ref = new WeakRef(this);
		subscription.onUpdate(() => {
			const instance = ref.deref();
			if (instance) instance.#onStoreUpdate(kind, subscription);
		});
		subscriptionFinalizer.register(this, subscription, subscription);
	}

	/** Closes an attached `subscription`, unregistering it first so its finalizer never closes it a second time. */
	#closeSubscription(subscription: SettingsSubscription): void {
		subscriptionFinalizer.unregister(subscription);
		subscription.close();
	}

	/** Closes both store documents; their last states stay recorded. */
	#closeSubscriptions(): void {
		const globalSub = this.#globalSub;
		const projectSub = this.#projectSub;
		this.#globalSub = undefined;
		this.#projectSub = undefined;
		if (globalSub) this.#closeSubscription(globalSub);
		if (projectSub) this.#closeSubscription(projectSub);
	}

	/** Latest state of the global document: the open subscription's (this instance's unacked writes applied), else the last recorded one. */
	#storeGlobal(): GlobalDocState | undefined {
		return this.#globalSub ? globalStateOf(this.#globalSub.update) : this.#globalState;
	}

	/** Latest state of the project document, like {@link #storeGlobal}. */
	#storeProject(): ProjectDocState | undefined {
		return this.#projectSub ? projectStateOf(this.#projectSub.update) : this.#projectState;
	}

	/** Main config file the store reports for `state`; the default one when the document has none yet. */
	#configPathOf(state: GlobalDocState): string {
		return state.configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
	}

	/**
	 * A state the store pushed for `subscription`: another process's write, a watched file edit, or this
	 * instance's own write coming back saved. Recorded only while a strict reload collects states (it
	 * adopts them when it ends) or a write of this instance is being sent; otherwise applied
	 * keep-last-good, like a watched edit.
	 */
	#onStoreUpdate(kind: "global" | "project", subscription: SettingsSubscription): void {
		if (kind === "global") {
			if (this.#globalSub !== subscription) return;
			const state = globalStateOf(subscription.update);
			this.#globalState = state;
			if (!this.#strictReloading && !this.#sending) this.#adoptStoreStates(state, undefined);
			return;
		}
		if (this.#projectSub !== subscription) return;
		const state = projectStateOf(subscription.update);
		this.#projectState = state;
		if (!this.#strictReloading && !this.#sending) this.#adoptStoreStates(undefined, state);
	}

	/**
	 * Applies store states keep-last-good, leaving out each one the live layers already hold: a global
	 * state equal to the live global layer (the usual push: this instance's own write acknowledged), a
	 * project state equal to the one the live project layer was built from. With nothing left, nothing
	 * is resolved, rebuilt, or notified.
	 */
	#adoptStoreStates(globalState: GlobalDocState | undefined, projectState: ProjectDocState | undefined): void {
		const global =
			globalState &&
			this.#configPathOf(globalState) === this.#configPath &&
			settingValuesEqual(globalState.settings, this.#global)
				? undefined
				: globalState;
		const project = projectState && settingValuesEqual(projectState, this.#projectAdopted) ? undefined : projectState;
		if (!global && !project) return;
		if (project) this.#projectSettingsWarningsSeen = this.#noteProjectState(project, this.#cwd);
		this.#adoptLive({ global, project });
	}

	/**
	 * A project-document state for `cwd` is about to be read into a layer: drops the capability fs
	 * cache of the project's native settings files (discovery in this process must see what the store
	 * saw) and logs each warning not in `seen`, the warnings already surfaced for that scope. Returns
	 * the warnings now surfaced, for the caller to keep with the layer.
	 */
	#noteProjectState(
		state: ProjectDocState,
		cwd: string,
		seen: ReadonlySet<string> = this.#projectSettingsWarningsSeen,
	): Set<string> {
		const projectConfigDir = getProjectAgentDir(cwd);
		invalidateCapabilityFsCache(path.join(projectConfigDir, "config.yml"));
		invalidateCapabilityFsCache(path.join(projectConfigDir, "settings.json"));
		for (const warning of state.warnings) {
			if (!seen.has(warning)) logger.warn(`Settings: ${warning}`);
		}
		return new Set(state.warnings);
	}

	/**
	 * Applies newer persisted layers to the live instance keep-last-good: a store state of the global
	 * (`global`) or project (`project`) document, or re-read `--config` overlays (`overlay`). Each layer
	 * is adopted unless it fails validation, and a value this build cannot read keeps its last good one.
	 * The project layer is resolved last, and again whenever a layer above it was adopted: their
	 * `disabledProviders` decide which providers feed it. Notifies every setting whose effective value changed.
	 */
	#adoptLive(change: { global?: GlobalDocState; overlay?: ConfigOverlayReadResult; project?: ProjectDocState }): void {
		let layers = this.#ownLayers();
		let configPath = this.#configPath;
		let overlayShellPathSource = this.#overlayShellPathSource;
		if (change.global) {
			const settings = structuredClone(change.global.settings);
			const source = this.#configPathOf(change.global);
			this.#keepReadableValues(settings, layers.global, source);
			const trial: OwnLayers = { ...layers, global: settings };
			if (this.#acceptsLayers(trial, source)) {
				layers = trial;
				configPath = source;
			}
		}
		if (change.overlay) {
			const source = this.#configFiles.join(", ");
			this.#keepReadableValues(change.overlay.settings, layers.configOverlay, source);
			const trial: OwnLayers = { ...layers, configOverlay: change.overlay.settings };
			if (this.#acceptsLayers(trial, source)) {
				layers = trial;
				overlayShellPathSource = change.overlay.shellPathSource;
			}
		}
		let projectShellPathSource = this.#projectShellPathSource;
		let projectAdopted = this.#projectAdopted;
		const projectState = change.project ?? this.#storeProject();
		const upperChanged = layers.global !== this.#global || layers.configOverlay !== this.#configOverlay;
		if (projectState && (change.project || upperChanged)) {
			const project = this.#resolveProjectRead(projectState, this.#cwd, layers);
			const source = project.sourcePaths.join(", ") || getProjectAgentDir(this.#cwd);
			const trial: OwnLayers = { ...layers, project: project.settings };
			if (this.#acceptsLayers(trial, source)) {
				layers = trial;
				projectShellPathSource = project.shellPathSource;
				projectAdopted = projectState;
			}
		}
		const settled = this.#settlePins(layers);

		const previous = this.#snapshot();
		this.#configPath = configPath;
		this.#overlayShellPathSource = overlayShellPathSource;
		this.#projectShellPathSource = projectShellPathSource;
		this.#projectAdopted = projectAdopted;
		this.#global = layers.global;
		this.#project = layers.project;
		this.#configOverlay = layers.configOverlay;
		this.#overrides = layers.overrides;
		for (const setting of settled) this.#softPins.delete(setting);
		this.#rebuildMerged();
		this.#fireChangesSince(previous);
	}

	/**
	 * Have the settings store save every write this instance sent it.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#mirror) return this.#forwardRefresh(this.#mirror, { op: "flush" });
		const results = await Promise.allSettled([this.#globalSub?.flush(), this.#projectSub?.flush()]);
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
	}

	/**
	 * Independent instance scoped to `cwd`: same global, `--config` overlay, and runtime layers, the
	 * project layer read for `cwd` (persisted instances, which open their own store documents). An
	 * {@link overlay} clones its parent for `cwd` and re-applies its own layers on top, so inherited
	 * values carry over.
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
			// A detached instance has no store to read the new project from: its clone is in-memory.
			const persist = this.#persist && !this.#savesCancelled;
			cloned = new Settings({
				cwd,
				agentDir: this.#agentDir,
				inMemory: !persist,
			});
			cloned.#storage = this.#storage;
			cloned.#configPath = this.#configPath;
			cloned.#configFiles = [...this.#configFiles];
			cloned.#overlayShellPathSource = this.#overlayShellPathSource;
			if (persist) {
				const [globalSub, projectSub] = await cloned.#openDocs("write", { global: true });
				if (globalSub) cloned.#attach("global", globalSub);
				cloned.#attach("project", projectSub);
			} else {
				cloned.#project = structuredClone(this.#project);
				cloned.#projectShellPathSource = this.#projectShellPathSource;
			}
		}
		try {
			const projectState = cloned.#storeProject();
			if (projectState) {
				cloned.#projectSettingsWarningsSeen = cloned.#noteProjectState(projectState, cloned.#cwd);
				const project = cloned.#resolveProjectRead(projectState, cloned.#cwd, {
					global: this.#global,
					configOverlay: this.#configOverlay,
					overrides: this.#overrides,
				});
				cloned.#project = project.settings;
				cloned.#projectAdopted = projectState;
				cloned.#projectShellPathSource = project.shellPathSource;
			}
			// The clone starts from this instance's live global layer (last good values included) and
			// follows the store from its next push on.
			cloned.#global = structuredClone(this.#global);
			cloned.#configOverlay = structuredClone(this.#configOverlay);
			// A soft-pinned default yields to a value the clone's own scope configures.
			cloned.#softPins = new Set(this.#softPins);
			const layers = { ...cloned.#ownLayers(), overrides: this.#buildOriginalOverrides() };
			for (const setting of cloned.#settlePins(layers)) cloned.#softPins.delete(setting);
			cloned.#overrides = layers.overrides;
			cloned.#untrustedRuntimeModelRoles = new Set(this.#untrustedRuntimeModelRoles);
			cloned.#rebuildMerged();
			inheritWarnings(cloned, this);
			cloned.#validateAll();
		} catch (error) {
			cloned.#closeSubscriptions();
			throw error;
		}
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
	 * `validate` check; the previous layers stay in effect, except that a global or project
	 * state the store delivered during the reload is still applied keep-last-good, as a
	 * watched edit would be.
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
		await this.#exclusive("strict", () => this.#reloadStrict());
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

	/**
	 * Strict reload: the store re-reads both documents while the `--config` overlays are re-read here,
	 * and the layers are replaced only when every source loaded and the result validates. Store pushes
	 * arriving meanwhile are only recorded; the layers are built from the latest states afterwards,
	 * which carry every write this instance made during the reload. A reload that fails still adopts
	 * those states, keep-last-good: the store does not push an unchanged file again, so an edit it
	 * delivered during the reload would otherwise never reach the live layers.
	 */
	async #reloadStrict(): Promise<void> {
		this.#strictReloading = true;
		try {
			const [globalResult, projectResult, overlayResult] = await Promise.allSettled([
				this.#globalSub?.reload(),
				this.#projectSub?.reload(),
				this.#readConfigOverlays(),
			]);
			if (globalResult.status === "rejected") throw globalResult.reason;
			if (projectResult.status === "rejected") throw projectResult.reason;
			if (overlayResult.status === "rejected") throw overlayResult.reason;

			const layers: OwnLayers = { ...this.#ownLayers(), configOverlay: overlayResult.value.settings };
			const globalState = this.#globalSub ? this.#storeGlobal() : undefined;
			if (globalState) layers.global = structuredClone(globalState.settings);
			// Resolved over the refreshed global and overlay layers: they decide the project's providers.
			const projectState = this.#projectSub ? this.#storeProject() : undefined;
			// Kept at once: the warnings are surfaced now, whether or not the reload commits.
			if (projectState) this.#projectSettingsWarningsSeen = this.#noteProjectState(projectState, this.#cwd);
			const project = projectState ? this.#resolveProjectRead(projectState, this.#cwd, layers) : undefined;
			if (project) layers.project = project.settings;
			const settled = this.#settlePins(layers);
			this.#validateAll(this.#mergeOverParent(this.#mergeOwnLayers(layers)), this.#cwd);

			const previous = this.#snapshot();
			if (globalState) {
				this.#globalState = globalState;
				this.#configPath = this.#configPathOf(globalState);
			}
			if (project) {
				this.#projectState = projectState;
				this.#projectAdopted = projectState;
				this.#projectShellPathSource = project.shellPathSource;
			}
			this.#overlayShellPathSource = overlayResult.value.shellPathSource;
			this.#global = layers.global;
			this.#project = layers.project;
			this.#configOverlay = layers.configOverlay;
			this.#overrides = layers.overrides;
			for (const setting of settled) this.#softPins.delete(setting);
			this.#rebuildMerged();
			this.#fireChangesSince(previous);
			this.#syncOverlayPolls();
		} catch (error) {
			// The store will not push these again. Adopted while pushes are still only recorded, so
			// each state is applied once; states the live layers already hold are left out.
			try {
				this.#adoptStoreStates(
					this.#globalSub ? this.#storeGlobal() : undefined,
					this.#projectSub ? this.#storeProject() : undefined,
				);
			} catch (adoptError) {
				logger.warn("Settings: failed to apply on-disk config change", { error: String(adoptError) });
			}
			throw error;
		} finally {
			this.#strictReloading = false;
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
			const logKey = `${source}\0${setting.id}`;
			if (next === undefined || next === null || setting.accepts(next)) {
				if (this.#divergenceLogged.size > 0) this.#divergenceLogged.delete(logKey);
				continue;
			}
			const kept = getByPath(live, setting.segments);
			if (kept === undefined || kept === null || !setting.accepts(kept)) continue;
			setByPath(fresh, setting.segments, structuredClone(kept));
			if (!this.#divergenceIsNew(logKey, String(JSON.stringify(next)))) continue;
			logger.warn("Settings: keeping last good value; on-disk value is invalid", {
				path: source,
				setting: setting.id,
				value: next,
				kept,
			});
		}
	}

	/**
	 * Whether the kept-last-good divergence `key` (a source, or one setting of it) was not yet logged
	 * with this `signature` (the rejected value or error). Every store push re-evaluates the same bad
	 * state, so each distinct one is logged once; the entry clears when the source reads cleanly again.
	 */
	#divergenceIsNew(key: string, signature: string): boolean {
		if (this.#divergenceLogged.get(key) === signature) return false;
		this.#divergenceLogged.set(key, signature);
		return true;
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
			this.#divergenceLogged.delete(source);
			return true;
		} catch (error) {
			if (!this.#divergenceIsNew(source, String(error))) return false;
			logger.warn("Settings: keeping last good config; on-disk change is invalid", {
				path: source,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: open the
	 * project document (`.omp/config.yml` etc.) of `cwd` in place of the current one, re-resolve
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
	 * @throws Error when the new project fails to load or a value configured for the new scope fails
	 * its definition's `validate` check; the instance then stays on its previous scope.
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
		let opened: SettingsSubscription | undefined;
		try {
			if (normalized === this.#cwd) return;
			await this.flush();
			// In-memory and detached instances keep their project layer: they have no document to swap.
			if (this.#persist && !this.#savesCancelled) {
				const link = await settingsLink();
				opened = await link.open(
					{ kind: "project", cwd: path.resolve(normalized) },
					{ mode: "write", watch: this.#watchingFiles },
				);
			}
			const layers = {
				global: this.#global,
				configOverlay: this.#configOverlay,
				overrides:
					this.#savedRuntimeModelRoleOverrides.size === 0 ? this.#overrides : this.#buildOriginalOverrides(),
			};
			const projectState = opened ? projectStateOf(opened.update) : undefined;
			// Another project: none of its warnings were surfaced yet.
			const warningsSeen = projectState ? this.#noteProjectState(projectState, normalized, new Set()) : undefined;
			const project = projectState ? this.#resolveProjectRead(projectState, normalized, layers) : undefined;
			const candidate: OwnLayers = { ...layers, project: project?.settings ?? this.#project };
			const settledPins = this.#settlePins(candidate);
			this.#validateAll(this.#mergeOverParent(this.#mergeOwnLayers(candidate)), normalized);

			const previous = this.#snapshot();
			this.#cwd = normalized;
			this.#overrides = candidate.overrides;
			for (const setting of settledPins) this.#softPins.delete(setting);
			this.#savedRuntimeModelRoleOverrides.clear();
			if (opened && project && warningsSeen) {
				// The old project's sent writes are the store's to save; only its pushes end here.
				if (this.#projectSub) this.#closeSubscription(this.#projectSub);
				this.#attach("project", opened);
				opened = undefined;
				this.#projectState = projectState;
				this.#projectAdopted = projectState;
				this.#project = project.settings;
				this.#projectShellPathSource = project.shellPathSource;
				this.#projectSettingsWarningsSeen = warningsSeen;
			}
			this.#rebuildMerged();
			this.#fireChangesSince(previous);
			this.#syncOverlayPolls();
		} catch (error) {
			// A document opened for a scope that was not adopted.
			opened?.close();
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
	 * Raw project settings layer (`.omp/config.yml`, `.omp/settings.json`),
	 * deep-cloned. Companion to {@link getGlobalSettings} for the legacy
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
	 * (`.omp/config.yml` or `.omp/settings.json`, both merged into the project
	 * layer) and no higher user-level layer (a `--config` overlay or a runtime
	 * override) replaces it; otherwise `"user"`.
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
	#setRuntimeModelRoleOverrides(next: Record<string, string | null>): void {
		const prev = cfgModelRoles.get(this);
		setByPath(this.#overrides, ["modelRoles"], next);
		this.#rebuildMerged();
		this.#fireIfChanged(cfgModelRoles, prev);
	}

	/** Runtime model-role override record for whole-map edits, keeping `null` tombstones. */
	#runtimeModelRoleOverridesForEdit(): Record<string, string | null> {
		const value = getByPath(this.#overrides, ["modelRoles"]);
		const roles: Record<string, string | null> = {};
		if (!isRecord(value)) return roles;
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			if (value[role] === null) {
				roles[role] = null;
				continue;
			}
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) roles[role] = modelId;
		}
		return roles;
	}

	#updateRuntimeModelRoleOverride(role: ModelRole | string, modelId: string | undefined): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;

		const nextRuntimeOverride = this.#runtimeModelRoleOverridesForEdit();
		if (modelId === undefined) {
			delete nextRuntimeOverride[role];
		} else {
			nextRuntimeOverride[role] = modelId;
			this.#untrustedRuntimeModelRoles.delete(role);
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
		this.#savedRuntimeModelRoleOverrides.set(role, this.#runtimeModelRoleOverridesForEdit()[role]);
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
		// A cleared role is written as `null`, so the project file keeps saying it falls back to global.
		this.#send(this.#projectSub, [{ segments: ["modelRoles", role], value: modelId }]);
		setByPath(this.#project, ["modelRoles"], current);
		this.#rebuildMerged();
		this.#fireIfChanged(cfgModelRoles, prev);
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
		// A local-only layer skips re-setting the role it holds (or clearing an absent one);
		// the runtime-override sync below still applies.
		if (!this.#globalWriteIsNoop(["modelRoles", role], modelId)) {
			const current = this.#modelRolesFromLayer(this.#global);
			if (modelId === undefined) {
				delete current[role];
			} else {
				current[role] = modelId;
			}
			// Written per role rather than as the whole `modelRoles` record: the store merges only
			// the changed role into the file, so a concurrent edit to a sibling role (another
			// process, an external editor) is not clobbered by this process's snapshot.
			this.#send(this.#globalSub, [
				modelId === undefined
					? { segments: ["modelRoles", role], remove: true }
					: { segments: ["modelRoles", role], value: modelId },
			]);
			setByPath(this.#global, ["modelRoles"], current);
			this.#rebuildMerged();
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

	/** Replace roles in the configured storage layer and synchronize runtime overrides. */
	replaceModelRoles(modelRoles: ReadOnlyDict<string>): void {
		const project = cfgModelRoleStorage.get(this) === "project";
		const roles = new Set([...Object.keys(this.getModelRoles()), ...Object.keys(modelRoles)]);
		for (const role of roles) {
			const value = Object.hasOwn(modelRoles, role) ? modelRoles[role] : undefined;
			if (project) {
				if (value !== undefined) this.setProjectModelRole(role, value);
				else if (this.getProjectModelRole(role) || this.getModelRoleProvenance(role) === "runtime") {
					this.clearProjectModelRole(role);
				}
			} else if (
				value !== undefined ||
				this.getGlobalModelRole(role) !== undefined ||
				this.getModelRoleProvenance(role) === "runtime"
			) {
				this.setModelRole(role, value);
			}
		}
	}

	/**
	 * Detached in-memory copy with {@link replaceModelRoles} applied: same layer precedence, no saves,
	 * no notifications. Read its roles and their provenance; never write through it.
	 */
	previewModelRoles(modelRoles: ReadOnlyDict<string>): Settings {
		const preview = new Settings({ inMemory: true, cwd: this.#cwd, agentDir: this.#agentDir }, { projection: true });
		preview.#parent = this.#parent;
		// The role mutators replace their layer's modelRoles map instead of editing it in place.
		preview.#global = { ...this.#global };
		preview.#project = { ...this.#project };
		preview.#configOverlay = this.#configOverlay;
		preview.#overrides = { ...this.#overrides };
		preview.#savedRuntimeModelRoleOverrides = new Map(this.#savedRuntimeModelRoleOverrides);
		preview.#remerge();
		preview.replaceModelRoles(modelRoles);
		return preview;
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
		const next = this.#runtimeModelRoleOverridesForEdit();
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
				this.#savedRuntimeModelRoleOverrides.delete(role);
				this.#untrustedRuntimeModelRoles.delete(role);
			}
		}
		this.#setRuntimeModelRoleOverrides(next);
	}

	/**
	 * Replace the runtime model-role override record wholesale (the `--preset`
	 * launch path). `null` tombstones unset the roles the map omits, and later
	 * per-role {@link overrideModelRoles} writes keep those tombstones, so the
	 * roles stay unset for the run. With `untrusted` (a project config's preset)
	 * the values route this process's session but stay out of
	 * {@link grantAuthority}, so an untrusted preset never widens
	 * operator-owned model grants.
	 */
	overrideModelRolesWhole(roles: ReadOnlyDict<string | null>, options: { untrusted?: boolean } = {}): void {
		if (this.#mirror) {
			return this.#forward(this.#mirror, {
				op: "overrideModelRolesWhole",
				roles: { ...roles },
				untrusted: options.untrusted === true,
			});
		}
		// Whole-map replacement supersedes any per-role capture, like `writeValue` on the override layer.
		this.#savedRuntimeModelRoleOverrides.clear();
		this.#untrustedRuntimeModelRoles = new Set(options.untrusted ? Object.keys(roles) : []);
		const prev = cfgModelRoles.get(this);
		setByPath(this.#overrides, ["modelRoles"], { ...roles });
		this.#rebuildMerged();
		this.#fireIfChanged(cfgModelRoles, prev);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		if (!this.#persist) {
			// An in-memory instance persists nothing and follows no file: it has no global document
			// and takes the project document as a snapshot.
			const [, projectSub] = await this.#openDocs("read", {});
			return this.#adoptOpened(undefined, projectSub, false);
		}
		const [globalSub, projectSub] = await this.#openDocs("write", { global: true, storage: true });
		return this.#adoptOpened(globalSub, projectSub, true);
	}

	/** Snapshot of both documents, opened `read` so the store never moves an invalid config aside for it. */
	async #loadReadOnly(): Promise<Settings> {
		const [globalSub, projectSub] = await this.#openDocs("read", { global: true });
		return this.#adoptOpened(globalSub, projectSub, false);
	}

	/**
	 * Opens this scope's project document and, with `global`, its global document (after agent.db, with
	 * `storage`) in the settings store. The two open independently; both settle before either failure
	 * is reported, a global one first, and a document that did open is closed again.
	 */
	async #openDocs(
		mode: "read" | "write",
		options: { global?: boolean; storage?: boolean },
	): Promise<[SettingsSubscription | undefined, SettingsSubscription]> {
		const link = await settingsLink();
		const openGlobal = async (): Promise<SettingsSubscription | undefined> => {
			if (options.storage) this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
			if (!options.global) return undefined;
			return link.open({ kind: "global", agentDir: path.resolve(this.#agentDir) }, { mode });
		};
		const [globalResult, projectResult] = await Promise.allSettled([
			openGlobal(),
			link.open({ kind: "project", cwd: path.resolve(this.#cwd) }, { mode }),
		]);
		if (globalResult.status === "rejected") {
			if (projectResult.status === "fulfilled") projectResult.value.close();
			throw globalResult.reason;
		}
		if (projectResult.status === "rejected") {
			globalResult.value?.close();
			throw projectResult.reason;
		}
		return [globalResult.value, projectResult.value];
	}

	/**
	 * Builds every layer from freshly opened documents and the `--config` overlays, then validates
	 * strictly. With `keep` the documents stay open and this instance follows them; otherwise they
	 * were a snapshot and are closed. A failure closes them.
	 */
	async #adoptOpened(
		globalSub: SettingsSubscription | undefined,
		projectSub: SettingsSubscription,
		keep: boolean,
	): Promise<Settings> {
		try {
			const overlay = await this.#readConfigOverlays();
			// Read the states only now: the store may have pushed newer ones while the overlays loaded.
			if (globalSub) {
				const state = globalStateOf(globalSub.update);
				this.#globalState = state;
				this.#global = structuredClone(state.settings);
				this.#configPath = this.#configPathOf(state);
			}
			this.#configOverlay = overlay.settings;
			this.#overlayShellPathSource = overlay.shellPathSource;
			// Global and overlay `disabledProviders` decide which providers feed the project layer.
			const projectState = projectStateOf(projectSub.update);
			this.#projectState = projectState;
			this.#projectSettingsWarningsSeen = this.#noteProjectState(projectState, this.#cwd);
			const project = this.#resolveProjectRead(projectState, this.#cwd, this.#ownLayers());
			this.#project = project.settings;
			this.#projectAdopted = projectState;
			this.#projectShellPathSource = project.shellPathSource;

			// Build merged view (global → project → overrides; project wins over global)
			this.#rebuildMerged();
			this.#validateAll();
		} catch (error) {
			globalSub?.close();
			projectSub.close();
			throw error;
		}
		if (keep && !this.#savesCancelled) {
			if (globalSub) this.#attach("global", globalSub);
			this.#attach("project", projectSub);
		} else {
			globalSub?.close();
			projectSub.close();
		}
		return this;
	}

	/**
	 * The project layer of a project-document `state` for `cwd`: its items merged, leaving out those
	 * of providers `disabledProviders` disables. That setting may come from any layer, the project's
	 * own native config included, so it resolves over `layers` with the merged project.
	 */
	#resolveProjectRead(
		state: ProjectDocState,
		cwd: string,
		layers: Omit<OwnLayers, "project">,
	): ProjectSettingsReadResult {
		let project = this.#mergeProjectState(state.items, state.nativeModelRoles);
		const disabled = this.#disabledProviderIds({ ...layers, project: project.settings }, cwd);
		if (state.items.some(item => disabled.has(item.provider))) {
			const filtered = this.#mergeProjectState(
				state.items.filter(item => !disabled.has(item.provider)),
				state.nativeModelRoles,
			);
			const projectSwitch = getByPath(project.settings, cfgDisabledProviders.segments);
			if (projectSwitch !== undefined) {
				const remaining = this.#disabledProviderIds({ ...layers, project: filtered.settings }, cwd);
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
			// The merge shares subtrees with the store's state, which stays as received: migrate a copy.
			settings: migrateRawSettings(structuredClone(project.settings)),
			shellPathSource: project.shellPathSource,
			sourcePaths: state.items.map(item => item.path),
		};
	}

	/** Project `items` merged in the store's order, then the native project config's model roles. */
	#mergeProjectState(
		items: readonly ProjectSettingsItem[],
		nativeModelRoles: unknown,
	): { settings: RawSettings; shellPathSource: string | undefined } {
		let settings: RawSettings = {};
		let shellPathSource: string | undefined;
		for (const item of items) {
			settings = this.#deepMerge(settings, dropSettingsGroupShadows(item.data, item.path), {
				arrays: "combine",
			});
			if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
		}
		if (nativeModelRoles !== undefined) settings = this.#deepMerge(settings, { modelRoles: nativeModelRoles });
		return { settings, shellPathSource };
	}

	/** Provider ids `disabledProviders` resolves to for `cwd` when `layers` are merged (over the overlay parent). */
	#disabledProviderIds(layers: OwnLayers, cwd: string): ReadonlySet<string> {
		const value = configuredValue(this.#mergeOverParent(this.#mergeOwnLayers(layers)), cfgDisabledProviders, cwd);
		return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
	}

	/** The `--config` overlays, read from disk here: they belong to this process, not to the settings store. */
	async #readConfigOverlays(): Promise<ConfigOverlayReadResult> {
		let shellPathSource: string | undefined;
		let settings: RawSettings = {};
		for (const filePath of this.#configFiles) {
			const overlay = await this.#loadOverlayYaml(filePath);
			settings = this.#deepMerge(settings, overlay, { arrays: "combine" });
			if (Object.hasOwn(overlay, "shellPath")) shellPathSource = filePath;
		}
		return { settings, shellPathSource };
	}

	/**
	 * Strict loader for explicit `--config` overlays: missing or malformed
	 * files are hard errors so a typo'd path cannot silently fall back to the
	 * persistent settings.
	 */
	async #loadOverlayYaml(filePath: string): Promise<RawSettings> {
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
		return migrateRawSettings(parsed as RawSettings);
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
 * `resetSettingsForTest` can detach every instance from the settings
 * store and {@link findScopedSettings} can resolve a session by scope.
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
	// Detach every constructed instance — including isolated (non-singleton)
	// ones — from the settings store and stop its overlay polls, then drop the
	// shared link: an in-process store's save timers and file polls would
	// otherwise fire mid-way through the NEXT test (cross-file pollution).
	for (const ref of liveSettingsInstances) {
		ref.deref()?.cancelPendingSaves();
	}
	disposeSettingsLinkForTest();
	liveSettingsInstances.clear();
	globalInstance = null;
	globalInstancePromise = null;
	releaseGlobalMirrorEffects = undefined;
	clearBoundSettingsMethods();
	// Effect-owned process state (theme, redaction, request limits, …) returns to its defaults.
	resetRegistryForTest(Settings.isolated());
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
