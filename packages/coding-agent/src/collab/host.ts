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
import { GuestRegistry, type GuestRegistryEvent, permissionNames } from "./guest-manager";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabGuestFrame,
	type CollabHostFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	formatCollabLink,
	formatCollabWebLink,
	GUEST_PERMISSIONS,
	type GuestIdentity,
	type GuestPermissionSet,
	type GuestRole,
	type GuestStatus,
	generateRoomId,
	type PermissionAuditEntry,
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
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket<CollabHostFrame, CollabGuestFrame> | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	#guests = new GuestRegistry();
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#guestsUnsubscribe?: () => void;
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
		for (const identity of this.#guests.list()) {
			list.push({
				name: identity.name,
				role: "guest",
				readOnly: (this.#guests.effectivePermissions(identity) & GUEST_PERMISSIONS.PROMPT) === 0 || undefined,
			});
		}
		return list;
	}
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#socket || !this.#hasUiResponders()) return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			// Remove before the end-frame: a settled request must never replay
			// to guests that join later (only unanswered asks stay queued).
			this.#pendingUi.delete(reqId);
			this.#sendUiCapable({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#sendUiCapable({ t: "ui-request", request: fullRequest });
		return promise;
	}
	/** True when at least one connected guest holds the UI_RESPONSE bit. */
	#hasUiResponders(): boolean {
		for (const identity of this.#guests.list()) {
			if (identity.peerId < 0) continue;
			if ((this.#guests.effectivePermissions(identity) & GUEST_PERMISSIONS.UI_RESPONSE) !== 0) return true;
		}
		return false;
	}

	/** Target every connected guest holding the UI_RESPONSE bit (proto-3 guests included). */
	#sendUiCapable(frame: CollabHostFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const identity of this.#guests.list()) {
			if (identity.peerId < 0) continue;
			if ((this.#guests.effectivePermissions(identity) & GUEST_PERMISSIONS.UI_RESPONSE) === 0) continue;
			socket.send(frame, identity.peerId);
		}
	}

	/**
	 * Target a frame at every connected proto-4 guest. Legacy guests are never
	 * sent guest-management/chat frames; `gate` narrows further by capability.
	 */
	#sendToGuests(frame: CollabHostFrame, gate?: (identity: GuestIdentity) => boolean): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const identity of this.#guests.list()) {
			if (identity.peerId < 0 || identity.capabilities.protocolVersion < 4) continue;
			if (gate && !gate(identity)) continue;
			socket.send(frame, identity.peerId);
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

		const socket = new CollabSocket<CollabHostFrame, CollabGuestFrame>({ wsUrl: parsed.wsUrl, role: "host", key });
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
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
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
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
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
		this.#guestsUnsubscribe = this.#guests.on(event => this.#onGuestEvent(event));
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
		this.#guestsUnsubscribe?.();
		this.#guestsUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.collabHost = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
	}

	#broadcast(frame: CollabHostFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		this.#socket.send(frame);
	}

	/**
	 * Map a {@link GuestRegistryEvent} onto the wire for observing guests and
	 * refresh the host's own surfaces. Guest frames go only to proto-4
	 * guests; legacy guests are never invited into the newer grammar.
	 */
	#onGuestEvent(event: GuestRegistryEvent): void {
		if (this.#stopped || !this.#socket) return;
		switch (event.type) {
			case "guest-joined": {
				// Re-read on reattach: the event may carry the pre-reconnect peerId.
				const guest = this.#guests.byId(event.guest.id) ?? event.guest;
				const viewOnly = (this.#guests.effectivePermissions(guest) & GUEST_PERMISSIONS.PROMPT) === 0;
				// The joining guest learns its identity from welcome; the event is
				// for everyone else.
				this.#sendToGuests({ t: "guest-joined", guest }, identity => identity.id !== guest.id);
				this.#ctx.session.emitNotice(
					"info",
					`${guest.name} joined the collab session${viewOnly ? " (view-only)" : ""}`,
					"collab",
				);
				this.#updateStatusSegment();
				this.#scheduleStateBroadcast();
				break;
			}
			case "guest-left": {
				const name = this.#guests.byId(event.guestId)?.name ?? "a guest";
				this.#sendToGuests({ t: "guest-left", guestId: event.guestId, reason: event.reason });
				this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
				this.#updateStatusSegment();
				this.#scheduleStateBroadcast();
				break;
			}
			case "guest-role-changed":
				this.#sendToGuests({ t: "guest-role-changed", guestId: event.guestId, role: event.role, by: event.by });
				this.#scheduleStateBroadcast();
				break;
			case "guest-permission-changed":
				this.#sendToGuests({
					t: "guest-permission-changed",
					guestId: event.guestId,
					permissionsSet: event.permissionsSet,
				});
				this.#scheduleStateBroadcast();
				break;
			case "guest-presence-changed":
				this.#sendToGuests(
					{ t: "guest-presence", guestId: event.guestId, status: event.status },
					identity => identity.capabilities.supportsPresence,
				);
				break;
		}
	}

	#handleFrame(frame: CollabGuestFrame, fromPeer: number): void {
		if (frame.t !== "hello") this.#guests.touch(fromPeer);
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame, fromPeer);
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
			case "guest-invite":
				this.#handleGuestInvite(frame.name, frame.role, frame.permissionsOverride, fromPeer);
				break;
			case "guest-kick":
				this.#handleGuestKick(frame.guestId, frame.reason, fromPeer);
				break;
			case "guest-role":
				this.#handleGuestRole(frame.guestId, frame.role, fromPeer);
				break;
			case "guest-permission":
				this.#handleGuestPermission(frame.guestId, frame.grant, frame.revoke, fromPeer);
				break;
			case "guest-message":
				this.#handleGuestMessage(frame.to, frame.text, frame.kind, fromPeer);
				break;
			case "guest-presence":
				this.#handleGuestPresence(frame.status, fromPeer);
				break;
			case "guest-cursor":
				this.#handleGuestCursor(frame.agentId, frame.position, fromPeer);
				break;
			case "permission-audit":
				this.#handlePermissionAudit(frame.reqId, frame.guestId, frame.limit, fromPeer);
				break;
			default:
				// Default is unreachable for the declared grammar; reachable for
				// runtime garbage, so log the frame itself instead of a field.
				logger.debug("collab host ignoring unexpected frame", { frame, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/**
	 * Targeted denial when {@link fromPeer} lacks {@link flag}; true when the
	 * action may proceed.
	 */
	#checkPermission(flag: GuestPermissionSet, action: string, fromPeer: number): boolean {
		if (this.#guests.hasPermissionForPeer(fromPeer, flag)) return true;
		this.#socket?.send(
			{ t: "error", message: `${action} requires the ${permissionNames(flag)} permission` },
			fromPeer,
		);
		return false;
	}

	#handleHello(frame: Extract<CollabGuestFrame, { t: "hello" }>, fromPeer: number): void {
		// Proto-3 guests (pre-guest-management builds) speak a subset of the
		// grammar and are served the legacy surface; only older-than-ui-request
		// versions are rejected outright (their welcome would hang the ask
		// flow — see the COLLAB_PROTO history in @oh-my-pi/pi-wire).
		if (frame.proto < 3 || frame.proto > COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${frame.proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = frame.name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(frame.writeToken);
		const attached = this.#guests.attach({
			peerId: fromPeer,
			name: cleanName,
			proto: frame.proto,
			canWrite,
			guestId: frame.guestId,
			capabilities: frame.capabilities,
		});
		const socket = this.#socket;
		if (!socket) return;
		if ("error" in attached) {
			// Kicked identity rejoining: refuse with a targeted goodbye.
			socket.send({ t: "bye", reason: "removed from this session" }, fromPeer);
			return;
		}
		const identity = attached.identity;
		const modern = identity.capabilities.protocolVersion >= 4;

		// Snapshot and send synchronously: no awaits between snapshot, welcome,
		// and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
		// queue behind the snapshot on the same socket and the guest can't
		// observe a gap between the snapshot fragment and live traffic.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		socket.send(
			{
				t: "welcome",
				// Negotiated per-peer version: proto-3 guests are served the
				// legacy grammar, so the welcome promises v3 to them.
				proto: Math.min(frame.proto, COLLAB_PROTO),
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				readOnly: canWrite ? undefined : true,
				...(modern
					? {
							self: identity,
							guests: this.#guests.list(),
							permissionsSet: this.#guests.effectivePermissions(identity),
						}
					: {}),
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if ((this.#guests.effectivePermissions(identity) & GUEST_PERMISSIONS.UI_RESPONSE) !== 0) {
			for (const pending of this.#pendingUi.values()) {
				socket.send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */
	#sendSnapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
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
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.UI_RESPONSE, "responding to ask", fromPeer)) return;
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.PROMPT, "prompting", fromPeer)) return;
		const name = this.#guests.byPeer(fromPeer)?.name ?? "a guest";
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
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	#handleAbort(fromPeer: number): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.ABORT, "interrupting", fromPeer)) return;
		const name = this.#guests.byPeer(fromPeer)?.name ?? "a guest";
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab"))
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	#handlePeerLeft(peer: number): void {
		// The registry emits guest-left (notice + guest frames) when a mapping
		// exists; peers that never hello'd were never visible anyway.
		this.#guests.detachPeer(peer);
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
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		const flag =
			cmd === "chat"
				? GUEST_PERMISSIONS.AGENT_CHAT
				: cmd === "kill"
					? GUEST_PERMISSIONS.AGENT_KILL
					: GUEST_PERMISSIONS.AGENT_REVIVE;
		if (!this.#checkPermission(flag, "agent control", fromPeer)) return;
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
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
		if (!this.#checkPermission(GUEST_PERMISSIONS.FETCH_TRANSCRIPT, "transcript reads", fromPeer)) return;
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
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

	// ── Guest management (proto-4 frames) ───────────────────────────────────

	#handleGuestInvite(
		name: string,
		role: GuestRole,
		permissionsOverride: GuestPermissionSet | undefined,
		fromPeer: number,
	): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.GUEST_INVITE, "inviting guests", fromPeer)) return;
		const actor = this.#guests.byPeer(fromPeer);
		if (!actor) return;
		this.#guests.invite(name, role, actor.id, permissionsOverride);
		this.#ctx.session.emitNotice("info", `${actor.name} invited ${name.trim()} as ${role}`, "collab");
	}

	#handleGuestKick(guestId: string, reason: string | undefined, fromPeer: number): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.GUEST_KICK, "kicking guests", fromPeer)) return;
		const actor = this.#guests.byPeer(fromPeer);
		if (!actor) return;
		const target = this.#guests.byId(guestId);
		if (!target) {
			this.#socket?.send({ t: "error", message: `no such guest: ${guestId}` }, fromPeer);
			return;
		}
		const kickedPeer = target.peerId;
		this.#guests.kick(guestId, actor.id, reason);
		// The registry event broadcast guest-left (the kicked peer is already
		// detached there); drop the pipe itself with a targeted goodbye.
		if (kickedPeer >= 0) {
			this.#socket?.send(
				{ t: "bye", reason: reason ? `removed by ${actor.name}: ${reason}` : `removed by ${actor.name}` },
				kickedPeer,
			);
		}
	}

	#handleGuestRole(guestId: string, role: GuestRole, fromPeer: number): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.GUEST_ROLE, "changing roles", fromPeer)) return;
		const actor = this.#guests.byPeer(fromPeer);
		if (!actor) return;
		if (!this.#guests.byId(guestId)) {
			this.#socket?.send({ t: "error", message: `no such guest: ${guestId}` }, fromPeer);
			return;
		}
		this.#guests.setRole(guestId, role, actor.id);
	}

	#handleGuestPermission(
		guestId: string,
		grant: GuestPermissionSet,
		revoke: GuestPermissionSet,
		fromPeer: number,
	): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.PERMISSION_MANAGE, "permission changes", fromPeer)) return;
		const actor = this.#guests.byPeer(fromPeer);
		if (!actor) return;
		if (!this.#guests.byId(guestId)) {
			this.#socket?.send({ t: "error", message: `no such guest: ${guestId}` }, fromPeer);
			return;
		}
		if (grant) this.#guests.grantPermission(guestId, grant, actor.id);
		if (revoke) this.#guests.revokePermission(guestId, revoke, actor.id);
	}

	#handleGuestMessage(
		to: string | "broadcast",
		text: string,
		kind: "chat" | "system" | undefined,
		fromPeer: number,
	): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.GUEST_CHAT, "guest chat", fromPeer)) return;
		const sender = this.#guests.byPeer(fromPeer);
		if (!sender) return;
		const cleanText = text.trim();
		if (!cleanText) {
			this.#socket?.send({ t: "error", message: "empty guest message" }, fromPeer);
			return;
		}
		const wireKind = kind ?? "chat";
		if (to === "broadcast") {
			this.#sendToGuests(
				{ t: "guest-message", from: sender, to, text: cleanText, kind: wireKind },
				identity => identity.capabilities.supportsGuestChat && identity.id !== sender.id,
			);
			return;
		}
		const target = this.#guests.byId(to);
		if (!target || target.peerId < 0 || !target.capabilities.supportsGuestChat) {
			this.#socket?.send({ t: "error", message: `guest ${to} is not available for chat` }, fromPeer);
			return;
		}
		this.#socket?.send({ t: "guest-message", from: sender, to, text: cleanText, kind: wireKind }, target.peerId);
	}

	#handleGuestPresence(status: GuestStatus, fromPeer: number): void {
		const sender = this.#guests.byPeer(fromPeer);
		if (!sender?.capabilities.supportsPresence) return;
		this.#guests.updateStatus(fromPeer, status);
	}

	#handleGuestCursor(
		agentId: string | undefined,
		position: { line: number; column: number } | undefined,
		fromPeer: number,
	): void {
		const sender = this.#guests.byPeer(fromPeer);
		if (!sender?.capabilities.supportsCursors) return;
		this.#sendToGuests(
			{ t: "guest-cursor", from: sender.id, agentId, position },
			identity => identity.capabilities.supportsCursors && identity.id !== sender.id,
		);
	}

	#handlePermissionAudit(
		reqId: number,
		guestId: string | undefined,
		limit: number | undefined,
		fromPeer: number,
	): void {
		if (!this.#checkPermission(GUEST_PERMISSIONS.PERMISSION_MANAGE, "reading the audit log", fromPeer)) return;
		this.#socket?.send({ t: "permission-audit", reqId, entries: this.#guests.auditLog(guestId, limit) }, fromPeer);
	}

	// ── Host-side management API (slash commands, scripts) ──────────────────

	/** Current guest identities, oldest join first. */
	get guests(): GuestIdentity[] {
		return this.#guests.list();
	}

	/** Queue a pending invitation; the next hello with that display name joins as {@link role}. */
	inviteGuest(name: string, role: GuestRole, permissionsOverride?: GuestPermissionSet): void {
		this.#guests.invite(name, role, "host", permissionsOverride);
	}

	/** Kick by guestId or unique display name; returns the kicked guestId or null. */
	kickGuest(target: string, reason?: string): string | null {
		const guest = this.#resolveGuest(target);
		if (!guest) return null;
		const kickedPeer = guest.peerId;
		this.#guests.kick(guest.id, "host", reason);
		if (kickedPeer >= 0) {
			this.#socket?.send(
				{ t: "bye", reason: reason ? `removed by the host: ${reason}` : "removed by the host" },
				kickedPeer,
			);
		}
		return guest.id;
	}

	/** Change a guest's role by guestId or unique display name. */
	setGuestRole(target: string, role: GuestRole): GuestIdentity | null {
		const guest = this.#resolveGuest(target);
		if (!guest) return null;
		return this.#guests.setRole(guest.id, role, "host");
	}

	grantGuestPermissions(target: string, bits: GuestPermissionSet): GuestIdentity | null {
		const guest = this.#resolveGuest(target);
		if (!guest) return null;
		return this.#guests.grantPermission(guest.id, bits, "host");
	}

	revokeGuestPermissions(target: string, bits: GuestPermissionSet): GuestIdentity | null {
		const guest = this.#resolveGuest(target);
		if (!guest) return null;
		return this.#guests.revokePermission(guest.id, bits, "host");
	}

	/** Drop per-guest overrides; the guest falls back to its role defaults. */
	clearGuestPermissions(target: string): GuestIdentity | null {
		const guest = this.#resolveGuest(target);
		if (!guest) return null;
		return this.#guests.clearGuestOverrides(guest.id, "host");
	}

	/** Guest permission audit trail, oldest first. */
	auditLog(guestId?: string, limit?: number): PermissionAuditEntry[] {
		return this.#guests.auditLog(guestId, limit);
	}

	/** Resolve a slash-command target: guestId first, then unique case-insensitive name. */
	#resolveGuest(target: string): GuestIdentity | undefined {
		const byId = this.#guests.byId(target);
		if (byId) return byId;
		const key = target.trim().toLowerCase();
		const matches = this.#guests.list().filter(identity => identity.name.trim().toLowerCase() === key);
		return matches.length === 1 ? matches[0] : undefined;
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#guests.onlineCount() + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
