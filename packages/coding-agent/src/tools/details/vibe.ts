/** Operation represented by a worker-session tool result. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	/** Live TV-wall snapshot of the owner's worker sessions at (or during) the call. */
	screens: VibeScreenSnapshot[];
	/** Sessions the director killed, left off `screens`; shown as a count. */
	hiddenKilled?: string[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		/** True on interim progress emissions while the wait is still blocking. */
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}

/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	/** Terminated by the director (`vibe_kill`) or mode teardown; unset for workers that died on their own. */
	killed?: boolean;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Worker identity and job handle returned by a spawn. */
export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

/** Delivery mode and optional turn job for a worker message. */
export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Worker shutdown outcome including any cancelled turn. */
export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

/** Settled and still-running worker turns observed by a wait. */
export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";
