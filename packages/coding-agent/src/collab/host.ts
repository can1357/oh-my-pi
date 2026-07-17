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
import * as os from "node:os";
import type { ImageContent, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type {
	BusChannel,
	RemoteSessionScope,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@pk-nerdsaver-ai/pi-wire";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import type { SessionInfo } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { clearCollabLinkFile } from "./link-file";
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
import { findLoadableRemoteSession, selectRemoteSessions, toRemoteSessionSnapshot } from "./remote-control";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
/** Serialized-size cap per `snapshot-chunk` frame in the post-welcome transcript train (#3144). */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
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
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: InteractiveModeContext): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
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
	#sessionId = "";
	#unsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#stopped = false;
	#loadingRemoteSession = false;

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
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event });
			this.#onEventForState(event);
		});
		const bus = this.#ctx.eventBus;
		if (bus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(bus.on(channel, data => this.#broadcast({ t: "bus", channel, data })));
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry });
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
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.collabHost = undefined;
		clearCollabLinkFile();
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			if (this.#loadingRemoteSession) return;
			void this.stop("session switched");
			this.#ctx.session.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		this.#socket.send(frame);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
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
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			case "list-sessions":
				void this.#handleListSessions(frame.reqId, frame.scope, frame.limit, fromPeer);
				break;
			case "load-session":
				void this.#handleLoadSession(frame.reqId, frame.path, fromPeer);
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
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	#handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		this.#sendWelcome(fromPeer, canWrite);
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#sendWelcome(fromPeer: number, canWrite: boolean): void {
		// Snapshot and send synchronously: no awaits between snapshot and send, so
		// later entries/events queue behind the welcome on the same socket and the
		// guest never sees a gap.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab snapshot exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		// Small welcome first — the guest clears its first-welcome timeout on
		// arrival — then the transcript as a `snapshot-chunk` train, all queued
		// synchronously so no other directed frame can interleave (#3144).
		this.#socket?.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				entryCount: entries.length,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		let chunk: typeof entries = [];
		let chunkBytes = 0;
		const flush = (final: boolean): void => {
			this.#socket?.send({ t: "snapshot-chunk", entries: chunk, final }, fromPeer);
			chunk = [];
			chunkBytes = 0;
		};
		for (const entry of entries) {
			const bytes = JSON.stringify(entry).length;
			if (chunk.length > 0 && chunkBytes + bytes > SNAPSHOT_CHUNK_BYTES) flush(false);
			chunk.push(entry);
			chunkBytes += bytes;
		}
		// The final (possibly empty) chunk terminates the train; the guest resumes
		// the replica only after seeing it.
		flush(true);
	}

	#resyncGuests(): void {
		for (const [peer, { canWrite }] of this.#peers) {
			this.#sendWelcome(peer, canWrite);
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
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
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

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
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
					cwd: ref.cwd,
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
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
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
					if (ref && ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId);
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	async #listSessionsForRemote(
		scope: RemoteSessionScope | undefined,
	): Promise<{ scope: RemoteSessionScope; sessions: SessionInfo[] }> {
		const resolvedScope = scope === "all" ? "all" : "project";
		const sessions =
			resolvedScope === "all"
				? await SessionManager.listAll()
				: await SessionManager.list(this.#ctx.sessionManager.getCwd(), this.#ctx.sessionManager.getSessionDir());
		return { scope: resolvedScope, sessions };
	}

	async #handleListSessions(
		reqId: number,
		scope: RemoteSessionScope | undefined,
		limit: number | undefined,
		fromPeer: number,
	): Promise<void> {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("session listing", fromPeer);
			return;
		}
		try {
			const { scope: resolvedScope, sessions } = await this.#listSessionsForRemote(scope);
			this.#socket?.send(
				{
					t: "sessions",
					reqId,
					scope: resolvedScope,
					sessions: selectRemoteSessions(sessions, limit),
					currentPath: this.#ctx.sessionManager.getSessionFile(),
				},
				fromPeer,
			);
		} catch (err) {
			logger.warn("collab list-sessions failed", { error: String(err) });
			this.#socket?.send(
				{
					t: "sessions",
					reqId,
					scope: scope === "all" ? "all" : "project",
					sessions: [],
					error: String(err),
				},
				fromPeer,
			);
		}
	}

	async #handleLoadSession(reqId: number, requestedPath: string, fromPeer: number): Promise<void> {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("session loading", fromPeer);
			return;
		}
		const trimmedPath = requestedPath.trim();
		if (!trimmedPath) {
			this.#socket?.send({ t: "session-loaded", reqId, error: "empty session path" }, fromPeer);
			return;
		}
		try {
			const sessions = await SessionManager.listAll();
			const session = findLoadableRemoteSession(sessions, trimmedPath);
			if (!session) {
				this.#socket?.send(
					{ t: "session-loaded", reqId, error: "session is not in the known session list" },
					fromPeer,
				);
				return;
			}
			this.#loadingRemoteSession = true;
			try {
				await this.#ctx.handleResumeSession(session.path);
				this.#sessionId = this.#ctx.sessionManager.getSessionId();
				this.#lastStateJson = "";
			} finally {
				this.#loadingRemoteSession = false;
			}
			this.#ctx.session.emitNotice("info", "Remote control loaded a session", "collab");
			this.#socket?.send({ t: "session-loaded", reqId, session: toRemoteSessionSnapshot(session) }, fromPeer);
			this.#resyncGuests();
			this.#scheduleStateBroadcast();
		} catch (err) {
			logger.warn("collab load-session failed", { error: String(err) });
			this.#socket?.send({ t: "session-loaded", reqId, error: String(err) }, fromPeer);
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
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
				slice = slice.subarray(0, lastNewline >= 0 ? lastNewline + 1 : 0);
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
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
