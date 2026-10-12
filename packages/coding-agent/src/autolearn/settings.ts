/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
// Master flag is default-off → inert (read live at every stop); sub-flags gate behaviour.
export const cfgAutolearnEnabled = register({
	id: "autolearn.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-Learn (experimental)",
		description:
			"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
	},
});

export const cfgAutolearnAutoContinue = register({
	id: "autolearn.autoContinue",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-run capture at stop",
		description:
			"When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.",
		condition: "autolearnActive",
	},
});

// Config-file-only knob (numbers without `options` are hidden from the UI).
export const cfgAutolearnMinToolCalls = register({ id: "autolearn.minToolCalls", type: "number", default: 5 });

// Both below gate the session-settle scribe (see `autolearn/controller.ts`): a
// small model re-reads the finished session and mints managed skills from it.
export const cfgAutolearnScribe = register({
	id: "autolearn.scribe",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Auto-Learn",
		label: "Scribe pass at session settle",
		description:
			"When on, a small model reads the settled session and mints/enhances managed skills for its reusable procedures (uses extra tokens)",
		condition: "autolearnActive",
	},
});

/** Scribe model selector; empty means the `smol` role (see `resolveAutolearnScribeModel`). */
export const cfgAutolearnModel = register({ id: "autolearn.model", type: "string", default: undefined });
