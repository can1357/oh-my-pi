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
import type { ImageContent, ProviderFileReference, TextContent } from "@oh-my-pi/pi-ai";
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
	describeThrown,
	encodeEntryFrame,
	encodeEventFrame,
	encodeFrame,
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
 * Longest guest-supplied label (agent id, peer name) the host quotes into a frame.
 * Bounds the quote, never the lookup. Unbounded, a quoting reply can exceed the
 * relay's payload limit and close the host socket.
 */
const GUEST_LABEL_MAX = 64;
/**
 * Ceiling, in UTF-16 code units, on an `error` frame's text, applied where the
 * frame is sent: prose composed elsewhere (`AgentLifecycleManager#ensureLive`)
 * embeds the untruncated guest id. This host's own longest message plus a full
 * {@link GUEST_LABEL_MAX} label is 154 units, so the cut never lands on its wording.
 */
const ERROR_MESSAGE_MAX = 512;
const RESYNC_MESSAGE = "the host discarded your backlog; rejoin to resync";

/**
 * Schemes a replicated image URL may use. `http:` is intentional: the blob broker
 * emits `http://127.0.0.1:<port>` URLs (`blob-broker/exposure.ts`).
 */
const IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const IMAGE_DETAIL_VALUES = new Set(["auto", "low", "high", "original"]);
/**
 * Image media types every provider converter and the blob broker recognise; SVG is
 * excluded because it carries script. An allowlist, not a grammar check, because
 * well-formed values do the damage: this string becomes a broker `content-type`, a
 * plain-object key (`__proto__`), and part of a `data:` URL, where a `,` ends it.
 */
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);
const PROVIDER_FILE_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/**
 * Image content off the wire, rebuilt from the fields {@link ImageContent} declares,
 * or `null`. Rebuilt rather than checked so a deeply nested unknown property cannot
 * reach the recursive serializers downstream. Assumes plain `JSON.parse` output.
 */
function toImageContent(value: unknown): ImageContent | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== "image") return null;
	const { data, mimeType, detail, url, providerFile } = candidate;
	// `data` is only type-checked: every sink JSON-escapes it or appends it after
	// `;base64,`, and a scan would run over megabytes per prompt.
	if (typeof data !== "string" || typeof mimeType !== "string") return null;
	if (!IMAGE_MIME_TYPES.has(mimeType)) return null;
	if (detail !== undefined && !IMAGE_DETAIL_VALUES.has(detail as string)) return null;
	if (url !== undefined && !isReplicableImageUrl(url)) return null;
	const image: ImageContent = { type: "image", data, mimeType };
	if (detail !== undefined) image.detail = detail as ImageContent["detail"];
	if (url !== undefined) image.url = url;
	if (providerFile !== undefined) {
		const reference = toProviderFileReference(providerFile);
		if (!reference) return null;
		image.providerFile = reference;
	}
	return image;
}

/**
 * Whether a replicated image URL is one this host will hand to a provider. Both
 * `ImageContent.url` and `ProviderFileReference.uri` reach provider fetches, so both
 * take this predicate; `URL.canParse` alone accepts `javascript:`. Length is
 * deliberately unbounded: no consumer states a ceiling.
 */
function isReplicableImageUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return IMAGE_URL_PROTOCOLS.has(parsed.protocol);
}

function toProviderFileReference(value: unknown): ProviderFileReference | null {
	if (typeof value !== "object" || value === null) return null;
	const { provider, id, uri, expiresAt } = value as Record<string, unknown>;
	if (!PROVIDER_FILE_PROVIDERS.has(provider as string)) return null;
	if (id !== undefined && typeof id !== "string") return null;
	// Unlike `id`, `uri` is dereferenced by providers, so it gets the scheme allowlist.
	if (uri !== undefined && !isReplicableImageUrl(uri)) return null;
	// Finite, not merely a number: `JSON.parse("1e999")` is `Infinity`, which
	// serializes back out as `null`.
	if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) return null;
	const reference: ProviderFileReference = { provider: provider as ProviderFileReference["provider"] };
	if (id !== undefined) reference.id = id;
	if (uri !== undefined) reference.uri = uri;
	if (expiresAt !== undefined) reference.expiresAt = expiresAt;
	return reference;
}
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

interface PendingCollabUiRequest {
	request: CollabUiRequest;
	promise: Promise<CollabGuestUiResult>;
	settle(result: CollabGuestUiResult): void;
	responsePending?: boolean;
	/** Peers that were handed this dialog and can still answer it. */
	recipients: Set<number>;
	retainOnReconnect?: boolean;
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
	#peers = new Map<number, { name: string; canWrite: boolean }>();
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

