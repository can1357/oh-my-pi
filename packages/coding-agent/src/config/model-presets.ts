/**
 * Model presets: named snapshots of the role assignments (`modelRoles`) and
 * `defaultThinkingLevel`, saved and re-applied as a whole.
 *
 * Presets persist to the global config (`modelPresets.<name>`); a project config
 * may also define presets, which are listed and applied but never copied into
 * the global file. Applying a preset writes roles the way the model hub does:
 * into the scope selected by `modelRoleStorage`, replacing `--model`/env runtime
 * role overrides like hub edits do. Roles still decided by another layer (a
 * `--config` overlay, a project config in global mode, or the global config in
 * project mode) are reported back instead of being silently kept.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "./model-resolver";
import { cfgModelPresets, cfgModelRoleStorage, type ModelPreset } from "./model-settings";
import type { Settings, SettingProvenance } from "./settings";

/** Preset names: a letter, then letters, digits, `-` or `_` (the model hub's role-name rule). */
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

export function isValidModelPresetName(name: string): boolean {
	return PRESET_NAME_PATTERN.test(name);
}

type PresetLookup = { kind: "found"; preset: ModelPreset } | { kind: "missing" } | { kind: "invalid"; reason: string };

/** Type guard for one `retry.fallbackChains` value: an ordered array of model selectors. */
function isSelectorList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/** Validate one raw `modelPresets` entry; hand-edited config can hold anything. */
function parseModelPreset(raw: unknown): ModelPreset | string {
	if (!isRecord(raw)) return "it is not a mapping";
	const roles = raw.modelRoles;
	if (!isRecord(roles)) return "`modelRoles` is missing or not a mapping";
	const modelRoles: Record<string, string> = {};
	for (const role of Object.keys(roles)) {
		const value = roles[role];
		if (typeof value !== "string" || value.trim() === "") return `role \`${role}\` is not a model selector`;
		modelRoles[role] = value;
	}
	const rawChains = raw.fallbackChains;
	let fallbackChains: Record<string, string[]> | undefined;
	if (rawChains !== undefined) {
		if (!isRecord(rawChains)) return "`fallbackChains` is not a mapping";
		fallbackChains = {};
		for (const key of Object.keys(rawChains)) {
			const chain = rawChains[key];
			if (!isSelectorList(chain)) return `fallback chain \`${key}\` is not an array of model selectors`;
			fallbackChains[key] = [...chain];
		}
	}
	const level = raw.defaultThinkingLevel;
	if (level === undefined) {
		return fallbackChains === undefined ? { modelRoles } : { modelRoles, fallbackChains };
	}
	const thinking = typeof level === "string" ? parseConfiguredThinkingLevel(level) : undefined;
	if (thinking === undefined || !isDefaultThinkingLevel(thinking)) {
		return "`defaultThinkingLevel` is not a thinking level";
	}
	return fallbackChains === undefined
		? { modelRoles, defaultThinkingLevel: thinking }
		: { modelRoles, defaultThinkingLevel: thinking, fallbackChains };
}

function isDefaultThinkingLevel(
	level: ConfiguredThinkingLevel,
): level is NonNullable<ModelPreset["defaultThinkingLevel"]> {
	return level === AUTO_THINKING || THINKING_EFFORTS.some(effort => effort === level);
}

/** Look a preset up whole from the highest layer owning its name — same-name entries never merge. */
export function getModelPreset(settings: Settings, name: string): PresetLookup {
	const owned = settings.getOwnedModelPreset(name);
	if (!owned) return { kind: "missing" };
	const parsed = parseModelPreset(owned.entry);
	return typeof parsed === "string" ? { kind: "invalid", reason: parsed } : { kind: "found", preset: parsed };
}

