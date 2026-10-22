/**
 * TUI side of a hosted session: an `InteractiveMode` whose local `AgentSession` is a permanently idle replica
 * of the session a detached host runs. Host frames feed the replica (entries), the EventController (events),
 * and the dialogs (extension UI); input goes back to the host over RPC. Same precedent as the collab guest
 * (`collab/guest.ts`) with the relay swapped for `RpcClient` over `connectSessionHost`.
 *
 * Every transcript, snapshot, and state frame applies strictly in arrival order through one promise chain. A
 * dialog is launched from that chain but never awaited by it: awaiting the user would block the `cancel` that
 * must dismiss the dialog and every streaming event behind it. A frame that fails to apply leaves the view
 * incoherent with the host, so the link fails closed: nothing further is applied, the transport is dropped
 * (the host keeps running) and `onClosed` reports why.
 *
 * The replica is a transcript copy, so it is owner-private: a `0700` directory, one `0600` file per client
 * instance and per snapshot (`<hostId>-<instance>-<n>.jsonl`). Two clients never share a replica, which would
 * make them contend for its ownership lease, and a replacement snapshot never overwrites a file the previous
 * session manager may still be flushing to. The link deletes exactly the files it created (with their
 * artifact directories): a superseded one once the session has switched off it, the rest when it leaves,
 * fails, or loses the host.
 *
 * The local session carries the host's session id from the snapshot header, so it must be a passive replica
 * (`AgentSessionConfig.passiveReplica`): disposing an ordinary session releases the resources that id scopes.
 *
 * Links in the host's transcript mean the host's files, while the footer, completion, and `@file` stay with the
 * terminal's own directory. Each snapshot installs the host's origin (`ctx.hostOrigin`: its cwd and artifact root)
 * before the transcript is painted, a relocation notice replaces it, and the link withdraws what it published when it
 * ends. Nothing of the host's artifacts is copied here.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	sanitizeDisplayLine,
	sanitizeDisplaySingleLine,
	sanitizeDisplayText,
} from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { ContextUsage } from "@oh-my-pi/pi-tui/status-line/types";
import { clearAssistantMessageLinkTargets } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { ExtensionUISelectItem } from "../extensibility/extensions/types";
import { ensurePrivateDir, pidAlive } from "../ipc/private-endpoint";
import { RpcClient, RpcCommandError } from "../modes/rpc/rpc-client";
import { MAX_RPC_REASSEMBLED_BYTES } from "../modes/rpc/rpc-frame";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostFrame,
	RpcPreconditions,
	RpcQueueAttachments,
	RpcSessionOrigin,
	RpcSnapshot,
} from "../modes/rpc/rpc-types";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSessionEvent } from "../session/agent-session";
import {
	applyReplicaEvent,
	applyReplicaHostState,
	ingestReplicaEntry,
	loadReplica,
	resetReplicaEventState,
} from "../session/replica-view";
import {
	reportTernSession,
	setExtensionTerminalTitle,
	setSessionTerminalTitle,
	setTerminalSessionSource,
	type TerminalSessionSource,
} from "../utils/title-generator";
import { connectSessionHost } from "./client";
import { StreamingMessageAccumulator } from "./message-accumulator";
import type { SessionHostEntry } from "./registry";

export interface HostedClientOptions {
	/**
	 * Must already be in hosted client mode (`ctx.hostedClientMode`: startup automation is off before the first
	 * frame) and its `session` a passive replica (`session.passiveReplica`).
	 */
	ctx: InteractiveModeContext;
	entry: SessionHostEntry;
	/** Owner-private directory for the local replica files; created (`0700`) when missing. */
	replicaDir: string;
	/**
	 * The link is closed without this client leaving ({@link HostedClientLink.detach} and
	 * {@link HostedClientLink.exit} never call it): reconnecting after a lost transport gave up or found the host
	 * gone, or a host frame could not be applied to the local view. `hostAlive` is a probe of `entry.pid`; `message`
	 * says what happened and how to continue; `sessionFile` (only when the host exited) is the session the host had
	 * open, per the last snapshot applied, undefined for an in-memory session.
	 */
	onClosed: (reason: { hostAlive: boolean; message: string; sessionFile?: string }) => void;
	/** How long reconnecting after a lost transport keeps trying while the host process lives. Default 30 s. */
	reconnectTimeoutMs?: number;
	/**
	 * The first snapshot paints below the frame already on screen (the startup header) instead of clearing the
	 * terminal history: set for the terminal's first attach, not for `/attach` switches.
	 */
	keepStartupFrame?: boolean;
}

/** A host id is 16 lowercase hex digits; it becomes part of a file name. */
const HOST_ID_PATTERN = /^[0-9a-f]{16}$/;
const REPLICA_FILE_MODE = 0o600;
/** The socket can close a few milliseconds before the OS finishes reaping a killed host. */
const HOST_EXIT_GRACE_MS = 250;
const HOST_EXIT_POLL_MS = 25;
/** Delay before each reconnect attempt; the last repeats until the host is gone or the timeout passes. */
const RECONNECT_DELAYS_MS = [0, 250, 500, 1000, 2000];
const RECONNECT_TIMEOUT_MS = 30_000;
const RECONNECTING_ERROR = "Reconnecting to the session host; try again once it is back";

type DialogRequest = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" | "ask" }>;
type OpenUrlRequest = Extract<RpcExtensionUIRequest, { method: "open_url" }>;

function isDialogRequest(request: RpcExtensionUIRequest): request is DialogRequest {
	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
		case "ask":
			return true;
		default:
			return false;
	}
}

/** What taking the newest queued message back from the host did; see {@link HostedClientLink.takeBackQueued}. */
export type QueuedTakeBack =
	/** Removed from the host's queue: its text is for the editor. */
	| { outcome: "restored"; text: string }
	/** Nothing was queued. */
	| { outcome: "empty" }
	/** The host no longer had it: it was delivered, or removed by someone else. */
	| { outcome: "delivered" }
	/** It carries an attachment that text alone would lose; left queued. */
	| { outcome: "attachment" }
	/** The host did not report which queued prompts carry attachments, so none can be told apart; left queued. */
	| { outcome: "unreported" };

function isFlagList(value: unknown, length: number): value is boolean[] {
	return Array.isArray(value) && value.length === length && value.every(flag => typeof flag === "boolean");
}

