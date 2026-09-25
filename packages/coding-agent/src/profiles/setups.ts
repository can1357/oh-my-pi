/**
 * Saved setups: named, reusable settings overlays stored as
 * `<agentDir>/setups/<name>.yml`. A setup file is a native `config.yml`-style
 * document plus reserved `$setup` metadata. Loading is tolerant: settings this
 * version of omp cannot own are skipped with a warning instead of rejecting the
 * whole file, so setups survive setting renames and removals across upgrades.
 */
import type { BigIntStats, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, isEexist, isEnoent, logger, stringifyYamlConfig, truncate } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { orderedSettings } from "../config/all-settings";
import { modelRoleAliasTarget, normalizeModelPatternList } from "../config/model-resolver";
import { cfgModelRoles } from "../config/model-settings";
import type { AnySetting } from "../config/registry";
import type { RawSettings, Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import {
	cfgTaskAgentAdvisor,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentPrewalk,
	cfgTaskDisabledAgents,
} from "../task/settings";
import { createFileAtomically, replaceFileAtomically } from "../utils/atomic-file";
import {
	type ModelRoleAssignments,
	PROFILE_EMOJIS,
	PROFILE_SETTINGS_GROUPS,
	type ProfileDraft,
	type ProfileEmoji,
	type ProfileSettingsGroup,
	type SetupMetadata,
} from "./types";

const SETUPS_DIRNAME = "setups";
const SETUP_EXTENSION = ".yml";
const SETUP_METADATA_KEY = "$setup";
const SETUP_FORMAT_VERSION = 1;
const MAX_SETUP_BYTES = 1024 * 1024;
const MAX_SETUP_NAME_LENGTH = 64;
/** Longest excerpt of an untrusted string a diagnostic quotes. */
const MAX_DIAGNOSTIC_TEXT_LENGTH = 64;
/** Alias expansions one profile's model roles may need; bounds preview work for crafted files. */
const MAX_ROLE_REFERENCE_WORK = 10_000;
const WINDOWS_INVALID_FILENAME_RE = /[\p{Cc}\p{Cf}<>:"/\\|?*]/u;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROFILE_EMOJI_SET = new Set<string>(PROFILE_EMOJIS.map(option => option.emoji));
const GROUP_ORDER = new Map<string, number>(PROFILE_SETTINGS_GROUPS.map((group, index) => [group.id, index]));
/** Per-agent task settings; they have no Settings tab, so they group under Agents & tasks. */
const AGENT_TASK_SETTINGS: ReadonlySet<AnySetting> = new Set<AnySetting>([
	cfgTaskDisabledAgents,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentPrewalk,
	cfgTaskAgentAdvisor,
]);
/** Structured settings a setup may own; every other setup setting is a boolean, number, or enum. */
const STRUCTURED_SETUP_SETTINGS: ReadonlySet<AnySetting> = new Set([...AGENT_TASK_SETTINGS, cfgRetryFallbackChains]);

export type SetupErrorKind = "invalid-name" | "not-found" | "exists" | "invalid" | "too-large" | "unsupported-version";

export class SetupError extends Error {
	constructor(
		readonly kind: SetupErrorKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SetupError";
	}
}

export interface SavedSetupDescriptor {
	name: string;
	updatedAt: number;
	metadata?: SetupMetadata;
	/** Why the setup cannot be loaded; listed anyway so the user can see and delete it. */
	error?: string;
}

export interface LoadedSetup extends ProfileDraft {
	name: string;
	path: string;
	/** Entries skipped while loading, each naming the setting and why. */
	warnings: string[];
}

/** A profile read from an exported file or the clipboard. */
export interface ImportedProfile extends ProfileDraft {
	/** Entries this version of omp cannot load, each naming the setting and why. */
	warnings: string[];
	/** Safety-sensitive settings the shared text set; an import never carries them. */
	withheld: AnySetting[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A bounded description of an untrusted document value for a diagnostic: a quoted
 * excerpt of a string, a scalar as written, and only the kind of a list or mapping,
 * whose YAML aliases could otherwise expand exponentially when serialized.
 */
function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(truncate(value, MAX_DIAGNOSTIC_TEXT_LENGTH));
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object" && value !== null) return "a mapping";
	return String(value);
}

/** Validate a user-facing setup name; the result is also the file basename. */
export function normalizeSetupName(name: string): string {
	const normalized = name.trim();
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		[...normalized].length > MAX_SETUP_NAME_LENGTH ||
		WINDOWS_INVALID_FILENAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized) ||
		PROTOTYPE_KEYS.has(normalized)
	) {
		throw new SetupError("invalid-name", `"${name}" is not a valid profile name`);
	}
	return normalized;
}

function setupsDirectory(agentDir: string): string {
	return path.join(agentDir, SETUPS_DIRNAME);
}

function setupFilePath(name: string, agentDir: string): string {
	return path.join(setupsDirectory(agentDir), `${name}${SETUP_EXTENSION}`);
}

// ─── Setting ownership ───────────────────────────────────────────────────────

function settingGroup(setting: AnySetting): ProfileSettingsGroup | undefined {
	if (AGENT_TASK_SETTINGS.has(setting)) return "tasks";
	const tab = setting.ui?.tab;
	return tab !== undefined && GROUP_ORDER.has(tab) ? (tab as ProfileSettingsGroup) : undefined;
}

/** Whether a setup may own `setting`: grouped, not credential or machine-local, and a supported value type. */
function isSetupSetting(setting: AnySetting): boolean {
	if (settingGroup(setting) === undefined || setting.isCredential || setting.isMachineLocal) return false;
	const { type } = setting;
	return type === "boolean" || type === "number" || type === "enum" || STRUCTURED_SETUP_SETTINGS.has(setting);
}

const SETUP_SETTINGS = orderedSettings().filter(isSetupSetting);
const SETUP_SETTING_IDS = new Set<string>(SETUP_SETTINGS.map(setting => setting.id));
/** Every proper prefix of a setup setting id, e.g. `task` for `task.disabledAgents`. */
const SETUP_BRANCHES = new Set<string>(
	SETUP_SETTINGS.flatMap(({ segments }) =>
		segments.slice(1).map((_, index) => segments.slice(0, index + 1).join(".")),
	),
);
/**
 * Setup settings that loosen approvals or secret redaction, or hand over the
 * user's real browser, desktop, or code execution. Saved profiles may hold
 * them; exports and imports never carry them.
 */
const SAFETY_SENSITIVE_SETUP_SETTINGS = SETUP_SETTINGS.filter(setting => setting.isSafetySensitive);

/** Settings a setup includes when `group` is enabled. */
export function getSetupGroupSettings(group: ProfileSettingsGroup): AnySetting[] {
	return SETUP_SETTINGS.filter(setting => settingGroup(setting) === group);
}

function sortGroups(groups: Iterable<ProfileSettingsGroup>): ProfileSettingsGroup[] {
	return [...new Set(groups)].sort((left, right) => (GROUP_ORDER.get(left) ?? 0) - (GROUP_ORDER.get(right) ?? 0));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** The value a setup may store for `setting`, or `undefined` when this omp version would reject it. */
function validSettingValue(setting: AnySetting, value: unknown): unknown {
	switch (setting) {
		case cfgTaskDisabledAgents:
			return isStringArray(value) ? [...value] : undefined;
		case cfgTaskAgentModelOverrides: {
			if (!isPlainRecord(value)) return undefined;
			const overrides: Record<string, string | string[] | null> = {};
			for (const [agent, selector] of Object.entries(value)) {
				if (PROTOTYPE_KEYS.has(agent)) return undefined;
				if (selector === null || typeof selector === "string") overrides[agent] = selector;
				else if (isStringArray(selector)) overrides[agent] = [...selector];
				else return undefined;
			}
			return overrides;
		}
		case cfgTaskAgentPrewalk:
		case cfgTaskAgentAdvisor: {
			if (!isPlainRecord(value)) return undefined;
			const overrides: Record<string, string | null> = {};
			for (const [agent, setting] of Object.entries(value)) {
				if (PROTOTYPE_KEYS.has(agent) || (setting !== null && typeof setting !== "string")) return undefined;
				overrides[agent] = setting;
			}
			return overrides;
		}
		case cfgRetryFallbackChains: {
			if (!isPlainRecord(value)) return undefined;
			const chains: Record<string, string[]> = {};
			for (const [role, chain] of Object.entries(value)) {
				if (PROTOTYPE_KEYS.has(role) || !isStringArray(chain)) return undefined;
				chains[role] = [...chain];
			}
			return chains;
		}
	}
	if (setting.type === "boolean") return typeof value === "boolean" ? value : undefined;
	if (setting.type === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	if (setting.type === "enum")
		return typeof value === "string" && setting.enumValues?.includes(value) ? value : undefined;
	return undefined;
}

// ─── Nested config paths ─────────────────────────────────────────────────────

/** Read the value at `segments` (a setting's dotted path) from a nested settings object. */
export function readConfigPath(
	source: Record<string, unknown>,
	segments: readonly string[],
): { present: boolean; value?: unknown } {
	let current: unknown = source;
	for (const segment of segments) {
		if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
		current = current[segment];
	}
	return { present: true, value: current };
}

/** Write the value at `segments` into a nested settings object, creating parent objects. */
export function writeConfigPath(target: RawSettings, segments: readonly string[], value: unknown): void {
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		const child = current[segment];
		if (isPlainRecord(child)) {
			current = child;
		} else {
			const created: RawSettings = {};
			current[segment] = created;
			current = created;
		}
	}
	current[segments[segments.length - 1]] = value;
}

/** Delete the value at `segments` from a nested settings object, dropping parents the deletion emptied. */
export function deleteConfigPath(target: RawSettings, segments: readonly string[]): void {
	const parents: RawSettings[] = [target];
	for (const segment of segments.slice(0, -1)) {
		const child = parents[parents.length - 1][segment];
		if (!isPlainRecord(child)) return;
		parents.push(child);
	}
	delete parents[parents.length - 1][segments[segments.length - 1]];
	// Drop parents the deletion emptied so saved files stay minimal.
	for (let index = parents.length - 1; index > 0; index--) {
		if (Object.keys(parents[index]).length > 0) break;
		delete parents[index - 1][segments[index - 1]];
	}
}

/** Keys present in a setup document that no setup setting id accounts for. */
function collectIgnoredPaths(node: Record<string, unknown>, prefix: string, ignored: string[]): void {
	for (const key of Object.keys(node)) {
		const childPath = prefix ? `${prefix}.${key}` : key;
		if (!prefix && (key === SETUP_METADATA_KEY || key === "modelRoles")) continue;
		if (SETUP_SETTING_IDS.has(childPath)) continue;
		const child = node[key];
		if (isPlainRecord(child) && SETUP_BRANCHES.has(childPath)) collectIgnoredPaths(child, childPath, ignored);
		else ignored.push(childPath);
	}
}

// ─── Parsing and serialization ───────────────────────────────────────────────

function parseMetadata(value: unknown, warnings: string[]): SetupMetadata {
	const metadata: SetupMetadata = { version: SETUP_FORMAT_VERSION, enabledGroups: [] };
	if (value === undefined) return metadata;
	if (!isPlainRecord(value)) {
		warnings.push(`Ignored ${SETUP_METADATA_KEY}: expected a mapping`);
		return metadata;
	}
	if (value.version !== undefined && value.version !== SETUP_FORMAT_VERSION) {
		throw new SetupError(
			"unsupported-version",
			`This profile uses format version ${describeValue(value.version)}; update omp to load it`,
		);
	}
	if (typeof value.emoji === "string" && PROFILE_EMOJI_SET.has(value.emoji)) {
		metadata.emoji = value.emoji as ProfileEmoji;
	} else if (value.emoji !== undefined) {
		warnings.push("Ignored emoji: not one of the available profile emojis");
	}
	if (Array.isArray(value.enabledGroups)) {
		const groups: ProfileSettingsGroup[] = [];
		for (const group of value.enabledGroups) {
			if (typeof group !== "string") {
				warnings.push(`Ignored settings group entry: expected a group name, got ${describeValue(group)}`);
			} else if (GROUP_ORDER.has(group)) {
				groups.push(group as ProfileSettingsGroup);
			} else {
				warnings.push(`Ignored settings group ${describeValue(group)}: unknown group`);
			}
		}
		metadata.enabledGroups = sortGroups(groups);
	} else if (value.enabledGroups !== undefined) {
		warnings.push("Ignored enabledGroups: expected a list");
	}
	return metadata;
}

function parseModelRoles(value: unknown, warnings: string[]): ModelRoleAssignments {
	const roles: ModelRoleAssignments = {};
	if (value === undefined) return roles;
	if (!isPlainRecord(value)) {
		warnings.push("Ignored modelRoles: expected a mapping");
		return roles;
	}
	for (const [role, selector] of Object.entries(value)) {
		if (PROTOTYPE_KEYS.has(role)) warnings.push(`Ignored model role "${role}": reserved name`);
		else if (selector === null || typeof selector === "string") roles[role] = selector;
		else warnings.push(`Ignored model role "${role}": expected a model selector or null`);
	}
	return roles;
}

/**
 * Whether expanding `roles`' aliases stays within budget. Role resolution walks
 * every alias path with its own visited set, so roles that all list each other
 * expand combinatorially and would freeze the preview. An alias to a role the
 * profile leaves unset counts as one to `default`, which that role inherits.
 */
function roleReferencesWithinBudget(roles: ModelRoleAssignments): boolean {
	let work = 0;
	const visit = (role: string, visited: ReadonlySet<string>): boolean => {
		const selector = roles[role];
		if (typeof selector !== "string") return true;
		for (const pattern of normalizeModelPatternList(selector)) {
			const alias = modelRoleAliasTarget(pattern);
			if (alias === undefined) continue;
			const target = Object.hasOwn(roles, alias) ? alias : Object.hasOwn(roles, "default") ? "default" : undefined;
			if (target === undefined || visited.has(target)) continue;
			if (++work > MAX_ROLE_REFERENCE_WORK) return false;
			if (!visit(target, new Set([...visited, target]))) return false;
		}
		return true;
	};
	return Object.keys(roles).every(role => visit(role, new Set([role])));
}

/**
 * Read a setup document. Only a non-mapping document, an unsupported format
 * version, or model roles whose aliases expand past a safety budget are fatal;
 * every other problem skips the affected entry with a warning.
 * Groups owning a kept setting stay enabled even if metadata omitted them, so a
 * setting moved between Settings tabs keeps its saved value.
 */
export function parseSetupDocument(document: unknown): ProfileDraft & { warnings: string[] } {
	if (!isPlainRecord(document)) throw new SetupError("invalid", "A profile must be a YAML mapping");
	const warnings: string[] = [];
	const metadata = parseMetadata(document[SETUP_METADATA_KEY], warnings);
	const config: RawSettings = { modelRoles: parseModelRoles(document.modelRoles, warnings) };
	if (!roleReferencesWithinBudget(config.modelRoles as ModelRoleAssignments)) {
		throw new SetupError("invalid", "This profile's model roles reference each other too many times to load safely");
	}
	const groups = new Set(metadata.enabledGroups);
	for (const setting of SETUP_SETTINGS) {
		const found = readConfigPath(document, setting.segments);
		if (!found.present) continue;
		const value = validSettingValue(setting, found.value);
		if (value === undefined) {
			warnings.push(`Ignored ${setting.id}: value is not valid for this version of omp`);
			continue;
		}
		writeConfigPath(config, setting.segments, value);
		groups.add(settingGroup(setting)!);
	}
	const ignored: string[] = [];
	collectIgnoredPaths(document, "", ignored);
	for (const ignoredPath of ignored) {
		warnings.push(`Ignored ${ignoredPath}: not a setting this version of omp can load from a profile`);
	}
	metadata.enabledGroups = sortGroups(groups);
	return { metadata, config, warnings };
}

/** Serialize a draft as a native settings overlay with `$setup` metadata. */
export function serializeSetup(draft: ProfileDraft): string {
	const metadata: Record<string, unknown> = { version: SETUP_FORMAT_VERSION };
	if (draft.metadata.emoji !== undefined) metadata.emoji = draft.metadata.emoji;
	metadata.enabledGroups = sortGroups(draft.metadata.enabledGroups);
	return stringifyYamlConfig({ [SETUP_METADATA_KEY]: metadata, ...draft.config });
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

/** The draft's model roles; entries that are not a selector or `null` are dropped. */
export function draftModelRoles(draft: ProfileDraft): ModelRoleAssignments {
	const roles: ModelRoleAssignments = {};
	const value = draft.config.modelRoles;
	if (!isPlainRecord(value)) return roles;
	for (const [role, selector] of Object.entries(value)) {
		if (selector === null || typeof selector === "string") roles[role] = selector;
	}
	return roles;
}

/** Only the model roles of `draft`, for a models-only export. */
export function modelsOnlyDraft(draft: ProfileDraft): ProfileDraft {
	return { metadata: { ...draft.metadata, enabledGroups: [] }, config: { modelRoles: draftModelRoles(draft) } };
}

/**
 * Start a models-only draft from the effective configuration. A role a higher
 * layer masks with `null` stays masked, so the draft never brings back the
 * lower layer's model. When the live session's model is supplied, it becomes
 * the saved default together with its configured thinking level (including `auto`).
 */
export function createSetupDraft(
	settings: Settings,
	current?: { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel },
): ProfileDraft {
	const modelRoles: ModelRoleAssignments = {};
	// `getModelRoles()` drops `null` masks; the raw effective record keeps them.
	const effective: unknown = cfgModelRoles.get(settings);
	if (isPlainRecord(effective)) {
		for (const [role, value] of Object.entries(effective)) {
			if (PROTOTYPE_KEYS.has(role)) continue;
			const selector = value === null ? null : settings.getModelRole(role);
			if (selector !== undefined) modelRoles[role] = selector;
		}
	}
	if (current) {
		modelRoles.default = formatModelSelectorValue(`${current.provider}/${current.id}`, current.thinkingLevel);
	}
	return { metadata: { version: SETUP_FORMAT_VERSION, enabledGroups: [] }, config: { modelRoles } };
}

/**
 * Include or exclude a settings group. Including captures the settings the
 * user explicitly configured in that group; defaults stay unset so the setup
 * keeps following omp's defaults. Excluding removes every saved group setting.
 */
export function setDraftGroup(
	draft: ProfileDraft,
	group: ProfileSettingsGroup,
	included: boolean,
	settings: Settings,
): ProfileDraft {
	const config = structuredClone(draft.config);
	const groups = new Set(draft.metadata.enabledGroups);
	if (included) {
		for (const setting of getSetupGroupSettings(group)) {
			if (readConfigPath(config, setting.segments).present || !settings.isConfigured(setting)) continue;
			const value = validSettingValue(setting, setting.layered(settings));
			if (value !== undefined) writeConfigPath(config, setting.segments, value);
		}
		groups.add(group);
	} else {
		for (const setting of getSetupGroupSettings(group)) deleteConfigPath(config, setting.segments);
		groups.delete(group);
	}
	return { metadata: { ...draft.metadata, enabledGroups: sortGroups(groups) }, config };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function parseYamlDocument(content: string, subject: string): unknown {
	try {
		return YAML.parse(content);
	} catch (error) {
		throw new SetupError("invalid", `${subject} is not valid YAML`, { cause: error });
	}
}

async function readSetupDocument(filePath: string, name: string): Promise<unknown> {
	const file = Bun.file(filePath);
	let content: string;
	try {
		if (file.size > MAX_SETUP_BYTES) throw new SetupError("too-large", `Profile "${name}" is larger than 1 MiB`);
		content = await file.text();
	} catch (error) {
		if (error instanceof SetupError) throw error;
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${name}" was not found`, { cause: error });
		throw error;
	}
	return parseYamlDocument(content, `Profile "${name}"`);
}

async function readSetupFile(filePath: string, name: string): Promise<ProfileDraft & { warnings: string[] }> {
	return parseSetupDocument(await readSetupDocument(filePath, name));
}

/** Atomically replace `filePath` with `content`. */
async function replaceSetupFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await Bun.write(tempPath, content);
	try {
		await replaceFileAtomically(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

/** List saved setups by name, including unreadable ones with their error. */
export async function listSavedSetups(agentDir: string = getAgentDir()): Promise<SavedSetupDescriptor[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(setupsDirectory(agentDir));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const descriptors: SavedSetupDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(SETUP_EXTENSION)) continue;
		const name = entry.slice(0, -SETUP_EXTENSION.length);
		try {
			if (normalizeSetupName(name) !== name) continue;
		} catch {
			continue;
		}
		const filePath = setupFilePath(name, agentDir);
		let updatedAt: number;
		try {
			const stats = await fs.stat(filePath);
			if (!stats.isFile()) continue;
			updatedAt = stats.mtimeMs;
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		try {
			const { metadata } = await readSetupFile(filePath, name);
			descriptors.push({ name, updatedAt, metadata });
		} catch (error) {
			if (!(error instanceof SetupError)) throw error;
			descriptors.push({ name, updatedAt, error: error.message });
		}
	}
	return descriptors.sort((left, right) => left.name.localeCompare(right.name));
}

/** Load one saved setup; skipped entries are logged and returned as warnings. */
export async function loadSavedSetup(name: string, agentDir: string = getAgentDir()): Promise<LoadedSetup> {
	const normalized = normalizeSetupName(name);
	const filePath = setupFilePath(normalized, agentDir);
	const setup = await readSetupFile(filePath, normalized);
	if (setup.warnings.length > 0) {
		logger.warn("Saved setup loaded with skipped entries", { setup: normalized, warnings: setup.warnings });
	}
	return { ...setup, name: normalized, path: filePath };
}

/** Save a draft. Without `overwrite`, an existing setup of the same name is never replaced. */
export async function saveSetup(
	name: string,
	draft: ProfileDraft,
	options: { agentDir?: string; overwrite?: boolean } = {},
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const agentDir = options.agentDir ?? getAgentDir();
	const filePath = setupFilePath(normalized, agentDir);
	const content = serializeSetup(draft);
	if (Buffer.byteLength(content) > MAX_SETUP_BYTES) {
		throw new SetupError("too-large", `Profile "${normalized}" is larger than 1 MiB`);
	}
	await fs.mkdir(setupsDirectory(agentDir), { recursive: true });
	if (options.overwrite) {
		await replaceSetupFile(filePath, content);
	} else {
		await createSetupFile(filePath, content, normalized);
	}
	return { name: normalized, updatedAt: Date.now(), metadata: draft.metadata };
}

/**
 * Set or clear one saved setup's emoji. Every other entry stays as written,
 * including entries this version of omp skipped on load, so an emoji change
 * never drops settings a newer omp understands.
 */
export async function setSavedSetupEmoji(
	name: string,
	emoji: ProfileEmoji | undefined,
	agentDir: string = getAgentDir(),
): Promise<SavedSetupDescriptor> {
	const normalized = normalizeSetupName(name);
	const filePath = setupFilePath(normalized, agentDir);
	const document = await readSetupDocument(filePath, normalized);
	// Parsing validates the format version before anything is written.
	const { metadata } = parseSetupDocument(document);
	const { [SETUP_METADATA_KEY]: rawMetadata, ...entries } = document as Record<string, unknown>;
	const nextMetadata: Record<string, unknown> = isPlainRecord(rawMetadata)
		? { ...rawMetadata }
		: { version: SETUP_FORMAT_VERSION, enabledGroups: metadata.enabledGroups };
	if (emoji === undefined) delete nextMetadata.emoji;
	else nextMetadata.emoji = emoji;
	const content = stringifyYamlConfig({ [SETUP_METADATA_KEY]: nextMetadata, ...entries });
	if (Buffer.byteLength(content) > MAX_SETUP_BYTES) {
		throw new SetupError("too-large", `Profile "${normalized}" is larger than 1 MiB`);
	}
	await replaceSetupFile(filePath, content);
	return { name: normalized, updatedAt: Date.now(), metadata: { ...metadata, emoji } };
}

/** Rename a saved setup without replacing another one. Case-only renames are allowed. */
export async function renameSavedSetup(
	name: string,
	newName: string,
	agentDir: string = getAgentDir(),
): Promise<string> {
	const from = normalizeSetupName(name);
	const to = normalizeSetupName(newName);
	if (from === to) return to;
	const fromPath = setupFilePath(from, agentDir);
	const toPath = setupFilePath(to, agentDir);
	let source: BigIntStats;
	try {
		source = await fs.stat(fromPath, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${from}" was not found`, { cause: error });
		throw error;
	}
	if (await resolvesToFile(toPath, source)) {
		// A case-insensitive filesystem resolves both names to this file: renaming in place changes only the case.
		await fs.rename(fromPath, toPath);
		return to;
	}
	await createSetupFile(toPath, await Bun.file(fromPath).text(), to);
	await fs.rm(fromPath);
	return to;
}

/** Whether `candidate` names the file `source` describes, as case variants do on case-insensitive filesystems. */
async function resolvesToFile(candidate: string, source: BigIntStats): Promise<boolean> {
	try {
		const target = await fs.stat(candidate, { bigint: true });
		return target.dev === source.dev && target.ino === source.ino;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Create a setup file that must not exist yet; nothing partial is ever visible under `filePath`. */
async function createSetupFile(filePath: string, content: string, name: string): Promise<void> {
	try {
		await createFileAtomically(filePath, content);
	} catch (error) {
		if (isEexist(error)) throw new SetupError("exists", `A profile named "${name}" already exists`, { cause: error });
		throw error;
	}
}

/** Delete one saved setup file. Live settings and other setups are untouched. */
export async function deleteSavedSetup(name: string, agentDir: string = getAgentDir()): Promise<void> {
	const normalized = normalizeSetupName(name);
	try {
		await fs.rm(setupFilePath(normalized, agentDir));
	} catch (error) {
		if (isEnoent(error)) throw new SetupError("not-found", `Profile "${normalized}" was not found`, { cause: error });
		throw error;
	}
}

// ─── Sharing ─────────────────────────────────────────────────────────────────
// An exported profile is the same document as a saved one, so imports follow
// the same tolerant rules: entries this version cannot load are skipped and named.
// Safety-sensitive settings never travel: exports leave them out, imports withhold them.

/** Safety-sensitive settings `draft` sets. */
export function safetySensitiveSettings(draft: ProfileDraft): AnySetting[] {
	return SAFETY_SENSITIVE_SETUP_SETTINGS.filter(setting => readConfigPath(draft.config, setting.segments).present);
}

/** `draft` without its safety-sensitive settings: the form an export shares. */
export function shareableDraft(draft: ProfileDraft): { draft: ProfileDraft; withheld: AnySetting[] } {
	const withheld = safetySensitiveSettings(draft);
	if (withheld.length === 0) return { draft, withheld };
	const config = structuredClone(draft.config);
	for (const setting of withheld) deleteConfigPath(config, setting.segments);
	return { draft: { metadata: draft.metadata, config }, withheld };
}

/** Parse profile text from an exported file or the clipboard. */
export function parseProfileText(text: string): ImportedProfile {
	if (Buffer.byteLength(text) > MAX_SETUP_BYTES) throw new SetupError("too-large", "The profile is larger than 1 MiB");
	const { warnings, ...parsed } = parseSetupDocument(parseYamlDocument(text, "The profile"));
	const shared = shareableDraft(parsed);
	return { ...shared.draft, warnings, withheld: shared.withheld };
}

/** Read an exported profile file. `label` names the file in errors (default: its path). */
export async function readProfileFile(filePath: string, label: string = filePath): Promise<ImportedProfile> {
	let stats: Stats;
	try {
		stats = await fs.stat(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new SetupError("not-found", `No file at ${label}`, { cause: error });
		throw error;
	}
	if (!stats.isFile()) throw new SetupError("invalid", `${label} is not a file`);
	if (stats.size > MAX_SETUP_BYTES) throw new SetupError("too-large", "The profile is larger than 1 MiB");
	return parseProfileText(await Bun.file(filePath).text());
}

/** Write `draft` as an exported profile file; an existing file is never replaced. `label` names it in errors. */
export async function writeProfileFile(filePath: string, draft: ProfileDraft, label: string = filePath): Promise<void> {
	const content = serializeSetup(draft);
	if (Buffer.byteLength(content) > MAX_SETUP_BYTES) {
		throw new SetupError("too-large", "The profile is larger than 1 MiB");
	}
	try {
		await fs.writeFile(filePath, content, { flag: "wx" });
	} catch (error) {
		if (isEexist(error)) throw new SetupError("exists", `${label} already exists`, { cause: error });
		if (isEnoent(error))
			throw new SetupError("not-found", `The folder for ${label} does not exist`, { cause: error });
		throw error;
	}
}
