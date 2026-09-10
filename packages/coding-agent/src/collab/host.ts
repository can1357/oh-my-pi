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

import { timingSafeEqual } from "node:crypto";
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
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";
import { shrinkForReplication } from "./replication-shrink";

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
 * ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
/**
 * Longest guest-supplied label this host will put into a frame it sends.
 *
 * Not a limit on what an id or a name may be — an agent lookup takes the id whole,
 * so a longer real one still addresses its agent — only on how much of it a guest
 * can make the host emit. Unbounded, a reply that quotes one is as large as the
 * guest chose: 100,000 characters measured 200,031 bytes for an unknown-agent
 * kill, and the queue admits one oversized entry on an empty queue, so a large
 * enough label builds a frame past the relay's payload limit and closes the host
 * socket — a guest-triggered disconnect out of an error path whose whole purpose
 * is to be polite about a mistake.
 *
 * The number is the cap {@link CollabHost.#handleHello} already applied to a peer
 * name, the other guest-supplied label that reaches a frame; it is shared rather
 * than repeated so the two cannot drift. Both sites truncate to it rather than
 * refusing past it: a label over the cap is still the one its sender chose, and a
 * bound that replaced it with something else would make the reply that quotes it
 * wrong about which agent or which guest it means.
 */
const GUEST_LABEL_MAX = 64;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	/**
	 * Guest identity and permission, keyed by relay peer id. Drives the
	 * participant list, notices, the status segment and the writable-peer fan-out.
	 * Deliverability is not its job: {@link CollabSocket.isServing} owns that, and
	 * the two disagree on purpose while a peer is connected but has not said hello
	 * yet, and after a shed, when the peer leaves the participant list but is
	 * still owed a resync error.
	 */
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	/**
	 * Never reset, including across a room recreation: ids must not be reissued, or
	 * a late `ui-response` carrying an old id would settle an unrelated new request.
	 * An old id that maps to nothing is harmless.
	 */
	#uiReqSeq = 0;
	/**
	 * Outstanding asks. `recipients` is the set of peers that were handed the
	 * dialog and can still answer it — the queue admitting a `ui-request` is what
	 * puts a peer in, and losing write permission, being shed or leaving is what
	 * takes it out. Emptying it settles the ask, because the caller awaits this
	 * with no timeout of its own.
	 */
	#pendingUi = new Map<
		number,
		{ request: CollabUiRequest; recipients: Set<number>; settle(result: CollabGuestUiResult): void }
	>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#stopped = false;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
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

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#socket || !this.#hasWritablePeers()) return null;
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
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		const recipients = new Set<number>();
		this.#pendingUi.set(reqId, { request: fullRequest, recipients, settle });
		// A registration only means something if somebody was asked, and it stops
		// meaning anything once nobody who was asked can answer. The queue can
		// refuse a targeted frame under pressure, and the caller awaits this with no
		// timeout of its own, so an ask nobody received settles here instead of
		// waiting for a reply that cannot come. A partial delivery still stands: one
		// guest holding the dialog is enough to answer it, which is why the
		// recipients are tracked rather than counted.
		for (const peerId of this.#sendWritablePeers({ t: "ui-request", request: fullRequest })) {
			recipients.add(peerId);
		}
		if (recipients.size === 0) settle({ kind: "unavailable" });
		return promise;
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	/** @returns the writable peers the frame was admitted for. */
	#sendWritablePeers(frame: CollabFrame): number[] {
		const socket = this.#socket;
		if (!socket) return [];
		const admitted: number[] = [];
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite && socket.send(frame, peerId)) admitted.push(peerId);
		}
		return admitted;
	}

	/**
	 * Drop {@link peer} from every outstanding ask, settling the ones it was the
	 * last recipient of. Called wherever a peer stops being able to answer:
	 * departure, a shed, or a `hello` that gives up write permission. Without it
	 * an ask the queue admitted counts as delivered for ever, and its caller waits
	 * for a reply from somebody the host has already written off.
	 */
	#dropAskRecipient(peer: number): void {
		for (const pending of this.#pendingUi.values()) {
			if (!pending.recipients.delete(peer)) continue;
			if (pending.recipients.size === 0) pending.settle({ kind: "unavailable" });
		}
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
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
		const key = await importRoomKey(rawKey);

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
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
		socket.onPeerOverload = peer => this.#handlePeerOverload(peer);
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) {
				// Notices are advisory: the roster guests render comes from `state`
				// frames, so losing one costs a transcript line and nothing else. That
				// matters because a guest causes one per `hello` without it being
				// addressed to them, and unshedable peer-caused broadcasts would
				// otherwise reach the terminal overload path.
				this.#broadcast({ t: "event", event: shrinkForReplication(event) }, event.type === "notice");
			}
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
					observabilityBus.on(channel, data => this.#broadcast({ t: "bus", channel, data })),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();
	}

	/** Broadcast a goodbye, detach all taps, and close the socket. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
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
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.collabHost = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
	}

	/** @returns false when a saturated queue discarded an advisory frame. */
	#broadcast(frame: CollabFrame, advisory = false): boolean {
		if (this.#stopped || !this.#socket) return false;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return false;
		}
		if (advisory) return this.#socket.broadcastAdvisory(frame);
		this.#socket.send(frame);
		return true;
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Controls are dispatched synchronously while frames finish decrypting, so
		// a hello can land after its sender's `peer-left`. The socket settled the
		// peer's lifetime at reception; re-read it here rather than acting on a
		// sender that is already gone and registering a ghost participant.
		if (!this.#socket?.isServing(fromPeer)) {
			logger.debug("collab host ignoring frame from a peer it no longer serves", { type: frame.t, fromPeer });
			return;
		}
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/**
	 * Timing-safe write-token check; peers without a valid token are read-only.
	 *
	 * Takes `unknown` because the protocol's field types are what a guest claims,
	 * not what it sent: the frame is `JSON.parse`d and cast. `Buffer.from` throws
	 * `ERR_INVALID_ARG_TYPE` on anything that is not a string, and the throw would
	 * unwind into `CollabSocket`'s frame-handler catch — losing the whole `hello`
	 * with nothing but a debug line, which a guest cannot tell apart from a welcome
	 * the queue refused. A token that is not a string is a token that does not
	 * match, so it answers the same `false` a wrong one does and the guest joins
	 * read-only.
	 */
	#verifyWriteToken(token: unknown): boolean {
		const expected = this.#writeToken;
		if (!expected || typeof token !== "string" || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	/**
	 * Every field here is `unknown` for the reason given on {@link #verifyWriteToken}:
	 * the declared protocol types describe what a well-behaved guest sends, and this
	 * is the boundary where that stops being a guarantee. `proto` needs no narrowing
	 * — a non-number is never equal to {@link COLLAB_PROTO}, so it takes the mismatch
	 * path and is reported through `String`, which is total for anything JSON can
	 * carry. `name` does: `.trim()` throws on a non-string, including `null`.
	 */
	#handleHello(name: unknown, proto: unknown, writeToken: unknown, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{
					t: "error",
					message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${String(proto)}`,
				},
				fromPeer,
			);
			return;
		}
		// A name that is not a string is a name this host cannot use, which is what
		// a blank one already means: the guest gets the generated one either way.
		const cleanName = (typeof name === "string" ? name.trim().slice(0, GUEST_LABEL_MAX) : "") || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		// Registered before the snapshot is built, because `#buildState` reads the
		// roster and the welcome has to show the joiner itself. Held against the
		// batch's admission below, so a hello whose welcome the queue refused leaves
		// the host's view of the room exactly as it found it.
		const registered = this.#peers.get(fromPeer);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		// Enqueue the welcome and its snapshot synchronously so live traffic cannot
		// overtake them; materialize the chunks only as the transport drains.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		let serialized = JSON.stringify(snapshot);
		// Two units, deliberately. The strip threshold compares UTF-16 code units,
		// the unit it was tuned in: measured against bytes it would fire at a third
		// of the size on a session written in CJK and take that guest's images out
		// of replicated history three times sooner, which is a lossy degradation and
		// not something a unit tidy-up gets to decide.
		if (serialized.length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			// Re-serialize: stripping is what decides how much of this snapshot the
			// queue will hold, and an image-heavy session shrinks by an order of
			// magnitude. Charging the arrival size instead refuses joins the budget
			// has room for and sheds guests to make room for memory nobody holds.
			if (stripped > 0) serialized = JSON.stringify(snapshot);
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		// The charge is in bytes, the unit every other charge and the budget itself
		// are in. Free next to the serialization it reads, and it costs nothing to
		// hold the string this far: the batch below retains the whole clone anyway.
		const snapshotBytes = Buffer.byteLength(serialized);
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const socket = this.#socket;
		if (!socket) return;
		const welcome: CollabFrame = {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state: this.#buildState(),
			agents: this.#snapshotAgents(),
			entryCount: entries.length,
			readOnly: canWrite ? undefined : true,
		};
		// snapshotForReplication clones, and the batch holds that clone until it
		// drains, so the queue is told what it is keeping alive: the serialized byte
		// length of what stripping left, before an entry filter that only shrinks it
		// further.
		if (!socket.sendBatch(this.#welcomeWithSnapshot(welcome, entries), fromPeer, snapshotBytes)) {
			// No welcome reached the guest, and a guest applies nothing before one. So
			// there is no participant to announce, nothing to add to the roster, and
			// above all nobody to hand a pending ask to: an ask recorded against a peer
			// that cannot answer it is the hang this policy already closed once, and a
			// registered ghost reaches it by a different route. Undoing the
			// registration is the whole remedy — never a promotion, since it only ever
			// restores what this id already had, and a relay does not reissue an id
			// inside a room.
			if (registered) this.#peers.set(fromPeer, registered);
			else this.#peers.delete(fromPeer);
			logger.debug("collab: welcome batch was not admitted; leaving the peer unregistered", { fromPeer });
			return;
		}
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				if (socket.send({ t: "ui-request", request: pending.request }, fromPeer)) {
					pending.recipients.add(fromPeer);
				}
			}
		} else {
			// A repeated hello without the write token demotes the peer, and a
			// read-only peer's answer is rejected, so it is no longer a recipient of
			// anything it was handed while it could still write.
			this.#dropAskRecipient(fromPeer);
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
	 * The welcome and the chunks built from the same {@link entries} are one unit:
	 * the welcome primes the guest's accumulator with `entryCount` and the train
	 * terminates it, so a guest given one without the other finalizes a replica it
	 * believes is complete. Yielding both from one generator makes them a single
	 * queue entry, so admission, supersede and cancellation are one decision and a
	 * partial admission cannot be expressed. It is also what lets a snapshot past
	 * the whole send budget ship at all: the budget admits an entry with nothing
	 * ahead of it, and a welcome queued on the line before would be that
	 * something.
	 */
	*#welcomeWithSnapshot(
		welcome: CollabFrame,
		entries: (StoredSessionEntry & WireSessionEntry)[],
	): Generator<CollabFrame> {
		yield welcome;
		yield* this.#snapshotChunks(entries);
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames.
	 * Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	*#snapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[]): Generator<CollabFrame> {
		if (entries.length === 0) {
			yield { t: "snapshot-chunk", entries: [], final: true };
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (StoredSessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = JSON.stringify(shrunk).length;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			yield { t: "snapshot-chunk", entries: batch, final: i >= entries.length };
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	/**
	 * `images` is `unknown` for the reason given on {@link #verifyWriteToken}: the
	 * declared type is the sender's claim, and this one was spread, which a truthy
	 * non-iterable throws out of.
	 *
	 * `text` is checked rather than merely typed, because the two branches below
	 * failed differently and one of them failed late. Without images a non-string
	 * becomes the content whole, and `promptCustomMessage` rejects it in its first
	 * statement, before any session insertion, so the catch below replies. With
	 * images it goes into a `TextContent` instead, where nothing rejects it: `join`
	 * stringifies a copy and the original is persisted as sent, so the entry is
	 * invalid session state and a later turn throws on `item.text.toWellFormed()`
	 * inside a provider serializer — a different subsystem, minutes away, with
	 * nothing left to tell the guest. Refused here so neither branch can.
	 */
	#handlePrompt(text: unknown, images: unknown, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		if (typeof text !== "string") {
			this.#socket?.send({ t: "error", message: "prompt failed: message text must be a string" }, fromPeer);
			return;
		}
		const name = peer.name;
		// `Array.isArray`, not a length test: `{ length: 1 }` passes a length test and
		// then throws out of the spread, and that throw unwinds into `CollabSocket`'s
		// frame-handler catch — losing the whole prompt for a debug line. Anything
		// that is not an array carries no images, which is the path a prompt without
		// any already takes, so the text still gets through.
		const content: string | (TextContent | ImageContent)[] =
			Array.isArray(images) && images.length > 0 ? [{ type: "text", text }, ...(images as ImageContent[])] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		// A turn can outlast the guest by minutes, which is too long to hold a
		// retirement record for, so this reply is best-effort. Captured up front all
		// the same: `isServing` read at the reply site knows nothing about room
		// boundaries, and a reconnect reissues this id to somebody else, whose own
		// share of the queue a burst of stale errors is enough to spend.
		const stillTheAsker = this.#socket?.bestEffortAddressee(fromPeer);
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
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				if (stillTheAsker?.()) {
					this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
				}
			});
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
			.then(() => this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab"))
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
		if (this.#peers.size === 0 && this.#pendingUi.size === 0) return;
		// Identities first: settle() fans `ui-request-end` out over #peers, and those
		// ids belong to the room that just went away.
		this.#peers.clear();
		// The relay closed everyone who could answer, so an outstanding ask has no
		// recipient. Leaving it pending hangs callers that await it without racing a
		// local dialog, and #handleHello re-poses every pending request to the next
		// writable guest — a different occupant of a different room. Matches the
		// teardown path; settle() is guarded against a second resolve, so a teardown
		// after this is a no-op.
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/** Identity and UI only: the socket already retired the peer and dropped its backlog. */
	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		this.#dropAskRecipient(peer);
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/** The socket discarded this peer's backlog to keep the room alive; drop it and tell it to rejoin. */
	#handlePeerOverload(peer: number): void {
		if (this.#stopped) return;
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		// Before the resync error, so the `ui-request-end` frames a settle fans out
		// are not addressed to the peer that just lost its backlog.
		this.#dropAskRecipient(peer);
		this.#socket?.send({ t: "error", message: "the host discarded your backlog; rejoin to resync" }, peer);
		if (name) {
			this.#ctx.session.emitNotice(
				"warning",
				`${name} fell too far behind and was dropped; they can rejoin`,
				"collab",
			);
		}
		this.#updateStatusSegment();
		// Deliberately no state broadcast. Removing the peer changes `participants`,
		// so the frame would defeat the JSON dedupe, and admitting it into a queue
		// that is still full sheds the next peer, whose report schedules another
		// changed state — walking the whole roster one participant per debounce
		// interval. `state` is level-triggered, so the next real change re-sends the
		// current roster; the local status segment above is already up to date.
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
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			// Level-triggered like `state`, and re-sent on the next registry change.
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() }, true);
		}, AGENTS_DEBOUNCE_MS);
	}

	/**
	 * All three fields are `unknown` for the reason given on {@link #verifyWriteToken}.
	 * Two hazards live here, and they pull in opposite directions: a value that
	 * matches nothing and is answered by nothing, which a guest cannot tell apart
	 * from a frame the queue refused; and a value quoted back into the answer, which
	 * is how an error path polite enough to reply became one a guest can size.
	 */
	#handleAgentCmd(cmd: unknown, agentId: unknown, text: unknown, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Two different uses, so two different values. The lookup takes the id whole,
		// because truncating it would let a long id address the agent that owns its
		// prefix. The quoting is bounded by {@link GUEST_LABEL_MAX}, because every
		// reply below embeds it and a guest chooses its length; and it is only ever a
		// string, because interpolating a nested array throws `RangeError` out of the
		// reply — measured reachable, since a 5,000-deep one survives `JSON.stringify`
		// and `JSON.parse` on the way here while 60,000 does not.
		//
		// Bounded two ways, because the reasons differ and only one of them is
		// anonymity. An id that is absent or not a string names nothing, and saying so
		// is accurate. A long one names something — the lookup just used it — so it is
		// truncated rather than disowned: nothing above the cap enforces that ids stay
		// short, and a long id is likelier to be one a guest actually typed, which is
		// exactly when a reply has to say which agent failed.
		const id = typeof agentId === "string" ? agentId : "";
		const quoted =
			id.length === 0 ? "(unnamed agent)" : id.length <= GUEST_LABEL_MAX ? id : `${id.slice(0, GUEST_LABEL_MAX)}…`;
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(id)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${quoted}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		// Best-effort and room-scoped for the same reason as a failed prompt: agent
		// work has no bound, and past a reconnect this id is somebody else's.
		const stillTheAsker = this.#socket?.bestEffortAddressee(fromPeer);
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId: quoted, error: String(err) });
			if (!stillTheAsker?.()) return;
			this.#socket?.send({ t: "error", message: `agent ${quoted}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				// `.trim()` throws on a number, and the throw would be swallowed, so a
				// malformed message would vanish rather than be answered. A message that
				// is not a string is not a message, which is what an empty one already
				// means: the guest gets the same reply either way.
				const trimmed = typeof text === "string" ? text.trim() : "";
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${quoted}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(id)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(id);
					// Throw, not return: `fail` runs off the rejection below, so returning
					// left an unknown id with no reply at all — alone among the three,
					// since `chat` and `revive` both get one out of `ensureLive`.
					if (!ref) throw new Error(`unknown agent "${quoted}"`);
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(id, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(id).catch(fail);
				break;
			default:
				// Without this a `cmd` matching no case fell out of the switch and
				// returned: nothing run, nothing said. Answered like a command this host
				// knows but cannot carry out. The value is not echoed back — the guest
				// sent it, and it is unvalidated enough that repeating it is the sender
				// choosing what the host emits.
				this.#socket?.send({ t: "error", message: `agent ${quoted}: unknown agent command` }, fromPeer);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		// The read is asynchronous, so the peer can leave — or the whole room can be
		// recreated — before there is anything to reply with.
		const stillTheAsker = this.#socket?.addressee(fromPeer);
		const reply = (text: string, newSize: number, error?: string) => {
			if (!stillTheAsker?.()) return;
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		};
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
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
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			// `state` is a level-triggered snapshot: a guest can cause an endless
			// stream of distinct ones (a repeated hello under a new name defeats the
			// dedupe), and as replica-bearing broadcasts they would reach the terminal
			// path and end the room. Advisory instead — and only recorded as sent when
			// it was admitted, or the dedupe would pin a value the guests never saw.
			if (this.#broadcast({ t: "state", state }, true)) this.#lastStateJson = json;
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
