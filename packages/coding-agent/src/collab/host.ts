/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import { DialogSupersededError, WITHDRAWN_DIALOG_REPLY_MS } from "../extensibility/extensions/types";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	encodeEntryFrame,
	encodeEventFrame,
	encodeSnapshotChunk,
	type EncodedFrame,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import {
	type CollabAccess,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	publishCollabHost,
} from "./registry";
import { CollabSocket } from "./relay-client";
import {
	COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
	copyForReplication,
	MAX_REPLICATED_PAYLOAD_BYTES,
	oversizedEntryNotice,
	type ReplicatedEntry,
	serializeReplicatedEntry,
	serializeReplicatedEvent,
} from "./replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}
const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own. Measured in UTF-8 bytes — the unit the relay
 * and the seal step care about — not UTF-16 code units (#11433).
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const MAX_PENDING_UI_REQUESTS = 64;
/**
 * How long the host waits, once a message from its person withdraws a guest's question, for a writer that said
 * `hello.cancelReplies`. Such a guest replies as soon as it reads the withdrawal, one relay round trip after the
 * host sent it, behind any answer it had already sent. One that has not replied by then is not reading (a paused
 * or frozen browser tab, a hung client): the host stops waiting for it, as it stops waiting for a guest that
 * predates `cancelReplies` after {@link WITHDRAWN_DIALOG_REPLY_MS}, and the person's message goes on to the agent.
 * An answer that arrives later is ignored. It is many relay round trips long, and short enough that a stalled
 * guest holds the host's turn only briefly; the collab status names the guests waited on meanwhile.
 */
export const WITHDRAWN_GUEST_REPLY_LIMIT_MS = 10_000;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

/** A guest that said `hello`. */
interface CollabPeer {
	name: string;
	canWrite: boolean;
	/** The guest replies to every withdrawn request it was shown (`hello.cancelReplies`). */
	cancelReplies: boolean;
}

/**
 * A request a person's message withdrew while it was open. It settles on the first answer from a writer it still
 * waits for, or `unavailable` once it waits for none.
 */
interface CollabUiWithdrawal {
	/**
	 * Writers shown the request that may still answer it, by peer id. A writer leaves the set with its reply, when it
	 * leaves the room (once the frames it sent before leaving have been dispatched), or when its time runs out:
	 * {@link WITHDRAWN_DIALOG_REPLY_MS} for one that predates `cancelReplies`, {@link WITHDRAWN_GUEST_REPLY_LIMIT_MS}
	 * for any. Only a writer still in the set may answer: not one that replied, not one that joined later.
	 */
	replies: Map<number, CollabPeer>;
	timers: Timer[];
	/** Stops listening for the caller's {@link DialogSupersededError.abandon}. */
	release(): void;
}

interface PendingCollabUiRequest {
	request: CollabUiRequest;
	promise: Promise<CollabGuestUiResult>;
	settle(result: CollabGuestUiResult): void;
	responsePending?: boolean;
	retainOnReconnect?: boolean;
	/**
	 * The writer records the request was sent to. A withdrawal waits only on these: a writer never shown the request
	 * (one that left before it was asked, or joined while it was not offered) has nothing to reply to. Records, not
	 * ids, so an id the relay reissues after a room recreation never matches.
	 */
	shown: Set<CollabPeer>;
	withdrawal?: CollabUiWithdrawal;
}

/**
 * Identity a host publishes to the local registry. The controller that owns
 * hosting supplies a process-lifetime `instanceId` and bumps `generation` for
 * every room it starts; `access` caps what the registry hands out for this
 * room (the room itself always carries a write token for its own links).
 */
export interface CollabHostOptions {
	instanceId?: string;
	generation?: number;
	access?: CollabAccess;
	/**
	 * Whether guests may drive the session yet: prompts, interrupts, and agent
	 * commands are refused with an error frame while this returns false. Joins,
	 * transcript fetches, and dialog answers are always accepted, so a writer
	 * can still answer a question raised while the session is starting up.
	 * Defaults to always ready.
	 */
	guestActionsReady?: () => boolean;
	/**
	 * Called once when the relay ends the room for good after it opened —
	 * a non-retryable close or fatal socket failure (e.g. send backlog), not
	 * `stop()`. Teardown has already begun; the owner may start a successor.
	 */
	onEnded?: () => void;
}

/**
 * `start()` rejects with this when `stop()` deliberately ends the room while it
 * is still connecting (session switch, access upgrade, `/collab stop`,
 * shutdown), as opposed to a relay failure.
 */
export class CollabHostStoppedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabHostStoppedError";
	}
}

/**
 * `start()` rejects with this when the relay never opened the room: the first
 * connection closed or timed out. The room was never joinable or published, so
 * an owner may retry it without guests or the registry having seen it.
 */