/** Saved preset names, sorted; names a `--config`/runtime `null` tombstone hides are left out. */
export function getModelPresetNames(settings: Settings): string[] {
	return Object.keys(cfgModelPresets.get(settings))
		.filter(name => settings.getOwnedModelPreset(name) !== undefined)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Well-formed `retry.fallbackChains` entries from the live settings record, as fresh
 * arrays. The setting validates only the outer object — hand-edited YAML can hold `null`
 * or a bare string per key — and a preset that snapshotted such an entry would fail
 * `parseModelPreset` and become unappliable. Malformed entries are dropped instead.
 * Arrays are copied so a preset and the live record never share an instance.
 */
function sanitizeFallbackChains(raw: Record<string, unknown>): Record<string, string[]> {
	const chains: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (isSelectorList(value)) chains[key] = [...value];
	}
	return chains;
}

/** Order-sensitive equality for two selector lists; `undefined` matches only `undefined`. */
function sameSelectorList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((sel, i) => sel === b[i]);
}

/** Reported as a shadowed chain when only the record's key order differs from the preset's. */
const KEY_ORDER_LABEL = "(key order)";

/**
 * Equality for two `retry.fallbackChains` records, key order included:
 * `resolveRetryFallbackChainKey` takes the first matching key at equal precedence, so a record
 * whose keys are merely reordered is a different configuration, not the same one.
 */
function sameFallbackChains(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key, i) => key === bKeys[i] && sameSelectorList(a[key], b[key]));
}

/**
 * First saved preset (by name) the current setup matches: identical effective role
 * assignments, the same default thinking level when the preset records one, and the
 * same `retry.fallbackChains` — key order included — when it records those too.
 * Undefined when the setup was edited past every preset.
 */
export function findActiveModelPreset(settings: Settings): string | undefined {
	const roles = settings.getModelRoles();
	// Same filter as `saveModelPreset`: empty selectors are never stored.
	const roleIds = Object.keys(roles).filter(role => roles[role]);
	const thinking = cfgDefaultThinkingLevel.get(settings);
	const liveChains = sanitizeFallbackChains(cfgRetryFallbackChains.get(settings));
	return getModelPresetNames(settings).find(name => {
		const lookup = getModelPreset(settings, name);
		if (lookup.kind !== "found") return false;
		const { modelRoles, defaultThinkingLevel } = lookup.preset;
		if (defaultThinkingLevel !== undefined && defaultThinkingLevel !== thinking) return false;
		const presetChains = lookup.preset.fallbackChains;
		if (presetChains !== undefined && !sameFallbackChains(presetChains, liveChains)) return false;
		const presetIds = Object.keys(modelRoles);
		return (
			presetIds.length === roleIds.length &&
			presetIds.every(role => Object.hasOwn(roles, role) && roles[role] === modelRoles[role])
		);
	});
}

/**
 * Save the effective role assignments, `defaultThinkingLevel` and `retry.fallbackChains`
 * as `name` in the global config, overwriting a preset of the same name. Only this entry
 * is written, so presets defined by a project config are never copied globally.
 *
 * @throws Error when `name` is not a valid preset name.
 */
export function saveModelPreset(settings: Settings, name: string): ModelPreset {
	if (!isValidModelPresetName(name)) {
		throw new Error(`Invalid preset name "${name}": use a letter, then letters, digits, - or _`);
	}
	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (selector) modelRoles[role] = selector;
	}
	const preset: ModelPreset = {
		modelRoles,
		defaultThinkingLevel: cfgDefaultThinkingLevel.get(settings),
		fallbackChains: sanitizeFallbackChains(cfgRetryFallbackChains.get(settings)),
	};
	cfgModelPresets.setEntry(settings, name, preset);
	return preset;
}

export type ModelPresetDeleteResult = "deleted" | "missing" | "project";

/**
 * Delete `name` from the global config. A preset only a project (or `--config`)
 * file defines is reported as `project`: it has to be removed from that file.
 * The same applies when another layer defines the same name: the global entry is
 * removed but the preset keeps listing, so `project` is reported instead of a
 * false `deleted`.
 */
