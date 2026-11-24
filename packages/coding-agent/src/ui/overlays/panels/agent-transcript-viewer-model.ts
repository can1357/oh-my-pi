/**
 * State of the Agent Hub transcript viewer: a parked subagent's, an
 * advisor's or a collab guest's transcript (no live in-view session).
 *
 * Local transcripts tail append-only growth: an unchanged file identity and
 * matching sentinel windows mean only new JSONL is parsed and appended; a
 * rewrite, truncation or rotation reloads the whole file. Remote (collab
 * guest) transcripts read the host's byte-capped increments. The message
 * draft revives a parked agent (or steers a live one) on send; advisors are
 * read-only.
 */
import type * as fs from "node:fs";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { type Accessor, signal, untrack } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentHubRemote } from "../../../modes/view-model/overlays/agent-hub";
import type {
	AgentTranscriptEntry,
	AgentTranscriptSource,
} from "../../../modes/view-model/overlays/agent-transcript-viewer";
import { type TurnUsageSummary, TurnUsageTally } from "../../../modes/view-model/overlays/usage-row";
import { imageContent, type SessionMessageEntryLike, textContent } from "../../../session/transcript/transcript-entry";
import { ToolCall, type ToolCallOptions, type ToolCallResult } from "../../transcript/tool-block";
import type { LineValue } from "./common";
import { getKeybindings } from "../../../config/keybindings/keybindings";

export type ViewerAgentStatus = "running" | "idle" | "parked" | "aborted";

/** The registry entry the viewer reads. */
export interface ViewerAgentRef {
	readonly kind: string;
	readonly status: ViewerAgentStatus;
	readonly parentId?: string;
	readonly sessionFile?: string | null;
}

/**
 * The session's handlers of transcript controls (a prompt's copy and rewind,
 * a reply's copy, a turn's hold menu). The viewer's blocks run the same ones
 * as the session's own transcript.
 */
export interface ViewerTranscriptActions {
	/** A prompt bubble's control or hold-menu entry (`copy-message`, `rewind`, `edit-turn`, …). */
	prompt(act: string, text: string, timestamp: number): void;
	/** A reply's control or hold-menu entry (`copy-answer`, `retry-turn`, …). */
	reply(act: string, message: AssistantMessage, copyText?: string): void;
}

/** The progress snapshot behind the stats row. */
export interface ViewerProgress {
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly durationMs: number;
	readonly toolCount: number;
	readonly cost: number;
}

export interface AgentTranscriptViewerDeps {
	readonly agentId: string;
	readonly transcript: AgentTranscriptSource;
	readonly registry: { get(id: string): ViewerAgentRef | undefined };
	/** Collab guest: the host serves the transcript. */
	readonly remote?: AgentHubRemote;
	/** Progress snapshot source for the stats row. */
	readonly observers?: { getSession(id: string): { readonly progress?: ViewerProgress } | undefined };
	/** Revive+prompt path of messageable local agents (lazy). */
	readonly lifecycle?: () => {
		ensureLive(
			id: string,
		): Promise<{ prompt(text: string, options: { streamingBehavior: "steer" }): Promise<unknown> }>;
	};
	/** Terminal rows (the viewer fills the screen). */
	readonly terminalRows: () => number;
	/** Keys that toggle tool and thinking expansion (`ctrl+o`). */
	readonly expandKeys: readonly string[];
	/** Keys that close the whole hub. */
	readonly hubKeys: readonly string[];
	/** Close this viewer (back to the hub). */
	readonly onClose: () => void;
	/** Close the viewer and the hub. */
	readonly onHubClose: () => void;
	/** Re-read interval (ms); default 250. */
	readonly pollMs?: number;
	/** Entry to start the terminal view at (opened from an activity row). */
	readonly initialEntryId?: string;
	/** Transcript controls; blocks only show them with a handler. */
	readonly actions?: ViewerTranscriptActions;
	/** The terminal's clock (`hour12`) prompt times follow; the locale default when undefined. */
	readonly hour12?: Accessor<boolean | undefined>;
	/** Opens the inspector of a bash card's command. */
	readonly inspectShell?: ToolCallOptions["inspectShell"];
}