/**
 * The host's attachment flags for `queued`, or undefined when it sent none (a host that predates them) or they are not
 * parallel to the chips they came with. Flags are read by position, so a list of another length is never trusted.
 */
function readQueueAttachments(
	value: unknown,
	queued: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
): RpcQueueAttachments | undefined {
	if (typeof value !== "object" || value === null || !("steering" in value) || !("followUp" in value))
		return undefined;
	const { steering, followUp } = value;
	if (!isFlagList(steering, queued.steering.length) || !isFlagList(followUp, queued.followUp.length)) return undefined;
	return { steering: [...steering], followUp: [...followUp] };
}

/** Whether `pid` is still a running process, giving a just-killed process time to be reaped. */
async function hostProcessAlive(pid: number): Promise<boolean> {
	for (let waited = 0; pidAlive(pid); waited += HOST_EXIT_POLL_MS) {
		if (waited >= HOST_EXIT_GRACE_MS) return true;
		await Bun.sleep(HOST_EXIT_POLL_MS);
	}
	return false;
}

export class HostedClientLink {
	readonly hostId: string;
	readonly #ctx: InteractiveModeContext;
	readonly #entry: SessionHostEntry;
	readonly #replicaDir: string;
	readonly #onClosed: HostedClientOptions["onClosed"];
	readonly #reconnectTimeoutMs: number;
	readonly #keepStartupFrame: boolean;
	readonly #client: RpcClient;
	/** Distinguishes this client's replica files from every other client of the same host. */
	readonly #instanceId = crypto.randomBytes(8).toString("hex");
	#generation = 0;
	/** Replica files this link created and has not deleted yet: the only files it ever deletes. */
	readonly #replicas = new Set<string>();
	/** The origin this link published to `ctx.hostOrigin`: the only one it ever withdraws. */
	#origin: RpcSessionOrigin | undefined;
	/**
	 * The host's session file (none: an unsaved session): what Tern is told to restore instead of the replica, and
	 * what a reopen offers once the host exited.
	 */
	#sessionFile: string | undefined;
	readonly #terminalSession: TerminalSessionSource = {
		file: () => this.#sessionFile,
		cwd: () => this.#origin?.cwd ?? this.#ctx.sessionManager.getCwd(),
	};
	/** Frames apply strictly in arrival order through this chain. */
	#chain: Promise<void> = Promise.resolve();
	readonly #firstSnapshot = Promise.withResolvers<void>();
	/** The first snapshot is applied. */
	#attached = false;
	/** `connect` has resolved: from here on, a closed link reports through `onClosed`. */
	#connected = false;
	/** Explicit detach/exit, a failed connect, or a lost transport given up: nothing applies or reports any more. */
	#left = false;
	/** The transport ended unexpectedly and the link is trying to get it back; writes are refused meanwhile. */
	#reconnecting = false;
	/** The running reconnect loop, which a leave waits out. */
	#reconnectLoop: Promise<void> | undefined;
	/** The current reconnect attempt: resolved once the host's reply is applied, rejected when it cannot be. */
	#reconnectAttempt: PromiseWithResolvers<void> | undefined;
	/** When the running reconnect gives up (epoch ms). */
	#reconnectDeadline = 0;
	/**
	 * A dialog was aborted by the loss, or its answer may have died with the transport: the ring would not resend
	 * it, so the next attempt asks for a snapshot.
	 */
	#dialogLost = false;
	/** A dialog answer went out on the current transport. The host confirms none, so a loss may have dropped it. */
	#answerSent = false;
	/** What the next connection's `hello` resumes from; undefined asks for a snapshot. */
	#resumePoint: { hostId: string; epoch: number; lastSeq: number } | undefined;
	/**
	 * Rebuilds streamed messages from the host's delta updates. Kept across reconnects, so a resume's replay applies
	 * on top of it; a snapshot resets and re-seeds it.
	 */
	readonly #messages = new StreamingMessageAccumulator();
	/** A frame failed to apply, so the view no longer matches the host: nothing else is applied. */
	#failure: Error | undefined;
	/** Session epoch of the view the user sees; sent as `ifEpoch` on writes. */
	#epoch = 0;
	#idleActivity: { epoch: number; isComposing: boolean; pending: Promise<void> } | undefined;
	#isStreaming = false;
	#isCompacting = false;
	#queued: { steering: readonly string[]; followUp: readonly string[] } = { steering: [], followUp: [] };
	/** Which of {@link #queued} carry an attachment, as the host reported it with them; undefined when it did not. */
	#queuedAttachments: RpcQueueAttachments | undefined;
	/** Attached clients, as the status line shows them. */
	#clientCount = 0;
	/** The host's context usage as last read; the idle local replica cannot estimate it the way the host does. */
	#hostContext: ContextUsage | undefined;
	/** Open host dialogs by request id; aborting dismisses one without answering it. */
	readonly #dialogs = new Map<string, AbortController>();
	/**
	 * Dialog requests received and not yet presented, by request id, each with the UI generation that made it eligible.
	 * A `cancel` withdraws one the moment it arrives; a replacement snapshot discards them all and lists the ones that
	 * are still open under its own generation.
	 */
	readonly #awaiting = new Map<string, number>();
	/**
	 * The view the host currently shows this client, counted when a snapshot (the first or a replacement) is RECEIVED,
	 * not when the chain reaches it. A request or snapshot queued behind slower frames still carries the generation
	 * it arrived in, so one that belongs to an earlier view can neither present a dialog nor consume the eligibility a
	 * later view granted.
	 */
	#uiGeneration = 0;
	/** Extension status and widget keys the host set on this view: cleared when the view is replaced or left. */
	readonly #hostStatusKeys = new Set<string>();
	readonly #hostWidgetKeys = new Set<string>();

	private constructor(options: HostedClientOptions) {
		this.hostId = options.entry.hostId;
		this.#ctx = options.ctx;
		this.#entry = options.entry;
		this.#replicaDir = options.replicaDir;
		this.#onClosed = options.onClosed;
		this.#reconnectTimeoutMs = options.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS;
		this.#keepStartupFrame = options.keepStartupFrame === true;
		this.#client = new RpcClient({
			// A leave mid-reconnect may land while `start()` waits to spawn: no hello goes out after it.
			spawn: () =>
				this.#open
					? connectSessionHost({
							entry: options.entry,
							client: { kind: "tui" },
							ui: true,
							messageUpdates: "delta",
							resume: this.#resumePoint,
							// `stop()` cannot interrupt a dial: a reconnect's own is bounded by what is left of it.
							timeoutMs: this.#reconnecting ? Math.max(0, this.#reconnectDeadline - Date.now()) : undefined,
						})
					: Promise.reject(new Error("Left the session host")),
		});
	}

	/**
	 * Attach to the host and resolve once its first snapshot is fully applied: replica loaded and rendered, host
	 * state mirrored, open dialogs presented. Every listener is registered before the transport starts. A failure
	 * rejects and leaves nothing behind: the connection is dropped and the replica files are deleted.
	 */
	static async connect(options: HostedClientOptions): Promise<HostedClientLink> {
		if (!options.ctx.hostedClientMode) {
			throw new Error("Hosted client mode must be enabled before attaching: startup automation is still on");
		}
		if (!options.ctx.session.passiveReplica) {
			throw new Error(
				"The local session of a hosted client must be a passive replica: it adopts the host's session id, and disposing an ordinary session would release the resources that id scopes",
			);
		}
		if (!HOST_ID_PATTERN.test(options.entry.hostId)) {
			throw new Error(`Not a session host id: ${JSON.stringify(options.entry.hostId)}`);
		}
		await ensurePrivateDir(options.replicaDir, "hosted session replica");
		const link = new HostedClientLink(options);
		try {
			await link.#attach();
		} catch (error) {
			// A frame may still be mid-application (the transport can fail while the first snapshot is being loaded):
			// stop it taking effect, then wait for it, so nothing touches the session or the files after this rejects.
			link.#left = true;
			await link.#client.stop();
			await link.#chain;
			link.#abortDialogs();
			await link.#discardLocalState();
			throw link.#failure ?? error;
		}
		link.#connected = true;
		return link;
	}

	/** The host's queue as last reported by a snapshot or `queue_update`. */
	get queued(): { readonly steering: readonly string[]; readonly followUp: readonly string[] } {
		return this.#queued;
	}

	/** The host's agent is mid-run. The local replica never is: route on this, not on `ctx.session.isStreaming`. */
	get isStreaming(): boolean {
		return this.#isStreaming;
	}

	/** The host is compacting its context. */
	get isCompacting(): boolean {
		return this.#isCompacting;
	}

	/** Host session epoch of the view on screen: the `ifEpoch` of every write. */
	get epoch(): number {
		return this.#epoch;
	}

	/** The transport was lost and the link is getting it back: writes reject until it is. */
	get reconnecting(): boolean {
		return this.#reconnecting;
	}

	/**
	 * Send input to the host. Rejects with an `RpcCommandError` (`code: "stale"` when the session moved on under
	 * this view); the caller keeps the user's draft and the link never retries a write.
	 */
	async prompt(text: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
		await this.#client.prompt(text, images, streamingBehavior, this.#guard());
	}

	/**
	 * {@link prompt} with `steer`, resolving once all work it caused has settled, as a local `session.prompt` does.
	 * Startup messages use it so each runs as its own turn instead of steering the last.
	 */
	async promptToCompletion(text: string, images?: ImageContent[]): Promise<void> {
		await this.#client.promptToCompletion(text, { images, streamingBehavior: "steer", preconditions: this.#guard() });
	}

	/** Coalesce same-tick preferences; RPC already serializes writes, so a new draft never waits for an older ack. */
	setIdleActivity(isComposing: boolean): Promise<void> {
		const epoch = this.#epoch;
		if (this.#idleActivity?.epoch === epoch && this.#idleActivity.isComposing === isComposing) {
			return this.#idleActivity.pending;
		}
		const pending = Promise.resolve()
			.then(async () => {
				if (!this.#open || this.#reconnecting || this.#epoch !== epoch || this.#idleActivity !== report) return;
				await this.#client.setIdleActivity(isComposing, { ifEpoch: epoch });
			})
			.catch(error => {
				if (this.#idleActivity === report) this.#idleActivity = undefined;
				// A queued replacement owns the next report; this obsolete preference must not close its view.
				if (error instanceof RpcCommandError && error.code === "stale") return;
				throw error;
			});
		const report = { epoch, isComposing, pending };
		this.#idleActivity = report;
		return pending;
	}

	/** Abort the host's current run. Not epoch-guarded: an abort must reach the session the host runs now. */
	async abort(): Promise<void> {
		if (this.#reconnecting) throw new Error(RECONNECTING_ERROR);
		await this.#client.abort();
	}

	/**
	 * Take the newest queued message back from the host (steering before follow-ups, as the local queue pops), so the
	 * caller can put its text in the editor. Only a message that is text and nothing else can be: the host lists
	 * queued chips as text, so taking back a prompt that carries an image would lose the image. That is decided
	 * from the host's own report of which queued prompts carry attachments, and checked again by the host when it
	 * removes (it refuses a prompt that gained one meanwhile). Without that report (a host that predates it, or one
	 * frame that did not match its queue) nothing is removed. Everything but `restored` leaves the host's queue as it was.
	 */
	async takeBackQueued(): Promise<QueuedTakeBack> {
		const queue = this.#queued.steering.length > 0 ? "steering" : "followUp";
		const text = this.#queued[queue].at(-1);
		if (text === undefined) return { outcome: "empty" };
		const attached = this.#queuedAttachments?.[queue].at(-1);
		if (attached === undefined) return { outcome: "unreported" };
		if (attached) return { outcome: "attachment" };
		const { removed, refused } = await this.#client.removeQueuedMessage(text, queue, this.#guard(), {
			match: "last",
			refuseAttachments: true,
		});
		if (refused === "attachments") return { outcome: "attachment" };
		return removed ? { outcome: "restored", text } : { outcome: "delivered" };
	}

	/** The new model reaches this view (and every peer) as the host's `config_update`, not as a local change. */
	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#client.setModel(provider, modelId, this.#guard());
	}

	/** Cycle the host's model. `false`: the host has no other model to cycle to, so nothing changed. */
	async cycleModel(): Promise<boolean> {
		return (await this.#client.cycleModel(this.#guard())) !== null;
	}

	/** The models the host can switch to: its own credentials and custom models, not this client's. */
	availableModels(): Promise<Model[]> {
		return this.#client.getAvailableModels();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#client.setThinkingLevel(level, this.#guard());
	}

	/** Cycle the host's thinking level. `false`: the host's model has no thinking levels, so nothing changed. */
	async cycleThinkingLevel(): Promise<boolean> {
		return (await this.#client.cycleThinkingLevel(this.#guard())) !== null;
	}

	/** Leave the session running and close this client; a reconnect in progress stops without sending anything. */
	async detach(): Promise<void> {
		await this.#leave(() => this.#client.detach());
	}

	/**
	 * `detach`, or stop the host when this is its last client. Mid-reconnect nothing can carry the request: the link
	 * leaves without stopping the host and rejects, naming the host that is still running.
	 */
	async exit(): Promise<void> {
		const reconnecting = this.#reconnecting;
		await this.#leave(() => this.#client.exit());
		if (reconnecting) {
			throw new Error(`connection lost; host ${this.hostId} still running (omp attach ${this.hostId})`);
		}
	}

	async #attach(): Promise<void> {
		const client = this.#client;
		client.onHostFrame(frame => {
			if (!this.#open) return;
			const generation = this.#receiveHostFrame(frame);
			this.#enqueue(() => this.#applyHostFrame(frame, generation));
		});
		client.onSessionEvent(event => this.#enqueue(() => this.#applySessionEvent(this.#messages.apply(event))));
		client.onExtensionUiRequest(request => {
			if (this.#open) this.#receiveUiRequest(request);
		});
		client.onClose(error => this.#handleTransportClosed(error));
		// Awaited together: the first snapshot can fail while `start()` is still settling, and must not go unobserved.
		await Promise.all([client.start(), this.#firstSnapshot.promise]);
		// Every UI client must opt in before the host's `ask` tool sends one `ask` dialog instead of a `select` per question.
		await client.setAskDialog(true);
	}

	#guard(): RpcPreconditions {
		// Every guarded write starts here; while reconnecting its outcome could not be known, so it is never sent.
		if (this.#reconnecting) throw new Error(RECONNECTING_ERROR);
		return { ifEpoch: this.#epoch };
	}

	/** Whether the link still applies frames and reports through `onClosed`. */
	get #open(): boolean {
		return !this.#left && this.#failure === undefined;
	}

	/** Whether a host dialog is on screen, received and not yet presented, or answered on the current transport. */
	get #dialogsAtRisk(): boolean {
		return this.#dialogs.size > 0 || this.#awaiting.size > 0 || this.#answerSent;
	}

	/** Mark the leave before the request: nothing may report it as a lost connection, and no answer may follow it. */
	async #leave(request: () => Promise<void>): Promise<void> {
		if (!this.#open) return;
		this.#left = true;
		// Mid-reconnect there is no connection to carry the request: nothing is sent.
		const connected = !this.#reconnecting;
		this.#reconnecting = false;
		this.#reconnectAttempt?.reject(new Error("Left the session host"));
		this.#abortDialogs();
		this.#ctx.statusLine.setCollabStatus(null);
		try {
			if (connected) await request();
		} finally {
			await this.#client.stop();
			// The loop stops a connection it opened meanwhile before it returns.
			await this.#reconnectLoop;
			// Whatever was mid-apply finishes before the caller touches the shared TUI state.
			await this.#chain;
			await this.#discardLocalState();
		}
	}

	#enqueue(apply: () => Promise<void> | void): void {
		this.#chain = this.#chain
			.then(async () => {
				if (this.#open) await apply();
			})
			.catch(error => this.#handleApplyFailure(toError(error)));
	}

	#handleApplyFailure(error: Error): void {
		logger.warn("Hosted client frame apply failed", { hostId: this.hostId, error: error.message });
		if (!this.#attached) {
			this.#firstSnapshot.reject(error);
			return;
		}
		// Off the chain: this handler is part of it, so waiting for the chain here would never finish.
		void this.#failClosed(error);
	}

	/**
	 * A frame could not be applied, so entries and events can no longer be fed into this view without risking a
	 * transcript or epoch that disagrees with the host. Stop applying, drop the transport without leaving the
	 * session (the host and its other clients carry on), delete the local copy, and report.
	 */
	async #failClosed(error: Error): Promise<void> {
		if (!this.#open) return;
		this.#failure = error;
		this.#reconnecting = false;
		this.#reconnectAttempt?.reject(error);
		this.#abortDialogs();
		await this.#client.stop();
		await this.#discardLocalState();
		if (!this.#connected) return;
		const hostAlive = await hostProcessAlive(this.#entry.pid);
		this.#ctx.showError(`Hosted session view stopped: ${error.message}`);
		const base = `session view update failed: ${error.message}`;
		this.#notifyClosed({
			hostAlive,
			message: hostAlive
				? `${base} (host ${this.hostId} still running; omp attach ${this.hostId})`
				: `${base}; host exited`,
		});
	}

	#notifyClosed(reason: Parameters<HostedClientOptions["onClosed"]>[0]): void {
		try {
			this.#onClosed(reason);
		} catch (callbackError) {
			logger.error("Hosted client close callback failed", { hostId: this.hostId, error: String(callbackError) });
			this.#ctx.showError(`Failed to handle the closed host connection: ${toError(callbackError).message}`);
		}
	}

	async #applyHostFrame(frame: RpcHostFrame, uiGeneration: number): Promise<void> {
		const ctx = this.#ctx;
		switch (frame.type) {
			case "attached": {
				if (frame.hostId !== this.hostId) {
					throw new Error(`Connected to session host ${frame.hostId}, expected ${this.hostId}`);
				}
				await this.#applySnapshot(frame.snapshot, frame.epoch, uiGeneration);
				this.#attached = true;
				this.#firstSnapshot.resolve();
				this.#finishReconnect();
				return;
			}
			case "resumed":
				// Only the answer to this link's own `resume`, for the session the view still shows.
				if (!this.#reconnecting || frame.epoch !== this.#epoch) {
					throw new Error(`Session host sent a resume reply this client did not ask for (epoch ${frame.epoch})`);
				}
				this.#finishReconnect();
				return;
			case "entry": {
				// A host that predates `leafId` sends none: the entry then becomes the leaf, as it always did.
				const authoritative = frame.leafId === undefined ? undefined : { leafId: frame.leafId };
				// With it, the host's own leaf rides with the entry: an off-branch append must not move this view's branch.
				ingestReplicaEntry(ctx.session, frame.entry, authoritative);
				if (authoritative && frame.entry.type === "title_change") this.#showSessionTitle();
				return;
			}
			case "session_replaced":
				await this.#applySnapshot(frame.snapshot, frame.epoch, uiGeneration);
				return;
			case "clients_changed":
				this.#clientCount = frame.clients.length;
				this.#publishStatus();
				return;
			case "config_update":
				applyReplicaHostState(ctx.session, { model: frame.model, thinkingLevel: frame.thinkingLevel });
				this.#refreshChrome();
				// A model change moves the context window the host's usage is measured against.
				void this.#refreshHostContext();
				return;
			case "session_info_update":
				// A relocation notice: the same session, now somewhere else. Links already on screen follow it.
				if (frame.origin) {
					this.#setOrigin(frame.origin);
					// The host's session file moved with it: Tern's restore and a reopen after the host exits need the new path.
					await this.#readRelocatedSessionFile();
					await ctx.refreshTranscriptLinks();
					if (!this.#open) return;
				}
				this.#showSessionTitle(frame.title);
				return;
			case "command_output":
				ctx.showStatus(sanitizeDisplayText(frame.text));
				return;
			case "rpc_frame_error": {
				// The dropped frame never reaches this view, so it can no longer match the host.
				const limit = `${MAX_RPC_REASSEMBLED_BYTES / (1024 * 1024)} MiB RPC frame limit`;
				throw new Error(
					frame.originalType === "attached"
						? `The session is too large to attach: the host's snapshot exceeds the ${limit}`
						: `the host dropped a frame of type ${frame.originalType ?? "unknown"} over the ${limit}`,
				);
			}
		}
	}

	async #applySessionEvent(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.#isStreaming = true;
				break;
			case "agent_end":
				this.#isStreaming = false;
				break;
			case "auto_compaction_start":
				this.#isCompacting = true;
				break;
			case "auto_compaction_end":
				this.#isCompacting = false;
				break;
			case "queue_update":
				this.#queued = { steering: [...event.steering], followUp: [...event.followUp] };
				this.#queuedAttachments = readQueueAttachments(
					"attachments" in event ? event.attachments : undefined,
					this.#queued,
				);
				break;
			case "thinking_level_changed":
				// Before the handler runs: it restyles the editor and thinking blocks from the session's level,
				// and this event outruns the host's `config_update` for the same change.
				this.#ctx.session.setReplicaThinkingLevel(event.thinkingLevel);
				break;
		}
		await applyReplicaEvent(this.#ctx, event);
		if (event.type === "queue_update") {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
		}
		// The host's usage moves when a turn settles or compaction rewrites its context.
		if (event.type === "agent_end" ? event.isTerminal !== false : event.type === "auto_compaction_end") {
			void this.#refreshHostContext();
		}
	}

	/**
	 * Replace the whole view with `snapshot`: load it into a fresh replica file, drop every UI anchor of the
	 * previous session, mirror the host's state, repaint, and present the dialogs that are still open.
	 */
	async #applySnapshot(snapshot: RpcSnapshot, epoch: number, uiGeneration: number): Promise<void> {
		const { header, state, origin } = snapshot;
		if (!header) throw new Error("Session host sent a snapshot without a session header");
		// Its links mean the host's files, so a host that cannot say where its session lives cannot be shown.
		if (!origin) {
			throw new Error(
				"Session host sent a snapshot without where its session lives (origin): it is an older build; stop it and attach again",
			);
		}
		const ctx = this.#ctx;
		const replicaPath = path.join(this.#replicaDir, `${this.hostId}-${this.#instanceId}-${++this.#generation}.jsonl`);
		// Tracked before the write: a failure or a leave in between must still find the file to delete.
		this.#replicas.add(replicaPath);
		const activated = await loadReplica(ctx.session, replicaPath, header, snapshot.entries, {
			isLive: () => this.#open,
			fileMode: REPLICA_FILE_MODE,
			// The loader picks the last journal entry as the branch; the host may be on another.
			leafId: snapshot.leafId,
		});
		if (!activated || !this.#open) return;
		// Before the repaint below: its links resolve against the host this snapshot came from, not the terminal's directory.
		this.#setOrigin(origin);
		this.#sessionFile = state.sessionFile;
		setTerminalSessionSource(this.#terminalSession);
		// The session switched off every earlier replica of this link after flushing it. One that cannot be removed
		// now stays owned, for the cleanup when the link ends.
		for (const superseded of this.#replicas) {
			if (superseded === replicaPath) continue;
			if (await this.#deleteReplica(superseded)) this.#replicas.delete(superseded);
		}

		// Live blocks of the previous session survive a failed repaint (see CollabGuestLink#finalizeSnapshot): seal, don't dispose.
		const orphanedLiveBlocks = [...ctx.pendingTools.values(), ...ctx.eventController.takeDisplaceableComponents()];
		ctx.clearTransientSessionUi();
		ctx.eventController.resetTranscriptAnchors();
		resetReplicaEventState(ctx);
		this.#messages.reset();

		this.#isStreaming = state.isStreaming;
		this.#isCompacting = state.isCompacting;
		this.#hostContext = state.contextUsage;
		this.#queued = { steering: [...state.queuedMessages.steering], followUp: [...state.queuedMessages.followUp] };
		this.#queuedAttachments = readQueueAttachments(snapshot.queueAttachments, this.#queued);
		applyReplicaHostState(ctx.session, { model: state.model, thinkingLevel: state.thinkingLevel });
		setSessionTerminalTitle(state.sessionName ?? header.title, ctx.sessionManager.getCwd());
		this.#clientCount = snapshot.clients.length;
		this.#publishStatus();

		// Run bookkeeping (loader, activity meter) before the replay creates its pending tool handles.
		if (state.isStreaming) await ctx.eventController.handleEvent({ type: "agent_start" });
		else ctx.statusLine.markActivityEnd();
		try {
			// The terminal's first attach keeps the startup frame (as an in-process launch does); a switch replaces it.
			await ctx.renderInitialMessages(
				this.#keepStartupFrame && !this.#attached ? { preserveExistingChat: true } : { clearTerminalHistory: true },
			);
		} catch (error) {
			for (const handle of orphanedLiveBlocks) handle.seal();
			throw error;
		}
		ctx.eventController.restorePendingToolResults();
		// The snapshot carries the in-flight message but no provider event for it: start it once and let the next
		// real delta update it, instead of fabricating an update.
		if (snapshot.streaming) {
			const { messageId, message } = snapshot.streaming;
			if (message.role === "assistant") this.#messages.seed(messageId, message);
			await applyReplicaEvent(ctx, { type: "message_start", message });
		}
		await ctx.reloadTodos();
		if (!this.#open) return;

		this.#epoch = epoch;
		ctx.updatePendingMessagesDisplay();
		this.#refreshChrome();
		// Statuses and widgets the host's extensions show now, most set before this client attached.
		this.#clearHostUi();
		for (const request of snapshot.uiState ?? []) this.#applyUiRequest(request, uiGeneration);
		// Only the dialogs still wanted: one the host withdrew while this snapshot was applying is no longer awaited.
		for (const request of snapshot.pendingUi) this.#applyUiRequest(request, uiGeneration);
		await this.setIdleActivity(ctx.editor.getText().trim() !== "");
	}

	/**
	 * Delete one replica this link created, with its artifact directory. A failure is reported, never ignored, and
	 * leaves the file owned so the next cleanup retries it; returns whether the file is gone.
	 */
	async #deleteReplica(file: string): Promise<boolean> {
		try {
			// Through the session manager: it closes its append writer before the file goes (as `/session delete` does).
			await this.#ctx.session.sessionManager.dropSession(file);
			return true;
		} catch (error) {
			logger.warn("Hosted client replica not removed", { file, error: String(error) });
			this.#ctx.showWarning(`Could not remove the local copy of the hosted session: ${file}`);
			return false;
		}
	}

	/**
	 * Delete everything this link put on this terminal: the replicas it still owns (nothing else in the directory is
	 * touched) and the origin it published. Every way a link ends comes here.
	 */
	async #discardLocalState(): Promise<void> {
		this.#retireOrigin();
		this.#clearHostUi();
		for (const file of this.#replicas) {
			if (await this.#deleteReplica(file)) this.#replicas.delete(file);
		}
	}

	/** Remove every status and widget the host set on this view. */
	#clearHostUi(): void {
		for (const key of this.#hostStatusKeys) this.#ctx.setHookStatus(key, undefined);
		for (const key of this.#hostWidgetKeys) this.#ctx.setHookWidget(key, undefined);
		this.#hostStatusKeys.clear();
		this.#hostWidgetKeys.clear();
	}

	/**
	 * Make `origin` (none: withdrawn) the place this view's links resolve. Everything resolved against the previous
	 * place is dropped: a link that appears before the next refresh must not open it.
	 */
	#setOrigin(origin: RpcSessionOrigin | undefined): void {
		this.#origin = origin;
		this.#ctx.hostOrigin = origin;
		clearAssistantMessageLinkTargets(this.#ctx);
	}

	/**
	 * Withdraw the origin this link published, and the host session it reports to the terminal with it, unless
	 * something else has replaced them since.
	 */
	#retireOrigin(): void {
		if (this.#origin === undefined || this.#ctx.hostOrigin !== this.#origin) return;
		this.#setOrigin(undefined);
		setTerminalSessionSource(undefined);
	}

	/** A relocation moved the host's session file, and its notice names only the new directory: read the file back. */
	async #readRelocatedSessionFile(): Promise<void> {
		try {
			const { sessionFile } = await this.#client.getState();
			if (!this.#open) return;
			this.#sessionFile = sessionFile;
		} catch (error) {
			// Leaving or losing the host fails the request too; those are reported by their own paths.
			if (this.#open && !this.#reconnecting) {
				logger.warn("Hosted client could not read the relocated session file", {
					hostId: this.hostId,
					error: String(error),
				});
			}
		}
		if (this.#open) reportTernSession();
	}

	/**
	 * Dialog requests are accepted when they are RECEIVED, not when the transcript chain reaches them: a host's
	 * `cancel` (another client answered) and a replacement snapshot must withdraw a dialog at once, even while a slow
	 * event is still being applied. The presentation itself stays serialized with the transcript, and is tied to the
	 * UI generation the request arrived in.
	 */
	#receiveUiRequest(request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask": {
				// One presentation per request id, whether it arrived live or inside a snapshot.
				if (this.#dialogs.has(request.id) || this.#awaiting.has(request.id)) return;
				const generation = this.#uiGeneration;
				this.#awaiting.set(request.id, generation);
				this.#enqueue(() => this.#applyUiRequestReporting(request, generation));
				return;
			}
			case "cancel":
				this.#awaiting.delete(request.targetId);
				this.#dismissDialog(request.targetId);
				return;
			default: {
				const generation = this.#uiGeneration;
				this.#enqueue(() => this.#applyUiRequestReporting(request, generation));
			}
		}
	}

	/**
	 * A snapshot replaces the view: whatever was presented or waiting belongs to the old one, and the snapshot lists
	 * what is still open, under the new generation. Returns the generation `frame` belongs to.
	 */
	#receiveHostFrame(frame: RpcHostFrame): number {
		if (frame.type !== "attached" && frame.type !== "session_replaced") return this.#uiGeneration;
		this.#abortDialogs();
		const generation = ++this.#uiGeneration;
		for (const request of frame.snapshot.pendingUi) {
			if (isDialogRequest(request)) this.#awaiting.set(request.id, generation);
		}
		return generation;
	}

	/**
	 * Present a received dialog unless it was withdrawn (cancelled, replaced, or the link ended) before its turn, or
	 * its turn belongs to an earlier view than the one that made the request eligible: a request or snapshot queued
	 * behind slower frames must not consume the eligibility a later replacement granted for the same id.
	 */
	#presentAwaiting(request: DialogRequest, generation: number): void {
		if (this.#awaiting.get(request.id) !== generation) return;
		this.#awaiting.delete(request.id);
		this.#presentDialog(request);
	}

	#publishStatus(): void {
		this.#ctx.statusLine.setCollabStatus({
			role: "hosted",
			participantCount: this.#clientCount,
			contextUsage: this.#hostContext,
		});
		this.#refreshChrome();
	}

	/** Ask the host for its current context usage. Best effort: a failure keeps the last reading. */
	async #refreshHostContext(): Promise<void> {
		const epoch = this.#epoch;
		try {
			const { contextUsage } = await this.#client.getState();
			// A replaced session or a closed link no longer owns this reading.
			if (!this.#open || this.#epoch !== epoch) return;
			this.#hostContext = contextUsage;
			this.#publishStatus();
		} catch (error) {
			// Leaving or losing the host fails the request too; those are reported by their own paths.
			if (this.#open && !this.#reconnecting) {
				logger.warn("Hosted client could not read the host's context usage", {
					hostId: this.hostId,
					error: String(error),
				});
			}
		}
	}

	/** Show the host's session name (the replica already holds it: see `ingestReplicatedEntry`) in the terminal title and chrome. */
	#showSessionTitle(title: string | undefined = this.#ctx.sessionManager.getSessionName()): void {
		setSessionTerminalTitle(title, this.#ctx.sessionManager.getCwd());
		this.#refreshChrome();
	}

	#refreshChrome(): void {
		this.#ctx.updateEditorBorderColor();
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}

	/** A failing UI request must not end the link: it never touches the transcript or the epoch. */
	#applyUiRequestReporting(request: RpcExtensionUIRequest, generation: number): void {
		try {
			this.#applyUiRequest(request, generation);
		} catch (error) {
			logger.warn("Hosted client UI request failed", {
				hostId: this.hostId,
				method: request.method,
				error: String(error),
			});
			this.#ctx.showError(
				`Could not apply a session host UI request (${request.method}): ${toError(error).message}`,
			);
		}
	}

	/** `generation`: the UI generation `request` was received in (`#uiGeneration`). */
	#applyUiRequest(request: RpcExtensionUIRequest, generation: number): void {
		const ctx = this.#ctx;
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask":
				this.#presentAwaiting(request, generation);
				return;
			case "cancel":
				// Withdrawn when it was received (see #receiveUiRequest), not when the transcript chain reaches it.
				return;
			case "notify":
				ctx.showHookNotify(sanitizeDisplayText(request.message), request.notifyType);
				return;
			case "setStatus":
				if (request.statusText === undefined) this.#hostStatusKeys.delete(request.statusKey);
				else this.#hostStatusKeys.add(request.statusKey);
				ctx.setHookStatus(
					request.statusKey,
					request.statusText === undefined ? undefined : sanitizeDisplayLine(request.statusText),
				);
				return;
			case "setWidget":
				if (request.widgetLines === undefined) this.#hostWidgetKeys.delete(request.widgetKey);
				else this.#hostWidgetKeys.add(request.widgetKey);
				// Untrusted host text, like the status above; indentation is kept, so no trim.
				ctx.setHookWidget(request.widgetKey, request.widgetLines?.map(sanitizeDisplaySingleLine), {
					placement: request.widgetPlacement,
				});
				return;
			case "setTitle":
				setExtensionTerminalTitle(request.title);
				return;
			case "set_editor_text":
				ctx.editor.setText(request.text);
				return;
			case "open_url":
				this.#openUrl(request);
				return;
		}
	}

	/** A browser launch is a side effect: only web URLs, never a path or an arbitrary scheme the host named. */
	#openUrl(request: OpenUrlRequest): void {
		const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
		if (url?.protocol !== "http:" && url?.protocol !== "https:") {
			this.#ctx.showError(`Session host asked to open an unsupported URL: ${sanitizeDisplayLine(request.url)}`);
			return;
		}
		this.#ctx.openInBrowser(url.href);
		const lines = [`Opening ${sanitizeDisplayLine(request.launchUrl ?? url.href)}`];
		if (request.instructions) lines.push(sanitizeDisplayLine(request.instructions));
		this.#ctx.showStatus(lines.join("\n"));
	}

	/**
	 * Show a host dialog without waiting for the user. The first answer wins on the host: a `cancel` (or a leave, or
	 * a session replacement) aborts the presentation, and an aborted presentation never answers.
	 */
	#presentDialog(request: DialogRequest): void {
		if (this.#dialogs.has(request.id)) return;
		const abort = new AbortController();
		this.#dialogs.set(request.id, abort);
		this.#askUser(request, abort.signal).then(
			response => {
				if (this.#dialogs.get(request.id) !== abort) return;
				this.#dialogs.delete(request.id);
				this.#answerSent = true;
				try {
					this.#client.sendExtensionUiResponse(response);
				} catch (error) {
					logger.warn("Hosted client dialog answer not sent", { hostId: this.hostId, error: String(error) });
					this.#ctx.showError(`Could not send your answer to the session host: ${toError(error).message}`);
				}
			},
			error => {
				if (this.#dialogs.get(request.id) !== abort) return;
				this.#dialogs.delete(request.id);
				logger.warn("Hosted client dialog failed", { hostId: this.hostId, error: String(error) });
				this.#ctx.showError(`Could not show a session host dialog: ${toError(error).message}`);
			},
		);
	}

	async #askUser(request: DialogRequest, signal: AbortSignal): Promise<RpcExtensionUIResponse> {
		const { id } = request;
		const ctx = this.#ctx;
		const cancelled: RpcExtensionUIResponse = { type: "extension_ui_response", id, cancelled: true };
		switch (request.method) {
			case "select": {
				const items = request.options.map((label, index): ExtensionUISelectItem => {
					const description = request.optionDetails?.[index]?.description;
					return description ? { label, description } : label;
				});
				const value = await ctx.showHookSelector(sanitizeDisplayText(request.title), items, { signal });
				return value === undefined ? cancelled : { type: "extension_ui_response", id, value };
			}
			case "confirm": {
				const confirmed = await ctx.showHookConfirm(
					sanitizeDisplayText(request.title),
					sanitizeDisplayText(request.message),
					{ signal },
				);
				return { type: "extension_ui_response", id, confirmed };
			}
			case "input": {
				const value = await ctx.showHookInput(
					sanitizeDisplayText(request.title),
					request.placeholder === undefined ? undefined : sanitizeDisplayText(request.placeholder),
					{ signal },
				);
				return value === undefined ? cancelled : { type: "extension_ui_response", id, value };
			}
			case "editor": {
				const value = await ctx.showHookEditor(
					sanitizeDisplayText(request.title),
					request.prefill,
					{ signal },
					{ promptStyle: request.promptStyle },
				);
				return value === undefined ? cancelled : { type: "extension_ui_response", id, value };
			}
			case "ask": {
				const result = await ctx.showAskDialog(request.questions, { signal });
				if (result === undefined) return cancelled;
				// "Discuss instead" is an outcome of its own, not a cancellation.
				if (result.kind === "chat") return { type: "extension_ui_response", id, chat: true };
				return {
					type: "extension_ui_response",
					id,
					answers: result.results.map(item => ({
						id: item.id,
						selectedOptions: item.selectedOptions,
						customInput: item.customInput,
						customInputImages: item.customInputImages,
						note: item.note,
						noteImages: item.noteImages,
					})),
				};
			}
		}
	}

	#dismissDialog(requestId: string): void {
		const abort = this.#dialogs.get(requestId);
		if (!abort) return;
		this.#dialogs.delete(requestId);
		abort.abort();
	}

	/**
	 * Dismiss every open dialog without answering. Newest first, so settling the presented dialog cannot flash a
	 * queued one onto the surface before its own abort.
	 */
	#abortDialogs(): void {
		this.#awaiting.clear();
		const aborts = [...this.#dialogs.values()];
		this.#dialogs.clear();
		for (const abort of aborts.reverse()) abort.abort();
	}

	#handleTransportClosed(error: Error): void {
		if (!this.#open) return;
		if (!this.#connected) {
			// Nothing can be answered over a dead transport.
			this.#abortDialogs();
			// `connect` is still waiting on this transport: its pending request or first snapshot fails with it.
			this.#firstSnapshot.reject(error);
			return;
		}
		if (this.#reconnecting) {
			// A reconnect attempt's transport died before the link was back: the loop tries again.
			const attempt = this.#reconnectAttempt;
			this.#reconnectAttempt = undefined;
			attempt?.reject(error);
			this.#dialogLost ||= this.#dialogsAtRisk;
			this.#abortDialogs();
			return;
		}
		this.#reconnecting = true;
		// A dialog aborted here gets no replay from the ring: resuming without `resume` makes the snapshot present it again.
		this.#dialogLost = this.#dialogsAtRisk;
		this.#abortDialogs();
		this.#reconnectLoop = this.#reconnect(error);
	}

	/** The host's reply to a reconnect attempt is applied; the loop still restores per-connection settings. */
	#finishReconnect(): void {
		this.#reconnectAttempt?.resolve();
	}

	/**
	 * Get the transport back: resume from the host's replay ring, or take a fresh snapshot, until the host process is
	 * gone or the timeout passes. Commands in flight at the loss already failed with it and are never resent.
	 */
	async #reconnect(error: Error): Promise<void> {
		this.#reconnectDeadline = Date.now() + this.#reconnectTimeoutMs;
		// Frames that arrived before the close still render before anything else happens.
		await this.#chain;
		if (!this.#open) return;
		logger.warn("Session host connection lost; reconnecting", { hostId: this.hostId, error: error.message });
		this.#ctx.showStatus(`Connection to session host ${this.hostId} lost; reconnecting…`, { dim: true });
		// Detach, exit, or terminal shutdown may land at any await below: nothing is opened or reported after it.
		const stopped = (): boolean => !this.#open || this.#ctx.isShuttingDown;
		for (let attempt = 0; ; attempt++) {
			if (stopped()) return;
			const outcome = Promise.withResolvers<void>();
			let attemptTimer: NodeJS.Timeout | undefined;
			this.#reconnectAttempt = outcome;
			try {
				const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
				const left = (): number => this.#reconnectDeadline - Date.now();
				await Promise.race([Bun.sleep(Math.min(delay, Math.max(0, left()))), outcome.promise]);
				// A failed attempt may have applied frames: the resume point never passes what the view shows.
				await this.#chain;
				if (stopped()) return;
				// A plain probe keeps the schedule; a host still dying is caught by the next attempt.
				const hostAlive = pidAlive(this.#entry.pid);
				if (!hostAlive || left() <= 0) {
					await this.#closeLost(hostAlive, error);
					return;
				}
				// A host that accepts and never answers would hold `start()` for its own ready timeout: the attempt
				// gets only what is left of the reconnect timeout, as does its dial. `stop()` reports no close, so the
				// attempt is failed here.
				attemptTimer = setTimeout(() => {
					outcome.reject(new Error("Session host did not answer before the reconnect timeout"));
					void this.#client.stop();
				}, left());
				// `start()` resets `lastSeq`: an attempt that decoded nothing stamped keeps the previous point.
				const lastSeq = this.#client.lastSeq ?? this.#resumePoint?.lastSeq;
				this.#resumePoint =
					this.#dialogLost || lastSeq === undefined
						? undefined
						: { hostId: this.hostId, epoch: this.#epoch, lastSeq };
				// Folded into `#dialogLost` already: from here on, answers go out on the new transport.
				this.#answerSent = false;
				await this.#client.start();
				if (stopped()) throw new Error("Left the session host");
				await outcome.promise;
				// Per-connection settings do not survive a reconnect; writes stay refused until it is restored.
				await this.#client.setAskDialog(true);
				if (stopped()) throw new Error("Left the session host");
				// The transport died after the reply applied: its close handler dropped this attempt.
				if (this.#reconnectAttempt !== outcome) throw new Error("Session host connection lost again");
			} catch (attemptError) {
				clearTimeout(attemptTimer);
				logger.debug("Session host reconnect attempt failed", {
					hostId: this.hostId,
					error: String(attemptError),
				});
				// A transport that died inside `start()` reports no close: dialogs its snapshot presented end here.
				this.#dialogLost ||= this.#dialogsAtRisk;
				this.#abortDialogs();
				await this.#client.stop();
				continue;
			}
			clearTimeout(attemptTimer);
			if (!this.#open) return;
			this.#reconnecting = false;
			this.#reconnectAttempt = undefined;
			void this.#refreshHostContext();
			// The new connection has no draft report, and any report made while reconnecting was never sent.
			this.#idleActivity = undefined;
			this.setIdleActivity(this.#ctx.editor.getText().trim() !== "").catch(reportError => {
				if (this.#open && !this.#reconnecting) {
					logger.warn("Hosted client could not report its draft state", {
						hostId: this.hostId,
						error: String(reportError),
					});
				}
			});
			this.#ctx.showStatus(`Reconnected to session host ${this.hostId}`, { dim: true });
			return;
		}
	}

	/** Reconnecting ended without the host: delete the local copy and report. */
	async #closeLost(hostAlive: boolean, error: Error): Promise<void> {
		this.#left = true;
		this.#reconnecting = false;
		this.#reconnectAttempt = undefined;
		await this.#client.stop();
		await this.#discardLocalState();
		logger.warn("Session host connection closed", { hostId: this.hostId, hostAlive, error: error.message });
		// A fresh session the host never wrote has no file to reopen.
		const sessionFile =
			!hostAlive && this.#sessionFile !== undefined && (await Bun.file(this.#sessionFile).exists())
				? this.#sessionFile
				: undefined;
		this.#notifyClosed(
			hostAlive
				? { hostAlive, message: `connection lost (host ${this.hostId} still running; omp attach ${this.hostId})` }
				: { hostAlive, message: "host exited", sessionFile },
		);
	}
}
