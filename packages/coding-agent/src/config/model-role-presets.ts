import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isLoopbackUrl } from "../utils/loopback";
import { formatModelStringWithRouting } from "./model-resolver";

/** Built-in roles a preset always covers. The selected model remains the default role. */
export const MODEL_PRESET_ROLES = ["smol", "slow", "vision", "plan", "commit", "tiny", "task", "advisor"] as const;

/**
 * One saved role profile. `roles` maps role name → model selector for every
 * role the preset assigns (built-ins and custom roles). A `default` entry —
 * when present — binds the primary selector itself, routing and effort suffix
 * included, so a saved Default restores the exact reasoning setup. An optional
 * `fallbackChains` snapshot records the ordered `retry.fallbackChains` map
 * captured at save time — role keys, exact `provider/id` keys, and
 * `provider/*` wildcards alike, entries verbatim including `:level` and
 * `@upstream` suffixes. A preset without `fallbackChains` leaves fallback
 * chains untouched when applied, while an explicit `{}` clears the captured
 * chain map.
 */
export interface ModelRolePreset {
	roles: Record<string, string>;
	fallbackChains?: Record<string, string[]>;
}

const MODEL_ROLE_PRESET_NAME_PATTERN = /^[a-zA-Z][\w -]*$/;

export function isModelRolePresetName(value: string): boolean {
	return value.toLowerCase() !== "default" && MODEL_ROLE_PRESET_NAME_PATTERN.test(value);
}

/**
 * Roles a preset assigns: its built-in set, any custom roles it carries, and any
 * `extraRoleKeys` a caller must also visit — replacement semantics pass the
 * target scope's stored role keys so a custom role omitted from the incoming
 * preset is still cleared.
 */
export function modelRolePresetRoles(preset: ModelRolePreset | undefined, extraRoleKeys?: Iterable<string>): string[] {
	const roles: string[] = [...MODEL_PRESET_ROLES];
	const add = (role: string): void => {
		if (role !== "default" && !roles.includes(role)) roles.push(role);
	};
	if (preset) for (const role in preset.roles) add(role);
	if (extraRoleKeys) for (const role of extraRoleKeys) add(role);
	return roles;
}

function toPresetPayload(value: unknown): ModelRolePreset | undefined {
	if (!isRecord(value) || !isRecord(value.roles)) return undefined;
	const roles: Record<string, string> = {};
	for (const role in value.roles) {
		const assignment = value.roles[role];
		if (typeof assignment === "string") roles[role] = assignment;
	}
	const chains = sanitizeFallbackChains(value.fallbackChains);
	const payload: ModelRolePreset = { roles };
	if (chains) payload.fallbackChains = chains;
	return payload;
}

/**
 * Normalize a fallback-chain record: drops non-array chains and non-string
 * entries so edits through the UI operate on well-formed data. Returns
 * undefined for non-records; a valid empty record is preserved (it means
 * "clear preset-owned chains" when applied).
 */
