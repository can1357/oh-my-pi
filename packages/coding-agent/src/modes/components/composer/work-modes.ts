/**
 * Composer work modes.
 *
 * Every mode listed here maps to enforceable runtime behavior that already
 * exists in the session layer — no mode is presentation-only:
 *
 * - `ask`   — observational. The session's active toolset is restricted to an
 *   explicit allowlist (see {@link computeAskModeTools}); mutation, delegation,
 *   and unknown tools are excluded fail-closed.
 * - `build` — the session default: full configured toolset with the existing
 *   per-call approval gates (`tools.approvalMode` + `tools.approval.*`
 *   policies, enforced in `ExtensionToolWrapper.execute`).
 * - `plan`  — the existing plan mode (`/plan`): plan-restricted system prompt,
 *   standing resolve handler, and the plan-review approval overlay.
 *
 * The task brief's `Operate`, `Research`, and `Delegate` modes are not
 * presented: OMPK has no distinct session-scoped runtime path for them
 * (Operate ≡ Build's approval gates, Research ≡ Ask's read-only enforcement,
 * Delegate has no coordination-only enforcement primitive). Presenting them
 * would fake capabilities in presentation code.
 */

export type ComposerWorkMode = "ask" | "build" | "plan";

export interface ComposerWorkModeDef {
	readonly id: ComposerWorkMode;
	readonly label: string;
	/** Compact label used when the bar must shrink. */
	readonly short: string;
	/** Primary-action label for the execution rail. */
	readonly cta: string;
	readonly summary: string;
}

export const COMPOSER_WORK_MODES: readonly ComposerWorkModeDef[] = [
	{
		id: "ask",
		label: "Ask",
		short: "Ask",
		cta: "Send",
		summary: "Read-only tools; no state-changing execution",
	},
	{
		id: "build",
		label: "Build",
		short: "Bld",
		cta: "Run",
		summary: "Full workspace access with configured approval gates",
	},
	{
		id: "plan",
		label: "Plan",
		short: "Pln",
		cta: "Run",
		summary: "Draft a plan for approval before execution",
	},
];

export function getComposerWorkModeDef(id: ComposerWorkMode): ComposerWorkModeDef {
	const def = COMPOSER_WORK_MODES.find(mode => mode.id === id);
	if (!def) throw new Error(`Unknown composer work mode: ${id}`);
	return def;
}

/**
 * Explicitly observational tools available in Ask mode. Keep this allowlist
 * deliberately narrow: READ_ONLY_TOOL_NAMES also contains tools that mutate
 * state, launch work, or delegate to arbitrary tools.
 */
export const ASK_MODE_OBSERVATIONAL_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"search",
	"find",
	"web_search",
	"ast_grep",
	"inspect_image",
	"recall",
	"reflect",
]);

/** Restrict an active toolset to Ask mode's observational subset; unknown tools fail closed. */
export function computeAskModeTools(activeToolNames: readonly string[]): string[] {
	return activeToolNames.filter(name => ASK_MODE_OBSERVATIONAL_TOOLS.has(name));
}

/** Cycle order for the mode keybinding: ask → build → plan → ask. */
export function nextComposerWorkMode(current: ComposerWorkMode, planAvailable: boolean): ComposerWorkMode {
	const order: ComposerWorkMode[] = planAvailable ? ["ask", "build", "plan"] : ["ask", "build"];
	const index = order.indexOf(current);
	return order[(index + 1) % order.length] ?? "build";
}
