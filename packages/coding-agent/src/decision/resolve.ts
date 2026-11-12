/**
 * Effective configuration of one decision feature. `decision.backend: off` turns every feature
 * off; setting only the backend never enables a feature.
 */
import type { Settings } from "../config/settings";
import {
	cfgDecisionBackend,
	cfgDecisionSkillsDeadlineMs,
	cfgDecisionSkillsMode,
	type DECISION_MODES,
} from "./settings";

export type DecisionMode = (typeof DECISION_MODES)[number];
export type DecisionBackend = "off" | "deterministic" | "judge";
export type DecisionFeature = "skills";

export interface DecisionFeatureConfig {
	mode: DecisionMode;
	backend: DecisionBackend;
	/** Total budget for one evaluation, shared by every judge call it makes. */
	deadlineMs: number;
}

const FEATURES: Record<DecisionFeature, (settings: Settings) => { mode: DecisionMode; deadlineMs: number }> = {
	skills: settings => ({
		mode: cfgDecisionSkillsMode.get(settings),
		deadlineMs: cfgDecisionSkillsDeadlineMs.get(settings),
	}),
};

export function resolveDecisionFeature(settings: Settings, feature: DecisionFeature): DecisionFeatureConfig {
	const backend = cfgDecisionBackend.get(settings);
	const { mode, deadlineMs } = FEATURES[feature](settings);
	return { mode: backend === "off" ? "off" : mode, backend, deadlineMs };
}

export const DECISION_FEATURES = Object.keys(FEATURES) as DecisionFeature[];
