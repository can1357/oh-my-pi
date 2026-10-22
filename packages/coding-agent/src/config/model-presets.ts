/**
 * Model presets: named snapshots of the role assignments (`modelRoles`),
 * `defaultThinkingLevel` and role-keyed `retry.fallbackChains`, saved and
 * re-applied as a whole.
 *
 * Presets persist to the global config (`modelPresets.<name>`); a project config
 * may also define presets, which are listed and applied but never copied into
 * the global file. Applying a preset writes roles the way the model hub does:
 * into the scope selected by `modelRoleStorage`, replacing `--model`/env runtime
 * role overrides like hub edits do. Roles still decided by another layer (a
 * `--config` overlay, a project config in global mode, or the global config in
 * project mode) are reported back instead of being silently kept. Role fallback
 * chains are written to the global config like model hub chain edits, and only in
 * global storage mode; chains keyed by model or provider selector are not part of
 * a preset. An empty chain (`[]`) is kept as "no fallbacks", unlike an absent one.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { isRetryFallbackModelKey } from "../session/retry-fallback-chains";
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
	const preset: ModelPreset = { modelRoles };
	const level = raw.defaultThinkingLevel;
	if (level !== undefined) {
		const thinking = typeof level === "string" ? parseConfiguredThinkingLevel(level) : undefined;
		if (thinking === undefined || !isDefaultThinkingLevel(thinking)) {
			return "`defaultThinkingLevel` is not a thinking level";
		}
		preset.defaultThinkingLevel = thinking;
	}
	const chains = raw.fallbackChains;
	if (chains !== undefined) {
		if (!isRecord(chains)) return "`fallbackChains` is not a mapping";
		const fallbackChains: Record<string, string[]> = {};
		for (const role of Object.keys(chains)) {
			if (isRetryFallbackModelKey(role)) return `fallback chain \`${role}\` is not keyed by a role`;
			const chain = chains[role];
			if (!Array.isArray(chain) || !chain.every(entry => typeof entry === "string" && entry.trim() !== "")) {
				return `fallback chain \`${role}\` is not a list of model selectors`;
			}
			fallbackChains[role] = [...chain];
		}
		preset.fallbackChains = fallbackChains;
	}
	return preset;
}

/**
 * Effective fallback chains keyed by role, including explicit empty ones (`[]` disables
 * fallbacks, while an absent chain inherits defaults); model- and provider-keyed chains are left out.
 */
function getRoleFallbackChains(settings: Settings): Record<string, string[]> {
	const chains = cfgRetryFallbackChains.get(settings);
	const roleChains: Record<string, string[]> = {};
	for (const key of Object.keys(chains)) {
		const chain = chains[key];
		if (!isRetryFallbackModelKey(key) && Array.isArray(chain)) roleChains[key] = [...chain];
	}
	return roleChains;
}

function sameChain(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function sameChains(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameChain(a[key], b[key]))
	);
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
 * First saved preset (by name) the current setup matches: identical effective
 * role assignments, the same role fallback chains when the preset records them
 * (a preset without them leaves chains alone) and, when the preset records one,
 * the same default thinking level. Undefined when the setup was edited past every preset.
 */
export function findActiveModelPreset(settings: Settings): string | undefined {
	const roles = settings.getModelRoles();
	// Same filter as `saveModelPreset`: empty selectors are never stored.
	const roleIds = Object.keys(roles).filter(role => roles[role]);
	const thinking = cfgDefaultThinkingLevel.get(settings);
	const chains = getRoleFallbackChains(settings);
	return getModelPresetNames(settings).find(name => {
		const lookup = getModelPreset(settings, name);
		if (lookup.kind !== "found") return false;
		const { modelRoles, defaultThinkingLevel, fallbackChains } = lookup.preset;
		if (defaultThinkingLevel !== undefined && defaultThinkingLevel !== thinking) return false;
		if (fallbackChains !== undefined && !sameChains(fallbackChains, chains)) return false;
		const presetIds = Object.keys(modelRoles);
		return (
			presetIds.length === roleIds.length &&
			presetIds.every(role => Object.hasOwn(roles, role) && roles[role] === modelRoles[role])
		);
	});
}

