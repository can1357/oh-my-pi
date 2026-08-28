/**
 * Thin client for the omp RPC protocol.
 *
 * `RpcClient` in the coding-agent package is a far richer implementation, but
 * it is unusable here: its `start()` calls `ptree.spawn(["bun", cliPath, ...])`
 * and reads `Bun.env`, neither of which exists in a webview. So the process
 * lives in Rust and this replicates the protocol surface over a `Transport`.
 *
 * Two rules the protocol imposes, both load-bearing:
 *
 *   1. Responses MUST be matched on `id`, never on arrival order. `bash` and
 *      other commands are dispatched concurrently and docs/rpc.md is explicit
 *      that emission order is not guaranteed.
 *   2. A malformed line must never kill the reader. Frames come from a separate
 *      process that may be a different omp version.
 *
 * State is exposed as immutable snapshots for `useSyncExternalStore`, following
 * `collab-web/src/lib/client.ts`. Without that, every `message_update` delta
 * would re-render the whole transcript.
 */

import { type CompactionProgress, isBenignRefusal, isCancellation } from "./compaction";
import type { TodoPhase } from "./protocol";
import {
	type AvailableSlashCommand,
	BLOCKING_UI_METHODS,
	type ExtensionUiAnswer,
	type ExtensionUiRequestFrame,
	isAvailableCommandsUpdate,
	isExtensionUiRequest,
	isReadyFrame,
	isResponseFrame,
	type LoginProvider,
	type ReadyFrame,
	type ResponseFrame,
	type RpcSessionState,
	type ServerFrame,
	type SessionEventFrame,
	type SubagentProgress,
	type SubagentSnapshot,
} from "./protocol";
import { parsePhases, phasesFromToolResult } from "./todo";
import { type TranscriptEntry, TranscriptModel } from "./transcript";
import type { AgentHandle, RelayEvent, Transport } from "./transport";

/** Cap the retained raw-event log so a long session cannot grow without bound. */
const MAX_RETAINED_EVENTS = 2000;
const MAX_RETAINED_STDERR = 200;

/** Default per-request timeout. Login needs far longer and passes its own. */
const DEFAULT_TIMEOUT_MS = 120_000;
const LOGIN_TIMEOUT_MS = 600_000;

/*
 * A backstop, not a deadline. `/compact` reports itself through a later
 * `command_output` frame, so nothing correlates the end of the work to the
 * command that started it. If that frame never comes — an omp old enough not to
 * know the command, a summariser that wedges — the banner would otherwise stay
 * up forever. Generous, because a large context genuinely takes minutes.
 */
const COMPACTION_REPORT_TIMEOUT_MS = 600_000;

/** Compaction's own request deadline: the shared two minutes is not enough. */
const COMPACTION_TIMEOUT_MS = 900_000;

/**
 * How often to ask the server whether the compaction it is running is still
 * running.
 *
 * The banner used to live on edges — an event, then the command's response —
 * and both can be missed. Anchoring it to `get_state` only helped when
 * something else happened to refresh state, so a compaction that finished with
 * the session otherwise idle left the spinner up indefinitely. This is the one
 * case in this client that earns a poll: it runs for minutes, it is rare, and
 * being wrong about it is very visible.
 */
/** A lifecycle frame says `started`; everything downstream speaks `running`. */
function normalizeSubagentStatus(status: string | undefined): SubagentSnapshot["status"] {
	if (status === "started") return "running";
	if (status === "pending" || status === "running" || status === "completed") return status;
	if (status === "failed" || status === "aborted") return status;
	return "pending";
}

const COMPACTION_POLL_MS = 4_000;

/*
 * The frames after which `get_state` is worth asking for again. All of them
 * already reach this client — `rpc-client.ts` forwards them — they were simply
 * not being listened to.
 */
/** The same shape the rest of this file uses for a cause it must show a human. */
function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

const STATE_CHANGING_EVENTS = new Set([
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"model_changed",
	"thinking_level_changed",
	// A mode is state, and state that only this client can change is state that
	// drifts the moment the terminal changes it.
	"plan_mode_changed",
]);

/**
 * How long `starting` may last before the UI stops claiming the agent is on its
 * way. Comfortably past the ~3.8s a cold sidecar needs, short enough that a
 * process which will never answer is not presented as one that might.
 */
const DEFAULT_STALL_MS = 20_000;

/**
 * `suspended` is not a failure: the pool reclaimed the process to stay under its
 * live-session ceiling. The transcript survives and the session resumes when you
 * open it again.
 */
export type BridgeStatus = "idle" | "starting" | "ready" | "suspended" | "exited" | "error";

export interface BridgeSnapshot {
	status: BridgeStatus;
	/**
	 * `starting` has outlived its welcome. Not a status of its own: the child may
	 * genuinely still be coming up, and saying otherwise would be a guess. It is
	 * the cue to stop showing the optimistic text and show `stderr` instead.
	 */
	stalled: boolean;
	ready: ReadyFrame | null;
	pid: number | null;
	/** The spawn was skipped because a pre-warmed process was adopted. */
	prewarmed: boolean;
	state: RpcSessionState | null;
	commands: readonly AvailableSlashCommand[];
	/** Renderable messages and tool cards, in arrival order. */
	transcript: readonly TranscriptEntry[];
	/** Live subagent roster, newest activity last. */
	subagents: readonly SubagentSnapshot[];
	/** Oldest-first, capped. Raw frames, for the protocol probe view. */
	events: readonly SessionEventFrame[];
	/** UI request awaiting an answer, or null. Only blocking methods land here. */
	pendingUi: ExtensionUiRequestFrame | null;
	/**
	 * A compaction this client can see, manual or automatic.
	 *
	 * Owned here rather than read from `state.isCompacting`, because a manual
	 * compaction pushes no progress frames at all — the server goes quiet from
	 * the moment it starts until it is done. The client is the only thing that
	 * knows the operation is in flight.
	 */
	/**
	 * The agent's plan, freshest of the two places it comes from.
	 *
	 * `get_state` carries it, but a phase closes mid-turn and state is only asked
	 * for at turn boundaries — so the tool's own result is the live source and
	 * this is where the two are reconciled.
	 */
	todoPhases: readonly TodoPhase[];
	/**
	 * The boot sequence has finished, not merely "the process replied once".
	 *
	 * `status: "ready"` flips on the first correlated reply, which is well before
	 * `switch_session` has run — and switching aborts the session, killing any
	 * `bash` already in flight. Anything that runs shell commands has to wait for
	 * this instead, or its first command dies with `[Command cancelled]`.
	 */
	booted: boolean;
	compaction: CompactionProgress | null;
	/**
	 * Something worth saying that is not a failure — a compaction method falling
	 * back to the next one, say. Separate from `error` because painting one as
	 * the other is how a working operation comes to look broken.
	 */
	warning: string | null;
	stderr: readonly string[];
	error: string | null;
	exit: { code: number | null; signal: number | null } | null;
}

