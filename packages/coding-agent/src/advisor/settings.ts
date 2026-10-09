/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { ADVISOR_REVIEW_MODES, ADVISOR_SYNC_BACKLOG_MODES } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { register } from "../config/registry";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE } from "./emission-guard";

// Advisor is interactive-session assistance: protocol hosts opt in explicitly instead of inheriting the
// user's local preference, and get the default tuning rather than the user's local tuning.
export const cfgAdvisorEnabled = register({
	id: "advisor.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Enable Advisor",
		description:
			"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
	},
});

export const cfgAdvisorSyncBacklog = register({
	id: "advisor.syncBacklog",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ADVISOR_SYNC_BACKLOG_MODES,
	default: "off",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Sync Backlog",
		description:
			"Pause main agent until advisor backlog falls below threshold. Numeric values cap wait at 30 seconds; strict waits for all scheduled reviews without a wall-clock cap. Off disables catch-up delays. Abort, failure, and disposal release waits.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorImmuneTurns = register({
	id: "advisor.immuneTurns",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Immune Turns",
		description:
			"After an advisor concern or blocker interrupts, route further concerns as non-interrupting asides for this many primary turns. Blockers are exempt from the cooldown.",
		options: [
			{ value: "0", label: "0 steps", description: "No cooldown." },
			{ value: "1", label: "1 step" },
			{ value: "2", label: "2 steps" },
			{ value: "3", label: "3 steps", description: "Default." },
			{ value: "4", label: "4 steps" },
			{ value: "5", label: "5 steps" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorReviewMode = register({
	id: "advisor.reviewMode",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ADVISOR_REVIEW_MODES,
	default: "turn",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Review Mode",
		description:
			"Default advisor cadence when no WATCHDOG.yml roster is present. turn reviews every primary turn; agent-end reviews only final yields.",
		options: [
			{ value: "turn", label: "Every turn", description: "Review every primary update (tool-call round)." },
			{ value: "agent-end", label: "Agent end", description: "Review only at final yields (once per run)." },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorReviewInterval = register({
	id: "advisor.reviewInterval",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 1,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Review Interval",
		description:
			"Default advisor cadence when no WATCHDOG.yml roster is present: review every Nth eligible primary update. 1 = every update. Skipped updates are sent with the next scheduled review.",
		options: [
			{ value: "1", label: "Every eligible update", description: "Default." },
			{ value: "2", label: "Every 2nd" },
			{ value: "3", label: "Every 3rd" },
			{ value: "5", label: "Every 5th" },
			{ value: "10", label: "Every 10th" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorMaxNotesPerUpdate = register({
	id: "advisor.maxNotesPerUpdate",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Max Notes Per Update",
		description:
			"Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt.",
		options: [
			{ value: "1", label: "1 note", description: "Anti-flood (strict)." },
			{ value: "2", label: "2 notes" },
			{ value: "3", label: "3 notes" },
			{ value: "4", label: "4 notes", description: "Frontier reasoning models. Default." },
			{ value: "5", label: "5 notes" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorEvictStaleResults = register({
	id: "advisor.evictStaleResults",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Evict Stale Results",
		description:
			"Before each review, replace the advisor's read/grep/glob output from older reviews with a short placeholder. The latest review is kept.",
		condition: "advisorEnabled",
	},
});
