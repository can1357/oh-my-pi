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
	oversizedEntryNotice,
	type ReplicatedEntry,
	replicationByteLength,
	shrinkReplicatedEntry,
	shrinkReplicatedEvent,
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
 * Longest guest-supplied label this host will put into a frame it sends.
 *
 * Not a limit on what an id or a name may be — an agent lookup takes the id whole,
 * so a longer real one still addresses its agent — only on how much of it a guest
 * can make the host emit. Unbounded, a reply that quotes one is as large as the
 * guest chose — an unknown-agent kill quoted the id in the prefix and again
 * inside the error, so the reply ran to about twice whatever arrived. The queue
 * admits one oversized entry on an empty queue, so a large enough label builds a
 * frame past the relay's payload limit and closes the host socket: a
 * guest-triggered disconnect out of an error path whose whole purpose is to be
 * polite about a mistake.
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
 * Ceiling on the text of an `error` frame, applied where the frame is sent rather
 * than where its parts are chosen.
 *
 * Bounding the ingredients does not work, and this branch proved it twice: the
 * agent-command replies bound the id and then interpolated `String(err)`, and
 * `AgentLifecycleManager#ensureLive` embeds the id it was given, twice, in prose
 * of its own. Bounding the label bought almost nothing: the reply still carried
 * the id twice through prose composed elsewhere, so it still scaled with what
 * the guest sent. That message belongs to another module and its own callers, so
 * the only place that can bound it is the last one that touches it.
 *
 * 512 UTF-16 code units, which is what `slice` counts — not bytes. Astral text
 * costs four bytes per two units, so 512 units is 256 code points and about 1 KiB
 * in UTF-8; still four orders of magnitude inside the relay's payload limit,
 * which is the property that matters, but the unit is worth stating because the
 * budget elsewhere in this feature is named in bytes and these are not the same
 * number. A split surrogate at the cut is not a corruption risk: `JSON.stringify`
 * escapes a lone surrogate, so the frame stays valid JSON.
 *
 * 512 because the longest error this file composes from its own literals plus a
 * fully-sized {@link GUEST_LABEL_MAX} label measures 154 units — the `kill` reply
 * for an unknown agent, which spends the label twice. What gets cut is therefore
 * never this host's own wording. Prose from elsewhere has no such headroom and no
 * ceiling to compute one from: the revive path `AgentLifecycleManager.ensureLive`
 * runs into (`#resolveAndRevive`) interpolates the *untruncated* id twice, so the
 * same reply reaches 586 units at a 200-unit id and grows from there. That is what
 * the cap is for, and why it cannot be replaced by arithmetic over the ingredients.
 */
const ERROR_MESSAGE_MAX = 512;

/**
 * Schemes a replicated image URL may use.
 *
 * `http:` is here on purpose and not as an oversight: the blob broker's own
 * exposure emits `http://127.0.0.1:<port>` and `http://<bindHost>:<port>`
 * (`blob-broker/exposure.ts`), so requiring TLS would reject URLs this codebase
 * produces for itself. What the allowlist is for is everything else — `file:`,
 * `data:`, `javascript:` — which `URL.canParse` accepts happily and which
 * providers would be handed verbatim.
 */
const IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const IMAGE_DETAIL_VALUES = new Set(["auto", "low", "high", "original"]);
/**
 * Image media types this codebase can actually carry.
 *
 * Not a list chosen here. `normalizeAnthropicImageMediaType`
 * (`providers/anthropic.ts`), `createImageBlock` (`providers/amazon-bedrock.ts`)
 * and `EXT_BY_MIME` (`blob-broker/store.ts`) each recognise jpeg, png, gif and
 * webp; the first two also read `image/jpg` as a spelling of `image/jpeg`, and
 * `EXT_BY_MIME` does not, so that spelling costs a `.bin` extension on a broker
 * blob and nothing else.
 *
 * `image/svg+xml` is left out although `IMAGE_EXTENSION_BY_MIME`
 * (`session/blob-store.ts`) maps it: no provider converter accepts SVG, and it is
 * the one image type that carries script, which matters because of where this
 * value lands.
 *
 * An allowlist rather than a media-type grammar check, because the values that do
 * damage are well-formed media types. This string is not decoration in any of its
 * sinks:
 *
 * - The blob broker serves the guest's own bytes back under it as a response
 *   `content-type` (`blob-broker/store.ts`), on an origin this process operates.
 * - `EXT_BY_MIME[mimeType]` is a plain object read, so `"__proto__"` resolves to
 *   `Object.prototype` rather than `undefined`, the `?? "bin"` fallback never
 *   fires, and the path the broker publishes stops matching the
 *   `BLOB_PATH_PATTERN` its own request handler parses.
 * - The OpenAI, Cursor and completions converters build
 *   `data:${mimeType};base64,${data}`, where a `,` in the value ends the media
 *   type early and hands the rest of the URL to the sender.
 */
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);
const PROVIDER_FILE_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/**
 * Image content off the wire, rebuilt from the fields {@link ImageContent}
 * declares, or `null` if it is not image content at all.
 *
 * Rebuilt rather than checked, because a check leaves whatever else the sender
 * attached. An earlier version tolerated unknown properties on purpose, reasoning
 * that a newer guest might carry fields this host has no opinion about — sound
 * where such a field is read and dropped, and wrong here, because this object is
 * put into a session message, persisted, and handed to
 * {@link shrinkForReplication}, which measures it with `JSON.stringify` before
 * walking it: both recurse, so a sufficiently nested unknown property takes one
 * of them to `RangeError`, and which one it reaches first belongs to the runtime
 * rather than to the payload. Copying the known fields makes the shape the host
 * stores a property of this function rather than of what arrived. A newer field
 * is dropped instead of honoured, which is the safe direction to be wrong.
 *
 * Takes `unknown` and reads properties off it directly, which is only total for
 * the input it actually gets: this runs on `JSON.parse` output, which is plain
 * data. A `Proxy` with a throwing `get` would throw out of the destructuring, and
 * nothing on this path can produce one.
 */