export class CollabRelayUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabRelayUnavailableError";
	}
}

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId: string;
	#startedAt = 0;
	readonly #instanceId: string;
	readonly #generation: number;
	readonly #guestActionsReady: () => boolean;
	readonly #onEnded: (() => void) | undefined;
	readonly #access: CollabAccess;
	#relayConnected = false;
	#registryPublication: CollabHostPublication | null = null;
	/** Publication still being created; teardown awaits and withdraws it. */
	#pendingPublication: Promise<CollabHostPublication | null> | null = null;
	/** Set by the first teardown (explicit stop or fatal relay close); every later stop() awaits it. */
	#teardownDone: Promise<void> | null = null;
	/** Rejects the in-flight first-open wait when `stop()` overtakes `start()`. */
	#abortStart: ((reason: Error) => void) | null = null;
	#unsubscribe?: () => void;
	/**
	 * Guest identity and permission, keyed by relay peer id. Drives the
	 * participant list, notices, the status segment and the writable-peer fan-out.
	 * Deliverability is not its job: {@link CollabSocket.isServing} owns that, and
	 * the two disagree on purpose while a peer is connected but has not said hello
	 * yet, and after a shed, when the peer leaves the participant list but is
	 * still owed a resync error.
	 */
	#peers = new Map<number, CollabPeer>();
	/**
	 * Writers that left while frames they sent before leaving may still be decrypting, until the socket has
	 * dispatched those frames ({@link #handlePeerLeft}). An answer among those frames still counts for its
	 * request, and a request a person's message withdraws meanwhile still waits for them if they were shown it.
	 * Other frames from them are dropped, as from any peer that left. Cleared with {@link #peers} when the relay
	 * recreates the room, since ids are then reissued.
	 */
	#departing = new Map<number, CollabPeer>();
	/**
	 * Never reset, including across a room recreation: ids must not be reissued, or
	 * a late `ui-response` carrying an old id would settle an unrelated new request.
	 * An old id that maps to nothing is harmless.
	 */
	#uiReqSeq = 0;
	#pendingUi = new Map<number, PendingCollabUiRequest>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	/** Set the moment `stop()` begins; `#stopped` follows once teardown has run. */
	#stopping = false;
	/** The in-flight or finished `stop()`; concurrent callers share it. */
	#stopDone: Promise<void> | undefined;
	#stopped = false;
	/** Bumped on every `message_start`; keys a streaming message's superseding updates. */
	#messageSeq = 0;

	constructor(ctx: InteractiveModeContext, options: CollabHostOptions = {}) {
		this.#ctx = ctx;
		this.#instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#generation = options.generation ?? 1;
		this.#access = options.access ?? "control";
		this.#guestActionsReady = options.guestActionsReady ?? (() => true);
		this.#onEnded = options.onEnded;
		// The room mirrors the session that is active when it is created; the
		// frame guard and the registry snapshot compare against this from then on.
		this.#sessionId = ctx.sessionManager.getSessionId();
	}

	/** Registry identity shared by every room this process hosts. */
	get instanceId(): string {
		return this.#instanceId;
	}

	/** Registry generation of this room; a later room in the same process has a higher one. */
	get generation(): number {
		return this.#generation;
	}

	/** Highest access the registry hands out for this room. */
	get access(): CollabAccess {
		return this.#access;
	}

	/** Session this room mirrors; fixed at `start()`. */
	get sessionId(): string {
		return this.#sessionId;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/**
	 * The room is ending or gone. Checked before any guest action or mirrored
	 * frame: `stop()` drains the goodbye and awaits registry withdrawal before
	 * the socket closes, and no guest prompt, abort, answer, or join may reach
	 * the session — nor may any frame reach guests — once it has begun. The
	 * controller treats an ending room as absent, so `/collab` starts a new
	 * room instead of re-printing one that is about to close.
	 */
	get ending(): boolean {
		return this.#stopping || this.#stopped;
	}

	/**
	 * True while a host-side question is retained for (or shown to) a writable guest. A withdrawn one only
	 * waits for guests' replies to the withdrawal, so it needs no input; {@link awaitingGuests} names them.
	 */
	get inputRequired(): boolean {
		for (const pending of this.#pendingUi.values()) if (!pending.withdrawal) return true;
		return false;
	}

	/**
	 * Writable guests, by name, that a question closed by a message from the host's person still waits on: each
	 * one's answer sent before it read the closing, or its reply that it has none. The host's turn waits with it,
	 * though no input is required; the wait ends within {@link WITHDRAWN_GUEST_REPLY_LIMIT_MS}.
	 */
	get awaitingGuests(): string[] {
		const awaited = new Map<number, string>();
		for (const pending of this.#pendingUi.values()) {
			for (const [peerId, peer] of pending.withdrawal?.replies ?? []) awaited.set(peerId, peer.name);
		}
		return [...awaited.values()];
	}

	get relayConnected(): boolean {
		return this.#relayConnected;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	/**
	 * Mirror a host-side question to writable guests. Accepted from
	 * construction until teardown — including while the relay connection is
	 * still being established — so a dialog raised by an extension's
	 * `session_start` hook is retained for the first writer that joins.
	 * Set `retainOnReconnect` only for a request backed by a local dialog whose
	 * lifetime still owns the signal: authenticated writers can then resume it
	 * after a transport reconnect. Stop and session replacement always discard it.
	 * All current production callers opt in. The false default is a safeguard for
	 * future guest-only callers without a local dialog to own cancellation: their
	 * waits settle as unavailable when the relay recreates the room.
	 *
	 * A `signal` aborted with a `DialogSupersededError` (a message from the
	 * host's person) withdraws the request instead of settling it: guests are
	 * told with `ui-request-end { withdrawn: true }`, and an answer a guest sent
	 * before it read that still settles the request, however late the relay
	 * delivers it. A guest that said `hello.cancelReplies` replies to the
	 * withdrawal, so the host waits for that reply, up to
	 * {@link WITHDRAWN_GUEST_REPLY_LIMIT_MS}; one that did not is read for
	 * {@link WITHDRAWN_DIALOG_REPLY_MS}. The error's `abandon` signal ends the
	 * wait at once. Any other abort settles `unavailable` at once.
	 *
	 * Refused, and the room ended, once the active session is no longer the
	 * one this room mirrors: `/resume` runs the new session's `session_switch`
	 * hooks before the session-change callbacks fire, so a dialog raised there
	 * must stay local rather than reach the previous session's guests.
	 */
	requestGuestUi(
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
		options?: { retainOnReconnect?: boolean },
	): Promise<CollabGuestUiResult> | null {
		if (!this.#guestTrafficAllowed() || signal?.aborted || this.#pendingUi.size >= MAX_PENDING_UI_REQUESTS)
			return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			if (pending.withdrawal) {
				for (const timer of pending.withdrawal.timers) clearTimeout(timer);
				pending.withdrawal.release();
				this.#showAwaitedGuests();
			}
			resolve(result);
		};
		const onAbort = (): void => {
			const reason: unknown = signal?.reason;
			if (reason instanceof DialogSupersededError) this.#withdrawUi(pending, reason.abandon);
			else settle({ kind: "unavailable" });
		};
		const pending: PendingCollabUiRequest = {
			request: fullRequest,
			promise,
			settle,
			retainOnReconnect: options?.retainOnReconnect,
			shown: new Set(),
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, pending);
		this.#showUi(pending);
		return promise;
	}

	/** Withdraws an open request; see {@link requestGuestUi}. */
	#withdrawUi(pending: PendingCollabUiRequest, abandon: AbortSignal | undefined): void {
		if (abandon?.aborted) {
			pending.settle({ kind: "unavailable" });
			return;
		}
		// Only writers shown the request owe a reply: present ones, and departed ones whose earlier frames are still
		// being dispatched (an answer among them still counts).
		const replies = new Map<number, CollabPeer>();
		for (const peers of [this.#peers, this.#departing]) {
			for (const [peerId, peer] of peers) if (pending.shown.has(peer)) replies.set(peerId, peer);
		}
		const stopWaiting = (expired: (peer: CollabPeer) => boolean): void => {
			for (const [peerId, peer] of replies) if (expired(peer)) replies.delete(peerId);
			this.#settleWithdrawnIfDone(pending);
			this.#showAwaitedGuests();
		};
		const timers = [setTimeout(() => stopWaiting(() => true), WITHDRAWN_GUEST_REPLY_LIMIT_MS)];
		// A writer that predates `cancelReplies` sends no reply: read it for the window, then stop.
		if ([...replies.values()].some(peer => !peer.cancelReplies)) {
			timers.push(setTimeout(() => stopWaiting(peer => !peer.cancelReplies), WITHDRAWN_DIALOG_REPLY_MS));
		}
		const onAbandon = (): void => pending.settle({ kind: "unavailable" });
		abandon?.addEventListener("abort", onAbandon, { once: true });
		pending.withdrawal = { replies, timers, release: () => abandon?.removeEventListener("abort", onAbandon) };
		this.#sendWritablePeers({ t: "ui-request-end", reqId: pending.request.reqId, withdrawn: true });
		this.#settleWithdrawnIfDone(pending);
		this.#showAwaitedGuests();
	}

	/** A writer that was shown a withdrawn request will send nothing more for it. */
	#withdrawnReplyGone(pending: PendingCollabUiRequest, peerId: number): void {
		if (!pending.withdrawal?.replies.delete(peerId)) return;
		this.#settleWithdrawnIfDone(pending);
		this.#showAwaitedGuests();
	}

	/** Sends `pending`'s request to `toPeer`, or to every writer present, and records who was shown it. */
	#showUi(pending: PendingCollabUiRequest, toPeer?: number): void {
		for (const [peerId, peer] of this.#peers) {
			if (!peer.canWrite || (toPeer !== undefined && peerId !== toPeer)) continue;
			pending.shown.add(peer);
			this.#send({ t: "ui-request", request: pending.request }, peerId);
		}
	}

	/** The status segment names the guests a withdrawn request waits on ({@link awaitingGuests}). */
	#showAwaitedGuests(): void {
		if (!this.ending) this.#updateStatusSegment();
	}

	/**
	 * Settles a withdrawn request once no writer shown it can still reply. An answer held for a session
	 * transition may still settle it, so that wait re-checks when it ends ({@link #settleUiAfterTransition}).
	 */
	#settleWithdrawnIfDone(pending: PendingCollabUiRequest): void {
		if (pending.withdrawal?.replies.size === 0 && !pending.responsePending) pending.settle({ kind: "unavailable" });
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) this.#send(frame, peerId);
		}
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
		if (this.ending) throw new CollabHostStoppedError("collab host already stopped");
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const firstOpen = Promise.withResolvers<void>();
		// stop() may reject this before start() reaches its await (during key
		// import); mark the rejection handled so it can only surface at the await.
		firstOpen.promise.catch(() => {});
		this.#abortStart = firstOpen.reject;
		const key = await importRoomKey(rawKey);
		if (this.ending) throw new CollabHostStoppedError("collab host stopped before connecting");

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;

		let opened = false;
		socket.onOpen = () => {
			this.#relayConnected = true;
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onRoomRecreated = () => this.#handleRoomRecreated();
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			this.#relayConnected = false;
			if (this.#stopping || this.#stopped) return;
			if (!opened) {
				// A close the socket would retry (unreachable relay, dropped handshake)
				// means the relay is unavailable; a fatal one means it refused the room.
				firstOpen.reject(willReconnect ? new CollabRelayUnavailableError(reason) : new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
				this.#onEnded?.();
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new CollabRelayUnavailableError("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			// Nothing was sent on a connection that never opened: nothing to wait for.
			void socket.close();
			this.#socket = null;
			// A question retained while connecting has no room to reach anymore.
			for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
			this.#pendingUi.clear();
			throw err;
		} finally {
			clearTimeout(timeout);
			this.#abortStart = null;
		}

		this.#startedAt = Date.now();
		// Subscribe as soon as the relay is open. A guest can join as soon as the
		// link is visible (auto-start installs the room before this resolves).
		// Frames are mirrored only while #broadcastAllowed() holds (at least one
		// peer); a joining guest's welcome snapshot covers everything before that.
		// The local registry work below is independent of this.
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcastEvent(event);
			this.#onEventForState(event);
		});
		// Subagent frames publish on the session tree's observability bus at
		// any spawn depth; mirroring from it is what lets nested agents reach
		// guests at all. Embedders on the previous constructor signature only
		// wire a session bus — fall back to it so depth-1 frames keep flowing.
		const observabilityBus = this.#ctx.subagentEventBus ?? this.#ctx.eventBus;
		if (observabilityBus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					observabilityBus.on(channel, data => {
						if (this.#broadcastAllowed()) this.#send({ t: "bus", channel, data });
					}),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry) && this.#broadcastAllowed()) {
				const bounded = serializeReplicatedEntry(entry);
				const shrunk = bounded.value;
				if (shrunk.type === "custom_message" && shrunk.customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE) {
					// The live path also emits a guest-visible notice: guests only
					// apply `message` entries to their agent context, so without
					// this the substitution would be silently invisible there
					// (PR #11999 review). Notices never enter agent state.
					this.#send({ t: "event", event: oversizedEntryNotice(entry.type) });
				}
				this.#socket?.send(encodeEntryFrame(bounded.json));
			}
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();

		// Publish to the local host registry only after the relay connection
		// succeeded. Publication failure warns but never breaks hosting (#6099).
		// The in-flight task is tracked so a stop() that overtakes it withdraws
		// the result before resolving: a successor room reuses this endpoint.
		const publishing = publishCollabHost(this.#registrySource(), { instanceId: this.#instanceId }).then(
			publication => publication,
			err => {
				logger.warn("Collab host registry publication failed", { error: String(err) });
				this.#ctx.showStatus("Collab host discovery unavailable (omp collab list will not show this session)", {
					dim: true,
				});
				return null;
			},
		);
		this.#pendingPublication = publishing;
		const publication = await publishing;
		this.#pendingPublication = null;
		if (this.ending) {
			// stop() began, or the relay closed fatally, while publication was in
			// flight: withdraw it here too (close is idempotent) and refuse to
			// finish startup instead of installing a dead host that stays discoverable.
			if (publication) {
				await publication
					.close()
					.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
			}
			if (this.#stopping) throw new CollabHostStoppedError("collab host stopped during startup");
			throw new Error("relay connection closed during startup");
		}
		this.#registryPublication = publication;
	}

	/**
	 * Broadcast a goodbye, detach all taps, withdraw the registry entry, and
	 * close the socket. Resolves once the room is fully gone — including a
	 * teardown the room started on its own after a fatal relay close — so a
	 * successor can safely reuse this instance's registry endpoint.
	 */
	async stop(reason: string): Promise<void> {
		if (this.#teardownDone) return this.#teardownDone;
		if (this.#stopped) return;
		this.#stopDone ??= this.#runStop(reason);
		return this.#stopDone;
	}

	async #runStop(reason: string): Promise<void> {
		this.#stopping = true;
		// Leave the public slot at once: `/collab` must not re-print, and `/join`
		// must not see as hosting, a room that already refuses frames.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		this.#abortStart?.(new CollabHostStoppedError(`collab host stopped: ${reason}`));
		const socket = this.#socket;
		if (socket) {
			// Revocation drops queued application data; only the goodbye may drain.
			socket.discardPendingSends();
			// Sealing is asynchronous; without the flush the goodbye would still be
			// in the send chain when #teardown closes the socket and drops it.
			socket.send({ t: "bye", reason });
			await socket.flush();
		}
		await this.#teardown();
	}

	#teardown(): Promise<void> {
		this.#teardownDone ??= this.#runTeardown();
		return this.#teardownDone;
	}

	async #runTeardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		// A room that ended on its own (fatal relay close) reaches here without
		// `#runStop`: leave the public slot before the first await as well.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		const publication = this.#registryPublication;
		this.#registryPublication = null;
		if (publication) {
			// close() removes discovery metadata synchronously before awaiting the
			// server shutdown, so a stopped room disappears from lists immediately;
			// awaiting it lets a successor room reuse the same instance endpoint.
			await publication
				.close()
				.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		// The goodbye is in the socket's buffer; stop() resolves only once it has left the process, so an exit
		// right after it still tells guests the room ended (bounded by `CLOSE_DELIVERY_LIMIT_MS`).
		const closed = this.#socket?.close();
		this.#socket = null;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
		// A publication still being created when the room ended is withdrawn
		// before stop() resolves: a successor room reuses this instance
		// endpoint, and this room's late cleanup must never unlink the winner.
		const pending = this.#pendingPublication;
		this.#pendingPublication = null;
		const late = pending ? await pending : null;
		if (late) {
			await late.close().catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
		await closed;
	}

	/**
	 * The session this room mirrors is still the active one. Every path that
	 * reads or mutates session state on a guest's behalf (broadcasts, joins,
	 * prompts, registry queries) checks this first and refuses on a mismatch:
	 * the room mirrors nothing, welcomes nobody, and is absent from discovery
	 * while another session is active. It is suspended rather than ended
	 * because `switchSession()` adopts the target id before it commits and a
	 * failed switch restores the previous id without notifying anyone; only
	 * the committed change, delivered to the controller through the
	 * session-change callback, stops the room. A rolled-back switch simply
	 * finds the room current again.
	 */
	#sessionStillCurrent(): boolean {
		return this.#ctx.sessionManager.getSessionId() === this.#sessionId;
	}

	/** Live metadata and capability lookups served over the registry IPC. */
	#registrySource(): CollabHostRegistrySource {
		return {
			snapshot: () => this.#registrySnapshot(),
			link: access => (access === "view" ? this.#webViewLink : this.#webLink),
		};
	}

	/**
	 * Non-capability snapshot; URLs are only ever returned by `link`. A host
	 * that is ending, or whose session is not the active one, answers
	 * `snapshot_unavailable` to every registry op (the link op reads the
	 * snapshot first), so a listing omits it — without pruning — and no link
	 * is handed out for a room that already refuses joins.
	 */
	#registrySnapshot(): CollabHostSnapshot {
		if (!this.#guestTrafficAllowed()) throw new Error("collab room unavailable");
		if (this.#ctx.session.isSessionTransitioning) throw new Error("session transition in progress");
		const model = this.#ctx.session.model;
		return {
			instanceId: this.#instanceId,
			generation: this.#generation,
			pid: process.pid,
			sessionId: this.#sessionId,
			sessionName: this.#ctx.session.sessionName ?? null,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: model ? { provider: model.provider, id: model.id } : null,
			startedAt: this.#startedAt,
			participants: this.participants.length,
			relayConnected: this.#relayConnected,
			inputRequired: this.inputRequired,
			awaitingGuests: this.awaitingGuests.length,
			// Same source as the guest footer's `isStreaming`, read at query time:
			// true for the whole turn, including tool execution, and false once
			// the agent ends — so a poller sees the session stop while the room
			// is still published.
			busy: this.#ctx.session.isStreaming,
			access: this.#access,
		};
	}

	/** Shared liveness and session-identity gate for guest traffic and deferred actions. */
	#guestTrafficAllowed(): boolean {
		return !this.ending && this.#sessionStillCurrent();
	}

	/**
	 * Outbound path for frame objects; stop() deliberately bypasses it for the
	 * final goodbye. Pre-serialized broadcasts gate on {@link #broadcastAllowed},
	 * which applies the same liveness/session checks.
	 */
	#send(frame: CollabFrame, toPeer = 0): void {
		// Ending an existing dialog contains only its old-room request ID, never
		// current-session data. Do not strand guests if it settles during a
		// provisional /resume that later rolls back. All other traffic stays gated.
		if (this.ending || (!this.#sessionStillCurrent() && frame.t !== "ui-request-end")) return;
		this.#socket?.send(frame, toPeer);
	}

	/**
	 * Whether a mirrored broadcast has anyone to reach. Checked before any
	 * bound/serialize/seal work: an auto-started room usually has no guest, and
	 * the relay would discard the frame anyway. Nothing is lost by skipping it —
	 * guests ignore traffic until their welcome, which carries fresh state,
	 * agents, and the full snapshot.
	 */
	#broadcastAllowed(): boolean {
		return this.#peers.size > 0 && this.#guestTrafficAllowed();
	}

	/** Broadcast one session event, bounded and serialized exactly once. */
	#broadcastEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start") this.#messageSeq++;
		if (!this.#broadcastAllowed()) return;
		const frame = encodeEventFrame(serializeReplicatedEvent(event).json);
		// Each update carries the whole message so far, so a newer one supersedes
		// any still queued for the same message (#16956). Keyed per message so the
		// last update of one message is never superseded by the next one's.
		if (event.type === "message_update") this.#socket?.sendLatest(`message_update:${this.#messageSeq}`, frame);
		else this.#socket?.send(frame);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Controls are dispatched synchronously while frames finish decrypting, so
		// a hello can land after its sender's `peer-left`. The socket settled the
		// peer's lifetime at reception; re-read it here rather than acting on a
		// sender that is already gone and registering a ghost participant.
		if (!this.#socket?.isServing(fromPeer)) {
			// A writer that left may still be owed an answer it sent before leaving (`#departing`).
			if (frame.t === "ui-response" && this.#departing.has(fromPeer)) {
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				return;
			}
			logger.debug("collab host ignoring frame from a peer it no longer serves", { type: frame.t, fromPeer });
			return;
		}
		// An old-room answer may wait for rollback, but cannot settle against
		// another session. The response handler owns that bounded deferral.
		if (frame.t === "ui-response") {
			this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
			return;
		}
		// Inbound frames act on the mirrored session (join snapshots, prompts,
		// aborts, agent control); none may reach a session this room never
		// shared, or one whose room is already ending.
		if (!this.#guestTrafficAllowed()) return;
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, frame.cancelReplies === true, fromPeer);
				break;
			case "prompt":
				if (this.#rejectWhileStarting("prompting", fromPeer)) break;
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				if (this.#rejectWhileStarting("interrupting", fromPeer)) break;
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				if (this.#rejectWhileStarting("agent control", fromPeer)) break;
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	/**
	 * Guests must not drive the session while it is still starting up (an
	 * auto-started room is live before the session's startup hooks finish):
	 * refuse with a targeted error instead of running an agent turn beside them.
	 */
	#rejectWhileStarting(action: string, fromPeer: number): boolean {
		if (this.#guestActionsReady()) return false;
		const ready = this.#ctx.session.isSessionTransitioning
			? "the session transition completes"
			: "the host finishes starting up";
		this.#send({ t: "error", message: `${action} is unavailable until ${ready}` }, fromPeer);
		return true;
	}

	#handleHello(
		name: string,
		proto: number,
		writeToken: string | undefined,
		cancelReplies: boolean,
		fromPeer: number,
	): void {
		if (this.#ctx.session.isSessionTransitioning) {
			this.#send({ t: "error", message: "Session transition in progress; join again when it completes" }, fromPeer);
			return;
		}
		if (proto !== COLLAB_PROTO) {
			this.#send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const firstPeer = this.#peers.size === 0;
		this.#peers.set(fromPeer, { name: cleanName, canWrite, cancelReplies });

		const socket = this.#socket;
		if (!socket) return;
		// Serialize the snapshot synchronously: live traffic queued after this
		// cannot overtake it, and host rewrites of an entry in place cannot leak
		// into it later, so the live entries are read without a defensive deep
		// copy. Chunk frames are assembled from these strings only as the
		// transport drains.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		const snapshotEntries = this.#serializeSnapshotEntries(snapshot.entries.filter(isWireSessionEntry));
		const state = this.#buildState();
		// State broadcasts pause while no guest is joined, so the dedupe baseline
		// may predate this welcome; with no other peer to keep current, the welcome
		// becomes the baseline.
		if (firstPeer) this.#lastStateJson = JSON.stringify(state);
		this.#send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state,
				agents: this.#snapshotAgents(),
				entryCount: snapshotEntries.json.length,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		socket.sendBatch(this.#snapshotChunks(snapshotEntries.json, snapshotEntries.bytes), fromPeer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				// A withdrawn request is not offered again: the writers it waits for were shown it before.
				if (pending.responsePending || pending.withdrawal) continue;
				this.#showUi(pending, fromPeer);
			}
		}
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Serialize every snapshot entry exactly once, bounded under
	 * {@link MAX_REPLICATED_PAYLOAD_BYTES}. Only an entry that throws or exceeds
	 * the ceiling pays for {@link serializeReplicatedEntry}'s shrink passes, so a
	 * single oversized tool-result entry cannot ship as an oversized chunk that
	 * trips the relay's per-frame `maxPayloadLength` (issue #3739), and an entry
	 * that cannot be shrunk at all ships as a bounded placeholder instead of
	 * stranding the guest without a terminator (issue #11433).
	 *
	 * When the snapshot exceeds {@link WELCOME_IMAGE_STRIP_THRESHOLD} — or holds
	 * an entry that does not serialize as-is (a non-JSON leaf such as `BigInt`,
	 * a throwing `toJSON`, nesting past the engine limit) — images are stripped
	 * from private copies of the message entries first, so the chunker falls
	 * back to clipping or placeholders only for what is still too large.
	 */
	#serializeSnapshotEntries(entries: ReplicatedEntry[]): { json: string[]; bytes: number[] } {
		const raw: (string | null)[] = [];
		const bytes: number[] = [];
		let total = 0;
		let unserializable = false;
		for (const entry of entries) {
			let json: string | null = null;
			let entryBytes = 0;
			try {
				// `byteLength` throws on the `undefined` a top-level `toJSON` may yield.
				const text = JSON.stringify(entry);
				entryBytes = Buffer.byteLength(text, "utf8");
				json = text;
			} catch {
				unserializable = true;
			}
			raw.push(json);
			bytes.push(entryBytes);
			total += entryBytes;
		}
		const stripImages = unserializable || total > WELCOME_IMAGE_STRIP_THRESHOLD;
		let stripped = 0;
		const json: string[] = [];
		for (const [i, entry] of entries.entries()) {
			let text = raw[i] ?? null;
			let source = entry;
			// `"image` covers every image carrier the stripper handles: `image`
			// content blocks, `images` arrays, and file-mention `image` fields.
			if (stripImages && entry.type === "message" && (text === null || text.includes('"image'))) {
				// The JSON round-trip is exactly what a guest would receive; an entry
				// that does not serialize goes through the depth-bounded walk instead.
				const copy: ReplicatedEntry = text === null ? copyForReplication(entry) : JSON.parse(text);
				const removed = copy.type === "message" ? stripImagesFromMessage(copy.message) : 0;
				if (removed > 0) {
					stripped += removed;
					source = copy;
					text = null;
				}
			}
			if (text === null || (bytes[i] ?? 0) > MAX_REPLICATED_PAYLOAD_BYTES) {
				// Never throws, and always returns a bounded payload: a throw here
				// would end the train without its `final: true` terminator, and the
				// guest would time out its join while the host lists it as joined.
				text = serializeReplicatedEntry(source).json;
				bytes[i] = Buffer.byteLength(text, "utf8");
			}
			json.push(text);
		}
		if (stripImages) logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		return { json, bytes };
	}

	/**
	 * Slice pre-serialized entries into byte-bounded `snapshot-chunk` frames.
	 * Every batch carries at least one entry, and the last batch is tagged
	 * `final: true` so the guest can finalize the replica. An empty snapshot
	 * still emits one `final` chunk so the guest never blocks on a missing
	 * terminator. Each batch's strings are released once its frame is built.
	 */
	*#snapshotChunks(entries: string[], bytes: number[]): Generator<EncodedFrame> {
		if (entries.length === 0) {
			yield encodeSnapshotChunk([], true);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const start = i;
			let batchBytes = 0;
			while (i < entries.length) {
				const entryBytes = bytes[i] ?? 0;
				if (i > start && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batchBytes += entryBytes;
				i++;
			}
			const batch = entries.slice(start, i);
			entries.fill("", start, i);
			yield encodeSnapshotChunk(batch, i >= entries.length);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const suspended = !this.#guestTrafficAllowed();
		if (suspended && (this.ending || !this.#ctx.session.isSessionTransitioning)) return;
		// A writer that left is still heard for the answers it sent before leaving (`#departing`): the relay
		// forwarded them while it was present, and only their decryption finished after its departure.
		const departed = !this.#peers.has(fromPeer) && this.#departing.has(fromPeer);
		if (!departed && !this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		const pending = this.#pendingUi.get(reqId);
		if (pending?.withdrawal) {
			// A withdrawn request hears only the writers it still waits for: not one that replied or ran out of
			// time, not one that joined after the withdrawal. Acknowledged like a settled request.
			if (!pending.withdrawal.replies.has(fromPeer)) {
				this.#send({ t: "ui-request-end", reqId }, fromPeer);
				return;
			}
			// No value: this writer has no answer for it. Counted even while an answer waits for a session
			// transition, which may yet fail to apply.
			if (value === undefined) {
				this.#withdrawnReplyGone(pending, fromPeer);
				return;
			}
		}
		if (pending) {
			if (pending.responsePending) return;
			if (suspended) {
				void this.#settleUiAfterTransition(pending, value, fromPeer);
				return;
			}
			pending.settle({ kind: "answered", value });
			return;
		}
		// The request already settled (or never existed for this peer). A writer that
		// reconnected after the broadcast `ui-request-end` resends its answer and would
		// otherwise wait forever, so acknowledge it directly; one that left needs nothing.
		if (!departed) this.#send({ t: "ui-request-end", reqId }, fromPeer);
	}

	async #settleUiAfterTransition(
		pending: PendingCollabUiRequest,
		value: CollabUiResponseValue,
		fromPeer: number,
	): Promise<void> {
		// At most one answer per existing request; stop/local cancellation wakes
		// the wait even if a session hook never finishes.
		pending.responsePending = true;
		const { reqId } = pending.request;
		const peer = this.#peers.get(fromPeer);
		try {
			do {
				await Promise.race([this.#ctx.session.waitForSessionTransition(), pending.promise]);
			} while (
				this.#pendingUi.get(reqId) === pending &&
				!this.ending &&
				!this.#sessionStillCurrent() &&
				this.#ctx.session.isSessionTransitioning
			);
			if (this.#pendingUi.get(reqId) !== pending || !this.#guestTrafficAllowed()) return;
			// A withdrawn request keeps an answer it received from a writer it waited for, even one that has left
			// since: nothing else will answer it. Any other request takes it only from a writer still present.
			if (pending.withdrawal || (peer?.canWrite && this.#peers.get(fromPeer) === peer)) {
				pending.settle({ kind: "answered", value });
			} else {
				this.#showUi(pending);
			}
		} catch (error) {
			logger.warn("Collab UI response could not await session transition", { error: String(error) });
			pending.settle({ kind: "unavailable" });
		} finally {
			pending.responsePending = false;
			// Replies to the withdrawal that arrived while this answer waited may leave nothing to wait for.
			if (this.#pendingUi.get(reqId) === pending) this.#settleWithdrawnIfDone(pending);
		}
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const name = peer.name;
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText: text },
			)
			.then(dispatched => {
				if (dispatched === false) return this.#notifyPromptDropped(fromPeer);
			})
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	async #notifyPromptDropped(fromPeer: number): Promise<void> {
		while (!this.ending && this.#ctx.session.isSessionTransitioning) {
			await this.#ctx.session.waitForSessionTransition();
		}
		if (this.ending) return;
		if (!this.#sessionStillCurrent()) {
			await this.stop(
				"session changed before a guest prompt was submitted. Rejoin and resend any prompt not shown in the conversation",
			);
			return;
		}
		this.#send(
			{ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." },
			fromPeer,
		);
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => {
				if (!this.#guestTrafficAllowed()) return;
				this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab");
			})
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	/**
	 * The relay recreated the room and will reissue peer ids from 1, so every id in
	 * {@link #peers} is meaningless — and `#peers` is the permission registry, not
	 * just the roster. Leaving it populated lets whoever takes a reissued id inherit
	 * the `canWrite` of the guest that held it, which a read-only link is enough to
	 * exploit: `#handleFrame` admits a frame before its sender has said hello, so a
	 * `prompt`, `abort`, `agent-cmd` or `ui-response` would be authorized against
	 * the stale entry. Runs before the socket reports the open, so no frame from the
	 * new room can be dispatched against the old identities.
	 */
	#handleRoomRecreated(): void {
		if (this.#stopped) return;
		this.#departing.clear();
		if (this.#peers.size === 0 && this.#pendingUi.size === 0) return;
		// Identities first: settle() fans `ui-request-end` out over #peers, and those
		// ids belong to the room that just went away.
		this.#peers.clear();
		// A mirrored local dialog remains open through a transport reconnect. Keep
		// its request for replay after a new hello verifies the writer again. Bare
		// guest-only callers still settle rather than wait without a recipient, and
		// so does a withdrawn request, since the writers it waited for were in the old
		// room, unless it holds an answer for a session transition: it settles with
		// that answer when the transition ends.
		// Explicit stop and session replacement continue to settle every request.
		for (const pending of this.#pendingUi.values()) {
			if (pending.withdrawal) {
				pending.withdrawal.replies.clear();
				this.#settleWithdrawnIfDone(pending);
			} else if (!pending.retainOnReconnect) {
				pending.settle({ kind: "unavailable" });
			}
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Identity and UI: the socket already retired the peer and dropped its backlog. Frames a writer sent before it
	 * left may still be decrypting, and an answer among them still counts: withdrawn requests stop waiting for
	 * the writer, and its answers stop counting, once the socket has dispatched those frames ({@link #departing}).
	 */
	#handlePeerLeft(peer: number): void {
		const record = this.#peers.get(peer);
		this.#peers.delete(peer);
		if (record?.canWrite) {
			this.#departing.set(peer, record);
			const retire = (): void => {
				// A room recreation since then cleared the record, and the id may name someone else now.
				if (this.#departing.get(peer) !== record) return;
				this.#departing.delete(peer);
				for (const pending of this.#pendingUi.values()) this.#withdrawnReplyGone(pending, peer);
			};
			const socket = this.#socket;
			if (socket) void socket.dispatched().then(retire);
			else retire();
		}
		// Relay controls arrive outside the normal frame handler.
		if (!this.#guestTrafficAllowed()) return;
		if (record) this.#ctx.session.emitNotice("info", `${record.name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries agents.
		if (this.ending || this.#agentsDebounce || this.#peers.size === 0) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#send({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => {
						if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
						return session.prompt(trimmed, { streamingBehavior: "steer" });
					})
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref || !this.#guestTrafficAllowed()) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const ref = AgentRegistry.global().get(agentId);
		if (!ref?.sessionFile || ref.kind === "advisor") {
			reply("", fromByte, "no transcript available");
			return;
		}
		const file = ref.sessionFile;
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries state.
		if (this.ending || this.#stateDebounce || this.#peers.size === 0) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#send({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({
			role: "host",
			participantCount: this.#peers.size + 1,
			waitingOn: this.awaitingGuests,
		});
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
