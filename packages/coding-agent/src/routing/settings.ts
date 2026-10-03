/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Jev Model Routing steers each turn to a capability tier via TypeSafe System One judgments.
// Default OFF: when disabled or unconfigured the session model is used unchanged. The design is
// fail-open = fail expensive — any judge error, timeout, or low confidence keeps the top tier.
export const cfgJevRoutingEnabled = register({
	id: "jevRouting.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Jev Model Routing",
		description:
			"Route each turn to a capability tier via TypeSafe System One judgments. Default OFF — when off or unconfigured the session model is used unchanged. Fail-open = fail expensive: any judge error, timeout, or low confidence keeps the top tier.",
	},
});

export const cfgJevRoutingTiers = register({
	id: "jevRouting.tiers",
	type: "array",
	default: [],
	ui: {
		tab: "model",
		group: "Routing",
		label: "Routing Tiers",
		description:
			'Ordered cheapest → most capable. Each tier: {id, model: "provider/model", capability: free-text eligibility test}. Order is load-bearing — the last tier is the fail-safe default.',
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingMinConfidenceToDegrade = register({
	id: "jevRouting.minConfidenceToDegrade",
	type: "number",
	default: 0.85,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Degrade Confidence",
		description:
			"Minimum judge confidence to route DOWN to a cheaper tier. 0.85 suits mixed-capability pools; flat pools may use 0.55–0.65.",
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingMaxComplexityForDegrade = register({
	id: "jevRouting.maxComplexityForDegrade",
	type: "number",
	default: 0.5,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Degrade Complexity Ceiling",
		description: "Complexity score at or below which routing down is allowed.",
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingMinComplexityConfidence = register({
	id: "jevRouting.minComplexityConfidence",
	type: "number",
	default: 0.5,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Complexity Confidence Floor",
		description: "Below this the complexity score is untrusted and the task is treated as hard.",
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingAllowVerify = register({
	id: "jevRouting.allowVerify",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Verify Routed Output",
		description:
			"Post-hoc adequacy check on down-routed turns; a confident 'inadequate' verdict escalates to the next tier.",
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingMinConfidenceToEscalate = register({
	id: "jevRouting.minConfidenceToEscalate",
	type: "number",
	default: 0.7,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Escalate Confidence",
		description: "Minimum verifier confidence before acting on an 'inadequate' verdict.",
		condition: "jevRoutingActive",
	},
});

export const cfgJevRoutingMaxEscalationsPerTurn = register({
	id: "jevRouting.maxEscalationsPerTurn",
	type: "number",
	default: 1,
	ui: {
		tab: "model",
		group: "Routing",
		label: "Max Escalations Per Turn",
		description: "Cap on tier escalations within one turn; budget spent = accept output.",
		condition: "jevRoutingActive",
	},
});
