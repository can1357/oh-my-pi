/**
 * Built-in model roles and role metadata helpers.
 */

import { modelKind, type Model } from "@oh-my-pi/pi-catalog/types";
import {
	KIND_ROLE_IDS,
	MODEL_ROLE_IDS,
	type ModelBrowserRegistry,
	type ModelBrowserRoleInfo,
	type ModelRole,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { isValidThemeColor } from "@oh-my-pi/pi-tui/theme";
import type { Settings } from "./settings";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Format a model role as its canonical selector. */
export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export type { ModelRole } from "@oh-my-pi/pi-tui/overlays/model-browser";
export { CHAT_MODEL_ROLE_IDS, KIND_ROLE_IDS, MODEL_ROLE_IDS } from "@oh-my-pi/pi-tui/overlays/model-browser";

export type ModelRoleInfo = ModelBrowserRoleInfo;

function acceptsChat(model: Model): boolean {
	return modelKind(model) === "chat";
}

function acceptsTinyOrChat(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "tiny" || kind === "chat";
}

function acceptsWeb(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "search" || (kind === "chat" && model.webSearch !== undefined);
}

function acceptsJudge(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "judge" || kind === "tiny" || kind === "chat";
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success", section: "chat", accepts: acceptsChat },
	smol: { tag: "SMOL", name: "Fast", color: "warning", section: "chat", accepts: acceptsChat },
	slow: { tag: "SLOW", name: "Thinking", color: "accent", section: "chat", accepts: acceptsChat },
	vision: { tag: "VISION", name: "Vision", color: "error", section: "chat", accepts: acceptsChat },
	plan: { tag: "PLAN", name: "Architect", color: "muted", section: "chat", accepts: acceptsChat },
	commit: { tag: "COMMIT", name: "Commit", color: "dim", section: "chat", accepts: acceptsChat },
	tiny: { tag: "TINY", name: "Tiny", color: "dim", section: "chat", accepts: acceptsTinyOrChat },
	memory: { tag: "MEMORY", name: "Memory", color: "dim", section: "chat", accepts: acceptsTinyOrChat },
	task: { tag: "TASK", name: "Subtask", color: "muted", section: "chat", accepts: acceptsChat },
	advisor: { tag: "ADVISOR", name: "Advisor", color: "accent", section: "chat", accepts: acceptsChat },
	image: {
		tag: "IMAGE",
		name: "Image generation",
		color: "accent",
		section: "kind",
		accepts: model => modelKind(model) === "image",
	},
	web: { tag: "WEB", name: "Web search", color: "success", section: "kind", accepts: acceptsWeb },
	speech: {
		tag: "SPEECH",
		name: "Speech",
		color: "warning",
		section: "kind",
		accepts: model => modelKind(model) === "tts",
	},
	dictation: {
		tag: "DICTATION",
		name: "Dictation",
		color: "warning",
		section: "kind",
		accepts: model => modelKind(model) === "stt",
	},
	judge: { tag: "JUDGE", name: "Judge", color: "muted", section: "kind", accepts: acceptsJudge },
};

export type RoleInfo = ModelRoleInfo;

/** Whether a role belongs to the non-chat model-kind section. */
export function isKindRole(role: string): boolean {
	return KIND_ROLE_IDS.some(id => id === role);
}

function isModelRole(role: string): role is ModelRole {
	return MODEL_ROLE_IDS.some(id => id === role);
}

/** Available models eligible for a role, including keyless runner models. */
export function roleCandidatePool(role: string, settings: Settings, registry: ModelBrowserRegistry): Model[] {
	return registry.getAvailable("all").filter(getRoleInfo(role, settings).accepts);
}

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles: string[] = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role].hidden);
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) addRole(role);
	for (const role in settings.getModelRoles()) addRole(role);
	for (const role in settings.get("modelTags")) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = isModelRole(role) ? MODEL_ROLES[role] : undefined;
	const configuredTags = settings.get("modelTags");
	const configured = Object.hasOwn(configuredTags, role) ? configuredTags[role] : undefined;

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
			accepts: builtIn?.accepts ?? acceptsChat,
			section: builtIn?.section ?? "chat",
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted", accepts: acceptsChat, section: "chat" };
}
