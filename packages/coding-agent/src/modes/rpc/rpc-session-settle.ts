/**
 * Session quiescence for RPC mode: separates "the agent yielded" (a terminal
 * `agent_end`) from "the session is done" (nothing live, queued, or running in
 * the background that could inject a message and wake it again).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { RpcSessionSettledFrame } from "./rpc-types";

/** Session surface the settle predicate reads. */
export type RpcSettleSession = Pick<
	AgentSession,
	"isStreaming" | "hasAdmittedSubmission" | "queuedMessageCount" | "hasPendingAsyncWork"
>;

/**
 * True when no run is live or admitted, no steer/follow-up is queued, and no
 * background job or delivery can re-wake the session. Backs `session_settled`,
 * `prompt_result.sessionSettled`, and `get_state.isSettled`.
 */
export function isRpcSessionSettled(session: RpcSettleSession): boolean {
	return (
		!session.isStreaming &&
		!session.hasAdmittedSubmission &&
		session.queuedMessageCount === 0 &&
		!session.hasPendingAsyncWork()
	);
}

async function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/**
 * Emits `session_settled` once per stretch of agent activity, after the final
 * run yields and background work that could wake the session has drained.
 * Re-checks on every terminal `agent_end` and after session transitions.
 */
export class RpcSessionSettleWatcher {
	/** Agent activity since the last `session_settled`. */
	#active = false;
	#checking = false;
	#recheck = false;
	readonly #session: RpcSettleSession & Pick<AgentSession, "settleAsyncWork">;
	readonly #output: (frame: RpcSessionSettledFrame) => void;

	constructor(
		session: RpcSettleSession & Pick<AgentSession, "settleAsyncWork">,
		output: (frame: RpcSessionSettledFrame) => void,
	) {
		this.#session = session;
		this.#output = output;
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.#active = true;
		else if (event.type === "agent_end" && event.isTerminal !== false) void this.check();
	}

	/**
	 * Settle the current stretch of activity if the session is quiet, waiting out
	 * background work that will wake it. A live run is left alone: its own
	 * terminal `agent_end` triggers the next check.
	 */
	async check(): Promise<void> {
		if (this.#checking) {
			this.#recheck = true;
			return;
		}
		this.#checking = true;
		try {
			do {
				this.#recheck = false;
				// Two hops: prompt_result frames for this yield are written one macrotask
				// after it, and session_settled must follow them.
				await nextMacrotask();
				await nextMacrotask();
				while (this.#active && this.#canWaitOutBackgroundWork()) {
					await this.#session.settleAsyncWork();
				}
			} while (this.#recheck);
			if (!this.#active || !isRpcSessionSettled(this.#session)) return;
			this.#active = false;
			this.#output({ type: "session_settled" });
		} catch (error) {
			logger.warn("RPC session settle check failed", { error: String(error) });
		} finally {
			this.#checking = false;
		}
	}

	#canWaitOutBackgroundWork(): boolean {
		const session = this.#session;
		return !session.isStreaming && !session.hasAdmittedSubmission && session.hasPendingAsyncWork();
	}
}