function toImageContent(value: unknown): ImageContent | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== "image") return null;
	const { data, mimeType, detail, url, providerFile } = candidate;
	// `data` is deliberately not inspected beyond its type, unlike `mimeType`
	// beside it. Every sink either carries it as a JSON string value, where
	// `JSON.stringify` escapes it, or appends it after the `;base64,` of a data
	// URL, where nothing following can re-open the media type. So a wrong value
	// costs a rejected turn — the price of any wrong image — while the scan would
	// run over what is routinely megabytes on the prompt path.
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
 * Whether a replicated image URL is one this host will hand to a provider.
 *
 * Checked, not merely typed, because neither `ImageContent.url` nor
 * `ProviderFileReference.uri` is decoration: the OpenAI converter puts the former
 * straight into `image_url`, and the Google one puts *either* into the same
 * `fileUri` (`providers/google-shared.ts`), so a scheme of the sender's choosing
 * decides where a fetch attributed to the operator's credential points. Both
 * doors onto that sink take this predicate; checking only one leaves the other
 * open. Parsing alone is not the check — `URL.canParse("javascript:alert(1)")` is
 * `true`.
 *
 * Length is not bounded here, and the bound that used to be was removed rather
 * than corrected: 2048 was this feature's own invention, no consumer between here
 * and the provider states a ceiling to replace it with, and a long but well-formed
 * `https:` URL costs a rejected turn and nothing worse. A number with no source is
 * worse than no number, because it reads like a constraint that was looked up.
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
	// Not merely a string, unlike `id`: `id` is handed to OpenAI and Anthropic as an
	// opaque handle they look up, while `uri` is dereferenced — see
	// {@link isReplicableImageUrl}. The only producer of this field is the Gemini
	// Files API response (`blob-broker/provider-files-gemini.ts`), which returns an
	// `https:` URL, so the allowlist costs no reachable capability.
	if (uri !== undefined && !isReplicableImageUrl(uri)) return null;
	// Finite, not merely a number: `JSON.parse("1e999")` is `Infinity`, which is
	// `typeof "number"` and passes a bare check. It then serializes back out as
	// `null`, so the entry this rebuild exists to keep well-formed would be
	// persisted with a null where the type declares a number. `NaN` the same.
	// Finiteness rather than a safe integer, unlike `fromByte`: nothing indexes with
	// this and the declared contract is only `number`, so the property that matters
	// is that it survives a round trip.
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

	constructor(ctx: InteractiveModeContext, options: CollabHostOptions = {}) {
		this.#ctx = ctx;
		this.#instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#generation = options.generation ?? 1;
		this.#access = options.access ?? "control";
		this.#guestActionsReady = options.guestActionsReady ?? (() => true);
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
	 *
	 * Refused, and the room ended, once the active session is no longer the
	 * one this room mirrors: `/resume` runs the new session's `session_switch`
	 * hooks before the session-change callbacks fire, so a dialog raised there
	 * must stay local rather than reach the previous session's guests.
	 */
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
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
		this.#pendingUi.set(reqId, { request: fullRequest, promise, recipients, settle });
		// A registration only means something if somebody was asked, and it stops
		// meaning anything once nobody who was asked can answer. The queue can
		// refuse a targeted frame under pressure, and the caller awaits this with no
		// timeout of its own, so an ask nobody received settles here instead of
		// waiting for a reply that cannot come. A partial delivery still stands: one
		// guest holding the dialog is enough to answer it, which is why the
		// recipients are tracked rather than counted.
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
	 * Drop {@link peer} from every outstanding ask. Called wherever a peer stops
	 * being able to answer: departure, a shed, or a `hello` that gives up write
	 * permission. Without it an ask the queue admitted counts as delivered for
	 * ever, and its caller waits for a reply from somebody the host has already
	 * written off.
	 *
	 * A departure returns the ask to the retained state a dialog raised before any
	 * writer joined is in, so the next writer is handed it on join. A shed or a
	 * demotion settles an ask that has no recipient left: the shed peer's rejoin
	 * would replay the backlog it just outran, and the demoted peer is still in
	 * the room without the right to answer.
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
			// A question retained while connecting has no room to reach anymore.
			for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
			this.#pendingUi.clear();
			throw err;
		} finally {
			clearTimeout(timeout);
			this.#abortStart = null;
		}

		this.#startedAt = Date.now();
		// Mirror from the moment the relay is open. A guest can join as soon as
		// the link is visible (auto-start installs the room before this
		// resolves), and anything that happens after its welcome snapshot must
		// reach it; the local registry work below is independent of that.
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) {
				this.#broadcast({ t: "event", event: shrinkReplicatedEvent(event) }, event.type === "notice");
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
				this.#busUnsubscribers.push(observabilityBus.on(channel, data => this.#send({ t: "bus", channel, data })));
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) {
				const shrunk = shrinkReplicatedEntry(entry);
				if (shrunk.type === "custom_message" && shrunk.customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE) {
					// The live path also emits a guest-visible notice: guests only
					// apply `message` entries to their agent context, so without
					// this the substitution would be silently invisible there
					// (PR #11999 review). Notices never enter agent state.
					this.#send({ t: "event", event: oversizedEntryNotice(entry.type) });
				}
				this.#send({ t: "entry", entry: shrunk });
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

	/** Only outbound path; stop() deliberately bypasses it for the final goodbye. */
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

	/**
	 * Every `error` frame leaves through here, so no reply can exceed
	 * {@link ERROR_MESSAGE_MAX} code units of message, plus the one the ellipsis
	 * costs when it fires — 513, not 512 — whatever composed it.
	 *
	 * A cap on the whole message rather than on its parts, because the parts are not
	 * all chosen here: an error raised elsewhere arrives already carrying whatever a
	 * guest put into the request that produced it. Callers may still quote a bounded
	 * label for readability — that is what {@link #label} is for — but nothing
	 * downstream depends on their remembering to.
	 *
	 * This closes the `error` carrier, not the idea of echoing a guest value: a
	 * frame of another type that embeds one is bounded at its own site, and
	 * `#handleFetchTranscript`'s `reqId` is the one that needed it.
	 */
	#sendError(message: string, toPeer: number): boolean {
		const bounded = message.length <= ERROR_MESSAGE_MAX ? message : `${message.slice(0, ERROR_MESSAGE_MAX)}…`;
		const frame: CollabFrame = { t: "error", message: bounded };
		if (this.#sendSuppressed(frame)) return false;
		return this.#socket?.send(frame, toPeer) ?? false;
	}

	/**
	 * An error someone else raised, rendered for quoting.
	 *
	 * The argument on {@link #sendError} is about the error text, not about the
	 * error frame, so it holds for every consumer of that text and not just the
	 * reply: `ensureLive` embeds the id it was handed, twice, and a log line takes
	 * whatever volume a reply would. Bounded once, here, so a caller cannot bound
	 * one consumer and forget the other — which is exactly what happened when only
	 * the reply was fixed.
	 *
	 * Rendering is not safe by default either, and this helper originally assumed it
	 * was, one function below the doc comment on {@link #label} that says a nested
	 * value throws out of a template. {@link describeThrown} owns that; call this
	 * once per handler and reuse the result rather than converting twice.
	 */
	#reason(err: unknown): string {
		return describeThrown(err, ERROR_MESSAGE_MAX);
	}

	/**
	 * A value of unknown provenance, reduced to something safe to put in a frame or
	 * a log line: bounded in length, and never one whose own stringification can
	 * throw. A nested array reaches this handler at depths a template cannot survive
	 * — it does not have to, because it lands in the object arm below and is
	 * reported as unnamed without being converted at all.
	 *
	 * A number or a boolean is reported as itself, because for some of these fields
	 * that is the well-formed case and the reply has to name what actually arrived —
	 * a stale `proto` is a number, and saying it was unnamed would make the mismatch
	 * unreadable. A string is truncated rather than replaced, because a long one is
	 * still the name its sender chose. Nothing else has a name to give.
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
	 * Every field here is `unknown` for the reason given on {@link #verifyWriteToken}:
	 * the declared protocol types describe what a well-behaved guest sends, and this
	 * is the boundary where that stops being a guarantee. `proto` needs no narrowing
	 * to reach the right branch — a non-number is never equal to {@link COLLAB_PROTO},
	 * so it takes the mismatch path — but it does need one to be quoted back, which
	 * is why the reply runs it through {@link #label} rather than `String`: the value
	 * is guest-sized, and a nested array throws out of a template. `name` needs one
	 * to be used at all: `.trim()` throws on a non-string, including `null`.
	 */
	#rejectWhileStarting(action: string, fromPeer: number): boolean {
		if (this.#guestActionsReady()) return false;
		const ready = this.#ctx.session.isSessionTransitioning
			? "the session transition completes"
			: "the host finishes starting up";
		this.#send({ t: "error", message: `${action} is unavailable until ${ready}` }, fromPeer);
		return true;
	}

	#handleHello(name: unknown, proto: unknown, writeToken: unknown, fromPeer: number): void {
		if (this.#ctx.session.isSessionTransitioning) {
			this.#sendError("Session transition in progress; join again when it completes", fromPeer);
			return;
		}
		if (proto !== COLLAB_PROTO) {
			// `proto` is guest-controlled, so the reply that quotes it back would be
			// too — unbounded, it was as long as the guest chose. Labelled here for the
			// reader, and bounded by #sendError regardless of what reaches it.
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
		// Registered before the snapshot is built, because `#buildState` reads the
		// roster and the welcome has to show the joiner itself. Held against the
		// batch's admission below, so a hello whose welcome the queue refused leaves
		// the host's view of the room exactly as it found it.
		const registered = this.#peers.get(fromPeer);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		const snapshot = this.#ctx.sessionManager.snapshotForReplication(copyForReplication);
		let serialized = "";
		const measured = replicationByteLength(snapshot);
		if (measured !== null) serialized = JSON.stringify(snapshot);
		if (measured === null || serialized.length > WELCOME_IMAGE_STRIP_THRESHOLD) {
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
		if (!this.#guestTrafficAllowed()) {
			if (registered) this.#peers.set(fromPeer, registered);
			else this.#peers.delete(fromPeer);
			return;
		}
		const welcome: CollabFrame = {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state: this.#buildState(),
			agents: this.#snapshotAgents(),
			entryCount: entries.length,
			readOnly: canWrite ? undefined : true,
		};
		// Retained asks ride in the welcome batch rather than as one queue entry
		// each: up to MAX_PENDING_UI_REQUESTS of them are replayed to a joining
		// writer, which is past the per-peer share on its own.
		const replayed = canWrite ? [...this.#pendingUi.values()] : [];
		let replayBytes = 0;
		for (const pending of replayed) {
			replayBytes += Buffer.byteLength(JSON.stringify({ t: "ui-request", request: pending.request }));
		}
		// snapshotForReplication clones, and the batch holds that clone until it
		// drains, so the queue is told what it is keeping alive: the serialized byte
		// length of what stripping left, before an entry filter that only shrinks it
		// further, plus the replayed asks.
		const batch = this.#welcomeWithSnapshot(welcome, entries, replayed);
		if (!socket.sendBatch(batch, fromPeer, snapshotBytes + replayBytes)) {
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
			for (const pending of replayed) pending.recipients.add(fromPeer);
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
		replayed: readonly PendingCollabUiRequest[] = [],
	): Generator<CollabFrame> {
		yield welcome;
		yield* this.#snapshotChunks(entries);
		for (const pending of replayed) yield { t: "ui-request", request: pending.request };
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames.
	 * Each entry is first run through
	 * {@link shrinkReplicatedEntry} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739), and an entry that cannot be shrunk at
	 * all ships as a bounded placeholder instead of stranding the guest
	 * without a terminator (issue #11433). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	*#snapshotChunks(entries: ReplicatedEntry[]): Generator<CollabFrame> {
		if (entries.length === 0) {
			yield { t: "snapshot-chunk", entries: [], final: true };
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: ReplicatedEntry[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				// Never throws, and always returns a bounded payload: a throw here
				// would end the train without its `final: true` terminator, and the
				// guest would time out its join while the host lists it as joined.
				const shrunk = shrinkReplicatedEntry(entry);
				const entryBytes = replicationByteLength(shrunk) ?? 0;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			yield { t: "snapshot-chunk", entries: batch, final: i >= entries.length };
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
			if (this.#peers.get(fromPeer)?.canWrite) pending.settle({ kind: "answered", value });
			else this.#sendWritablePeers({ t: "ui-request", request: pending.request });
		} catch (error) {
			logger.warn("Collab UI response could not await session transition", { error: String(error) });
			pending.settle({ kind: "unavailable" });
		} finally {
			pending.responsePending = false;
		}
	}

	/**
	 * `images` is `unknown` for the reason given on {@link #verifyWriteToken}: the
	 * declared type is the sender's claim, and this one was spread, which a truthy
	 * non-iterable throws out of.
	 *
	 * `text` is refused below rather than merely typed, which is why nothing further
	 * down has to cope with it. It is written here because the reason is not local:
	 * the two paths it used to reach failed differently, and one failed late.
	 * Without images a non-string became the content whole and `promptCustomMessage`
	 * rejected it in its first statement, before any session insertion, so the catch
	 * below replied. With images it went into a `TextContent`, where nothing
	 * rejected it — `join` stringifies a copy and the original was persisted as
	 * sent, so the entry was invalid session state and a later turn threw on
	 * `item.text.toWellFormed()` inside a provider serializer, a different
	 * subsystem, minutes away, with nothing left to tell the guest.
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
		// An element is content the guest meant to send, which an `images` field that
		// is not an array at all is not — so a malformed element is refused rather
		// than dropped. It is the text defect one field over: unchecked,
		// `{type:"text",text:42}` is accepted into the content, persisted, and throws
		// a turn later at `item.text.toWellFormed()` inside a provider serializer.
		const offered = Array.isArray(images) ? images : [];
		const supplied = offered.map(toImageContent);
		if (supplied.some(image => image === null)) {
			this.#sendError("prompt failed: every image must carry string data and a supported image type", fromPeer);
			return;
		}
		const normalized = supplied as ImageContent[];
		const name = peer.name;
		// `Array.isArray`, not a length test: `{ length: 1 }` passed a length test and
		// then threw out of the spread, and that throw unwound into `CollabSocket`'s
		// frame-handler catch — losing the whole prompt for a debug line. Anything
		// that is not an array carries no images, which is the path a prompt without
		// any already takes, so the text still gets through.
		const content: string | (TextContent | ImageContent)[] =
			normalized.length > 0 ? [{ type: "text", text }, ...normalized] : text;
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
		this.#sendError("the host discarded your backlog; rejoin to resync", peer);
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
		if (this.ending || this.#agentsDebounce) return;
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
		// and `JSON.parse` on the way here. Where serialization stops carrying it is
		// stack-bound and varies by runtime, so this depends on 5,000 working rather
		// than on where the ceiling is.
		//
		// Bounded two ways, because the reasons differ and only one of them is
		// anonymity. An id that is absent or not a string names nothing, and saying so
		// is accurate. A long one names something — the lookup just used it — so it is
		// truncated rather than disowned: nothing above the cap enforces that ids stay
		// short, and a long id is likelier to be one a guest actually typed, which is
		// exactly when a reply has to say which agent failed.
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
				// `.trim()` throws on a number, and the throw would be swallowed, so a
				// malformed message would vanish rather than be answered. A message that
				// is not a string is not a message, which is what an empty one already
				// means: the guest gets the same reply either way.
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
				// Without this a `cmd` matching no case fell out of the switch and
				// returned: nothing run, nothing said. Answered like a command this host
				// knows but cannot carry out. The value is not echoed back — the guest
				// sent it, and it is unvalidated enough that repeating it is the sender
				// choosing what the host emits.
				this.#sendError(`agent ${quoted}: unknown agent command`, fromPeer);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: unknown, agentId: unknown, fromByte: unknown, fromPeer: number): Promise<void> {
		// The reply echoes both of these back — `reqId` so the guest can match it to
		// its request, `fromByte` as the resume point — so this frame is a second
		// carrier for a guest value, and #sendError cannot reach it: unnarrowed, a
		// `reqId` came back at whatever length it arrived. Narrowed rather than
		// truncated, because neither field is a label — a correlation id the host
		// altered would match nothing at the other end.
		// Safe integers, not merely finite: `fromByte` is a byte offset handed to
		// `read`, and `reqId` is matched by identity at the other end. `Number.isFinite`
		// admits -1, 0.5 and 2 ** 53, none of which is either of those things.
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
		// The one place a `transcript` frame is built, and the rule #sendError enforces
		// for error replies holds here too: this frame carries an error string, and
		// #sendError cannot reach it because it is not an error frame.
		//
		// No *unbounded* input reaches this bound today, and it is deliberately kept
		// anyway. The only dynamic error here comes from `fs` and quotes a host-owned
		// path, and #reason has already capped it to 513 units by the time it arrives
		// — so the slice can fire on that one extra unit but can never be what saves
		// the frame. That is a property of the callers, not of this site, which is
		// exactly why the guard belongs here: no test can fail if it is deleted, so
		// deleting it will look correct. It is structural: the premise of this design
		// is that whatever last touches a frame bounds it, so
		// that a caller composing a new message somewhere else cannot reintroduce the
		// defect. Dropping it because today's one error happens to be host-owned is
		// the reasoning that cost this branch three rounds — bound the ingredients,
		// trust the current callers, meet a new ingredient.
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
		if (this.ending || this.#stateDebounce) return;
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