export function sanitizeFallbackChains(value: unknown): Record<string, string[]> | undefined {
	if (!isRecord(value)) return undefined;
	const chains: Record<string, string[]> = {};
	for (const key in value) {
		const chain = value[key];
		if (!Array.isArray(chain)) continue;
		chains[key] = chain.filter((entry): entry is string => typeof entry === "string");
	}
	return chains;
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function storedPresets(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	return isRecord(value.presets) ? value.presets : undefined;
}

function curatedModel(selected: Model, available: readonly Model[], role: "smol" | "slow"): Model {
	const namespaceEnd = selected.id.indexOf(".");
	const namespacePrefix = namespaceEnd < 0 ? undefined : selected.id.slice(0, namespaceEnd + 1);
	let best = selected;
	let bestPriority = Infinity;
	for (const candidate of available) {
		if (candidate.provider !== selected.provider) continue;
		const priority = candidate.rolePresetPriority?.[role];
		if (priority === undefined) continue;
		const candidateMatchesNamespace = namespacePrefix !== undefined && candidate.id.startsWith(namespacePrefix);
		const bestMatchesNamespace = namespacePrefix !== undefined && best.id.startsWith(namespacePrefix);
		if (
			priority < bestPriority ||
			(priority === bestPriority &&
				(candidateMatchesNamespace !== bestMatchesNamespace ? candidateMatchesNamespace : candidate.id < best.id))
		) {
			best = candidate;
			bestPriority = priority;
		}
	}
	return best;
}
/** Same-provider catalog-ranked choices; eligibility and priority are authored in KDL. */
export function buildDefaultModelRolePreset(selected: Model, available: readonly Model[]): ModelRolePreset {
	const selectedSelector = formatModelStringWithRouting(selected);
	const sameModel = Object.fromEntries(MODEL_PRESET_ROLES.map(role => [role, selectedSelector])) as Record<
		string,
		string
	>;
	if (isLoopbackUrl(selected.baseUrl)) return { roles: sameModel };
	const fast = curatedModel(selected, available, "smol");
	const comprehensive = curatedModel(selected, available, "slow");
	const curated = {
		...sameModel,
		smol: formatModelStringWithRouting(fast),
		tiny: formatModelStringWithRouting(fast),
		slow: formatModelStringWithRouting(comprehensive),
		task: formatModelStringWithRouting(comprehensive),
		commit: formatModelStringWithRouting(comprehensive),
		plan: formatModelStringWithRouting(comprehensive),
		advisor: formatModelStringWithRouting(comprehensive),
	};
	return { roles: curated };
}

/** Return valid saved-preset names for one selected model. */
export function getModelRolePresetNames(value: unknown, model: Model): string[] {
	if (!isRecord(value)) return [];
	const presets = storedPresets(value[selector(model)]);
	if (!presets) return [];
	return Object.keys(presets)
		.filter(name => isModelRolePresetName(name) && isRecord(presets[name]) && isRecord(presets[name].roles))
		.sort((a, b) => a.localeCompare(b));
}

/** Look up a saved preset. Undefined means use OMP's curated default. */
export function getModelRolePreset(
	value: unknown,
	model: Model,
	name: string | undefined,
): ModelRolePreset | undefined {
	if (!name || !isModelRolePresetName(name) || !isRecord(value)) return undefined;
	const presets = storedPresets(value[selector(model)]);
	if (!presets || !isRecord(presets[name])) return undefined;
	return toPresetPayload(presets[name]);
}

/** A model's saved Default, or undefined for OMP's built-in Default. */
export function getModelRolePresetDefault(value: unknown, model: Model): ModelRolePreset | undefined {
	if (!isRecord(value)) return undefined;
	const entry = value[selector(model)];
	if (!isRecord(entry)) return undefined;
	const direct = toPresetPayload(entry.default);
	if (direct) return direct;
	return typeof entry.default === "string" ? getModelRolePreset(value, model, entry.default) : undefined;
}

/** The named preset selected as Default, if any. Undefined means the Default row. */
export function getModelRolePresetDefaultName(value: unknown, model: Model): string | undefined {
	if (!isRecord(value)) return undefined;
	const entry = value[selector(model)];
	if (!isRecord(entry) || typeof entry.default !== "string" || !isModelRolePresetName(entry.default)) {
		return undefined;
	}
	return getModelRolePreset(value, model, entry.default) ? entry.default : undefined;
}

export function saveModelRolePreset(
	value: unknown,
	model: Model,
	name: string,
	roles: Readonly<Record<string, string | undefined>>,
	fallbackChains?: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	if (!isModelRolePresetName(name)) return next;
	const payload: ModelRolePreset = { roles: filterRoles(roles) };
	if (fallbackChains) payload.fallbackChains = sanitizeFallbackChains(fallbackChains) ?? {};
	const current = next[selector(model)];
	next[selector(model)] = {
		...(isRecord(current) ? current : {}),
		presets: { ...storedPresets(current), [name]: payload },
	};
	return next;
}

/** Copy a role-assignment map into preset form, keeping the `default` selector and dropping non-strings. */
function filterRoles(roles: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const role in roles) {
		const assignment = roles[role];
		if (typeof assignment === "string") filtered[role] = assignment;
	}
	return filtered;
}

