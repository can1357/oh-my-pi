/**
 * Built-in model roles and role metadata helpers.
 */

import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import type { Settings } from "./settings";

export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "designer"
	| "commit"
	| "title"
	| "tiny"
	| "task"
	| "advisor"
	| "browser-operation"
	| "browser-control"
	| "route-predictor"
	| "fast-context"
	| "budget"
	| "balanced"
	| "max-intelligence"
	| "free";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success" },
	smol: { tag: "SMOL", name: "Fast", color: "warning" },
	slow: { tag: "SLOW", name: "Thinking", color: "accent" },
	vision: { tag: "VISION", name: "Vision", color: "error" },
	plan: { tag: "PLAN", name: "Architect", color: "muted" },
	designer: { tag: "DESIGNER", name: "Designer", color: "muted" },
	commit: { tag: "COMMIT", name: "Commit", color: "dim" },
	title: { tag: "TITLE", name: "Title", color: "dim", hidden: true },
	tiny: { tag: "TINY", name: "Tiny", color: "dim", hidden: true },
	task: { tag: "TASK", name: "Subtask", color: "muted" },
	advisor: { tag: "ADVISOR", name: "Advisor", color: "accent" },
	"browser-operation": { tag: "BROWSER", name: "Browser Operation", color: "warning" },
	"browser-control": { tag: "BROWSER", name: "Browser Control", color: "warning" },
	"route-predictor": { tag: "ROUTEPRED", name: "Route Predictor", color: "warning" },
	"fast-context": { tag: "FASTCTX", name: "Fast Context", color: "warning" },
	budget: { tag: "BUDGET", name: "Budget", color: "warning" },
	balanced: { tag: "BALANCED", name: "Balanced", color: "accent" },
	"max-intelligence": { tag: "MAXINT", name: "Max Intelligence", color: "success" },
	free: { tag: "FREE", name: "Free", color: "dim" },
};

export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"title",
	"tiny",
	"task",
	"advisor",
	"browser-operation",
	"browser-control",
	"route-predictor",
	"fast-context",
	"budget",
	"balanced",
	"max-intelligence",
	"free",
];

export type RoleInfo = ModelRoleInfo;

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role as ModelRole]?.hidden) as string[];
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
	const builtIn = role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined;
	const configured = settings.get("modelTags")[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}
