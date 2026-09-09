/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and, after a substantive turn,
 * optionally auto-runs a synthetic capture turn. Passive mode is intentionally
 * prompt-cache neutral: the standing system guidance remains available, but no
 * hidden mid-session reminder is inserted into the conversation.
 *
 * Installed once per top-level session (taskDepth 0). The subscription lives
 * for the session's lifetime — `newSession` resets the session in place
 * without re-running startup — so the controller needs no disposal.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

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
	capture: (content: string) => Promise<void>;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Prevent overlapping private capture runs while real primary turns continue. */
	#captureInFlight = false;
	/** One newer eligible primary stop arrived while capture was running. */
	#capturePending = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
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

		// Auto-run a capture turn only when explicitly enabled. Passive mode used to
		// queue a hidden custom message for the next real turn, but that mutates the
		// persisted conversation prefix after providers have cached it. The standing
		// auto-learn system guidance is stable; keep passive mode to that guidance
		// so Anthropic prompt-cache prefixes survive long sessions.
		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		if (!autoContinue) return;

		if (this.#captureInFlight) {
			this.#capturePending = true;
			return;
		}
		this.#startCapture();
	}

	#startCapture(): void {
		this.#captureInFlight = true;
		void this.#capture(AUTOLEARN_NUDGE_AUTOCONTINUE)
			.catch(err => {
				logger.warn("auto-learn capture failed", { err });
			})
			.finally(() => {
				this.#captureInFlight = false;
				if (!this.#capturePending) return;
				this.#capturePending = false;
				this.#startCapture();
			});
	}
}
