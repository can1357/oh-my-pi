import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { nextActionableTask } from "../../tools/todo";
import { generateIdleRecap, idleRecapDelayMs } from "../idle-recap";
import type { RpcRecap, RpcRecapUpdateFrame } from "./rpc-types";

export class RpcIdleRecapController {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcRecapUpdateFrame) => void;
	#timer?: NodeJS.Timeout;
	#abort?: AbortController;
	#latestRecap?: RpcRecap;

	constructor(session: AgentSession, output: (frame: RpcRecapUpdateFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	get latestRecap(): RpcRecap | undefined {
		return this.#latestRecap;
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#cancel();
				this.#clear();
				break;
			case "agent_end":
				if (event.isTerminal === false || this.#session.isStreaming) return;
				this.#schedule();
				break;
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.#cancel();
				break;
		}
	}

	resetForSessionChange(): void {
		this.#cancel();
		this.#clear();
	}

	dispose(): void {
		this.#cancel();
		this.#latestRecap = undefined;
	}

	#schedule(): void {
		this.#cancel();
		if (!this.#idleConditionsHold()) return;
		const recapSettings = this.#session.settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		const timeoutMs = idleRecapDelayMs(recapSettings.idleSeconds);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#run();
		}, timeoutMs);
		this.#timer.unref?.();
	}

	async #run(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.#session.model || this.#session.messages.length === 0) return;
		const sessionId = this.#session.sessionId;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			const goal = this.#session.getGoalModeState()?.goal.objective.trim() || this.#session.sessionName?.trim();
			const task = nextActionableTask(this.#session.getTodoPhases())?.content;
			const text = await generateIdleRecap(this.#session, { goal, task }, abort.signal);
			if (this.#abort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			if (this.#session.sessionId !== sessionId || !text) return;
			const recap: RpcRecap = { text, trigger: "idle", timestamp: Date.now() };
			this.#latestRecap = recap;
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

	#cancel(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#abort) {
			this.#abort.abort();
			this.#abort = undefined;
		}
	}

	#clear(): void {
		if (!this.#latestRecap) return;
		this.#latestRecap = undefined;
		this.#output({ type: "recap_update", recap: null });
	}
}
