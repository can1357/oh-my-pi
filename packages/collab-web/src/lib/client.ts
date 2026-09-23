/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * applied frame, so React change detection is reference equality all the way.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/** Paging state for a guest the host joined with a tail (`welcome.history`). */
export interface HistoryState {
	/** First entry id held; the `before` cursor of the next page. */
	startId: string | null;
	/** The host's active branch has entries before `startId`. */
	hasEarlier: boolean;
	/** A page request is in flight. */
	loading: boolean;
	/** Why the last page request failed; cleared when a page lands. */
	error: string | null;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	/** Set when the host sent a tail instead of the full session; `null` for a full snapshot. */
	history: HistoryState | null;
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/**
 * Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk
 * must make progress. History pages use the same per-frame budget.
 */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/** Byte budget of the join tail; the host fills it with whole turns and earlier turns page in on demand. */
export const TAIL_BYTES = 1024 * 1024;
/** Byte budget of each "load earlier" page. */
export const PAGE_BYTES = 1024 * 1024;

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

/** The in-flight fetch-history request; its page accumulates across `history` frames. */
interface PendingHistory {
	reqId: number;
	entries: SessionEntry[];
	timer: Timer;
}

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	/** Welcomed at least once: later opens are reconnects, each with its own welcome wait. */
	#joined = false;
	/** A live replica re-sent hello after a stale history cursor and awaits the fresh welcome. */
	#rejoining = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#pendingHistory: PendingHistory | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	#pendingSnapshot: { entries: SessionEntry[]; live: SessionEntry[]; total: number } | null = null;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#history: HistoryState | null = null;
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry/history frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) this.#armWelcomeTimer();
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	sendPrompt(text: string): void {
		this.#socket.send({ t: "prompt", text });
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
	}

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/**
	 * Request the page of history just before the oldest entry held. A no-op
	 * unless the host joined this guest with a tail that has earlier entries,
	 * the replica is live, and no page is already in flight. The outcome lands
	 * in {@link GuestSnapshot.history}; the page is prepended in one commit.
	 */
	fetchHistory(): void {
		const history = this.#history;
		if (
			history === null ||
			!history.hasEarlier ||
			history.startId === null ||
			history.loading ||
			this.#pendingSnapshot !== null ||
			this.#phase !== "live"
		) {
			return;
		}
		const reqId = ++this.#reqSeq;
		const pending: PendingHistory = { reqId, entries: [], timer: this.#historyTimer(reqId) };
		this.#pendingHistory = pending;
		// Any previous error stays until this page lands, so the control keeps its height.
		this.#history = { ...history, loading: true };
		this.#socket.send({ t: "fetch-history", reqId, before: history.startId, maxBytes: PAGE_BYTES });
		this.#commit();
	}


	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: HostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#welcomed = false;
		// A first join keeps the single deadline `connect()` armed.
		if (this.#joined) this.#armWelcomeTimer();
		this.#sendHello();
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	/** (Re)introduce this guest; the host answers with a fresh welcome and snapshot train. */
	#sendHello(): void {
		this.#socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: this.#name,
			writeToken: this.#writeToken,
			snapshot: { mode: "tail", maxBytes: TAIL_BYTES },
		});
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		// The host discards this peer's queued replies with the connection.
		this.#dropPendingHistory(null);
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			// After a welcome, only an open socket awaits one; the next open
			// re-arms the timer. Otherwise a retry backoff past the timeout (a
			// host restart, a laptop sleep) would end a guest that should just
			// keep retrying.
			if (this.#joined) this.#clearWelcomeTimer();
			// The next open's hello supersedes an in-session rejoin.
			this.#rejoining = false;
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		this.#failPendingTranscripts();
		this.#dropPendingHistory(null);
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			if (this.#rejoining) {
				// The replica is still live; only its history cursor is stale. A
				// retry re-requests the page, and its "stale" reply rejoins again.
				this.#rejoining = false;
				if (this.#history !== null) {
					this.#history = { ...this.#history, loading: false, error: "timed out reloading the latest messages" };
				}
				this.#commit();
				return;
			}
			if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	/** Idle timer for page `reqId`: re-armed by every `history` frame that makes progress. */
	#historyTimer(reqId: number): Timer {
		return setTimeout(() => {
			if (this.#pendingHistory?.reqId !== reqId) return;
			this.#dropPendingHistory("timed out loading earlier messages");
			this.#commit();
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	/**
	 * Forget the in-flight page request, if any; replies still on the wire
	 * are then ignored by reqId. `error` is surfaced, `null` clears it.
	 * Callers commit.
	 */
	#dropPendingHistory(error: string | null): void {
		const pending = this.#pendingHistory;
		if (pending === null) return;
		clearTimeout(pending.timer);
		this.#pendingHistory = null;
		if (this.#history !== null) this.#history = { ...this.#history, loading: false, error };
	}

	/** Resolve every transcript read in flight as transient (`null`), so its poller retries. */
	#failPendingTranscripts(): void {
		for (const pending of this.#pendingTranscripts.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
	}
	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// A fresh welcome (first join or reconnect) restarts the snapshot.
				// Entries already on screen stay until the new snapshot replaces
				// them once complete, so a resync never blanks the transcript.
				this.#header = frame.header;
				if (frame.entryCount === 0) {
					this.#entries = [];
					this.#publishedEntries = [];
					this.#pendingSnapshot = null;
				} else {
					this.#pendingSnapshot = { entries: [], live: [], total: frame.entryCount };
				}
				// Pages requested before this welcome describe the old replica.
				this.#dropPendingHistory(null);
				// So are transcript reads: the host dropped their queued replies
				// with the old join.
				this.#failPendingTranscripts();
				// Tail join: `history` pages in what the tail left out.
				this.#history = frame.history
					? {
							startId: frame.history.startId,
							hasEarlier: frame.history.hasEarlier,
							loading: false,
							error: null,
						}
					: null;
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#joined = true;
				this.#rejoining = false;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.#pendingSnapshot;
				if (pending === null) return;
				pending.entries.push(...frame.entries);
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#entries = pending.entries;
				this.#entries.push(...pending.live);
				this.#publishedEntries = [...this.#entries];
				this.#pendingSnapshot = null;
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				break;
			}
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				if (this.#pendingSnapshot !== null) {
					this.#pendingSnapshot.live.push(frame.entry);
					break;
				}
				this.#entries.push(frame.entry);
				this.#publishedEntries = [...this.#entries];
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "history": {
				const pending = this.#pendingHistory;
				// A reply to a request dropped by a timeout, close or re-welcome.
				if (pending?.reqId !== frame.reqId) return;
				if (frame.error !== undefined) {
					if (frame.error === "stale") {
						// The cursor left the host's active branch (tree navigation,
						// a discarded entry), so this replica is no longer a suffix of
						// the host's: join again for the current tail. The previous
						// entries, and the spinner, stay up until it lands, and the
						// replica stays live: errors meanwhile are notices, not a
						// refused join.
						this.#dropPendingHistory(null);
						if (this.#history !== null) this.#history = { ...this.#history, loading: true };
						this.#pushNotice("info", "the host's history changed; reloaded the latest messages");
						this.#rejoining = true;
						this.#armWelcomeTimer();
						this.#sendHello();
					} else {
						this.#dropPendingHistory(frame.error);
					}
					break;
				}
				pending.entries.push(...frame.entries);
				if (!frame.final) {
					clearTimeout(pending.timer);
					pending.timer = this.#historyTimer(pending.reqId);
					return;
				}
				// A conforming host never repeats rows the guest holds, nor answers
				// "more to come" with nothing: drop overlap so ids stay unique, and
				// treat a page that adds nothing as an error, so the near-top
				// loader stops instead of re-requesting the same cursor forever.
				const held = new Set(this.#entries.map(entry => entry.id));
				const page = pending.entries.filter(entry => !held.has(entry.id));
				if (page.length === 0 && frame.hasEarlier === true) {
					this.#dropPendingHistory("the host sent no earlier messages");
					break;
				}
				this.#dropPendingHistory(null);
				this.#entries = [...page, ...this.#entries];
				this.#publishedEntries = [...this.#entries];
				if (this.#history !== null) {
					this.#history = {
						startId: page[0]?.id ?? this.#history.startId,
						hasEarlier: frame.hasEarlier === true,
						loading: false,
						error: null,
					};
				}
				break;
			}
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		this.#commit();
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.entries.length,
				total: this.#pendingSnapshot.total,
			},
			history: this.#history,
		};
	}

	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
