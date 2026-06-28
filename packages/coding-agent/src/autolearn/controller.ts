/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and, after a substantive turn,
 * nudges the agent to capture reusable lessons. Default posture is passive
 * (a hidden reminder rides the next real turn); with `autolearn.autoContinue`
 * it auto-runs exactly one synthetic capture turn at stop.
 *
 * Installed once per top-level session (taskDepth 0). The subscription lives
 * for the session's lifetime — `newSession` resets the session in place
 * without re-running startup — so the controller needs no disposal.
 */
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudge from "../prompts/system/autolearn-nudge.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_PASSIVE = autolearnNudge.trim();
const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnNudgeAutoContinue.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than live settings: the `learn`/`manage_skill`
 * registry is built ONCE at session start (and only for top-level sessions), so
 * keying the guidance on `autolearn.enabled` would let a mid-session enable — or
 * a subagent that filtered the tools out — inject guidance pointing at tools the
 * session never built. The `learn` addendum is included only when the `learn`
 * tool is present (it requires a memory backend).
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
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Swallow the agent_end produced by an auto-run capture turn so it cannot re-trigger. */
	#suppressNext = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
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
			this.#onAgentEnd();
		}
	}

	#onAgentEnd(): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		if (this.#suppressNext) {
			this.#suppressNext = false;
			return;
		}
		// Honor a live opt-out: the subscription outlives the setting, so re-check
		// the current flag rather than trusting install-time state.
		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a
		// `goal` tool may have completed/dropped the goal before this stop — or is
		// still in it: a passive nudge would ride the goal continuation, and
		// auto-continue would compete with it.
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		// Auto-run a capture turn only when explicitly enabled; otherwise the
		// hidden reminder rides the next real turn passively.
		//
		// The two paths get DIFFERENT nudge text:
		// - Auto-continue spawns a synthetic turn with the nudge as its only
		//   user-role payload, so the prompt must be terminal — it tells the
		//   agent to capture and STOP, and must not be read as the user's
		//   reply to any pending question. Without that contract, the agent
		//   conflates the synthetic prompt with user approval and resumes
		//   prior work (e.g. commits/pushes an unanswered "want me to push?"
		//   question — #3504).
		// - Passive mode appends the nudge to the user's real next message,
		//   so the agent must answer the user normally and treat the capture
		//   as additive — not as the whole turn's job.
		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		const content = autoContinue ? AUTOLEARN_NUDGE_AUTOCONTINUE : AUTOLEARN_NUDGE_PASSIVE;
		// Arm suppression synchronously: the synthetic capture turn's agent_end
		// fires inside sendCustomMessage (before it resolves), so the flag must be
		// set before then. Disarm when no turn actually started — a deferred/queued
		// dispatch or a failed send produces no agent_end, and a latched flag would
		// otherwise swallow the next real stop.
		if (autoContinue) this.#suppressNext = true;

		this.#session
			.sendCustomMessage(
				{
					customType: "autolearn-nudge",
					content,
					display: false,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: autoContinue },
			)
			.then(started => {
				if (!started) this.#suppressNext = false;
			})
			.catch(err => {
				this.#suppressNext = false;
				logger.warn("auto-learn nudge delivery failed", { err });
			});
	}
}
