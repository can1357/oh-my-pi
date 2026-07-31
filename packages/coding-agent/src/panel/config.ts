import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseConfiguredThinkingLevel, parseThinkingLevel } from "../thinking";
import {
	PANEL_MAX_MEMBERS,
	PANEL_PERSONA_TOOLS,
	PANEL_STRATEGIES,
	PANEL_TASK_MODES,
	type PanelMember,
	type PanelPersona,
	type PanelPersonaTools,
	type PanelRole,
	type PanelSettings,
	type PanelStrategy,
	type PanelTaskMode,
	type ResolvedPanelMember,
	type ResolvedPanelRole,
} from "./types";

/** A descriptive user-configuration error for panel settings or resolved roles. */
export class PanelConfigError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "PanelConfigError";
	}
}

/** Key names rejected on every parsed record, regardless of shape, to keep prototype-pollution vectors out of static config. */
const UNSAFE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** True for a plain `{}`-shaped object: not an array, and not something with a foreign or null-free prototype chain. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Parses a plain object at `path`, rejecting non-objects, unsafe own key
 * names, and any own property that is not a plain enumerable data field
 * (an accessor, or a non-enumerable/symbol-keyed property) — static config
 * must never execute caller-supplied code as a side effect of being read.
 */
function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new PanelConfigError(path, "must be a plain object");
	for (const key of Object.keys(value)) {
		if (UNSAFE_KEYS.includes(key)) throw new PanelConfigError(`${path}.${key}`, "unsafe key name");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			throw new PanelConfigError(`${path}.${key}`, "must be a plain data field, not an accessor");
		}
	}
	return value;
}

/** Rejects any own key of `record` not present in `allowed`. */
function requireKnownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new PanelConfigError(`${path}.${key}`, "unknown key");
	}
}

function requireNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PanelConfigError(path, "must be a non-empty string");
	}
	return value;
}

/**
 * True when `model` ends in a trailing thinking selector the resolver's
 * default (unguarded) suffix parsing would recognize (`:high`, `:off`,
 * `:inherit`, and similar selectors). Panel members carry their thinking
 * override in the separate `thinking` field, so a recognized suffix is a
 * configuration mistake. `:max` and `:auto` are excluded because both are
 * ambiguous with real literal model ids. The resolver treats them as suffixes
 * only when explicitly opted in, guarded by a literal-id check.
 */
function hasForbiddenThinkingSuffix(model: string): boolean {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx <= 0) return false;
	const level = parseThinkingLevel(model.slice(colonIdx + 1));
	return level !== undefined && level !== ThinkingLevel.Max;
}

function parsePanelMember(value: unknown, path: string): PanelMember {
	const record = requireRecord(value, path);
	requireKnownKeys(record, ["model", "thinking", "persona"], path);

	const model = requireNonEmptyString(record.model, `${path}.model`);
	if (hasForbiddenThinkingSuffix(model)) {
		throw new PanelConfigError(
			`${path}.model`,
			"must not include a trailing thinking suffix; use the thinking field instead",
		);
	}

	let thinking: PanelMember["thinking"];
	if (record.thinking !== undefined) {
		if (typeof record.thinking !== "string") throw new PanelConfigError(`${path}.thinking`, "must be a string");
		const parsed = parseConfiguredThinkingLevel(record.thinking);
		if (parsed === undefined || parsed === ThinkingLevel.Inherit) {
			throw new PanelConfigError(`${path}.thinking`, "must be a thinking level other than inherit");
		}
		thinking = parsed;
	}

	let persona: string | undefined;
	if (record.persona !== undefined) {
		persona = requireNonEmptyString(record.persona, `${path}.persona`);
	}

	return Object.freeze({
		model,
		...(thinking !== undefined ? { thinking } : {}),
		...(persona !== undefined ? { persona } : {}),
	});
}

function parsePanelRole(value: unknown, path: string): PanelRole {
	const record = requireRecord(value, path);
	requireKnownKeys(record, ["strategy", "members"], path);

	const strategyRaw = record.strategy;
	if (typeof strategyRaw !== "string" || !(PANEL_STRATEGIES as readonly string[]).includes(strategyRaw)) {
		throw new PanelConfigError(`${path}.strategy`, `must be one of: ${PANEL_STRATEGIES.join(", ")}`);
	}
	const strategy = strategyRaw as PanelStrategy;

	const membersRaw = record.members;
	if (!Array.isArray(membersRaw)) throw new PanelConfigError(`${path}.members`, "must be an array");
	if (membersRaw.length < 2) throw new PanelConfigError(`${path}.members`, "must include at least two members");
	if (membersRaw.length > PANEL_MAX_MEMBERS) {
		throw new PanelConfigError(`${path}.members`, `must include at most ${PANEL_MAX_MEMBERS} members`);
	}
	const members = membersRaw.map((memberValue, index) => parsePanelMember(memberValue, `${path}.members[${index}]`));
	if (strategy === "independent") {
		if (members.some(member => member.persona !== undefined)) {
			throw new PanelConfigError(`${path}.members`, "independent roles must not assign a persona to any member");
		}
	} else {
		if (members.some(member => member.persona === undefined)) {
			throw new PanelConfigError(`${path}.members`, "personas roles require a persona for every member");
		}
	}

	return Object.freeze({ strategy, members: Object.freeze(members) });
}

