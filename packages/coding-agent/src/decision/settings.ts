/**
 * Settings declared by the decision layer (see `config/registry.ts`). Config-file only: every
 * feature stays off until both `decision.backend` and its own mode are set.
 */
import { register } from "../config/registry";

/** Modes shared by every decision feature; see `docs/decision-layer.md`. */
export const DECISION_MODES = ["off", "shadow", "suggest", "automatic"] as const;

export const cfgDecisionBackend = register({
	id: "decision.backend",
	type: "enum",
	values: ["off", "deterministic", "judge"] as const,
	default: "off",
});

export const cfgDecisionSkillsMode = register({
	id: "decision.skills.mode",
	type: "enum",
	values: DECISION_MODES,
	default: "off",
});

export const cfgDecisionSkillsVariant = register({
	id: "decision.skills.variant",
	type: "enum",
	values: ["roster", "progressive"] as const,
	default: "roster",
});

export const cfgDecisionSkillsDeadlineMs = register({
	id: "decision.skills.deadlineMs",
	type: "number",
	default: 4_000,
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0 || raw > 30_000) {
			throw new Error("decision.skills.deadlineMs must be an integer from 1 to 30000");
		}
	},
});

export const cfgDecisionToolsMode = register({
	id: "decision.tools.mode",
	type: "enum",
	values: DECISION_MODES,
	default: "off",
});

export const cfgDecisionToolsDeadlineMs = register({
	id: "decision.tools.deadlineMs",
	type: "number",
	default: 4_000,
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0 || raw > 30_000) {
			throw new Error("decision.tools.deadlineMs must be an integer from 1 to 30000");
		}
	},
});