export function deleteModelPreset(settings: Settings, name: string): ModelPresetDeleteResult {
	const global = settings.getGlobalSettings().modelPresets;
	if (isRecord(global) && Object.hasOwn(global, name)) {
		cfgModelPresets.setEntry(settings, name, undefined);
		return settings.getOwnedModelPreset(name) ? "project" : "deleted";
	}
	return settings.getOwnedModelPreset(name) ? "project" : "missing";
}

/**
 * Layer above global config that still defines preset `name`, if any — so a
 * global save can warn that the just-saved entry is shadowed and won't apply.
 */
export function modelPresetShadowOwner(
	settings: Settings,
	name: string,
): "runtime" | "overlay" | "project" | undefined {
	const owned = settings.getOwnedModelPreset(name);
	return owned && owned.source !== "global" ? owned.source : undefined;
}

const SOURCE_LABELS: Record<SettingProvenance, string> = {
	env: "environment",
	runtime: "command line",
	overlay: "--config file",
	project: "project config",
	global: "global config",
	default: "default",
};

/** Status line after saving `name`, naming the higher layer whose same-name preset still wins, if any. */
export function modelPresetSavedMessage(settings: Settings, name: string): string {
	const owner = modelPresetShadowOwner(settings, name);
	if (owner === undefined) return `Saved model preset "${name}"`;
	return `Saved model preset "${name}" to the global config, but the ${SOURCE_LABELS[owner]} still defines a preset of the same name, which takes precedence`;
}

/** Serialize default-role mutations with the model hub's assign/unassign paths. */
let modelRoleMutationTail: Promise<void> = Promise.resolve();
export async function acquireModelRoleMutation(): Promise<() => void> {
	const previous = modelRoleMutationTail;
	const { promise, resolve } = Promise.withResolvers<void>();
	modelRoleMutationTail = previous.then(() => promise);
	await previous;
	return resolve;
}

/** A role whose effective assignment differs from the preset after applying it. */
export interface ModelPresetShadowedRole {
	role: string;
	/** The preset's selector, or undefined when the preset leaves the role unset. */
	expected: string | undefined;
	/** The effective selector that won instead. */
	actual: string | undefined;
	source: SettingProvenance;
}

/** The preset's `defaultThinkingLevel` when a layer above global config still decides the setting. */
export interface ModelPresetShadowedThinking {
	expected: NonNullable<ModelPreset["defaultThinkingLevel"]>;
	/** The effective setting that won instead; the live session still uses `expected`. */
	actual: ModelPreset["defaultThinkingLevel"];
	source: SettingProvenance;
}

/**
 * A `retry.fallbackChains` entry — or the record's key order — that another layer still decides
 * after the preset was written, so the effective chains differ from the preset's.
 */
export interface ModelPresetShadowedChain {
	/** The chain key, or `"(key order)"` when only the record's key order differs. */
	key: string;
	/** The preset's chain for `key`, or its key sequence for the `"(key order)"` entry. */
	expected: readonly string[] | undefined;
	/** The chain — or key sequence — effectively in force instead. */
	actual: readonly string[] | undefined;
	source: SettingProvenance;
}

export type ModelPresetSwitchResult =
	| {
			kind: "switched";
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
			/** Roles another layer still decides; empty on a clean switch. */
			shadowed: ModelPresetShadowedRole[];
			/** Set when another layer still decides `defaultThinkingLevel`, so it returns on reload. */
			shadowedThinking: ModelPresetShadowedThinking | undefined;
			/** Chain keys (or key order) another layer still decides; empty on a clean switch. */
			shadowedChains: ModelPresetShadowedChain[];
	  }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	/** Nothing was written: the preset's default model cannot be used right now. */
	| { kind: "unavailable"; reason: string }
	/** Roles were written but the live model could not be switched. */
	| {
			kind: "failed";
			reason: string;
			shadowed: ModelPresetShadowedRole[];
			shadowedChains: ModelPresetShadowedChain[];
	  };

