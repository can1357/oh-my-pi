import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { nextActionableTask } from "../../tools/todo";
import { generateIdleRecap, idleRecapDelayMs } from "../idle-recap";
import { cfgRecap } from "../settings";
import type { RpcRecap, RpcRecapUpdateFrame } from "./rpc-types";

interface RecapPosition {
	sessionKey: string;
	leafId: string | null;
}

export class RpcIdleRecapController {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcRecapUpdateFrame) => void;
	#timer?: NodeJS.Timeout;
	#abort?: AbortController;
	/** Recap plus the position it summarizes; session switches outside RPC commands never reach this controller. */
	#latest?: { recap: RpcRecap; position: RecapPosition };

	constructor(session: AgentSession, output: (frame: RpcRecapUpdateFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	get latestRecap(): RpcRecap | undefined {
		return this.#latest && this.#stillAt(this.#latest.position) ? this.#latest.recap : undefined;
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.cancel();
				this.#clear();
				break;
			case "agent_end":
				if (event.isTerminal === false || this.#session.isStreaming) return;
				this.#schedule();
				break;
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.cancel();
				break;
		}
	}

	resetForSessionChange(): void {
		this.cancel();
		this.#clear();
	}

	/** Drop a pending or in-flight recap (host activity such as `abort` or `compact`); keeps the current recap. */
	cancel(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#abort) {
			this.#abort.abort();
			this.#abort = undefined;
		}
	}

	dispose(): void {
		this.cancel();
		this.#latest = undefined;
	}

	#schedule(): void {
		this.cancel();
		if (!this.#idleConditionsHold()) return;
		const recapSettings = cfgRecap.get(this.#session.settings);
		if (!recapSettings.enabled) return;
		const timeoutMs = idleRecapDelayMs(recapSettings.idleSeconds);
		// Bind to the position whose terminal agent_end armed the timer; an out-of-band
		// switch or tree navigation before it fires must not recap (or journal into) another one.
		const position = this.#currentPosition();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#run(position);
		}, timeoutMs);
		this.#timer.unref?.();
	}

	async #run(position: RecapPosition): Promise<void> {
		if (!this.#stillAt(position)) return;
		// A live settings change can disable recaps while the timer is pending.
		if (!cfgRecap.get(this.#session.settings).enabled || !this.#idleConditionsHold()) return;
		if (!this.#session.model || this.#session.messages.length === 0) return;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			const goal = this.#session.getGoalModeState()?.goal.objective.trim() || this.#session.sessionName?.trim();
			const task = nextActionableTask(this.#session.getTodoPhases())?.content;
			const generated = await generateIdleRecap(this.#session, { goal, task }, abort.signal);
			if (this.#abort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			if (!this.#stillAt(position) || !generated) return;
			this.#session.sessionManager.recordRecap(generated.replyText);
			const recap: RpcRecap = { text: generated.text, trigger: "idle", timestamp: Date.now() };
			this.#latest = { recap, position };
			this.#output({ type: "recap_update", recap });
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	#idleConditionsHold(): boolean {
		return !this.#session.isDisposed && !this.#session.isStreaming && !this.#session.isCompacting;
	}

	/**
	 * Session file plus persisted session id identify the session: copied files share
	 * header ids, and in-memory sessions have no file. `AgentSession.sessionId` is
	 * unusable: `--provider-session-id` pins it across switches.
	 */
	#currentPosition(): RecapPosition {
		const manager = this.#session.sessionManager;
		return {
			sessionKey: `${this.#session.sessionFile ?? ""}\n${manager.getSessionId()}`,
			leafId: manager.getLeafId(),
		};
	}

	/**
	 * Same session, and the recapped leaf is still on the active branch. Entries appended
	 * since (titles, labels) keep the recap valid; tree navigation off that path does not.
	 */
	#stillAt(position: RecapPosition): boolean {
		const current = this.#currentPosition();
		if (current.sessionKey !== position.sessionKey) return false;
		if (position.leafId === null || current.leafId === position.leafId) return true;
		return this.#session.sessionManager.getBranch().some(entry => entry.id === position.leafId);
	}

	#clear(): void {
		if (!this.#latest) return;
		this.#latest = undefined;
		this.#output({ type: "recap_update", recap: null });
	}
}
