/**
 * Composer hints: the placeholder of the empty composer, surfacing a gesture
 * that matters right now (background agents are running, effort can change).
 *
 * Hints are checked in priority order; the first that applies wins. A hint
 * retires for good once the user has performed its gesture
 * {@link ComposerHint.learnedAfter} times: the host records each use under the
 * hint's id and reports counts through {@link ComposerHintContext.uses}.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { KeybindingsManager } from "../../../config/keybindings/keybindings";
import { formatDoubleTap, formatKeyHint } from "../../../ui/keys/hints";

/** Stable hint ids; persisted as usage-counter keys, so never rename one. */
export type ComposerHintId = "agents" | "effort";

/** Live state hint conditions read. */
export interface ComposerHintContext {
	/** Subagents running in the background. */
	readonly runningAgents: number;
	/** The view is focused on a subagent session instead of the main one. */
	readonly focusedOnAgent: boolean;
	/** The viewed session already has messages. */
	readonly conversationStarted: boolean;
	readonly keybindings: KeybindingsManager;
	/** Times the user has performed the gesture a hint teaches. */
	uses(id: ComposerHintId): number;
}

/** A gesture tip: `key` drawn highlighted, `label` saying what it does. */
interface ComposerHint {
	readonly id: ComposerHintId;
	/** Uses of the gesture after which the hint stops showing. */
	readonly learnedAfter: number;
	resolve(ctx: ComposerHintContext): { key: string; label: string } | undefined;
}

/** Registered hints, highest priority first. */
const COMPOSER_HINTS: readonly ComposerHint[] = [
	{
		// The ←← gesture of the input controller: the agent hub from the main session.
		id: "agents",
		learnedAfter: 3,
		resolve: ctx => {
			if (ctx.runningAgents === 0 || ctx.focusedOnAgent) return undefined;
			return {
				key: formatDoubleTap("left"),
				label: `to see ${ctx.runningAgents} running ${ctx.runningAgents === 1 ? "agent" : "agents"}`,
			};
		},
	},
	{
		id: "effort",
		learnedAfter: 3,
		resolve: ctx => {
			if (ctx.conversationStarted) return undefined;
			const key = ctx.keybindings.keysFor("app.thinking.cycle")[0];
			return key ? { key: formatKeyHint(key), label: "to change thinking effort" } : undefined;
		},
	},
];

/** The highest-priority applicable, not yet learned hint: the key in accent, the label dim italic (`em`). */
export function resolveComposerHint(ctx: ComposerHintContext): TspSpan[] | undefined {
	for (const hint of COMPOSER_HINTS) {
		if (ctx.uses(hint.id) >= hint.learnedAfter) continue;
		const resolved = hint.resolve(ctx);
		if (resolved) return [{ t: resolved.key, s: "accent" }, { t: " " }, { t: resolved.label, s: "dim em" }];
	}
	return undefined;
}