const EMPTY_SNAPSHOT: BridgeSnapshot = {
	status: "idle",
	stalled: false,
	ready: null,
	pid: null,
	prewarmed: false,
	state: null,
	commands: [],
	transcript: [],
	subagents: [],
	events: [],
	pendingUi: null,
	todoPhases: [],
	booted: false,
	compaction: null,
	warning: null,
	stderr: [],
	error: null,
	exit: null,
};

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer: Timer;
	type: string;
}

export interface RpcBridgeOptions {
	/** Answer non-blocking UI requests (notify/setStatus/…) — default: ignore. */
	onNotice?(request: ExtensionUiRequestFrame): void;
	/** Called for `open_url`; the host should open it in the system browser. */
	onOpenUrl?(url: string, instructions?: string, launchUrl?: string): void;
	/** How long `starting` may last before `stalled` flips. Tests pass a small one. */
	stallAfterMs?: number;
}

export class RpcBridge {
	readonly tabId: string;
	#transport: Transport;
	#options: RpcBridgeOptions;

	#seq = 0;
	#pending = new Map<string, Pending>();
	/**
	 * Who is still owed the second answer a `prompt` can give.
	 *
	 * Only the newest one is kept: the composer sends one message at a time, and
	 * a watcher that outlived its send would hand a message back to a composer
	 * that has moved on to another.
	 */
	#lateFailure: { id: string; notify(cause: Error): void } | null = null;
	#listeners = new Set<() => void>();

	// Mutable interior; `#snapshot` is rebuilt lazily on read.
	#status: BridgeStatus = "idle";
	#stalled = false;
	#stallTimer: Timer | null = null;
	#ready: ReadyFrame | null = null;
	#pid: number | null = null;
	#prewarmed = false;
	#state: RpcSessionState | null = null;
	#commands: AvailableSlashCommand[] = [];
	#transcript = new TranscriptModel();
	#subagents = new Map<string, SubagentSnapshot>();
	#subagentList: SubagentSnapshot[] = [];
	#events: SessionEventFrame[] = [];
	#pendingUi: ExtensionUiRequestFrame | null = null;
	/** Blocking requests that arrived while another was on screen. */
	#uiQueue: ExtensionUiRequestFrame[] = [];
	/**
	 * Deadlines for the questions carrying one, keyed by request id.
	 *
	 * The server arms its own timer and, unlike an aborted dialog, lets it expire
	 * in silence — it resolves the default and forgets the request without ever
	 * emitting a `cancel`. Nothing else would take the modal down.
	 */
	#uiTimers = new Map<string, Timer>();
	#todoPhases: readonly TodoPhase[] = [];
	#booted = false;
	#compaction: CompactionProgress | null = null;
	#warning: string | null = null;
	#compactionTimer: Timer | null = null;
	#compactionPoll: Timer | null = null;
	#stateRefreshing = false;
	#stateRefreshWanted = false;
	#stderr: string[] = [];
	#error: string | null = null;
	#exit: { code: number | null; signal: number | null } | null = null;

	/**
	 * An eviction kills the child, so a `exited` always trails `evicted`.
	 * Without this the tab would flip from "suspended" to "the agent crashed" a
	 * few milliseconds later.
	 */
	#exitExpected = false;

	#snapshot: BridgeSnapshot = EMPTY_SNAPSHOT;
	#dirty = false;
	#notifyQueued = false;

	#stallAfterMs: number;

	constructor(tabId: string, transport: Transport, options: RpcBridgeOptions = {}) {
		this.tabId = tabId;
		this.#transport = transport;
		this.#options = options;
		this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_MS;
	}