export type ModelPresetSession = Pick<
	AgentSession,
	"setModel" | "setThinkingLevel" | "getAvailableModels" | "scopedModels" | "modelRegistry"
>;

function presetCandidates(session: ModelPresetSession): Model[] {
	const scoped = session.scopedModels.map(entry => entry.model);
	return scoped.length > 0 ? scoped : session.getAvailableModels();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** First authed model for a preset with no `default`, mirroring startup's automatic pick. */
function pickAutomaticDefault(session: ModelPresetSession, candidates: Model[]): Model | undefined {
	return pickDefaultAvailableModel(
		candidates.filter(candidate => session.modelRegistry.hasConfiguredAuth(candidate)),
		provider => session.modelRegistry.hasConcreteAuth(provider),
	);
}

/**
 * Where `default` lands once the preset is written: its model and thinking selector.
 * Without an explicit `:level` on the selector, the preset's own `defaultThinkingLevel`
 * applies even when a higher layer still decides the setting — the switch is for this
 * session; the shadowing layer is reported separately.
 */
function resolveLiveDefault(
	settings: Settings,
	session: ModelPresetSession,
	candidates: Model[],
	preset: ModelPreset,
): { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | string {
	const roleValue = settings.getModelRole("default");
	const fallbackLevel =
		preset.defaultThinkingLevel ?? parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings));
	if (!roleValue) {
		const model = pickAutomaticDefault(session, candidates);
		return model ? { model, thinkingLevel: fallbackLevel } : "no model with configured credentials is available";
	}
	const resolved = resolveModelRoleValue(roleValue, candidates, { settings });
	if (!resolved.model) return `default model \`${roleValue}\` is not available`;
	if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
		return `no credentials for ${resolved.model.provider}/${resolved.model.id}`;
	}
	return {
		model: resolved.model,
		thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : fallbackLevel,
	};
}

/** Write the preset's roles, thinking level and fallback chains, clearing what it leaves out. */
function writePresetRoles(settings: Settings, preset: ModelPreset): void {
	const project = cfgModelRoleStorage.get(settings) === "project";
	const roles = new Set([...Object.keys(settings.getModelRoles()), ...Object.keys(preset.modelRoles)]);
	if (project) {
		for (const role of roles) {
			const value = Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined;
			if (value !== undefined) settings.setProjectModelRole(role, value);
			else if (settings.getProjectModelRole(role) || settings.getModelRoleProvenance(role) === "runtime") {
				settings.clearProjectModelRole(role);
			}
		}
	} else {
		for (const role of roles) {
			if (Object.hasOwn(preset.modelRoles, role)) {
				settings.setModelRole(role, preset.modelRoles[role]);
				continue;
			}
			// Skip roles neither the global layer nor a runtime override owns:
			// deleting them would dirty the save queue without changing anything.
			if (settings.getGlobalModelRole(role) === undefined && settings.getModelRoleProvenance(role) !== "runtime") {
				continue;
			}
			settings.setModelRole(role, undefined);
		}
	}
	if (preset.defaultThinkingLevel !== undefined) {
		cfgDefaultThinkingLevel.set(settings, preset.defaultThinkingLevel);
	}
	if (preset.fallbackChains !== undefined) {
		// One whole-record write, not one `setEntry` per key: entry writes are staged and
		// re-applied by path (`Settings.#saveNow` → `setByPath`), so each key keeps its existing
		// position in config.yml and a reordered record would not survive a restart. Key order is
		// retry precedence here, so the preset's order has to land in the file. Copying the arrays
		// keeps the preset and the live record from ever sharing an instance.
		const chains: Record<string, string[]> = {};
		for (const [key, chain] of Object.entries(preset.fallbackChains)) chains[key] = [...chain];
		cfgRetryFallbackChains.set(settings, chains);
	}
}

