/**
 * Idle maintenance owned by one real session: the idle recap and idle compaction that run once the
 * session has been quiet for a while, whoever (if anyone) is attached.
 *
 * A stretch of activity ends at `agent_end`. The stretch is only armed once the session is
 * authoritatively quiet: the run that produced the `agent_end` has unwound, nothing is admitted,
 * queued or scheduled, and no background work can wake it. New activity, compaction, a session
 * transition or disposal invalidates everything captured before it: timers, the settling check and
 * an in-flight recap, so a late reply can never be announced.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { combine } from "../config/registry";
import { cfgRecap } from "../modes/settings";
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import { nextActionableTask } from "../tools/todo";
import type { AgentSession } from "./agent-session";
import type { AgentSessionEvent } from "./agent-session-events";
import {
	cfgCompactionIdleEnabled,
	cfgCompactionIdleThresholdTokens,
	cfgCompactionIdleTimeoutSeconds,
} from "./context-settings";
import { isSessionSettled, type SessionSettleHost, waitForSessionSettlement } from "./session-settle";

/** Probes the owner of the session supplies. Both are re-read whenever work could start. */
export interface IdleMaintenanceOptions {
	/** True while the owner does not want autonomous work (a draft being composed, the view left, startup unfinished). */
	isBlocked?: () => boolean;
	/** True while the owner has decided to start a turn it has not yet admitted (for example a scheduled goal continuation). */
	scheduledTurn?: () => boolean;
}

/** The session surface idle maintenance reads and drives. */
export type IdleMaintenanceSession = SessionSettleHost &
	Pick<
		AgentSession,
		| "settings"
		| "sessionManager"
		| "isCompacting"
		| "isSessionTransitioning"
		| "model"
		| "messages"
		| "subscribe"
		| "waitForIdle"
		| "waitForAdmittedSubmissions"
		| "getContextUsage"
		| "getGoalModeState"
		| "getTodoPhases"
		| "runIdleCompaction"
		| "runEphemeralTurn"
	>;

const RECAP_MIN_SECONDS = 1;
const RECAP_MAX_SECONDS = 3600;
const COMPACTION_MIN_SECONDS = 60;
const COMPACTION_MAX_SECONDS = 3600;

/** Only the idle-compaction inputs: unrelated `compaction.*` changes must not restart a deadline. */
const cfgIdleCompaction = combine({
	enabled: cfgCompactionIdleEnabled,
	thresholdTokens: cfgCompactionIdleThresholdTokens,
	timeoutSeconds: cfgCompactionIdleTimeoutSeconds,
});

/** Work the current stretch of activity still owes; each flag drops once its work has been done. */
interface PendingStretch {
	recap: boolean;
	compaction: boolean;
}