/**
 * Parses one persona record (the value stored at `panel.personas.<id>`),
 * rejecting unknown keys, unsupported modes, and any tools value outside
 * {@link PANEL_PERSONA_TOOLS}. Exported so the persona editor validates
 * entries with exactly the parser the config loader applies. Throws
 * {@link PanelConfigError} with the offending `path`.
 */
export function parsePanelPersona(value: unknown, path: string): PanelPersona {
	const record = requireRecord(value, path);
	requireKnownKeys(record, ["label", "modes", "instructions", "tools"], path);

	const label = requireNonEmptyString(record.label, `${path}.label`);

	const modesRaw = record.modes;
	if (!Array.isArray(modesRaw) || modesRaw.length === 0) {
		throw new PanelConfigError(`${path}.modes`, "must be a non-empty array");
	}
	const modes = modesRaw.map((modeValue, index) => {
		if (typeof modeValue !== "string" || !(PANEL_TASK_MODES as readonly string[]).includes(modeValue)) {
			throw new PanelConfigError(`${path}.modes[${index}]`, `must be one of: ${PANEL_TASK_MODES.join(", ")}`);
		}
		return modeValue as PanelTaskMode;
	});

	const instructions = requireNonEmptyString(record.instructions, `${path}.instructions`);

	const toolsRaw = record.tools;
	if (typeof toolsRaw !== "string" || !(PANEL_PERSONA_TOOLS as readonly string[]).includes(toolsRaw)) {
		throw new PanelConfigError(`${path}.tools`, `must be one of: ${PANEL_PERSONA_TOOLS.join(", ")}`);
	}

	return Object.freeze({ label, modes: Object.freeze(modes), instructions, tools: toolsRaw as PanelPersonaTools });
}

/**
 * Parses the `panel` settings record into a normalized, readonly-safe
 * {@link PanelSettings}. Only static shape and cross-reference invariants are
 * checked here (unknown keys, strategy/member counts, persona references);
 * model availability and resolved-family diversity are validated later by
 * {@link validateResolvedPanelRole} once every member's model has resolved.
 */
export function parsePanelSettings(value: unknown): PanelSettings {
	const record = requireRecord(value, "panel");
	requireKnownKeys(record, ["defaultRole", "roles", "personas"], "panel");

	let defaultRole: string | undefined;
	if (record.defaultRole !== undefined) {
		defaultRole = requireNonEmptyString(record.defaultRole, "panel.defaultRole");
	}

	const personasRaw = record.personas === undefined ? {} : requireRecord(record.personas, "panel.personas");
	const personas: Record<string, PanelPersona> = {};
	for (const [id, personaValue] of Object.entries(personasRaw)) {
		personas[id] = parsePanelPersona(personaValue, `panel.personas.${id}`);
	}

	const rolesRaw = record.roles === undefined ? {} : requireRecord(record.roles, "panel.roles");
	const roles: Record<string, PanelRole> = {};
	for (const [id, roleValue] of Object.entries(rolesRaw)) {
		const role = parsePanelRole(roleValue, `panel.roles.${id}`);
		if (role.strategy === "personas") {
			for (const member of role.members) {
				if (member.persona === undefined || lookupPanelPersona(personas, member.persona) === undefined) {
					throw new PanelConfigError(`panel.roles.${id}`, `unknown persona "${member.persona ?? ""}"`);
				}
			}
		}
		roles[id] = role;
	}

	if (defaultRole !== undefined && !Object.hasOwn(roles, defaultRole)) {
		throw new PanelConfigError("panel.defaultRole", `unknown role "${defaultRole}"`);
	}

	const settings: PanelSettings = { roles: Object.freeze(roles), personas: Object.freeze(personas) };
	return defaultRole !== undefined ? Object.freeze({ ...settings, defaultRole }) : Object.freeze(settings);
}

/**
 * Resolves `roleId` (or, when omitted, `settings.defaultRole`) against
 * `settings.roles`. Throws {@link PanelConfigError} when no role id is
 * available or the id names an unconfigured role.
 */
