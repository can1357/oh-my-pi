/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and runs at most one private pass per
 * substantive stop, choosing between two disjoint ones:
 *
 *   * a *terminal* settle — the session went idle — belongs to the scribe: a
 *     small model re-reads the finished session for reusable procedures, gated
 *     by `autolearn.scribe` and by a wired scribe runner;
 *   * every other substantive stop belongs to the capture nudge for the primary
 *     model, gated by `autolearn.autoContinue`.
 *
 * Disjointness is the point: a stop is never paid for twice. Passive mode is
 * intentionally prompt-cache neutral: the standing system guidance remains
 * available, but no hidden mid-session reminder is inserted into the
 * conversation.
 *
 * Installed once per top-level session (taskDepth 0) regardless of
 * `autolearn.enabled`: every stop re-reads the live setting, so toggling it
 * mid-session takes effect at the next stop. The subscription lives for the
 * session's lifetime — `newSession` resets the session in place without
 * re-running startup — so the controller needs no disposal.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import autolearnScribeNudge from "../prompts/system/autolearn-scribe-nudge.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

import {
	cfgAutolearnAutoContinue,
	cfgAutolearnEnabled,
	cfgAutolearnMinToolCalls,
	cfgAutolearnScribe,
} from "./settings";

const CAPTURE_NUDGE = autolearnNudgeAutoContinue.trim();
const SCRIBE_NUDGE = autolearnScribeNudge.trim();

/** The private pass a stop is eligible for; the two never share a stop. */
type AutoLearnPass = "capture" | "scribe";

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than settings: keying the guidance on
 * `autolearn.enabled` would let a subagent that filtered the tools out — or a
 * session whose registry has not yet reconciled — inject guidance pointing at
 * tools the session does not have. The `learn` addendum is included only when
 * the `learn` tool is present (it requires a memory backend).
 */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnGuidance.trim()];
	if (available.learn) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	capture: (content: string) => Promise<void>;
	/**
	 * Optional: wired only where a scribe model can resolve. Absent, a terminal
	 * settle falls back to the capture nudge rather than running nothing.
	 */
	scribe?: (content: string) => Promise<void>;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	readonly #scribe: ((content: string) => Promise<void>) | undefined;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** The pass now running, plus one newer eligible pass waiting behind it. */
	#passInFlight: AutoLearnPass | undefined;
	#passPending: AutoLearnPass | undefined;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
		this.#scribe = options.scribe;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Capture goal-mode state at the turn boundary, before any tool runs.
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		// Never nudge a turn that ended in an abort (ESC, cancel, etc.). The
		// abort flag on the session is unreliable by the time agent_end is
		// deferred to subscribers; read stopReason from the event messages.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		// The controller is installed regardless of the flag; honor its live value.
		if (!cfgAutolearnEnabled.get(this.#settings)) return;
		const minToolCalls = cfgAutolearnMinToolCalls.get(this.#settings);
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a
		// `goal` tool may have completed/dropped the goal before this stop — or is
		// still in it: a passive nudge would ride the goal continuation, and
		// auto-continue would compete with it.
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		// A terminal settle means the session is idle, and that stop belongs to
		// the scribe alone. Without one — disabled, or no model resolved — the
		// capture nudge keeps the stop, so the scribe flag never silences capture.
		if (event.isTerminal === true && this.#scribe && cfgAutolearnScribe.get(this.#settings)) {
			this.#schedule("scribe");
			return;
		}

		// Auto-run a capture turn only when explicitly enabled. Passive mode used to
		// queue a hidden custom message for the next real turn, but that mutates the
		// persisted conversation prefix after providers have cached it. The standing
		// auto-learn system guidance is stable; keep passive mode to that guidance
		// so Anthropic prompt-cache prefixes survive long sessions.
		if (cfgAutolearnAutoContinue.get(this.#settings) !== true) return;
		this.#schedule("capture");
	}

	#schedule(pass: AutoLearnPass): void {
		if (this.#passInFlight) {
			this.#passPending = pass;
			return;
		}
		this.#start(pass);
	}

	#start(pass: AutoLearnPass): void {
		const run = pass === "scribe" ? this.#scribe : this.#capture;
		if (!run) return;
		this.#passInFlight = pass;
		void run(pass === "scribe" ? SCRIBE_NUDGE : CAPTURE_NUDGE)
			.catch(err => {
				logger.warn("auto-learn pass failed", { pass, err });
			})
			.finally(() => {
				this.#passInFlight = undefined;
				const next = this.#passPending;
				this.#passPending = undefined;
				if (next) this.#start(next);
			});
	}
}