/**
 * Save the effective role assignments, `defaultThinkingLevel` and role fallback
 * chains as `name` in the global config, overwriting a preset of the same name. Only this entry is
 * written, so presets defined by a project config are never copied globally.
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
		fallbackChains: getRoleFallbackChains(settings),
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

/** A role whose effective fallback chain differs from the preset after applying it. */
export interface ModelPresetShadowedChain {
	role: string;
	/** The preset's chain, or undefined when the preset leaves the role without one. */
	expected: string[] | undefined;
	/** The effective chain that won instead. */
	actual: string[] | undefined;
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
			/** Role fallback chains another layer still decides; empty on a clean switch. */
			shadowedChains: ModelPresetShadowedChain[];
	  }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	/** Nothing was written: the preset's default model cannot be used right now. */
	| { kind: "unavailable"; reason: string }
	/** Roles were written but the live model could not be switched. */
	| { kind: "failed"; reason: string; shadowed: ModelPresetShadowedRole[] };

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

/** Write the preset's roles into the model hub's storage scope, clearing roles it leaves out. */
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
	writePresetFallbackChains(settings, preset);
}

/**
 * Replace the global role fallback chains with the preset's, clearing role chains it
 * leaves out. Model- and provider-keyed chains stay as they are. A preset without
 * recorded chains leaves them alone. In project storage mode nothing is written:
 * chains have no project-scoped write, and rewriting global chains would change
 * every other project; chains that then differ are reported as shadowed.
 */
function writePresetFallbackChains(settings: Settings, preset: ModelPreset): void {
	const chains = preset.fallbackChains;
	if (chains === undefined || cfgModelRoleStorage.get(settings) === "project") return;
	const retry = settings.getGlobalSettings().retry;
	const global = isRecord(retry) ? retry.fallbackChains : undefined;
	const globalRoles = isRecord(global) ? Object.keys(global).filter(key => !isRetryFallbackModelKey(key)) : [];
	for (const role of globalRoles) {
		if (!Object.hasOwn(chains, role)) cfgRetryFallbackChains.setEntry(settings, role, undefined);
	}
	for (const role of Object.keys(chains)) {
		cfgRetryFallbackChains.setEntry(settings, role, chains[role]);
	}
}

function shadowedChains(settings: Settings, preset: ModelPreset): ModelPresetShadowedChain[] {
	const expectedChains = preset.fallbackChains;
	if (expectedChains === undefined) return [];
	const effective = getRoleFallbackChains(settings);
	const roles = new Set([...Object.keys(effective), ...Object.keys(expectedChains)]);
	const shadowed: ModelPresetShadowedChain[] = [];
	for (const role of [...roles].sort((a, b) => a.localeCompare(b))) {
		const expected = Object.hasOwn(expectedChains, role) ? expectedChains[role] : undefined;
		const actual = Object.hasOwn(effective, role) ? effective[role] : undefined;
		if (!sameChain(expected, actual)) {
			shadowed.push({ role, expected, actual, source: settings.getFallbackChainProvenance(role) });
		}
	}
	return shadowed;
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
	if (typeof live === "string") return { kind: "failed", reason: live, shadowed };
	try {
		await session.setModel(live.model, "default", { persist: false });
	} catch (error) {
		return { kind: "failed", reason: errorMessage(error), shadowed };
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
		shadowedThinking: thinkingShadow,
		shadowedChains: chainShadow,
	};
}

function describeRoleValue(value: string | undefined): string {
	return value ?? "(unset)";
}

function describeChain(chain: readonly string[] | undefined): string {
	if (!chain) return "(none)";
	return chain.length > 0 ? chain.join(" → ") : "(no fallbacks)";
}

/** One line per role, the thinking level and each role fallback chain the preset could not set, for status output. */
export function describeShadowedRoles(
	shadowed: readonly ModelPresetShadowedRole[],
	thinking?: ModelPresetShadowedThinking,
	chains: readonly ModelPresetShadowedChain[] = [],
): string[] {
	const lines = shadowed.map(
		entry =>
			`${entry.role}: ${describeRoleValue(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeRoleValue(entry.expected)})`,
	);
	if (thinking) {
		lines.push(
			`defaultThinkingLevel: ${describeRoleValue(thinking.actual)} from ${SOURCE_LABELS[thinking.source]} (preset: ${thinking.expected})`,
		);
	}
	for (const entry of chains) {
		lines.push(
			`${entry.role} fallbacks: ${describeChain(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeChain(entry.expected)})`,
		);
	}
	return lines;
}

/** True when the switch applied the whole preset: switched, with no role, thinking level or fallback chain still decided elsewhere. */
export function isCleanModelPresetSwitch(result: ModelPresetSwitchResult): boolean {
	return (
		result.kind === "switched" &&
		result.shadowed.length === 0 &&
		result.shadowedThinking === undefined &&
		result.shadowedChains.length === 0
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
