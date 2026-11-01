/**
 * Session quiescence for RPC mode: separates "the agent yielded" (a terminal
 * `agent_end`) from "the session is done" (nothing live, queued, or running in
 * the background that could inject a message and wake it again).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isSessionSettled, type SessionSettleHost, waitForSessionSettlement } from "../../session/session-settle";
import type { RpcSessionSettledFrame } from "./rpc-types";

/**
 * Reports a turn the host side has decided to start but not yet admitted (for
 * example a scheduled goal continuation). Such a session is not settled.
 */
export type RpcScheduledTurnProbe = () => boolean;

/**
 * A scheduled-turn probe whose every "not settled" answer marks `watcher` active,
 * so a stretch reported busy only because of a pending host-scheduled turn still
 * ends with `session_settled` even if that turn is later abandoned.
 */
export function watchedScheduledTurnProbe(
	pending: () => boolean,
	watcher: () => Pick<RpcSessionSettleWatcher, "markActive"> | undefined,
): RpcScheduledTurnProbe {
	return () => {
		const isPending = pending();
		if (isPending) watcher()?.markActive();
		return isPending;
	};
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
	readonly #session: SessionSettleHost;
	readonly #output: (frame: RpcSessionSettledFrame) => void;
	readonly #scheduledTurn: RpcScheduledTurnProbe | undefined;

	constructor(
		session: SessionSettleHost,
		output: (frame: RpcSessionSettledFrame) => void,
		scheduledTurn?: RpcScheduledTurnProbe,
	) {
		this.#session = session;
		this.#output = output;
		this.#scheduledTurn = scheduledTurn;
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.#active = true;
		else if (event.type === "agent_end" && event.isTerminal !== false) void this.check();
	}

	/**
	 * Record activity that no `agent_start` announces (for example a reported pending
	 * goal turn), so the stretch it opens still ends with `session_settled`.
	 */
	markActive(): void {
		this.#active = true;
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
				if (this.#active) {
					await waitForSessionSettlement(this.#session, {
						isCurrent: () => this.#active,
						scheduledTurn: this.#scheduledTurn,
					});
				}
			} while (this.#recheck);
			if (!this.#active || !isSessionSettled(this.#session, this.#scheduledTurn)) return;
			this.#active = false;
			this.#output({ type: "session_settled" });
		} catch (error) {
			logger.warn("RPC session settle check failed", { error: String(error) });
		} finally {
			this.#checking = false;
		}
	}
}