/** One block of the transcript. */
export type ViewerBlock =
	| {
			readonly kind: "user";
			readonly id: string;
			readonly text: string;
			readonly synthetic: boolean;
			readonly timestamp: number;
			readonly liveSteered: boolean;
			readonly images: readonly ImageContent[];
	  }
	| {
			readonly kind: "parentIrc";
			readonly id: string;
			readonly parentIrc: { readonly from: string; readonly body: string };
			readonly timestamp: number;
	  }
	| {
			readonly kind: "assistant";
			readonly id: string;
			readonly message: AssistantMessage;
			readonly usage: TurnUsageSummary | undefined;
	  }
	| { readonly kind: "tool"; readonly id: string; readonly call: ToolCall }
	| { readonly kind: "compaction"; readonly id: string; readonly summary: string; readonly tokensBefore: number }
	| { readonly kind: "branch"; readonly id: string; readonly summary: string };

const POLL_MS = 250;
/** Every Nth idle poll re-reads the sentinels (rewrites that keep size and mtime). */
const SENTINEL_CHECK_EVERY = 5;
const SENTINEL_BYTES = 4096;

interface Sentinel {
	readonly offset: number;
	readonly bytes: Buffer;
}

interface LocalState {
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	/** Bytes after the last complete line. */
	readonly pending: string;
	readonly sentinels: readonly Sentinel[];
}

function readRange(source: AgentTranscriptSource["fs"], file: string, offset: number, length: number): Buffer {
	const buffer = Buffer.alloc(Math.max(0, length));
	if (length <= 0) return buffer;
	const fd = source.openSync(file, "r");
	try {
		let read = 0;
		while (read < length) {
			const n = source.readSync(fd, buffer, read, length - read, offset + read);
			if (n <= 0) break;
			read += n;
		}
		return read === length ? buffer : buffer.subarray(0, read);
	} finally {
		source.closeSync(fd);
	}
}

/** The head and tail windows of the first `size` bytes. */
function sentinelWindows(size: number): number[] {
	if (size <= 0) return [];
	const tail = Math.max(0, size - SENTINEL_BYTES);
	return tail === 0 ? [0] : [0, tail];
}

function sentinelsOf(data: Buffer): Sentinel[] {
	return sentinelWindows(data.byteLength).map(offset => ({
		offset,
		bytes: Buffer.from(data.subarray(offset, Math.min(data.byteLength, offset + SENTINEL_BYTES))),
	}));
}

/** Complete JSONL lines of `text` and the partial line after them. */
function splitComplete(text: string): { complete: string; pending: string } {
	const at = text.lastIndexOf("\n");
	return at < 0 ? { complete: "", pending: text } : { complete: text.slice(0, at + 1), pending: text.slice(at + 1) };
}

export class AgentTranscriptViewerModel {
	/** Bumped on every change either face shows. */
	readonly rev = signal(0);
	readonly blocks = signal<readonly ViewerBlock[]>([]);
	/** Tools and thinking expanded (Ctrl+O). */
	readonly expanded = signal(false);
	/** Model of the transcript (first assistant reply, else the last model change). */
	model: string | undefined;
	/** Send failure shown above the draft. */
	notice: string | undefined;
	draft: LineValue = { text: "", cursor: 0 };
	/** Terminal body scroll (logical rows) and whether it sticks to the end. */
	scroll = 0;
	followTail = true;
	/** Entry the next terminal paint scrolls to, once. */
	revealEntry: string | undefined;
	/** Body geometry of the last terminal paint. */
	bodyRows = 0;
	bodyHeight = 1;

	remoteError = "";
	remoteUnavailable = false;
	hasRemoteData = false;
	#remoteBytes = 0;
	#remoteInFlight = false;
	#remoteToken = 0;

	#local: LocalState | undefined;
	#localUnavailable = "";
	#loading = false;
	#idlePolls = 0;
	#tools = new Map<string, ToolCall>();
	#tally = new TurnUsageTally();
	#turnStartedAt: number | undefined;
	#poll: NodeJS.Timeout | undefined;
	#disposed = false;
	/** The registry entry and progress last shown. */
	#meta: string;

	constructor(readonly deps: AgentTranscriptViewerDeps) {
		this.revealEntry = deps.initialEntryId;
		this.#meta = this.#metaSignature();
		this.#refresh(false);
		this.#poll = setInterval(() => this.poll(), deps.pollMs ?? POLL_MS);
		this.#poll.unref?.();
	}