function shadowedRoles(settings: Settings, preset: ModelPreset): ModelPresetShadowedRole[] {
	const effective = settings.getModelRoles();
	const roles = new Set([...Object.keys(effective), ...Object.keys(preset.modelRoles)]);
	const shadowed: ModelPresetShadowedRole[] = [];
	for (const role of [...roles].sort((a, b) => a.localeCompare(b))) {
		const expected = Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined;
		const actual = Object.hasOwn(effective, role) ? effective[role] : undefined;
		if (expected !== actual) {
			shadowed.push({ role, expected, actual, source: settings.getModelRoleProvenance(role) });
		}
	}
	return shadowed;
}

/**
 * Chain entries — or the key order — the preset could not put in force, because a layer above
 * global config still decides them. A whole-record global write cannot remove those keys, and
 * `Settings.#deepMerge` puts the higher layer's keys first, so the effective record can differ
 * from the preset's in values, in membership, or in order alone.
 */
function shadowedChains(settings: Settings, preset: ModelPreset): ModelPresetShadowedChain[] {
	const expected = preset.fallbackChains;
	if (expected === undefined) return [];
	const effective = sanitizeFallbackChains(cfgRetryFallbackChains.get(settings));
	if (sameFallbackChains(effective, expected)) return [];
	const source = cfgRetryFallbackChains.provenance(settings);
	const shadowed: ModelPresetShadowedChain[] = [];
	for (const key of new Set([...Object.keys(effective), ...Object.keys(expected)])) {
		const want = Object.hasOwn(expected, key) ? expected[key] : undefined;
		const got = Object.hasOwn(effective, key) ? effective[key] : undefined;
		if (!sameSelectorList(want, got)) shadowed.push({ key, expected: want, actual: got, source });
	}
	// Same keys and values in a different order: still not the preset's configuration, because
	// chain resolution takes the first matching key.
	if (shadowed.length === 0) {
		shadowed.push({ key: KEY_ORDER_LABEL, expected: Object.keys(expected), actual: Object.keys(effective), source });
	}
	return shadowed;
}

function shadowedThinking(settings: Settings, preset: ModelPreset): ModelPresetShadowedThinking | undefined {
	const expected = preset.defaultThinkingLevel;
	if (expected === undefined) return undefined;
	const actual = cfgDefaultThinkingLevel.get(settings);
	if (actual === expected) return undefined;
	return { expected, actual, source: cfgDefaultThinkingLevel.provenance(settings) };
}

/**
 * Apply preset `name`: persist its roles and thinking level, then switch the
 * live session to the resulting default model and thinking level.
 *
 * The preset's own default is checked before anything is written, so a preset
 * whose model is gone leaves settings untouched. A live switch that still fails
 * afterwards is reported as `failed`, never as a completed switch.
 */
export async function applyModelPreset(
	settings: Settings,
	session: ModelPresetSession,
	name: string,
): Promise<ModelPresetSwitchResult> {
	const release = await acquireModelRoleMutation();
	try {
		return await applyModelPresetLocked(settings, session, name);
	} finally {
		release();
	}
}