	/** True while a host-side question is retained for (or shown to) a writable guest. */
	get inputRequired(): boolean {
		return this.#pendingUi.size > 0;
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
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		const recipients = new Set<number>();
		this.#pendingUi.set(reqId, {
			request: fullRequest,
			promise,
			recipients,
			settle,
			retainOnReconnect: options?.retainOnReconnect,
		});
		// The queue can refuse a targeted frame and the caller has no timeout, so an ask
		// no writable peer received settles below. Recipients are tracked, not counted:
		// one guest holding the dialog can answer it.
		const hadWritable = this.#hasWritablePeers();
		for (const peerId of this.#sendWritablePeers({ t: "ui-request", request: fullRequest })) {
			recipients.add(peerId);
		}
		// Nobody connected yet: keep the ask for the first writer that joins.
		// Writable peers that all refused the frame cannot answer it, and the
		// caller awaits this with no timeout of its own.
		if (hadWritable && recipients.size === 0) settle({ kind: "unavailable" });
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
		if (!socket || this.#sendSuppressed(frame)) return [];
		const admitted: number[] = [];
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite && socket.send(frame, peerId)) admitted.push(peerId);
		}
		return admitted;
	}

	/**
	 * Drop {@link peer} from every outstanding ask once it can no longer answer
	 * (departure, shed, or demotion), so no caller waits on it. A departure retains an
	 * emptied ask for the next writer; a shed or demotion settles it. See ADMISSION.md,
	 * "An exchange the host started has to end".
	 */
	#dropAskRecipient(peer: number, retainWhenEmpty = false): void {
		for (const pending of this.#pendingUi.values()) {
			if (!pending.recipients.delete(peer)) continue;
			if (pending.recipients.size === 0 && !retainWhenEmpty) pending.settle({ kind: "unavailable" });
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
		socket.onPeerOverload = peer => this.#handlePeerOverload(peer);
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
			socket.close();
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
		this.#socket?.close();
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
	}

	/** @returns false when a saturated queue discarded an advisory frame. */
	#broadcast(frame: CollabFrame, advisory = false): boolean {
		if (this.#stopped || !this.#socket || this.#sendSuppressed(frame)) return false;
		if (advisory) return this.#socket.broadcastAdvisory(frame);
		this.#socket.send(frame);
		return true;
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
		if (this.#sendSuppressed(frame)) return;
		this.#socket?.send(frame, toPeer);
	}

	/**
	 * The outbound gate every guest-bound frame passes, whichever helper builds it.
	 * Ending an existing dialog contains only its old-room request ID, never
	 * current-session data, so `ui-request-end` alone may leave during a
	 * provisional `/resume` that later rolls back.
	 */
	#sendSuppressed(frame: CollabFrame): boolean {
		return this.ending || (!this.#sessionStillCurrent() && frame.t !== "ui-request-end");
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
		const socket = this.#socket;
		if (event.type === "notice") socket?.broadcastAdvisory(frame);
		// Each update carries the whole message so far, so a newer one supersedes
		// any still queued for the same message (#16956). Keyed per message so the
		// last update of one message is never superseded by the next one's.
		else if (event.type === "message_update") socket?.sendLatest(`message_update:${this.#messageSeq}`, frame);
		else socket?.send(frame);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Controls are dispatched synchronously while frames finish decrypting, so
		// a hello can land after its sender's `peer-left`. The socket settled the
		// peer's lifetime at reception; re-read it here rather than acting on a
		// sender that is already gone and registering a ghost participant.
		if (!this.#socket?.isServing(fromPeer)) {
			logger.debug("collab host ignoring frame from a peer it no longer serves", {
				type: this.#label(frame.t),
				fromPeer,
			});
			return;
		}
		// Served by the relay but not registered here: shed, or its welcome was
		// refused. Its frames would otherwise be judged as a read-only peer's.
		if (frame.t !== "hello" && !this.#peers.has(fromPeer)) {
			this.#sendError(RESYNC_MESSAGE, fromPeer, true);
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
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
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
				logger.debug("collab host ignoring unexpected frame", { type: this.#label(frame.t), fromPeer });
		}
	}

	/**
	 * Timing-safe write-token check; peers without a valid token are read-only. Takes
	 * `unknown` because frame fields are a guest's claim: `Buffer.from` throws on a
	 * non-string, which would silently lose the whole `hello`.
	 */
	#verifyWriteToken(token: unknown): boolean {
		const expected = this.#writeToken;
		if (!expected || typeof token !== "string" || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/**
	 * Bounds the whole message to {@link ERROR_MESSAGE_MAX} units plus the ellipsis,
	 * not its parts: errors raised elsewhere arrive already carrying guest input.
	 * Frames of other types that echo guest values bound them at their own site.
	 */
	#sendError(message: string, toPeer: number, resync = false): boolean {
		const bounded = message.length <= ERROR_MESSAGE_MAX ? message : `${message.slice(0, ERROR_MESSAGE_MAX)}…`;
		const frame: CollabFrame = resync
			? { t: "error", message: bounded, resync: true }
			: { t: "error", message: bounded };
		if (this.#sendSuppressed(frame)) return false;
		return this.#socket?.send(frame, toPeer) ?? false;
	}

	/**
	 * A foreign error rendered once, bounded, for both the reply and the log line,
	 * since errors raised elsewhere embed guest input. Call once per handler.
	 */
	#reason(err: unknown): string {
		return describeThrown(err, ERROR_MESSAGE_MAX);
	}

	/**
	 * A guest value as a bounded label whose stringification cannot throw. Numbers and
	 * booleans show as themselves (a stale `proto` must stay readable), strings are
	 * truncated, and anything else is `(unnamed)` without being converted.
	 */
	#label(value: unknown): string {
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (typeof value !== "string" || value.length === 0) return "(unnamed)";
		return value.length <= GUEST_LABEL_MAX ? value : `${value.slice(0, GUEST_LABEL_MAX)}…`;
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#sendError(`${action} is disabled on a read-only link`, fromPeer);
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

	/**
	 * Fields are `unknown`: the declared protocol types are a guest's claim. A
	 * non-number `proto` takes the mismatch path and is quoted through {@link #label};
	 * `name` must be narrowed before `.trim()`.
	 */
	#handleHello(name: unknown, proto: unknown, writeToken: unknown, fromPeer: number): void {
		if (this.#ctx.session.isSessionTransitioning) {
			this.#sendError("Session transition in progress; join again when it completes", fromPeer);
			return;
		}
		if (proto !== COLLAB_PROTO) {
			// Guest-controlled: quoted through #label, and bounded by #sendError regardless.
			this.#sendError(
				`protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${this.#label(proto)}`,
				fromPeer,
			);
			return;
		}
		// A name that is not a string is a name this host cannot use, which is what
		// a blank one already means: the guest gets the generated one either way.
		const cleanName = (typeof name === "string" ? name.trim().slice(0, GUEST_LABEL_MAX) : "") || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const socket = this.#socket;
		if (!socket) return;
		// Registered before building the snapshot so the welcome's roster shows the
		// joiner; undone below if the batch is refused.
		const firstPeer = this.#peers.size === 0;
		const registered = this.#peers.get(fromPeer);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		const entries = this.#serializeSnapshotEntries(snapshot.entries.filter(isWireSessionEntry));
		if (!this.#guestTrafficAllowed()) {
			if (registered) this.#peers.set(fromPeer, registered);
			else this.#peers.delete(fromPeer);
			return;
		}
		const state = this.#buildState();
		const welcome: CollabFrame = {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state,
			agents: this.#snapshotAgents(),
			entryCount: entries.json.length,
			readOnly: canWrite ? undefined : true,
		};
		// Retained asks ride in the welcome batch rather than as one queue entry
		// each: up to MAX_PENDING_UI_REQUESTS of them are replayed to a joining
		// writer, which is past the per-peer share on its own.
		const replayed = canWrite ? [...this.#pendingUi.values()].filter(pending => !pending.responsePending) : [];
		let replayBytes = 0;
		for (const pending of replayed) {
			replayBytes += Buffer.byteLength(JSON.stringify({ t: "ui-request", request: pending.request }));
		}
		const snapshotBytes = entries.bytes.reduce((total, bytes) => total + bytes, 0);
		const encodedWelcome = encodeFrame(welcome);
		const retainedBytes = snapshotBytes + Buffer.byteLength(encodedWelcome) + replayBytes;
		const batch = this.#welcomeWithSnapshot(encodedWelcome, entries.json, entries.bytes, replayed);
		if (!socket.sendBatch(batch, fromPeer, retainedBytes)) {
			// No welcome reached the guest, and it applies nothing before one: restore the
			// prior registration so no roster entry or pending ask is recorded for it.
			if (registered) this.#peers.set(fromPeer, registered);
			else this.#peers.delete(fromPeer);
			logger.debug("collab: welcome batch was not admitted; leaving the peer unregistered", { fromPeer });
			return;
		}
		if (firstPeer) this.#lastStateJson = JSON.stringify(state);
		if (canWrite) {
			for (const pending of replayed) pending.recipients.add(fromPeer);
		} else {
			// A hello without the write token demotes the peer; it can no longer answer
			// anything it was handed.
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
	 * Welcome and chunks from the same {@link entries} as one queue entry, so a partial
	 * admission cannot be expressed and nothing queues ahead of a snapshot only the
	 * empty-queue floor can admit. See ADMISSION.md, atomicity invariant.
	 */
	*#welcomeWithSnapshot(
		welcome: EncodedFrame,
		entries: string[],
		bytes: number[],
		replayed: readonly PendingCollabUiRequest[] = [],
	): Generator<CollabFrame | EncodedFrame> {
		yield welcome;
		yield* this.#snapshotChunks(entries, bytes);
		for (const pending of replayed) yield { t: "ui-request", request: pending.request };
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
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		const pending = this.#pendingUi.get(reqId);
		if (pending) {
			if (!pending.recipients.has(fromPeer) || pending.responsePending) return;
			if (suspended) {
				void this.#settleUiAfterTransition(pending, value, fromPeer);
				return;
			}
			pending.settle({ kind: "answered", value });
			return;
		}
		// The request already settled (or never existed for this peer). A writer that
		// reconnected after the broadcast `ui-request-end` resends its answer and would
		// otherwise wait forever, so acknowledge it directly.
		this.#send({ t: "ui-request-end", reqId }, fromPeer);
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
			if (peer?.canWrite && this.#peers.get(fromPeer) === peer) pending.settle({ kind: "answered", value });
			else this.#sendWritablePeers({ t: "ui-request", request: pending.request });
		} catch (error) {
			logger.warn("Collab UI response could not await session transition", { error: String(error) });
			pending.settle({ kind: "unavailable" });
		} finally {
			pending.responsePending = false;
		}
	}

	/**
	 * `images` is `unknown` (see {@link #verifyWriteToken}) and is spread, which a
	 * truthy non-iterable throws out of. A non-string `text` is refused here: with
	 * images it would be persisted as invalid session state and throw a turn later
	 * inside a provider serializer, with nothing left to tell the guest.
	 */
	#handlePrompt(text: unknown, images: unknown, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		if (typeof text !== "string") {
			this.#sendError("prompt failed: message text must be a string", fromPeer);
			return;
		}
		// A malformed element is refused, not dropped: unchecked, `{type:"text",text:42}`
		// is persisted and throws a turn later inside a provider serializer.
		const offered = Array.isArray(images) ? images : [];
		const supplied = offered.map(toImageContent);
		if (supplied.some(image => image === null)) {
			this.#sendError("prompt failed: every image must carry string data and a supported image type", fromPeer);
			return;
		}
		const normalized = supplied as ImageContent[];
		const name = peer.name;
		// `Array.isArray`, not a length test: `{ length: 1 }` throws out of the spread and
		// loses the whole prompt. A non-array carries no images; the text still goes.
		const content: string | (TextContent | ImageContent)[] =
			normalized.length > 0 ? [{ type: "text", text }, ...normalized] : text;
		const details: CollabPromptDetails = { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		// Best-effort: a turn can outlast the guest by minutes, too long to pin a
		// retirement record. Still room-scoped, so a reissued id is not charged stale
		// errors. See ADMISSION.md, "An exchange the host started has to end".
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
			.then(dispatched => {
				if (dispatched === false) return this.#notifyPromptDropped(fromPeer);
			})
			.catch(err => {
				const reason = this.#reason(err);
				logger.warn("collab guest prompt failed", { error: reason });
				if (stillTheAsker?.()) {
					this.#sendError(`prompt failed: ${reason}`, fromPeer);
				}
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
			.catch(err => logger.warn("collab guest abort failed", { error: this.#reason(err) }));
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
		// A mirrored local dialog remains open through a transport reconnect. Keep
		// its request for replay after a new hello verifies the writer again. Bare
		// guest-only callers still settle rather than wait without a recipient.
		// Explicit stop and session replacement continue to settle every request.
		for (const pending of this.#pendingUi.values()) {
			if (!pending.retainOnReconnect) pending.settle({ kind: "unavailable" });
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/** Identity and UI only: the socket already retired the peer and dropped its backlog. */
	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		this.#dropAskRecipient(peer, true);
		if (!this.#guestTrafficAllowed()) return;
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
		this.#sendError(RESYNC_MESSAGE, peer, true);
		if (name) {
			this.#ctx.session.emitNotice(
				"warning",
				`${name} fell too far behind and was dropped; they can rejoin`,
				"collab",
			);
		}
		this.#updateStatusSegment();
		// Deliberately no state broadcast: into a still-full queue it would shed the next
		// peer, whose report changes state again, cascading through the roster. `state`
		// is level-triggered, so the next real change re-sends it.
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
			// Level-triggered like `state`, and re-sent on the next registry change.
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() }, true);
		}, AGENTS_DEBOUNCE_MS);
	}

	/**
	 * Fields are `unknown` (see {@link #verifyWriteToken}). Every malformed value must
	 * still be answered, and no answer may quote a guest value unbounded.
	 */
	#handleAgentCmd(cmd: unknown, agentId: unknown, text: unknown, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// The lookup takes the id whole: truncating would let a long id address the agent
		// owning its prefix. The quoted copy is bounded by GUEST_LABEL_MAX and always a
		// string, since interpolating a deeply nested array throws `RangeError`.
		const id = typeof agentId === "string" ? agentId : "";
		const quoted = this.#label(id);
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(id)?.kind === "advisor") {
			this.#sendError(`agent ${quoted}: advisor transcripts are read-only`, fromPeer);
			return;
		}
		// Best-effort and room-scoped for the same reason as a failed prompt: agent
		// work has no bound, and past a reconnect this id is somebody else's.
		const stillTheAsker = this.#socket?.bestEffortAddressee(fromPeer);
		const fail = (err: unknown) => {
			const reason = this.#reason(err);
			logger.warn("collab agent-cmd failed", { cmd, agentId: quoted, error: reason });
			if (!stillTheAsker?.()) return;
			this.#sendError(`agent ${quoted}: ${reason}`, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				// `.trim()` throws on a non-string; treat one as an empty message so it is answered.
				const trimmed = typeof text === "string" ? text.trim() : "";
				if (!trimmed) {
					this.#sendError(`agent ${quoted}: empty chat message`, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(id)
					.then(session => {
						if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
						return session.prompt(trimmed, { streamingBehavior: "steer" });
					})
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(id);
					if (!ref) throw new Error(`unknown agent "${quoted}"`);
					if (!this.#guestTrafficAllowed()) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
					await AgentLifecycleManager.global().release(id, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(id).catch(fail);
				break;
			default:
				// An unknown `cmd` must still be answered. Not echoed: it is unvalidated guest input.
				this.#sendError(`agent ${quoted}: unknown agent command`, fromPeer);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: unknown, agentId: unknown, fromByte: unknown, fromPeer: number): Promise<void> {
		// Both are echoed back and #sendError cannot bound this frame. Narrowed, not
		// truncated: an altered correlation id matches nothing. Safe integers because
		// `fromByte` is a `read` offset and `reqId` matches by identity.
		if (!Number.isSafeInteger(reqId) || (reqId as number) < 0) {
			this.#sendError("fetch-transcript needs a non-negative integer reqId", fromPeer);
			return;
		}
		if (!Number.isSafeInteger(fromByte) || (fromByte as number) < 0) {
			this.#sendError("fetch-transcript needs a non-negative integer fromByte", fromPeer);
			return;
		}
		return this.#fetchTranscript(reqId as number, agentId, fromByte as number, fromPeer);
	}

	async #fetchTranscript(reqId: number, agentId: unknown, fromByte: number, fromPeer: number): Promise<void> {
		// The read is asynchronous, so the peer can leave — or the whole room can be
		// recreated — before there is anything to reply with.
		const stillTheAsker = this.#socket?.addressee(fromPeer);
		// #sendError cannot reach a `transcript` frame's error string, so it is bounded
		// here. Intentionally uncovered: today's only dynamic error is already capped by
		// #reason, so no test fails if this is deleted. Keep it: whatever last touches a
		// frame bounds it.
		const reply = (text: string, newSize: number, error?: string) => {
			if (!stillTheAsker?.()) return;
			const bounded =
				error === undefined || error.length <= ERROR_MESSAGE_MAX ? error : `${error.slice(0, ERROR_MESSAGE_MAX)}…`;
			this.#send({ t: "transcript", reqId, text, newSize, error: bounded }, fromPeer);
		};
		const ref = AgentRegistry.global().get(typeof agentId === "string" ? agentId : "");
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
			const reason = this.#reason(err);
			logger.debug("collab transcript read failed", { agentId: this.#label(agentId), error: reason });
			reply("", fromByte, reason);
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
			// A guest can cause unbounded distinct `state` frames (a repeat hello under a new
			// name), so they go advisory; recorded as sent only when admitted, or the dedupe
			// pins a value guests never saw.
			if (this.#broadcast({ t: "state", state }, true)) this.#lastStateJson = json;
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
