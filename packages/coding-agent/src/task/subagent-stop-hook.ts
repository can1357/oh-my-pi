/**
 * `subagent_stop` support for task/subagent runs.
 *
 * The main session's `session_stop` pass lives in `session/agent-session.ts`,
 * where the settle path owns the decision. A child run's stop pass cannot live
 * there: the candidate-result predicate is executor/monitor state, so the pass
 * runs inside `driveSessionToResult` (and the IRC wake-turn observer, see
 * `task/executor.ts`) at the point where the child's owner background work has
 * quiesced and the candidate result (its terminal yield, or a message-result
 * run's final report) is the one the parent would otherwise accept. This module
 * owns the decision and its per-run state so that integration stays small
 * instead of another block in the executor's event loop.
 *
 * Semantics mirror `session_stop` deliberately: an explicit `decision: "block"`
 * outranks advisory `continue` requests and does not consume the advisory
 * allowance, a refusal without a reason gets the diagnostic prompt, and
 * `stop_hook_active` reports whether this drive already had a continuation.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveStopContinuationText } from "../extensibility/extensions/stop-continuation";
import subagentStopBlockedPrompt from "../prompts/system/subagent-stop-blocked.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";

/**
 * Advisory continuations one drive (initial run, follow-up turn, or wake turn)
 * may be granted. Matches the main session's allowance
 * (`SESSION_STOP_CONTINUATION_CAP`); an explicit refusal is exempt and stays
 * blocking until the handler allows completion or the run is cancelled.
 * Private: `subagent_stop` publishes the cap as behavior (documented in
 * `docs/extensions.md`), not as configurable API.
 */
const SUBAGENT_STOP_CONTINUATION_CAP = 8;

/** Identity of the child run and of the session that spawned it. */
export interface SubagentStopRunIdentity {
	/** Registry/task id of the child run (`agent://<id>`). */
	agentId: string;
	/** Agent definition the child was spawned from. */
	agentType: string;
	/** Parent session id, supplied by the spawn site (never read off the child). */
	parentSessionId?: string;
	/** Parent session transcript file, supplied by the spawn site. */
	parentSessionFile?: string;
}

/** Outcome of one `subagent_stop` pass over a candidate result. */
export type SubagentStopOutcome =
	/** Handlers left the candidate alone: it may be accepted and published. */
	| { kind: "allow" }
	/** Handlers refused the candidate: run the same session again with `text`. */
	| { kind: "continue"; text: string }
	/** The run was cancelled while handlers were consulting: the candidate was never confirmed. */
	| { kind: "aborted" }
	/** The candidate changed while handlers were consulting: the verdict is void and the run's current candidate is still unjudged. */
	| { kind: "stale" };

/**
 * Per-run `subagent_stop` state: the continuation allowance, `stop_hook_active`,
 * and the event construction for one child session.
 */
export class SubagentStopHook {
	readonly #identity: SubagentStopRunIdentity;
	readonly #signal: AbortSignal;
	/** `false` = the child has no `yield` tool, so its continuation prompt must not ask for one. */
	readonly #structured: boolean;
	#continuations = 0;
	#active = false;

	constructor(identity: SubagentStopRunIdentity, signal: AbortSignal, structured: boolean) {
		this.#identity = identity;
		this.#signal = signal;
		this.#structured = structured;
	}

	/**
	 * Offer a candidate result (a terminal yield, or a message-result run's final report) to `subagent_stop` handlers.
	 *
	 * Handler failures are isolated by the runner (reported through its error
	 * channel, never thrown here), and a run cancelled mid-pass reports
	 * {@link SubagentStopOutcome} `aborted` so the caller can drop the candidate
	 * instead of accepting one the handlers never confirmed.
	 *
	 * `candidateChanged` runs once the handlers answered and resolves true when
	 * the candidate they judged is no longer the run's current one (see
	 * {@link SubagentStopOutcome} `stale`).
	 */
	async run(session: AgentSession, candidateChanged?: () => Promise<boolean>): Promise<SubagentStopOutcome> {
		const runner = session.extensionRunner;
		if (!runner?.hasHandlers("subagent_stop")) return { kind: "allow" };
		if (this.#signal.aborted) return { kind: "aborted" };
		const result = await runner.emitSubagentStop({
			agent_id: this.#identity.agentId,
			agent_type: this.#identity.agentType,
			session_id: session.sessionId,
			session_file: session.sessionFile,
			parent_session_id: this.#identity.parentSessionId,
			parent_session_file: this.#identity.parentSessionFile,
			messages: session.messages,
			last_assistant_message: session.getLastAssistantMessage(),
			stop_hook_active: this.#active,
			signal: this.#signal,
		});
		// Cancelled mid-pass: the candidate was never confirmed, so the caller
		// must drop it rather than accept a yield a handler was still judging.
		if (this.#signal.aborted) return { kind: "aborted" };
		// The verdict is about the candidate the handlers were shown. When the run
		// moved on while they consulted, it decides nothing about the candidate the
		// run now has, so void it before it spends any state: a refusal must not
		// count as a continuation, nor leave `stop_hook_active` set for the pass
		// that judges the new candidate.
		if (candidateChanged) {
			let changed: boolean;
			try {
				changed = await candidateChanged();
			} catch (error) {
				// Cancelled while revalidating: the verdict never covered the candidate the run would publish.
				if (this.#signal.aborted) return { kind: "aborted" };
				throw error;
			}
			if (this.#signal.aborted) return { kind: "aborted" };
			if (changed) return { kind: "stale" };
		}
		// The diagnostic is only consulted for a reason-less refusal; render it only for a refusal.
		const blockedFallback =
			result?.decision === "block" ? prompt.render(subagentStopBlockedPrompt, { structured: this.#structured }) : "";
		const text = resolveStopContinuationText(result, blockedFallback);
		if (text === undefined) return { kind: "allow" };
		if (result?.decision !== "block" && this.#continuations >= SUBAGENT_STOP_CONTINUATION_CAP) {
			logger.warn("subagent_stop continuation cap reached", {
				agentId: this.#identity.agentId,
				cap: SUBAGENT_STOP_CONTINUATION_CAP,
			});
			return { kind: "allow" };
		}
		if (result?.decision !== "block") this.#continuations++;
		this.#active = true;
		return { kind: "continue", text };
	}
}