async function applyModelPresetLocked(
	settings: Settings,
	session: ModelPresetSession,
	name: string,
): Promise<ModelPresetSwitchResult> {
	const lookup = getModelPreset(settings, name);
	if (lookup.kind !== "found") return lookup;
	const { preset } = lookup;
	const candidates = presetCandidates(session);

	const presetDefault = Object.hasOwn(preset.modelRoles, "default") ? preset.modelRoles.default : undefined;
	if (presetDefault) {
		// Resolve against the preset's own roles overlaid on the current ones:
		// a default written as an alias (`@slow`) must see the state the write
		// produces, not the current roles.
		const roleLookup = {
			getModelRole: (role: string) =>
				Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : settings.getModelRole(role),
		};
		const resolved = resolveModelRoleValue(presetDefault, candidates, { settings, roleLookup });
		if (!resolved.model)
			return { kind: "unavailable", reason: `default model \`${presetDefault}\` is not available` };
		if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
			return {
				kind: "unavailable",
				reason: `no credentials for ${resolved.model.provider}/${resolved.model.id}`,
			};
		}
	} else if (!pickAutomaticDefault(session, candidates)) {
		// No `default` to apply and nothing to fall back to: refuse before writing.
		return { kind: "unavailable", reason: "no model with configured credentials is available" };
	}

	writePresetRoles(settings, preset);
	const shadowed = shadowedRoles(settings, preset);
	const thinkingShadow = shadowedThinking(settings, preset);
	const chainShadow = shadowedChains(settings, preset);

	const live = resolveLiveDefault(settings, session, candidates, preset);
	if (typeof live === "string") return { kind: "failed", reason: live, shadowed, shadowedChains: chainShadow };
	try {
		await session.setModel(live.model, "default", { persist: false });
	} catch (error) {
		return { kind: "failed", reason: errorMessage(error), shadowed, shadowedChains: chainShadow };
	}
	// setModel re-applies the model's default or keeps the current level; the preset decides instead.
	// `:inherit` means "no explicit level": leave what setModel applied rather than clearing the session level.
	if (live.thinkingLevel !== undefined && live.thinkingLevel !== ThinkingLevel.Inherit) {
		session.setThinkingLevel(live.thinkingLevel);
	}
	return {
		kind: "switched",
		model: live.model,
		thinkingLevel: live.thinkingLevel,
		shadowed,
		shadowedChains: chainShadow,
		shadowedThinking: thinkingShadow,
	};
}

function describeRoleValue(value: string | undefined): string {
	return value ?? "(unset)";
}

function describeChainValue(value: readonly string[] | undefined): string {
	if (value === undefined) return "(unset)";
	return value.length > 0 ? value.join(", ") : "(empty)";
}

/** One line per role, chain entry and the thinking level the preset could not set, for status output. */
export function describeShadowedRoles(
	shadowed: readonly ModelPresetShadowedRole[],
	thinking?: ModelPresetShadowedThinking,
	chains?: readonly ModelPresetShadowedChain[],
): string[] {
	const lines = shadowed.map(
		entry =>
			`${entry.role}: ${describeRoleValue(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeRoleValue(entry.expected)})`,
	);
	for (const entry of chains ?? []) {
		lines.push(
			`fallback chain ${entry.key}: ${describeChainValue(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeChainValue(entry.expected)})`,
		);
	}
	if (thinking) {
		lines.push(
			`defaultThinkingLevel: ${describeRoleValue(thinking.actual)} from ${SOURCE_LABELS[thinking.source]} (preset: ${thinking.expected})`,
		);
	}
	return lines;
}

/** True when the switch applied the whole preset: switched, with no role, chain entry or thinking level still decided elsewhere. */
export function isCleanModelPresetSwitch(result: ModelPresetSwitchResult): boolean {
	return (
		result.kind === "switched" &&
		result.shadowed.length === 0 &&
		result.shadowedChains.length === 0 &&
		result.shadowedThinking === undefined
	);
}

/** Short summary of a switch outcome for status lines and command output. */
export function formatModelPresetSwitch(name: string, result: ModelPresetSwitchResult): string {
	switch (result.kind) {
		case "missing":
			return `Preset not found: ${name}`;
		case "invalid":
			return `Preset "${name}" is malformed: ${result.reason}`;
		case "unavailable":
			return `Preset "${name}" not applied: ${result.reason}`;
		case "failed":
			return `Preset "${name}" roles saved, but the model was not switched: ${result.reason}`;
		case "switched": {
			const thinking = result.thinkingLevel ? ` · ${result.thinkingLevel}` : "";
			const model = `${result.model.provider}/${result.model.id}${thinking}`;
			const elsewhere = describeShadowedRoles(result.shadowed, result.shadowedThinking, result.shadowedChains);
			if (elsewhere.length === 0) return `Switched to preset "${name}" (${model})`;
			return `Switched to preset "${name}" (${model}); still set elsewhere: ${elsewhere.join("; ")}`;
		}
	}
}
