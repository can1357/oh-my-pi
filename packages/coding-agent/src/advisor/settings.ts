/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { ADVISOR_SEVERITIES } from "@oh-my-pi/pi-tui/chat/messages";
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
		label: __ompTranslate("Enable Advisor"),
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
		label: __ompTranslate("Advisor Sync Backlog"),
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
		label: __ompTranslate("Advisor Immune Turns"),
		description:
			"After an advisor concern or blocker interrupts, route further concerns as non-interrupting asides for this many primary turns. Blockers are exempt from the cooldown.",
		options: [
			{ value: "0", label: __ompTranslate("0 steps"), description: __ompTranslate("No cooldown.") },
			{ value: "1", label: __ompTranslate("1 step") },
			{ value: "2", label: __ompTranslate("2 steps") },
			{ value: "3", label: __ompTranslate("3 steps"), description: __ompTranslate("Default.") },
			{ value: "4", label: __ompTranslate("4 steps") },
			{ value: "5", label: __ompTranslate("5 steps") },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorContinueSeverity = register({
	id: "advisor.continueSeverity",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ADVISOR_SEVERITIES,
	default: "concern",
	ui: {
		tab: "model",
		group: "Advisor",
		label: __ompTranslate("Advisor Continue Severity"),
		description:
			"Minimum severity of an advisor note that wakes the agent after it finished with a final answer. Lower-severity notes stay as a card at the end of the transcript and reach the agent with your next message.",
		options: [
			{ value: "nit", label: __ompTranslate("Nit"), description: __ompTranslate("Every note continues the run.") },
			{
				value: "concern",
				label: __ompTranslate("Concern"),
				description: __ompTranslate("Concerns and blockers continue the run. Default."),
			},
			{
				value: "blocker",
				label: __ompTranslate("Blocker"),
				description: __ompTranslate("Only blockers continue the run."),
			},
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
		label: __ompTranslate("Advisor Review Mode"),
		description:
			"Default advisor cadence when no WATCHDOG.yml roster is present. turn reviews every primary turn; agent-end reviews only final yields.",
		options: [
			{
				value: "turn",
				label: __ompTranslate("Every turn"),
				description: __ompTranslate("Review every primary update (tool-call round)."),
			},
			{
				value: "agent-end",
				label: __ompTranslate("Agent end"),
				description: __ompTranslate("Review only at final yields (once per run)."),
			},
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
		label: __ompTranslate("Advisor Review Interval"),
		description:
			"Default advisor cadence when no WATCHDOG.yml roster is present: review every Nth eligible primary update. 1 = every update. Skipped updates are sent with the next scheduled review.",
		options: [
			{ value: "1", label: __ompTranslate("Every eligible update"), description: __ompTranslate("Default.") },
			{ value: "2", label: __ompTranslate("Every 2nd") },
			{ value: "3", label: __ompTranslate("Every 3rd") },
			{ value: "5", label: __ompTranslate("Every 5th") },
			{ value: "10", label: __ompTranslate("Every 10th") },
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
		label: __ompTranslate("Advisor Max Notes Per Update"),
		description:
			"Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt.",
		options: [
			{ value: "1", label: __ompTranslate("1 note"), description: __ompTranslate("Anti-flood (strict).") },
			{ value: "2", label: __ompTranslate("2 notes") },
			{ value: "3", label: __ompTranslate("3 notes") },
			{
				value: "4",
				label: __ompTranslate("4 notes"),
				description: __ompTranslate("Frontier reasoning models. Default."),
			},
			{ value: "5", label: __ompTranslate("5 notes") },
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
		label: __ompTranslate("Advisor Evict Stale Results"),
		description:
			"Before each review, replace the advisor's read/grep/glob output from older reviews with a short placeholder. The latest review is kept.",
		condition: "advisorEnabled",
	},
});