export function resolvePanelRole(settings: PanelSettings, roleId: string | undefined): ResolvedPanelRole {
	const id = roleId ?? settings.defaultRole;
	if (id === undefined) {
		throw new PanelConfigError("panel.defaultRole", "no panel role id was given and no default role is configured");
	}
	if (!Object.hasOwn(settings.roles, id)) {
		throw new PanelConfigError(`panel.roles.${id}`, "unknown panel role");
	}
	const role = settings.roles[id];
	return { roleId: id, role };
}

/**
 * Validates a resolved role against its saved member shape: resolved-list
 * length, index ordering, and, for `independent` strategy only, that every
 * resolved member carries a known, distinct model family (fail-closed on an
 * empty family by product decision). `personas` roles skip family diversity:
 * repeated families are the product contract for perspective coverage.
 * Persona existence and task-mode availability are validated separately by
 * {@link resolvePanelPersona}, which the runtime calls once per personas
 * member before dispatch.
 */
export function validateResolvedPanelRole(
	roleId: string,
	role: PanelRole,
	members: readonly ResolvedPanelMember[],
	taskMode: PanelTaskMode,
): void {
	const rolePath = `panel.roles.${roleId}`;
	if (!(PANEL_TASK_MODES as readonly string[]).includes(taskMode)) {
		throw new PanelConfigError(`${rolePath}.taskMode`, `unknown task mode "${taskMode}"`);
	}
	if (members.length !== role.members.length) {
		throw new PanelConfigError(
			`${rolePath}.members`,
			`expected ${role.members.length} resolved members, got ${members.length}`,
		);
	}
	members.forEach((member, position) => {
		if (member.index !== position) {
			throw new PanelConfigError(
				`${rolePath}.members[${position}]`,
				"resolved member index does not match its position",
			);
		}
	});

	if (role.strategy !== "independent") return;

	const seenFamilies = new Set<string>();
	for (const member of members) {
		if (member.family.length === 0) {
			throw new PanelConfigError(
				`${rolePath}.members[${member.index}]`,
				"resolved member has no known model family",
			);
		}
		if (seenFamilies.has(member.family)) {
			throw new PanelConfigError(
				`${rolePath}.members[${member.index}]`,
				`duplicate resolved model family "${member.family}"`,
			);
		}
		seenFamilies.add(member.family);
	}
}

/**
 * The built-in persona catalog, available whenever the user has not
 * configured `panel.personas`. Every built-in persona is read-only
 * (`workspace-read`) and supports both task modes.
 */
export const BUILTIN_PANEL_PERSONAS: Readonly<Record<string, PanelPersona>> = Object.freeze({
	analyst: Object.freeze({
		label: "Analyst",
		modes: PANEL_TASK_MODES,
		instructions:
			"Focus on facts, constraints, and options. When planning, map the affected subsystems and their dependencies.",
		tools: "workspace-read",
	}),
	implementer: Object.freeze({
		label: "Implementer",
		modes: PANEL_TASK_MODES,
		instructions:
			"Focus on the practical implementation choice. When planning, sequence the smallest safe set of changes.",
		tools: "workspace-read",
	}),
	reviewer: Object.freeze({
		label: "Reviewer",
		modes: PANEL_TASK_MODES,
		instructions:
			"Focus on risks, missing cases, and regressions. When planning, define acceptance tests and rollback risks.",
		tools: "workspace-read",
	}),
});

/** Resolves a custom persona first, then a built-in persona, using own-key lookup only. */
function lookupPanelPersona(
	personas: Readonly<Record<string, PanelPersona>>,
	personaId: string,
): PanelPersona | undefined {
	if (Object.hasOwn(personas, personaId)) return personas[personaId];
	if (Object.hasOwn(BUILTIN_PANEL_PERSONAS, personaId)) return BUILTIN_PANEL_PERSONAS[personaId];
	return undefined;
}

/**
 * Resolves a custom-over-built-in persona and verifies it supports the
 * requested task mode. Throws {@link PanelConfigError} for an unknown id
 * (including a user-controlled `constructor`/`toString`/`__proto__` lookup,
 * rejected by the own-key checks in {@link lookupPanelPersona}) or a persona
 * unavailable for `taskMode`.
 */
export function resolvePanelPersona(settings: PanelSettings, personaId: string, taskMode: PanelTaskMode): PanelPersona {
	const persona = lookupPanelPersona(settings.personas, personaId);
	if (persona === undefined) {
		throw new PanelConfigError(`panel.personas.${personaId}`, `unknown panel persona "${personaId}"`);
	}
	if (!persona.modes.includes(taskMode)) {
		throw new PanelConfigError(
			`panel.personas.${personaId}`,
			`persona "${personaId}" does not support ${taskMode} mode`,
		);
	}
	return persona;
}
