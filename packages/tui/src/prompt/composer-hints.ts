/**
 * Composer hints: the right-aligned placeholder shown in the empty composer to
 * surface gestures that matter right now (e.g. background agents are running).
 *
 * Hints are checked in priority order; the first one that applies wins. A hint
 * retires for good once the user has performed its gesture
 * {@link ComposerHint.learnedAfter} times — the host records each use under the
 * hint's id and reports counts through {@link ComposerHintContext.uses}.
 *
 * Add a hint by appending to {@link COMPOSER_HINTS}, extending
 * {@link ComposerHintId}, and recording the gesture where it is handled.
 */
import { uiText } from "@oh-my-pi/pi-utils/ui-language";
import { theme } from "../theme/theme";
import { formatDoubleTap, formatKeyHint, type KeybindingsManager } from "../app-keybindings";

/** Stable hint ids; persisted as usage-counter keys, so never rename one. */
export type ComposerHintId = "agents" | "effort";

/** Live state that hint conditions read. Built by the host on every render of the empty composer. */
export interface ComposerHintContext {
	/** Subagents currently running in the background. */
	runningAgents: number;
	/** The view is focused on a subagent session instead of the main one. */
	focusedOnAgent: boolean;
	/** The viewed session already has messages. */
	conversationStarted: boolean;
	keybindings: KeybindingsManager;
	/** Times the user has performed the gesture a hint teaches. */
	uses(id: ComposerHintId): number;
}

/** A gesture tip: `key` renders highlighted, `label` describes what it does. */
export interface ComposerHint {
	id: ComposerHintId;
	/** Uses of the gesture after which the hint stops showing. */
	learnedAfter: number;
	/** Key and label when the hint applies, otherwise `undefined`. */
	resolve(ctx: ComposerHintContext): { key: string; label: string } | undefined;
}

/** Registered hints, highest priority first. */
export const COMPOSER_HINTS: readonly ComposerHint[] = [
	{
		// Matches the ←← gesture in the input controller, which opens the agent hub
		// from the main session (in a focused view it hops to the parent instead).
		id: "agents",
		learnedAfter: 3,
		resolve: ctx => {
			if (ctx.runningAgents === 0 || ctx.focusedOnAgent) return undefined;
			return {
				key: formatDoubleTap("left"),
				label: uiText(
					ctx.runningAgents === 1 ? "to see {{count}} running agent" : "to see {{count}} running agents",
					{ count: ctx.runningAgents },
					`agents-${ruPluralCategory(ctx.runningAgents)}`,
				),
			};
		},
	},
	{
		id: "effort",
		learnedAfter: 3,
		resolve: ctx => {
			if (ctx.conversationStarted) return undefined;
			const key = ctx.keybindings.getKeys("app.thinking.cycle")[0];
			return key ? { key: formatKeyHint(key), label: uiText("to change thinking effort") } : undefined;
		},
	},
];

/** Russian plural category for a count, driving the `agents-…` catalog contexts. */
function ruPluralCategory(count: number): "one" | "few" | "many" {
	const mod100 = count % 100;
	if (mod100 >= 11 && mod100 <= 14) return "many";
	switch (count % 10) {
		case 1:
			return "one";
		case 2:
		case 3:
		case 4:
			return "few";
		default:
			return "many";
	}
}

/** Render the highest-priority applicable, not-yet-learned hint, if any. */
export function resolveComposerHint(ctx: ComposerHintContext): string | undefined {
	for (const hint of COMPOSER_HINTS) {
		if (ctx.uses(hint.id) >= hint.learnedAfter) continue;
		const resolved = hint.resolve(ctx);
		if (resolved) return `${theme.fg("accent", resolved.key)} ${theme.fg("dim", theme.italic(resolved.label))}`;
	}
	return undefined;
}