/** Save the current role assignment map as this model's Default preset. */
export function saveModelRolePresetDefault(
	value: unknown,
	model: Model,
	roles: Readonly<Record<string, string | undefined>>,
	fallbackChains?: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	const payload: ModelRolePreset = { roles: filterRoles(roles) };
	if (fallbackChains) payload.fallbackChains = sanitizeFallbackChains(fallbackChains) ?? {};
	const current = next[selector(model)];
	next[selector(model)] = {
		...(isRecord(current) ? current : {}),
		default: payload,
	};
	return next;
}

/**
 * Rename a saved preset in place. The payload moves verbatim and the Default
 * pointer follows when it named the old preset. Invalid source, invalid target,
 * or a name collision returns the input unchanged.
 */
export function renameModelRolePreset(value: unknown, model: Model, from: string, to: string): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	if (!isModelRolePresetName(from) || !isModelRolePresetName(to) || from === to) return next;
	const current = next[selector(model)];
	const presets = storedPresets(current);
	if (!isRecord(current) || !presets || !Object.hasOwn(presets, from) || Object.hasOwn(presets, to)) {
		return next;
	}
	const remaining = { ...presets };
	remaining[to] = remaining[from];
	delete remaining[from];
	const entry: Record<string, unknown> = { ...current, presets: remaining };
	if (entry.default === from) entry.default = to;
	next[selector(model)] = entry;
	return next;
}

/** Remove a model's saved Default and restore OMP's built-in Default. */
export function resetModelRolePresetDefault(value: unknown, model: Model): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	const current = next[selector(model)];
	if (isRecord(current)) {
		const entry = { ...current };
		delete entry.default;
		if (isRecord(entry.presets) && Object.keys(entry.presets).length === 0) delete entry.presets;
		if (Object.keys(entry).length === 0) delete next[selector(model)];
		else next[selector(model)] = entry;
	}
	return next;
}

/** Select a named preset as Default; undefined restores OMP's built-in Default. */
export function setModelRolePresetDefault(
	value: unknown,
	model: Model,
	name: string | undefined,
): Record<string, unknown> {
	if (name === undefined) return resetModelRolePresetDefault(value, model);
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	if (!isModelRolePresetName(name)) return next;
	const current = next[selector(model)];
	const presets = storedPresets(current);
	if (!presets || !isRecord(presets[name])) return next;
	next[selector(model)] = { ...(isRecord(current) ? current : {}), default: name };
	return next;
}

/** Whether a preset entry exists under `name` for `model`, regardless of payload validity. */
export function modelRolePresetKeyExists(value: unknown, model: Model, name: string): boolean {
	const presets = storedPresets(isRecord(value) ? value[selector(model)] : undefined);
	return !!presets && Object.hasOwn(presets, name);
}

/** Delete a named preset; deleting the named Default restores OMP's built-in Default. */
export function deleteModelRolePreset(value: unknown, model: Model, name: string): Record<string, unknown> {
	const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
	if (!isModelRolePresetName(name)) return next;
	const current = next[selector(model)];
	const presets = storedPresets(current);
	if (!isRecord(current) || !presets || !Object.hasOwn(presets, name)) return next;
	const remaining = { ...presets };
	delete remaining[name];
	const entry: Record<string, unknown> = { ...current, presets: remaining };
	if (entry.default === name) delete entry.default;
	if (Object.keys(remaining).length === 0) delete entry.presets;
	if (Object.keys(entry).length === 0) delete next[selector(model)];
	else next[selector(model)] = entry;
	return next;
}