	/** Re-read the transcript, and show registry or progress changes. */
	poll(): void {
		this.#refresh(true);
		const meta = this.#metaSignature();
		if (meta === this.#meta) return;
		this.#meta = meta;
		this.touch();
	}

	#metaSignature(): string {
		const ref = this.ref();
		return JSON.stringify([ref?.status, ref?.kind, ref?.parentId, ref?.sessionFile, this.progress()]);
	}

	touch(): void {
		this.rev.set(untrack(this.rev) + 1);
	}

	ref(): ViewerAgentRef | undefined {
		return this.deps.registry.get(this.deps.agentId);
	}

	/** Advisors are read-only; every other agent revives on send. */
	get sendable(): boolean {
		const ref = this.ref();
		if (!ref || ref.kind === "advisor") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
	}

	progress(): ViewerProgress | undefined {
		return this.deps.observers?.getSession(this.deps.agentId)?.progress;
	}

	/** What the body says while there are no messages. */
	placeholder(): string {
		if (this.deps.remote) {
			if (this.remoteError) return this.remoteError;
			if (this.remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		return this.ref()?.sessionFile ? "No messages yet." : "No session file available yet.";
	}

	/** The error shown above the draft: a send failure, else a remote read error under shown messages. */
	shownNotice(): string | undefined {
		return this.notice ?? (this.remoteError && untrack(this.blocks).length > 0 ? this.remoteError : undefined);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#remoteToken++;
	}

	#stopPolling(): void {
		clearInterval(this.#poll);
		this.#poll = undefined;
	}

	// ─── Loading ──────────────────────────────────────────────────────────

	#refresh(allowAsync: boolean): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		if (this.#loading) return;
		const file = this.ref()?.sessionFile;
		if (!file) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = this.deps.transcript.fs.statSync(file);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#local;
		if (state && state.path === file && state.dev === stat.dev && state.ino === stat.ino) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) {
				if (++this.#idlePolls < SENTINEL_CHECK_EVERY) return;
				this.#idlePolls = 0;
				if (!this.#sentinelsHold(file, state)) this.#loadFull(file, stat, allowAsync);
				return;
			}
			if (stat.size > state.size && this.#sentinelsHold(file, state)) {
				this.#appendLocal(file, stat, state, allowAsync);
				return;
			}
		}
		this.#loadFull(file, stat, allowAsync);
	}

	#clearLocal(reason: string): void {
		if (!this.#local && this.#localUnavailable === reason) return;
		this.#local = undefined;
		this.#localUnavailable = reason;
		this.model = undefined;
		this.#rebuild([]);
	}

	#sentinelsHold(file: string, state: LocalState): boolean {
		try {
			return state.sentinels.every(sentinel =>
				readRange(this.deps.transcript.fs, file, sentinel.offset, sentinel.bytes.byteLength).equals(sentinel.bytes),
			);
		} catch {
			return false;
		}
	}

	#loadFull(file: string, stat: fs.Stats, allowAsync: boolean): void {
		const promises = allowAsync ? this.deps.transcript.fs.promises : undefined;
		if (promises) {
			this.#loading = true;
			promises
				.readFile(file)
				.then(data => {
					this.#loading = false;
					if (!this.#disposed) this.#applyFull(file, stat, data);
				})
				.catch((error: unknown) => {
					// The state stays: the next poll retries.
					this.#loading = false;
					logger.debug("transcript viewer: read failed", { error: String(error) });
				});
			return;
		}
		try {
			this.#applyFull(file, stat, this.deps.transcript.fs.readFileSync(file));
		} catch (error) {
			logger.debug("transcript viewer: read failed", { error: String(error) });
		}
	}