	/**
	 * The only writer of `#status`, so the stall watchdog cannot drift away from
	 * the state it is watching: every exit from `starting` disarms it, and every
	 * entry re-arms it.
	 */
	#setStatus(next: BridgeStatus): void {
		this.#status = next;
		this.#stalled = false;
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer);
			this.#stallTimer = null;
		}
		if (next !== "starting") return;
		this.#stallTimer = setTimeout(() => {
			this.#stallTimer = null;
			if (this.#status !== "starting") return;
			this.#stalled = true;
			this.#touch();
		}, this.#stallAfterMs);
	}

	// -- store ---------------------------------------------------------------

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): BridgeSnapshot => {
		if (this.#dirty) {
			this.#snapshot = {
				status: this.#status,
				stalled: this.#stalled,
				ready: this.#ready,
				pid: this.#pid,
				prewarmed: this.#prewarmed,
				state: this.#state,
				commands: this.#commands,
				transcript: this.#transcript.entries,
				subagents: this.#subagentList,
				events: this.#events,
				pendingUi: this.#pendingUi,
				todoPhases: this.#todoPhases,
				booted: this.#booted,
				compaction: this.#compaction,
				warning: this.#warning,
				stderr: this.#stderr,
				error: this.#error,
				exit: this.#exit,
			};
			this.#dirty = false;
		}
		return this.#snapshot;
	};

	/**
	 * Mark dirty and notify once per microtask. A streaming turn produces
	 * hundreds of frames per second; without coalescing each one would be a
	 * separate React render.
	 */
	#touch(): void {
		this.#dirty = true;
		if (this.#notifyQueued) return;
		this.#notifyQueued = true;
		queueMicrotask(() => {
			this.#notifyQueued = false;
			for (const listener of this.#listeners) listener();
		});
	}

	// -- lifecycle -----------------------------------------------------------

	async start(cwd?: string): Promise<AgentHandle> {
		this.#setStatus("starting");
		this.#error = null;
		this.#exit = null;
		this.#exitExpected = false;
		this.#booted = false;
		this.#todoPhases = [];
		// A new process cannot answer questions the old one asked.
		this.#pendingUi = null;
		this.#uiQueue = [];
		this.#clearUiTimeouts();
		// A compaction cannot survive the process that was running it.
		this.#abandonCompaction();
		this.#touch();

		let handle: AgentHandle;
		try {
			handle = await this.#transport.start(this.tabId, event => this.#onRelayEvent(event), cwd);
		} catch (cause) {
			// A rejected `agent_start` is a missing binary, a bad cwd, a poisoned
			// mutex — none of which will ever produce a frame. Leaving the status on
			// `starting` made every one of them look like a slow launch, forever.
			this.#setStatus("error");
			this.#error = cause instanceof Error ? cause.message : String(cause);
			this.#touch();
			throw cause;
		}
		this.#pid = handle.pid;
		this.#prewarmed = handle.prewarmed;
		this.#touch();
		return handle;
	}

	/** Kill the process and fail everything still in flight. */
	async stop(): Promise<void> {
		await this.#transport.kill(this.tabId);
		this.#failPending(new Error("session stopped"));
	}

	/** Kill the process but keep the tab; the transcript lives in the jsonl. */
	async suspend(): Promise<void> {
		await this.#transport.suspend(this.tabId);
		this.#failPending(new Error("session suspended"));
	}

	#failPending(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	/**
	 * A process that is gone is not mid-turn.
	 *
	 * `#state` is a photograph taken at the last `get_state`, and the only thing
	 * that retakes it is a live child answering another one. A turn that was
	 * running when the child died therefore left `isStreaming` true in it forever
	 * — the refresh is driven by `turn_end`, which will never arrive — and
	 * everything that asks whether this session is busy reads that flag: the
	 * sidebar's activity dot, the close guard's "an agent is still working"
	 * prompt, the composer showing Stop where Send belongs, Escape-to-abort.
	 *
	 * Called from all three terminal arms, `fault` included: that one leaves the
	 * status on `error`, for which the session pane offers neither the Restart
	 * button nor the resume banner, so nothing else would ever correct it.
	 *
	 * Copied rather than mutated, because `getSnapshot` hands `state` out by
	 * reference. Guarded so a state that is already settled keeps its object
	 * identity and does not churn memoised consumers. Callers must `#touch()`.
	 */
	#clearLiveState(): void {
		const state = this.#state;
		if (!state || (!state.isStreaming && !state.isCompacting)) return;
		this.#state = { ...state, isStreaming: false, isCompacting: false };
	}

	// -- inbound -------------------------------------------------------------

	#onRelayEvent(event: RelayEvent): void {
		switch (event.event) {
			case "frames":
				for (const line of event.data.lines) this.#onLine(line);
				break;
			case "stderr":
				this.#stderr = [...this.#stderr, ...event.data.lines].slice(-MAX_RETAINED_STDERR);
				this.#touch();
				break;
			case "fault":
				this.#setStatus("error");
				this.#error = event.data.message;
				this.#failPending(new Error(event.data.message));
				this.#clearLiveState();
				this.#abandonCompaction();
				this.#touch();
				break;
			case "evicted":
				this.#setStatus("suspended");
				this.#exitExpected = true;
				this.#failPending(new Error("session suspended to free a slot"));
				this.#clearLiveState();
				this.#abandonCompaction();
				this.#touch();
				break;
			case "exited":
				if (this.#exitExpected) {
					// The eviction already reported this; stay suspended.
					this.#exitExpected = false;
					break;
				}
				this.#setStatus("exited");
				this.#exit = { code: event.data.code, signal: event.data.signal };
				this.#failPending(new Error(`sidecar exited (code ${event.data.code ?? "?"})`));
				this.#clearLiveState();
				this.#abandonCompaction();
				this.#touch();
				break;
		}
	}

	/**
	 * One newline-delimited JSON frame. A parse failure is recorded and skipped
	 * — never thrown — because one bad line must not stop the stream.
	 */
	#onLine(line: string): void {
		if (!line.trim()) return;

		let frame: ServerFrame;
		try {
			frame = JSON.parse(line) as ServerFrame;
		} catch {
			this.#stderr = [...this.#stderr, `[unparseable frame] ${line.slice(0, 200)}`].slice(-MAX_RETAINED_STDERR);
			this.#touch();
			return;
		}
		if (typeof frame?.type !== "string") return;

		if (isReadyFrame(frame)) {
			this.#ready = frame;
			this.#setStatus("ready");
			this.#touch();
			return;
		}

		if (isResponseFrame(frame)) {
			this.#settle(frame);
			return;
		}

		if (isAvailableCommandsUpdate(frame)) {
			this.#commands = frame.commands;
			this.#touch();
			return;
		}

		if (isExtensionUiRequest(frame)) {
			this.#onUiRequest(frame);
			return;
		}

		if (
			frame.type === "subagent_lifecycle" ||
			frame.type === "subagent_progress" ||
			frame.type === "subagent_event"
		) {
			this.#onSubagentFrame(frame);
			return;
		}

		this.#onSessionEvent(frame);
	}

	#settle(frame: ResponseFrame): void {
		const entry = this.#pending.get(frame.id);
		if (!entry) {
			/*
			 * `prompt` answers twice. The server acknowledges the frame and only
			 * then starts the turn — it has to, a turn runs for minutes — so a
			 * prompt that fails after the acknowledgement (no model selected, an
			 * image the provider will not take) comes back as a second response on
			 * an id nothing is waiting for any more. Dropped as a late reply, the
			 * message vanished and the composer had already been told it went.
			 */
			if (frame.success === false) {
				this.#error = frame.error ?? "The agent refused that request.";
				this.#touch();
				// The banner can say what went wrong, but only the caller still has
				// the message the server just refused to take.
				const late = this.#lateFailure;
				if (late?.id === frame.id) {
					this.#lateFailure = null;
					late.notify(new Error(this.#error));
				}
			}
			return; // otherwise a late reply to a timed-out or abandoned request
		}
		this.#pending.delete(frame.id);
		clearTimeout(entry.timer);

		// A correlated reply proves the sidecar is serving *this* webview, which
		// the `ready` frame cannot after a re-attach: it is emitted once, at
		// startup, into a channel that a reload or a route change threw away. A
		// failure reply counts too — it still came back from a live protocol loop.
		if (this.#status === "starting") {
			this.#setStatus("ready");
			this.#touch();
		}

		if (frame.success === false) {
			const error = new Error(frame.error ?? `${entry.type} failed`);
			if (frame.code) (error as Error & { code?: string }).code = frame.code;
			entry.reject(error);
			return;
		}
		entry.resolve(frame.data);
	}

	#onUiRequest(frame: ExtensionUiRequestFrame): void {
		if (frame.method === "open_url") {
			this.#options.onOpenUrl?.(String(frame.url ?? ""), frame.instructions, frame.launchUrl);
			return;
		}

		/*
		 * The server withdrawing a request it had already asked. It has settled its
		 * own side, so there is nothing to answer — the dialog just has to go, or
		 * it sits there forever collecting an answer nobody is waiting for. It also
		 * suppresses Escape-to-abort while it is up, so a stale one is worse than
		 * merely useless.
		 */
		if (frame.method === "cancel") {
			const target = frame.targetId;
			if (typeof target === "string") this.#withdrawUi(target);
			return;
		}

		// Non-blocking methods (notify, setStatus, setWidget, setTitle, …) need
		// no reply. Verified: an unanswered `setWidget` did not wedge the server.
		if (!BLOCKING_UI_METHODS.has(frame.method)) {
			this.#options.onNotice?.(frame);
			return;
		}

		/*
		 * One slot was not enough. The server can have more than one question
		 * outstanding — a plan review raised while an `ask` is open, say — and
		 * overwriting the first left its promise hanging on the server with no way
		 * for anyone to answer it. They queue, and the next appears as the current
		 * one is answered.
		 */
		if (this.#pendingUi) this.#uiQueue.push(frame);
		else this.#pendingUi = frame;
		this.#armUiTimeout(frame);
		this.#touch();
	}

	/**
	 * Run the server's own dialog deadline on this side too.
	 *
	 * `requestRpcDialog` resolves the default and drops the pending request when
	 * its timer expires, and — unlike the signal-driven abort beside it — sends
	 * no `cancel`. The modal would otherwise stay up over a question nobody is
	 * awaiting: it covers the composer, swallows Escape-to-abort, and every later
	 * question queues behind it. The deadline rides on the frame so a client can
	 * match it, and the response union carries `timedOut` for exactly this reply.
	 *
	 * Armed on arrival, not on display: a question waiting its turn in the queue
	 * is already burning the deadline the server started when it asked.
	 */
	#armUiTimeout(frame: ExtensionUiRequestFrame): void {
		const deadline = frame.timeout;
		if (typeof deadline !== "number") return;
		const id = frame.id;
		this.#uiTimers.set(
			id,
			setTimeout(() => {
				this.#uiTimers.delete(id);
				this.#withdrawUi(id);
				/*
				 * Sent, not skipped. The server's timer normally wins — it starts
				 * before the frame is written — and then drops this frame as an answer
				 * to an id it no longer holds. When a busy server loop lets ours land
				 * first, this is what settles its side instead of stranding it.
				 * Failures are the dead-sidecar case, which needs no banner of its own.
				 */
				this.#write({ type: "extension_ui_response", id, cancelled: true, timedOut: true }).catch(() => {});
			}, deadline),
		);
	}

	/** Take a request off the screen or out of the queue, wherever it is sitting. */
	#withdrawUi(id: string): void {
		this.#disarmUiTimeout(id);
		if (this.#pendingUi?.id === id) this.#pendingUi = this.#uiQueue.shift() ?? null;
		else this.#uiQueue = this.#uiQueue.filter(queued => queued.id !== id);
		this.#touch();
	}

	#disarmUiTimeout(id: string): void {
		const timer = this.#uiTimers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#uiTimers.delete(id);
	}

	#clearUiTimeouts(): void {
		for (const timer of this.#uiTimers.values()) clearTimeout(timer);
		this.#uiTimers.clear();
	}

	/** Answer the outstanding blocking UI request, then show the next one. */
	answerUi(response: ExtensionUiAnswer): void {
		const pending = this.#pendingUi;
		if (!pending) return;
		this.#disarmUiTimeout(pending.id);
		this.#pendingUi = this.#uiQueue.shift() ?? null;
		this.#touch();
		// Reported, not discarded: answering a dialog whose sidecar has died
		// rejects here, and `request()` already treats a failed write this way.
		this.#write({ type: "extension_ui_response", ...response }).catch(cause => {
			this.#error = cause instanceof Error ? cause.message : String(cause);
			this.#touch();
		});
	}

	/**
	 * Fold a subagent frame into the roster.
	 *
	 * All three frame types carry a `payload` keyed by subagent id, so they merge
	 * into one map rather than three parallel structures. The list is rebuilt on
	 * change so the snapshot stays immutable.
	 */
	#onSubagentFrame(frame: SessionEventFrame): void {
		const payload = frame.payload;
		if (typeof payload !== "object" || payload === null) return;

		const record = payload as Partial<SubagentSnapshot> & { progress?: SubagentProgress };
		const id = typeof record.id === "string" ? record.id : record.progress?.id;
		if (!id) return;

		const existing = this.#subagents.get(id);
		const merged: SubagentSnapshot = {
			...existing,
			...record,
			id,
			index: record.index ?? existing?.index ?? this.#subagents.size,
			agent: record.agent ?? record.progress?.agent ?? existing?.agent ?? "subagent",
			/*
			 * `started` is what a lifecycle frame says; the roster and the status
			 * dot only know the five in `SubagentProgress`. The server normalises it
			 * the same way for its own snapshot (`rpc-subagents.ts`), so a subagent
			 * that had only ever announced itself rendered with no state at all.
			 */
			status: normalizeSubagentStatus(record.status ?? record.progress?.status ?? existing?.status),
			lastUpdate: record.lastUpdate ?? Date.now(),
			progress: record.progress ?? existing?.progress,
		};

		this.#subagents.set(id, merged);
		this.#subagentList = [...this.#subagents.values()].sort((a, b) => a.index - b.index);
		this.#touch();
	}

	#onSessionEvent(frame: SessionEventFrame): void {
		this.#transcript.apply(frame as Record<string, unknown>);

		this.#events =
			this.#events.length >= MAX_RETAINED_EVENTS ? [...this.#events.slice(1), frame] : [...this.#events, frame];

		this.#followCompaction(frame);
		this.#followTodo(frame);

		/*
		 * `#state` has exactly one writer, `getState`, so anything derived from it
		 * is only as fresh as the last call. Gated on two frame types this was a
		 * photograph taken at boot: `isStreaming` never flipped, and with it the
		 * working indicator, the sidebar's activity dot, the turn-finished
		 * notification and Escape-to-abort were all reading a constant. Turn and
		 * compaction boundaries are the moments the state actually changes.
		 */
		if (STATE_CHANGING_EVENTS.has(frame.type)) this.#refreshState();
		this.#touch();
	}

	/**
	 * Ask for the state again, one request at a time, never dropping the last ask.
	 *
	 * These events arrive in bursts — an agentic run with twenty tool calls is
	 * twenty `turn_start`/`turn_end` pairs — and each one is a round trip to the
	 * sidecar. But merely skipping while one is in flight would be wrong: a reply
	 * to the `turn_start` ask was computed before `turn_end` happened, so
	 * dropping the second request leaves `isStreaming` stuck true after the turn
	 * is over. So overlapping asks collapse into exactly one trailing repeat.
	 */
	#refreshState(): void {
		if (this.#stateRefreshing) {
			this.#stateRefreshWanted = true;
			return;
		}
		this.#stateRefreshing = true;
		void this.getState()
			.catch(() => {})
			.finally(() => {
				this.#stateRefreshing = false;
				if (!this.#stateRefreshWanted) return;
				this.#stateRefreshWanted = false;
				this.#refreshState();
			});
	}

	/**
	 * The plan, the moment it changes.
	 *
	 * `tool_execution_end` for the `todo` tool carries the complete new snapshot
	 * in `result.details.phases` — the same place omp's own terminal reads it
	 * from. Taking it here means a task closing halfway through a long turn shows
	 * immediately, rather than at the turn boundary where `get_state` is asked.
	 *
	 * There is no "todos changed" event to listen for instead: `todo_reminder`
	 * carries only the open tasks and loses their phases, and `todo_auto_clear`
	 * is declared and forwarded but never emitted by anything.
	 */
	#followTodo(frame: SessionEventFrame): void {
		if (frame.type !== "tool_execution_end") return;
		const phases = phasesFromToolResult(frame as Record<string, unknown>);
		if (!phases) return;
		this.#todoPhases = phases;
		this.#touch();
	}

	/**
	 * A compaction is only visible if the client tracks it.
	 *
	 * The automatic path brackets itself with `auto_compaction_start` / `_end`.
	 * The manual one announces nothing at all — it goes quiet and eventually
	 * prints a line — so `startCompaction` opens the bracket and the closing
	 * `command_output` shuts it.
	 */
	#followCompaction(frame: SessionEventFrame): void {
		if (frame.type === "auto_compaction_start") {
			/*
			 * Both paths announce themselves here now; `reason` is what separates
			 * an operator asking from the engine deciding. A manual run has already
			 * opened its own bracket in `startCompaction` — this fills in the method
			 * the engine settled on without restarting the clock.
			 */
			const manual = frame.reason === "manual";
			this.#openCompaction({
				origin: manual ? "manual" : "auto",
				tokensBefore: this.#compaction?.tokensBefore ?? this.#state?.contextUsage?.tokens,
				action: typeof frame.action === "string" ? frame.action : undefined,
				reason: typeof frame.reason === "string" ? frame.reason : undefined,
			});
			return;
		}

		if (frame.type === "auto_compaction_end") {
			/*
			 * `errorMessage` here is not a failure. The engine sets it when a method
			 * reclaimed something but not enough and it is falling back to the next
			 * one — "Auto-shake reclaimed ~N tokens but context is still above the
			 * threshold; trying the next preferred compaction method." — and then
			 * emits a fresh start. The terminal shows exactly this as a warning, and
			 * calling it a failure would paint a red banner over an operation that
			 * is still running and about to succeed. `skipped` is a benign no-op the
			 * terminal stays silent about, so it stays silent here too.
			 */
			const message = typeof frame.errorMessage === "string" ? frame.errorMessage : null;
			/*
			 * Only for a pass this client did not ask for. `errorMessage` means two
			 * things — a method falling back to the next one, and a pass that
			 * genuinely failed — and nothing on the event separates them. For a run
			 * we started, the command's own response says which it was, and saying
			 * it twice, once amber and once red, is worse than saying it once.
			 */
			if (message && frame.skipped !== true && this.#compaction?.origin !== "manual") {
				this.#warning = message;
			}
			this.#closeCompaction();
			return;
		}

		/*
		 * The engine's only narration during a manual run: it emits these when a
		 * method turns out to be unavailable and it falls back to the next one.
		 * Not a failure — the run continues and usually succeeds.
		 */
		if (frame.type === "notice" && frame.source === "compaction" && this.#compaction) {
			if (typeof frame.message === "string") {
				this.#compaction = { ...this.#compaction, note: frame.message };
			}
			return;
		}
	}

	#stopCompactionPoll(): void {
		if (this.#compactionPoll === null) return;
		clearInterval(this.#compactionPoll);
		this.#compactionPoll = null;
	}

	/** Marks the next rejection as ours, so cancelling does not read as failing. */
	#cancellingCompaction = false;

	#openCompaction(progress: CompactionProgress): void {
		this.#compaction = progress;
		if (this.#compactionPoll === null) {
			this.#compactionPoll = setInterval(() => this.#refreshState(), COMPACTION_POLL_MS);
		}
		if (this.#compactionTimer !== null) clearTimeout(this.#compactionTimer);
		this.#compactionTimer = setTimeout(() => {
			this.#compactionTimer = null;
			if (!this.#compaction) return;
			this.#compaction = null;
			// The poll belongs to the banner. Clearing the banner inline used to
			// leave the 4-second `get_state` running for the life of the tab, and
			// every other exit is a no-op once `#compaction` is null.
			this.#stopCompactionPoll();
			this.#error = "The compaction never reported back. The session may or may not have been rewritten.";
			this.#touch();
		}, COMPACTION_REPORT_TIMEOUT_MS);
		this.#touch();
	}

	#closeCompaction(): void {
		// Idempotent: the event and the command response both close this, and
		// whichever arrives second must not reload the history a second time.
		if (!this.#compaction) return;
		this.#stopCompactionPoll();
		if (this.#compactionTimer !== null) {
			clearTimeout(this.#compactionTimer);
			this.#compactionTimer = null;
		}
		this.#compaction = null;
		/*
		 * Nothing pushes the rewritten history: `replaceMessages` is an array swap
		 * that emits no frame. Without this the transcript keeps showing the
		 * messages the compaction just replaced — which is the one state where a
		 * stale transcript actively misleads, since the tokens it represents are
		 * gone from the model's context.
		 */
		void this.reloadMessages().catch((cause: unknown) => {
			this.#error = `Compacted, but the transcript could not be reloaded: ${describe(cause)}`;
			this.#touch();
		});
		void this.getState().catch(() => {});
		this.#touch();
	}

	// -- outbound ------------------------------------------------------------

	async #write(payload: object): Promise<void> {
		await this.#transport.send(this.tabId, JSON.stringify(payload));
	}

	/**
	 * Send a command and await its response, correlated by `id`.
	 *
	 * The id is minted here and never reused, so a late response to a timed-out
	 * request cannot resolve a newer one.
	 */
	request<T = unknown>(
		command: { type: string; [key: string]: unknown },
		timeoutMs = DEFAULT_TIMEOUT_MS,
		onLateFailure?: (cause: Error) => void,
	): Promise<T> {
		const id = `d${++this.#seq}`;
		// Registered only when one is asked for, and never cleared by the next
		// request: `get_state` alone would otherwise cancel a prompt's watcher
		// before the turn it started had the chance to refuse.
		if (onLateFailure) this.#lateFailure = { id, notify: onLateFailure };
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`${command.type} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		this.#pending.set(id, { resolve, reject, timer, type: command.type });

		// Deliberately NOT `async`: the caller's handler must attach to `promise`
		// synchronously. An `await` before returning it leaves a window where the
		// sidecar can die and reject an unhandled promise.
		this.#write({ ...command, id }).catch((error: unknown) => {
			this.#pending.delete(id);
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});

		return promise as Promise<T>;
	}

	// -- typed surface, mirroring RpcClient ----------------------------------

	/**
	 * A prompt, and what to do with it if a turn is already running.
	 *
	 * `streamingBehavior` is not optional in practice. Without it the server
	 * throws `AgentBusyError` for a prompt that arrives mid-turn, and this client
	 * cannot know that it has: it chooses prompt-vs-steer from `state`, which is
	 * only refreshed at turn and compaction boundaries, so every submit in the
	 * window between a turn starting and that refresh landing was refused. The
	 * terminal tags an ordinary Enter the same way, for the same race.
	 */
	async prompt(message: string, images?: unknown[], onLateFailure?: (cause: Error) => void): Promise<boolean> {
		const data = await this.request<{ agentInvoked?: boolean } | undefined>(
			{ type: "prompt", message, images, streamingBehavior: "steer" },
			DEFAULT_TIMEOUT_MS,
			onLateFailure,
		);
		// rpc-mode answers an ACP builtin (`/model`, `/mcp`, `/compact`, …) on the
		// response itself — `executeAcpBuiltinSlashCommand` runs before the prompt
		// ever reaches `AgentSession`, so no `prompt_result` frame is emitted and
		// no user message is ever recorded. A prompt that did start a turn answers
		// with no data at all, so `undefined` means "the agent took it".
		return !(typeof data === "object" && data !== null && data.agentInvoked === false);
	}

	/**
	 * Draw a message in the transcript the moment it is sent.
	 *
	 * Not folded into `prompt`: `McpScreen` drives `/mcp add …` through the same
	 * command and its lines are not something anyone typed into this transcript.
	 * Only the composer speaks for the user, so only the composer echoes.
	 *
	 * Returns the handle `retractUserEcho` needs.
	 */
	echoUserMessage(text: string): string {
		const token = this.#transcript.echo(text);
		this.#touch();
		return token;
	}

	/** Undo an echo whose send was refused, so nothing unsent stays on screen. */
	retractUserEcho(token: string): void {
		if (this.#transcript.retract(token)) this.#touch();
	}

	async steer(message: string, images?: unknown[]): Promise<void> {
		await this.request({ type: "steer", message, images });
	}

	async followUp(message: string, images?: unknown[]): Promise<void> {
		await this.request({ type: "follow_up", message, images });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	/**
	 * Compact the session, visibly and cancellably.
	 *
	 * The typed command again, not `/compact` as a prompt. It went the long way
	 * round because the server handled `compact` inside its serialized command
	 * queue, so for the whole run nothing else was answered — an `abort` would
	 * sit behind the very operation it was meant to stop. `compact` now bypasses
	 * that queue the way `bash` does, so the typed command is both cancellable
	 * and honest about its result, and the banner is driven by the compaction
	 * lifecycle events instead of by parsing the prose a slash command printed.
	 *
	 * Its own timeout, because the default is two minutes and a large context
	 * genuinely takes longer.
	 */
	async startCompaction(): Promise<void> {
		if (this.#compaction) return;
		this.#error = null;
		this.#openCompaction({ origin: "manual", tokensBefore: this.#state?.contextUsage?.tokens });
		try {
			await this.request({ type: "compact" }, COMPACTION_TIMEOUT_MS);
			/*
			 * The response is the authoritative end: it resolves when the server's
			 * `compact()` returns. The lifecycle event usually gets here first and
			 * is what makes the banner feel immediate, but relying on it alone left
			 * the banner up after a compaction that had already finished — measured,
			 * with the session file's compaction entry six minutes older than the
			 * spinner still on screen. An event you can miss is not a backstop.
			 */
			this.#closeCompaction();
		} catch (cause) {
			this.#closeCompactionWithoutReload();
			const message = describe(cause);
			if (this.#cancellingCompaction || isCancellation(cause)) {
				// The operator's own doing, not a failure at them.
			} else if (isBenignRefusal(cause)) {
				// "Already compacted" is an answer, not a fault — and the server
				// says so with a code, so this is no longer a guess about wording.
				this.#warning = message;
			} else {
				this.#error = `Compaction failed: ${message}`;
			}
			this.#cancellingCompaction = false;
			this.#touch();
		}
	}

	/**
	 * Stop a compaction the user started.
	 *
	 * `abort` really does cancel it — the RPC handler calls `session.abort()`
	 * without `preserveCompaction`, which cancels the maintenance controller. But
	 * the slash command then returns **silently**: its catch swallows a
	 * `CompactionCancelledError` raised by a user interrupt and emits no
	 * `command_output` at all. Nothing else would ever take the banner down, so
	 * cancelling has to close its own bracket.
	 *
	 * No history reload: a cancelled pass rewrote nothing.
	 */
	async cancelCompaction(): Promise<void> {
		if (!this.#compaction) return;
		// The in-flight `compact` request will reject when the abort lands; that
		// rejection is this cancellation, not a failure worth a red banner.
		this.#cancellingCompaction = true;
		try {
			/*
			 * `abort_compact`, not `abort`. The blunt one also ends the turn, kills
			 * bash and eval and drains the post-prompt queue — pressing cancel on a
			 * compaction banner should stop the compaction and nothing else.
			 */
			await this.request({ type: "abort_compact" });
		} catch (cause) {
			this.#error = `Could not cancel the compaction: ${describe(cause)}`;
			this.#touch();
			return;
		}
		this.#closeCompactionWithoutReload();
		void this.getState().catch(() => {});
		this.#touch();
	}

	/**
	 * The process running a compaction is gone.
	 *
	 * `#compaction` and its ten-minute backstop lived entirely outside the
	 * request bookkeeping, so an eviction — routine, with three live sessions and
	 * LRU — left a background tab showing a spinner and a disabled button for ten
	 * minutes on a sidecar that had since been restarted, and then claimed the
	 * compaction "may or may not have been rewritten" when it definitively had
	 * not been.
	 */
	#abandonCompaction(): void {
		if (!this.#compaction) return;
		this.#closeCompactionWithoutReload();
	}

	/** A failed or refused compaction leaves nothing to reload. */
	#closeCompactionWithoutReload(): void {
		this.#stopCompactionPoll();
		if (this.#compactionTimer !== null) {
			clearTimeout(this.#compactionTimer);
			this.#compactionTimer = null;
		}
		this.#compaction = null;
	}

	/**
	 * Dismiss the current error.
	 *
	 * Until now `#error` was only ever cleared by `start()`, so a message from a
	 * transient failure sat on screen until the app was restarted.
	 */
	clearError(): void {
		if (this.#error === null) return;
		this.#error = null;
		this.#touch();
	}

	/**
	 * Surface a failure that happened in the UI rather than on the wire.
	 *
	 * The transcript's own actions — copying a message, a tool's output — have no
	 * other way to say they failed, and a menu that closes looks exactly like one
	 * that worked. The banner is already here and already dismissable.
	 */
	reportError(cause: unknown): void {
		this.#error = cause instanceof Error ? cause.message : String(cause);
		this.#touch();
	}

	/**
	 * The caller has finished the boot sequence — including the `switch_session`
	 * that aborts whatever the session was doing. Only after this is it safe to
	 * dispatch the side commands the panels run.
	 */
	markBooted(): void {
		if (this.#booted) return;
		this.#booted = true;
		this.#touch();
	}

	clearWarning(): void {
		if (this.#warning === null) return;
		this.#warning = null;
		this.#touch();
	}

	/**
	 * Turn plan mode on or off.
	 *
	 * The whole mode used to be terminal-only — `/plan` carries no non-TUI
	 * handler, so it was never even listed to this client and typing it sent the
	 * literal text to the model. The command exists now; the state and the
	 * `plan_mode_changed` event are what keep this honest when the mode is moved
	 * from somewhere else.
	 */
	async setPlanMode(enabled: boolean): Promise<void> {
		try {
			await this.request({ type: "set_plan_mode", enabled });
		} catch (cause) {
			this.#error = `Could not ${enabled ? "enter" : "leave"} plan mode: ${describe(cause)}`;
			this.#touch();
			return;
		}
		await this.getState().catch(() => {});
	}

	/** Re-open the review for the latest plan. */
	async planReview(): Promise<void> {
		try {
			await this.request({ type: "plan_review" });
		} catch (cause) {
			this.#error = `Could not open the plan review: ${describe(cause)}`;
			this.#touch();
		}
	}

	async getState(): Promise<RpcSessionState> {
		const state = await this.request<RpcSessionState>({ type: "get_state" });
		this.#state = state;
		// The cold-start copy, and the backstop for a plan changed by anything
		// other than the tool. The tool's own result is fresher and wins in
		// between.
		if (Array.isArray(state?.todoPhases)) this.#todoPhases = parsePhases(state.todoPhases);
		/*
		 * Self-healing: the server is the authority on whether a compaction is
		 * running, and this asks it on every turn and compaction boundary.
		 *
		 * The banner used to live entirely on edges — an event, then a response —
		 * and an edge you miss leaves a spinner up forever over an operation that
		 * finished. Anchoring it to state as well means the next refresh corrects
		 * it, whatever went wrong. Only once the server has confirmed the pass
		 * started (`action` is set by its own start event), so this cannot close a
		 * banner opened a moment ago for a compaction the server has yet to begin.
		 */
		if (this.#compaction?.action && state?.isCompacting === false) this.#closeCompaction();
		this.#touch();
		return state;
	}

	async getAvailableCommands(): Promise<AvailableSlashCommand[]> {
		const data = await this.request<{ commands: AvailableSlashCommand[] }>({
			type: "get_available_commands",
		});
		this.#commands = data.commands ?? [];
		this.#touch();
		return this.#commands;
	}

	async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
		const data = await this.request<{ models: Array<{ provider: string; id: string }> }>({
			type: "get_available_models",
		});
		return data.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.request({ type: "set_model", provider, modelId });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.request({ type: "set_thinking_level", level });
	}

	async compact(customInstructions?: string): Promise<unknown> {
		return this.request({ type: "compact", customInstructions });
	}

	async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
		await this.request({ type: "set_subagent_subscription", level });
	}

	async getSubagents(): Promise<SubagentSnapshot[]> {
		const data = await this.request<{ subagents?: SubagentSnapshot[] } | SubagentSnapshot[]>({
			type: "get_subagents",
		});
		// The command has been observed returning both a bare array and an
		// envelope; accept either rather than depending on which.
		const list = Array.isArray(data) ? data : (data?.subagents ?? []);
		for (const entry of list) this.#subagents.set(entry.id, entry);
		this.#subagentList = [...this.#subagents.values()].sort((a, b) => a.index - b.index);
		this.#touch();
		return this.#subagentList;
	}

	async getSubagentMessages(selector: { subagentId?: string; sessionFile?: string; fromByte?: number }) {
		return this.request({ type: "get_subagent_messages", ...selector });
	}

	/**
	 * Point this process at a saved session.
	 *
	 * A failure here is the one that must never be silent: the sidecar keeps its
	 * own session, so the tab goes on showing *a* transcript — just not the one
	 * you asked for. Swallowed, it looks like the session you opened; reported,
	 * it looks like what it is.
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		let result: { cancelled: boolean } | undefined;
		try {
			result = await this.request<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
		} catch (cause) {
			this.#error = `Could not open that session: ${cause instanceof Error ? cause.message : String(cause)}`;
			this.#touch();
			throw cause;
		}
		if (!result?.cancelled) {
			this.#transcript.clear();
			this.#events = [];
			this.#touch();
			/*
			 * Asked for together, and that is the point of the pair.
			 *
			 * `#state` has one writer and nothing on a switch wakes it —
			 * `STATE_CHANGING_EVENTS` is turn and compaction boundaries — so the
			 * model, the thinking level, the context usage and the model picker's
			 * selection all went on describing the session this process booted into
			 * until the first turn event. Paging a long history takes seconds, and
			 * every one of them showed the wrong session. What fixes that is the
			 * re-read being ON THE WIRE before the paging finishes, not it having
			 * already come back: awaiting it first delayed the slow half by a whole
			 * round trip and bought the state nothing, since it lands one round trip
			 * after the switch either way.
			 *
			 * Switching replays NOTHING through the event stream — the server just
			 * goes quiet on the new session — so the history has to be pulled in, or
			 * the chat opens blank, and a blank chat with no explanation is the worst
			 * outcome here: it looks like an empty session rather than a failure to
			 * read one.
			 */
			await Promise.all([
				this.getState().catch(() => {}),
				this.loadHistory().catch(cause => {
					this.#error = `Could not load this session's history: ${
						cause instanceof Error ? cause.message : String(cause)
					}`;
					this.#touch();
				}),
			]);
		}
		return result;
	}

	/**
	 * Fill the transcript from the session file, following the cursor.
	 *
	 * Pages walk **forward from the oldest message**, so asking for one and
	 * stopping showed the *start* of a long session rather than the work you had
	 * just done — a 581-message session opened on its first 200. A page can also
	 * come back short of the limit because the server caps it by bytes, so the
	 * loop follows `nextCursor` rather than counting.
	 *
	 * Paging refuses to start while the session is streaming or compacting, and a
	 * cursor goes stale if the session changes underneath it. Both stop the walk
	 * and keep whatever arrived: a partial transcript beats an empty one, and the
	 * caller is told how much is missing.
	 */
	async loadHistory(max = 4000): Promise<{ loaded: number; total: number }> {
		const all: unknown[] = [];
		let cursor: string | undefined;
		let total = 0;

		// Bounded: a runaway server would otherwise page forever.
		for (let guard = 0; guard < 64; guard++) {
			let page: { messages?: unknown[]; nextCursor?: string; totalMessages?: number } | undefined;
			try {
				page = await this.request({ type: "get_messages_page", cursor, limit: 200 });
			} catch (cause) {
				// Only the first page failing is worth reporting as a failure; a
				// later one just means we stop early with what we have.
				if (all.length === 0) throw cause;
				break;
			}
			const batch = page?.messages ?? [];
			if (typeof page?.totalMessages === "number") total = page.totalMessages;
			all.push(...batch);
			cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
			if (!cursor || batch.length === 0 || all.length >= max) break;
		}

		this.#transcript.hydrate(all);
		this.#touch();
		return { loaded: all.length, total: total || all.length };
	}

	/**
	 * Re-read the whole message list in one command.
	 *
	 * Not `loadHistory`, which pages — and paging is refused with `session_busy`
	 * while the session is streaming or compacting. An automatic compaction emits
	 * its end event from *inside* its own try block, before the controller is
	 * cleared, and for a threshold pass the prompt that triggered it is still in
	 * flight: both flags are still true at the moment this runs, so paging fails
	 * every time and the transcript keeps rendering messages the compaction has
	 * already replaced.
	 *
	 * `get_messages` carries no such guard — it returns `session.messages`
	 * directly — which is also what omp's own client falls back to.
	 */
	async reloadMessages(): Promise<number> {
		const data = await this.request<{ messages?: unknown[] }>({ type: "get_messages" });
		const messages = data?.messages ?? [];
		this.#transcript.hydrate(messages);
		this.#touch();
		return messages.length;
	}

	async getMessagesPage(cursor?: string, limit?: number): Promise<unknown> {
		return this.request({ type: "get_messages_page", cursor, limit });
	}

	async bash(command: string): Promise<unknown> {
		return this.request({ type: "bash", command });
	}

	/**
	 * Token totals and spend for the session.
	 *
	 * Separate from `get_state` on purpose: `cost` and the per-kind token counts
	 * live here, so the status bar fetches this when a turn settles rather than
	 * polling it while one is streaming.
	 */
	async getSessionStats(): Promise<{ cost?: number; tokens?: Record<string, number> }> {
		return this.request({ type: "get_session_stats" });
	}

	/**
	 * Rename the session this process has open.
	 *
	 * The server trims and refuses an empty name, so the caller does not have to
	 * guess what counts as blank.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.request({ type: "set_session_name", name });
	}

	/** Write the transcript as HTML and answer with where it landed. */
	async exportHtml(outputPath?: string): Promise<string> {
		const data = await this.request<{ path: string }>({ type: "export_html", outputPath });
		return data.path;
	}

	async getLoginProviders(): Promise<LoginProvider[]> {
		const data = await this.request<{ providers: LoginProvider[] }>({
			type: "get_login_providers",
		});
		return data.providers ?? [];
	}

	async login(providerId: string): Promise<{ providerId: string }> {
		return this.request({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
	}
}