export class IdleMaintenance {
	readonly #session: IdleMaintenanceSession;
	readonly #emit: (event: AgentSessionEvent) => void;
	readonly #options: IdleMaintenanceOptions;
	readonly #stops: Array<() => void>;
	#pending: PendingStretch | undefined;
	/** Bumped to supersede the settling check that will arm this stretch. */
	#check = 0;
	/** The recap request in flight; aborted when it is no longer wanted. */
	#recapRun: AbortController | undefined;
	#recapTimer: NodeJS.Timeout | undefined;
	#compactionTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(
		session: IdleMaintenanceSession,
		emit: (event: AgentSessionEvent) => void,
		options: IdleMaintenanceOptions,
	) {
		this.#session = session;
		this.#emit = emit;
		this.#options = options;
		this.#stops = [
			session.subscribe(event => this.#observe(event)),
			cfgRecap.listen(session.settings, () => this.refresh()),
			cfgIdleCompaction.listen(session.settings, () => this.refresh()),
		];
	}

	/**
	 * The owner's inputs may have changed (a setting, the blocker, a scheduled turn that went away): drop
	 * work that is no longer wanted and re-arm whatever the current stretch still owes, with a fresh delay.
	 */
	refresh(): void {
		if (this.#disposed || !this.#pending) return;
		if (this.#recapRun && !this.#recapWanted()) this.#cancelRecap();
		this.#schedule();
	}

	/**
	 * Supersede the current stretch: nothing captured before this call may arm, record or announce
	 * afterwards. Called on new activity, maintenance, at the start of every session transition and on disposal.
	 */
	invalidate(): void {
		this.#pending = undefined;
		this.#clearTimers();
		this.#check++;
		this.#cancelRecap();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.invalidate();
		for (const stop of this.#stops.splice(0)) stop();
	}

	#observe(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.invalidate();
				break;
			case "agent_end":
				this.invalidate();
				this.#pending = { recap: true, compaction: true };
				this.#schedule();
				break;
		}
	}

	#clearTimers(): void {
		clearTimeout(this.#recapTimer);
		clearTimeout(this.#compactionTimer);
		this.#recapTimer = undefined;
		this.#compactionTimer = undefined;
	}

	#cancelRecap(): void {
		this.#recapRun?.abort();
		this.#recapRun = undefined;
	}

	/** Compaction or a session transition is under way, or the owner does not want autonomous work. */
	#isBlocked(): boolean {
		const session = this.#session;
		return this.#options.isBlocked?.() === true || session.isCompacting || session.isSessionTransitioning;
	}

	#isQuiet(): boolean {
		return isSessionSettled(this.#session, this.#options.scheduledTurn);
	}

	#recapWanted(): boolean {
		return cfgRecap.get(this.#session.settings).enabled && !this.#isBlocked() && this.#isQuiet();
	}

	#contextTokens(): number {
		return this.#session.getContextUsage()?.tokens ?? 0;
	}

	/**
	 * Restart the settling check for the current stretch, replacing any earlier one and the armed timers.
	 * The check is launched off the caller's stack: the terminal `agent_end` is published while its own
	 * prompt is still admitted, so it must wait for the authoritative barriers before judging the session.
	 */
	#schedule(): void {
		this.#clearTimers();
		const check = ++this.#check;
		if (this.#disposed || !this.#pending) return;
		void this.#armWhenQuiet(() => this.#check === check).catch(error =>
			logger.warn("Idle maintenance check failed", { error: String(error) }),
		);
	}

	async #armWhenQuiet(isCurrent: () => boolean): Promise<void> {
		const session = this.#session;
		for (;;) {
			await session.waitForIdle();
			if (!isCurrent()) return;
			if (!session.hasAdmittedSubmission) break;
			await session.waitForAdmittedSubmissions();
			if (!isCurrent()) return;
		}
		const settled = await waitForSessionSettlement(session, {
			isCurrent,
			scheduledTurn: this.#options.scheduledTurn,
		});
		if (!settled || this.#isBlocked()) return;
		this.#arm();
	}

	/** Start the delays this quiet stretch still owes. */
	#arm(): void {
		const pending = this.#pending;
		if (!pending) return;
		const settings = this.#session.settings;
		if (pending.recap && !this.#recapRun) {
			const recap = cfgRecap.get(settings);
			if (recap.enabled) {
				const seconds = Math.max(RECAP_MIN_SECONDS, Math.min(RECAP_MAX_SECONDS, recap.idleSeconds));
				this.#recapTimer = setTimeout(() => this.#onRecapDue(), seconds * 1000);
				this.#recapTimer.unref?.();
			}
		}
		if (pending.compaction) {
			const idle = cfgIdleCompaction.get(settings);
			if (idle.enabled && idle.thresholdTokens > 0 && this.#contextTokens() >= idle.thresholdTokens) {
				const seconds = Math.max(COMPACTION_MIN_SECONDS, Math.min(COMPACTION_MAX_SECONDS, idle.timeoutSeconds));
				this.#compactionTimer = setTimeout(() => this.#onCompactionDue(), seconds * 1000);
				this.#compactionTimer.unref?.();
			}
		}
	}

	#onCompactionDue(): void {
		this.#compactionTimer = undefined;
		const pending = this.#pending;
		if (!pending?.compaction) return;
		// Blocked work stays owed: the owner's refresh re-arms it. Busy means the stretch is not over after all.
		if (this.#isBlocked()) return;
		if (!this.#isQuiet()) {
			this.#schedule();
			return;
		}
		// Pruning may have run since arming and dropped usage back below the threshold.
		const idle = cfgIdleCompaction.get(this.#session.settings);
		if (!idle.enabled || idle.thresholdTokens <= 0 || this.#contextTokens() < idle.thresholdTokens) return;
		this.#complete(pending, "compaction");
		this.#session.runIdleCompaction().catch(error => logger.warn("Idle compaction failed", { error: String(error) }));
	}

	#onRecapDue(): void {
		this.#recapTimer = undefined;
		if (!this.#pending?.recap || this.#recapRun) return;
		if (this.#isBlocked()) return;
		if (!this.#isQuiet()) {
			this.#schedule();
			return;
		}
		void this.#runRecap();
	}

	/**
	 * Generate the recap with an ephemeral side-channel turn over the current conversation, journal it to
	 * history.db (`session_recaps`), then announce it. Live goal/title and the active todo task anchor the
	 * request because the snapshot only carries conversation history. Quiet and unblocked state is re-read when
	 * the reply lands, so a reply for a stretch that has since ended is never announced.
	 */
	async #runRecap(): Promise<void> {
		const pending = this.#pending;
		const session = this.#session;
		if (!pending) return;
		const run = new AbortController();
		this.#recapRun = run;
		try {
			if (!session.model || session.messages.length === 0) {
				this.#complete(pending, "recap");
				return;
			}
			const promptText = prompt.render(idleRecapPrompt, {
				goal: this.#goalText() ?? "",
				task: nextActionableTask(session.getTodoPhases())?.content ?? "",
			});
			const { replyText } = await session.runEphemeralTurn({ promptText, signal: run.signal });
			if (this.#recapRun !== run || run.signal.aborted) return;
			if (this.#isBlocked()) return;
			if (!this.#isQuiet()) {
				this.#recapRun = undefined;
				this.#schedule();
				return;
			}
			this.#complete(pending, "recap");
			if (!replyText.trim()) return;
			session.sessionManager.recordRecap(replyText);
			this.#emit({ type: "idle_recap", recap: replyText });
		} catch (error) {
			if (run.signal.aborted) return;
			this.#complete(pending, "recap");
			logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#recapRun === run) this.#recapRun = undefined;
		}
	}

	/** One kind of work is done. A stretch that owes nothing more is dropped, so later refreshes cost nothing. */
	#complete(pending: PendingStretch, work: keyof PendingStretch): void {
		pending[work] = false;
		if (pending.recap || pending.compaction || this.#pending !== pending) return;
		this.#pending = undefined;
		this.#check++;
	}

	#goalText(): string | undefined {
		const goal = this.#session.getGoalModeState()?.goal.objective.trim();
		if (goal) return goal;
		return this.#session.sessionManager.getSessionName()?.trim() || undefined;
	}
}