	#applyFull(file: string, stat: fs.Stats, data: Buffer): void {
		// Identity and mtime after the read: the file may have grown since the stat.
		let after = stat;
		try {
			after = this.deps.transcript.fs.statSync(file);
		} catch {}
		const { complete, pending } = splitComplete(data.toString("utf-8"));
		this.#localUnavailable = "";
		this.#local = {
			path: file,
			dev: after.dev,
			ino: after.ino,
			size: data.byteLength,
			mtimeMs: after.mtimeMs,
			pending,
			sentinels: sentinelsOf(data),
		};
		this.model = undefined;
		this.#rebuild(this.#messages(this.deps.transcript.parseEntries(complete)));
	}

	#appendLocal(file: string, stat: fs.Stats, state: LocalState, allowAsync: boolean): void {
		let chunk: string;
		let sentinels: Sentinel[];
		try {
			chunk = readRange(this.deps.transcript.fs, file, state.size, stat.size - state.size).toString("utf-8");
			sentinels = sentinelWindows(stat.size).map(offset => ({
				offset,
				bytes: readRange(this.deps.transcript.fs, file, offset, Math.min(SENTINEL_BYTES, stat.size - offset)),
			}));
		} catch (error) {
			logger.debug("transcript viewer: tail read failed", { error: String(error) });
			this.#loadFull(file, stat, allowAsync);
			return;
		}
		const { complete, pending } = splitComplete(state.pending + chunk);
		this.#local = { ...state, size: stat.size, mtimeMs: stat.mtimeMs, pending, sentinels };
		const previousModel = this.model;
		const parsed = complete ? this.#messages(this.deps.transcript.parseEntries(complete)) : [];
		if (parsed.length > 0) this.#append(parsed);
		else if (this.model !== previousModel) this.touch();
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteInFlight) return;
		const from = this.#remoteBytes;
		const token = ++this.#remoteToken;
		this.#remoteInFlight = true;
		remote
			.readTranscript(this.deps.agentId, from)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteInFlight = false;
				if (!result) {
					if (!this.hasRemoteData && !this.remoteUnavailable) {
						this.remoteUnavailable = true;
						this.touch();
					}
					return;
				}
				if (result.error) {
					this.remoteError = result.error;
					this.hasRemoteData = true;
					this.remoteUnavailable = false;
					this.#stopPolling();
					this.touch();
					return;
				}
				if (result.newSize < from) {
					// The host's transcript rotated: start over.
					this.#remoteBytes = 0;
					this.remoteError = "";
					this.hasRemoteData = false;
					this.model = undefined;
					this.#rebuild([]);
					this.#fetchRemote();
					return;
				}
				this.remoteUnavailable = false;
				this.remoteError = "";
				this.hasRemoteData = true;
				const { complete } = splitComplete(result.text);
				this.#remoteBytes = from + Buffer.byteLength(complete, "utf-8");
				const parsed = complete ? this.#messages(this.deps.transcript.parseEntries(complete)) : [];
				if (parsed.length > 0) this.#append(parsed);
				else this.touch();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id: this.deps.agentId, error: String(error) });
			});
	}

	/** Message entries, noting the model (the first reply's, a model change's). */
	#messages(entries: readonly AgentTranscriptEntry[]): SessionMessageEntryLike[] {
		const messages: SessionMessageEntryLike[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.model && entry.message.role === "assistant") this.model = entry.message.model;
			} else if (entry.type === "model_change") this.model = entry.model;
		}
		return messages;
	}

	#rebuild(entries: readonly SessionMessageEntryLike[]): void {
		this.#tools.clear();
		this.#tally.reset();
		this.#turnStartedAt = undefined;
		this.blocks.set([]);
		this.#append(entries);
	}

	#append(entries: readonly SessionMessageEntryLike[]): void {
		const added: ViewerBlock[] = [];
		for (const entry of entries) {
			const message = entry.message;
			switch (message.role) {
				case "user":
				case "developer": {
					// Only a prompt the user wrote starts the turn's clock: an agent-attributed one
					// (a subagent's assignment, an advisor's redirect) does not.
					if (message.role === "user" && message.attribution !== "agent") {
						this.#turnStartedAt = message.timestamp;
						this.#tally.reset();
					} else if (message.role === "developer" && message.synthetic) {
						// A synthetic developer message starts a fresh run (auto-continue, an approved
						// plan): only one the user set off is that run's prompt.
						this.#tally.reset();
						this.#turnStartedAt = message.userInitiated ? message.timestamp : undefined;
					}
					if (message.role !== "user") break;
					if (message.parentIrc) {
						added.push({
							kind: "parentIrc",
							id: entry.id,
							parentIrc: message.parentIrc,
							timestamp: message.timestamp,
						});
						break;
					}
					const text = textContent(message.content);
					if (!text) break;
					added.push({
						kind: "user",
						id: entry.id,
						text,
						synthetic: message.synthetic ?? false,
						timestamp: message.timestamp,
						liveSteered: message.liveSteered === true,
						images: imageContent(message.content),
					});
					break;
				}
				case "assistant": {
					const usage = this.#tally.add(message, this.#turnStartedAt);
					added.push({ kind: "assistant", id: entry.id, message, usage });
					for (const part of message.content) {
						if (part.type !== "toolCall") continue;
						const call = new ToolCall({
							id: part.id,
							name: part.name,
							args: part.arguments,
							...(this.deps.inspectShell ? { inspectShell: this.deps.inspectShell } : {}),
						});
						call.setArgsComplete();
						call.setExpanded(untrack(this.expanded));
						this.#tools.set(part.id, call);
						added.push({ kind: "tool", id: part.id, call });
					}
					break;
				}
				case "toolResult": {
					const call = this.#tools.get(message.toolCallId);
					if (!call) break;
					call.updateResult(
						{ content: message.content, details: message.details, isError: message.isError } as ToolCallResult,
						false,
					);
					call.seal();
					break;
				}
				case "compactionSummary":
					added.push({
						kind: "compaction",
						id: entry.id,
						summary: message.summary,
						tokensBefore: message.tokensBefore,
					});
					break;
				case "branchSummary":
					added.push({ kind: "branch", id: entry.id, summary: message.summary });
					break;
			}
		}
		if (added.length > 0) this.blocks.set([...untrack(this.blocks), ...added]);
		this.touch();
	}

	// ─── Input ────────────────────────────────────────────────────────────

	toggleExpanded(): void {
		const expanded = !untrack(this.expanded);
		this.expanded.set(expanded);
		for (const call of this.#tools.values()) call.setExpanded(expanded);
		this.touch();
	}

	/** Esc: clear a non-empty draft, else close. */
	escape(): void {
		if (this.draft.text.trim() !== "") {
			this.draft = { text: "", cursor: 0 };
			this.touch();
			return;
		}
		this.deps.onClose();
	}

	submit(): void {
		const text = this.draft.text.trim();
		this.draft = { text: "", cursor: 0 };
		this.touch();
		if (!text) return;
		this.notice = undefined;
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, text);
			return;
		}
		const lifecycle = this.deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; steers a live one mid-turn.
				const session = await lifecycle().ensureLive(id);
				await session.prompt(text, { streamingBehavior: "steer" });
			} catch (error) {
				this.notice = error instanceof Error ? error.message : String(error);
			}
			this.touch();
		})();
	}

	/** Scroll the terminal body by `delta` rows (against the last paint's geometry). */
	scrollBy(delta: number): void {
		const max = Math.max(0, this.bodyRows - this.bodyHeight);
		this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
		this.followTail = this.scroll >= max;
		this.touch();
	}

	scrollToTop(): void {
		this.scrollBy(Number.NEGATIVE_INFINITY);
	}

	scrollToBottom(): void {
		this.scrollBy(Number.POSITIVE_INFINITY);
	}

	/** Terminal keys before the draft gets them; true when handled. */
	key(id: string, text: string | undefined): boolean {
		if (this.deps.hubKeys.includes(id)) {
			this.deps.onHubClose();
			return true;
		}
		if (id === "escape") {
			this.escape();
			return true;
		}
		if (this.deps.expandKeys.includes(id)) {
			this.toggleExpanded();
			return true;
		}
		// Typing a message takes every key; an empty draft leaves them to scrolling.
		if (!this.sendable || this.draft.text.trim() === "") {
			const page = Math.max(1, this.bodyHeight);
			const delta: Record<string, number> = {
				up: -1,
				down: 1,
				k: -1,
				j: 1,
				"shift+up": -5,
				"shift+down": 5,
				pageUp: -page,
				pageDown: page,
			};
			if (delta[id] !== undefined) {
				this.scrollBy(delta[id]);
				return true;
			}
			if (id === "home" || text === "g") {
				this.scrollToTop();
				return true;
			}
			if (id === "end" || text === "G") {
				this.scrollToBottom();
				return true;
			}
		}
		if (this.sendable && getKeybindings().matchesId(id, "tui.input.submit")) {
			this.submit();
			return true;
		}
		return false;
	}
}
