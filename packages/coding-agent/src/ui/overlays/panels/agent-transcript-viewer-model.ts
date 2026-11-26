/**
 * State of the Agent Hub transcript viewer: a parked subagent's, an
 * advisor's or a collab guest's transcript (no live in-view session).
 *
 * Local transcripts are read through the host's session storage and tail
 * append-only growth: while the text just before the rendered end is
 * unchanged, only new JSONL is parsed and appended; a rewrite, truncation or
 * rotation reloads the whole transcript. Remote (collab guest) transcripts
 * read the host's byte-capped increments. The message draft revives a parked
 * agent (or steers a live one) on send; advisors are read-only.
 */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { type Accessor, signal, untrack } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../../config/settings";
import { formatModelString } from "../../../config/model-resolver";
import type { AgentHubRemote } from "../../../modes/view-model/overlays/agent-hub";
import type {
	AgentTranscriptEntry,
	AgentTranscriptSource,
	AgentTranscriptStat,
} from "../../../modes/view-model/overlays/agent-transcript-viewer";
import { type TurnUsageSummary, TurnUsageTally } from "../../../modes/view-model/overlays/usage-row";
import { imageContent, type SessionMessageEntryLike, textContent } from "../../../session/transcript/transcript-entry";
import { resolveEditToolMode } from "../../../utils/edit-mode";
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
 * The session's handlers of transcript controls (a prompt's copy and edit,
 * a reply's copy, a turn's hold menu). The viewer's blocks run the same ones
 * as the session's own transcript.
 */
export interface ViewerTranscriptActions {
	/** A prompt bubble's control or hold-menu entry (`copy-message`, `edit-turn`, `rewind-turn`, …). */
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
	/**
	 * Settings the agent ran under (a subagent reads `edit.*` through to its parent's). Each
	 * reply's `edit` calls parse in the mode they select for the model that wrote it; without
	 * them a hashline, sloppy or magic call shows no target path.
	 */
	readonly settings?: Settings;
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
/** Every Nth idle poll re-reads the anchor, catching a rewrite of the tail that keeps size and mtime. */
const IDLE_VERIFY_EVERY = 5;
/**
 * Every Nth idle poll re-reads the whole transcript and compares what was
 * rendered, catching a rewrite *before* the anchor — an edit to an early
 * message that keeps the file's size and restores its mtime changes nothing
 * the cheaper checks look at. Rarer than the anchor check because it costs a
 * full read.
 */
const FULL_VERIFY_EVERY = 20;
/** UTF-16 units of rendered text a tail read must find unchanged before it appends. */
const ANCHOR_CHARS = 4096;

interface LocalState {
	readonly path: string;
	/** The stat the last read answered; an unchanged stat makes a poll idle. */
	readonly seen: AgentTranscriptStat;
	/** Byte offset just past the last complete line rendered. */
	readonly offset: number;
	/** The rendered text that ends at {@link offset}, starting at byte {@link anchorOffset}. */
	readonly anchor: string;
	readonly anchorOffset: number;
	/** The rendered text's hash and length in UTF-16 units, for the whole-transcript verify. */
	readonly rendered: RenderedHash;
}

/**
 * A polynomial hash of rendered transcript text, in a form that can be
 * extended by an append as cheaply as it can be recomputed whole:
 * `H(a + b) = H(a) * base^|b| + H(b)`. A plain digest would have to re-hash
 * the entire rendered prefix on every append, which is quadratic over a
 * session; this costs the length of the append.
 */
const HASH_BASE = 131n;
const HASH_MOD = 2305843009213693951n; // 2^61 - 1, a Mersenne prime

interface RenderedHash {
	readonly value: bigint;
	readonly length: number;
}

function hashRendered(text: string): RenderedHash {
	let value = 0n;
	for (let i = 0; i < text.length; i++) value = (value * HASH_BASE + BigInt(text.charCodeAt(i) + 1)) % HASH_MOD;
	return { value, length: text.length };
}

function concatRendered(a: RenderedHash, b: RenderedHash): RenderedHash {
	let shift = 1n;
	for (let i = 0; i < b.length; i++) shift = (shift * HASH_BASE) % HASH_MOD;
	return { value: (a.value * shift + b.value) % HASH_MOD, length: a.length + b.length };
}

/** The last {@link ANCHOR_CHARS} of `text`, rendered text that ends at byte `offset`, and the byte it starts at. */
function anchorAt(text: string, offset: number): { anchor: string; anchorOffset: number } {
	let start = Math.max(0, text.length - ANCHOR_CHARS);
	// Start on a character: a low surrogate continues the pair before it.
	const unit = text.charCodeAt(start);
	if (unit >= 0xdc00 && unit <= 0xdfff) start++;
	const anchor = text.slice(start);
	return { anchor, anchorOffset: offset - Buffer.byteLength(anchor, "utf-8") };
}

/** Complete JSONL lines of `text` and the partial line after them. */
function splitComplete(text: string): { complete: string; pending: string } {
	const at = text.lastIndexOf("\n");
	return at < 0 ? { complete: "", pending: text } : { complete: text.slice(0, at + 1), pending: text.slice(at + 1) };
}

/**
 * `stat` with its size cut to the end of `text`, read from byte `from`: the
 * stat that read answers for. A read that stops short of the size `stat` saw (a
 * window of a long transcript) then leaves the next poll a larger size to read
 * on to, instead of an unchanged stat that idles it with the tail unread.
 */
function answeredStat(stat: AgentTranscriptStat, from: number, text: string): AgentTranscriptStat {
	return { ...stat, size: Math.min(stat.size, from + Buffer.byteLength(text, "utf-8")) };
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
		// The first read starts now; polls re-stat the transcript for growth.
		this.#refresh();
		this.#poll = setInterval(() => this.poll(), deps.pollMs ?? POLL_MS);
		this.#poll.unref?.();
	}

	/** Re-read the transcript, and show registry or progress changes. */
	poll(): void {
		this.#refresh();
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
		if (!this.ref()?.sessionFile) return "No session file available yet.";
		// Until the first read lands there is neither a transcript nor a reason it is missing.
		if (!this.#local && !this.#localUnavailable) return "Loading transcript…";
		return "No messages yet.";
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

	#refresh(): void {
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
		let stat: AgentTranscriptStat;
		try {
			stat = this.deps.transcript.stat(file);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#local;
		if (
			!state ||
			state.path !== file ||
			stat.size < state.offset ||
			// A different file at the same path: rotation, which no content check
			// can see because the content may be identical.
			(stat.dev !== undefined && stat.dev !== state.seen.dev) ||
			(stat.ino !== undefined && stat.ino !== state.seen.ino)
		) {
			// A new transcript, one cut below what is rendered, or a rotation: rebuild.
			this.#readLocal(file, stat, undefined);
			return;
		}
		// Idle fast path: an unchanged size and mtime costs one stat; the anchor is
		// re-read only every Nth idle poll so a rewrite that keeps both is still noticed.
		const idle = stat.size === state.seen.size && stat.mtimeMs === state.seen.mtimeMs;
		if (idle && ++this.#idlePolls % IDLE_VERIFY_EVERY !== 0) return;
		const full = !idle || this.#idlePolls % FULL_VERIFY_EVERY === 0;
		if (!idle) this.#idlePolls = 0;
		this.#readLocal(file, stat, state, full && idle);
	}

	#clearLocal(reason: string): void {
		if (!this.#local && this.#localUnavailable === reason) return;
		this.#local = undefined;
		this.#localUnavailable = reason;
		this.model = undefined;
		this.#rebuild([]);
	}

	/**
	 * Read the transcript from the anchor of `state` and append what follows the
	 * rendered end. Without a state, or when the anchor text changed (a rewrite,
	 * not an append), read it from the start and rebuild. A read may answer only
	 * a window of a long transcript; the state then records the end of that
	 * window as the size seen, so the next poll reads on from it.
	 */
	#readLocal(file: string, stat: AgentTranscriptStat, state: LocalState | undefined, verifyWhole = false): void {
		this.#loading = true;
		if (verifyWhole && state) {
			void this.#verifyLocal(file, stat, state);
			return;
		}
		const from = state?.anchorOffset ?? 0;
		this.deps.transcript
			.readFrom(file, from)
			.then(text => {
				this.#loading = false;
				if (this.#disposed) return;
				const answered = answeredStat(stat, from, text);
				if (state && text.startsWith(state.anchor))
					this.#appendLocal(state, answered, text.slice(state.anchor.length));
				else if (from > 0) this.#readLocal(file, stat, undefined);
				else this.#applyFull(file, answered, text);
			})
			.catch((error: unknown) => {
				// The state stays: the next poll retries.
				this.#loading = false;
				logger.debug("transcript viewer: read failed", { error: String(error) });
			});
	}

	/**
	 * The whole-transcript verify: whether the transcript still starts with the
	 * rendered text of `state`, by its hash. A read may answer one window of a
	 * long transcript, so the rendered text is hashed window by window from byte
	 * 0 until a window reaches its end; no window is compared as if it held the
	 * whole of it. Unchanged, what follows the rendered end in that window is
	 * appended; changed, the view is rebuilt from the first window.
	 */
	async #verifyLocal(file: string, stat: AgentTranscriptStat, state: LocalState): Promise<void> {
		try {
			const first = await this.deps.transcript.readFrom(file, 0);
			let text = first;
			let at = 0;
			let hashed: RenderedHash = { value: 0n, length: 0 };
			for (;;) {
				if (this.#disposed) return;
				const remaining = state.rendered.length - hashed.length;
				if (text.length >= remaining) {
					const whole = concatRendered(hashed, hashRendered(text.slice(0, remaining)));
					this.#loading = false;
					if (whole.value === state.rendered.value) {
						this.#appendLocal(state, answeredStat(stat, at, text), text.slice(remaining));
					} else this.#applyFull(file, answeredStat(stat, 0, first), first);
					return;
				}
				// A window short of the rendered end: hash its complete lines and read on after them.
				const { complete } = splitComplete(text);
				if (!complete) {
					// The transcript ends before the rendered text does.
					this.#loading = false;
					this.#applyFull(file, answeredStat(stat, 0, first), first);
					return;
				}
				hashed = concatRendered(hashed, hashRendered(complete));
				at += Buffer.byteLength(complete, "utf-8");
				text = await this.deps.transcript.readFrom(file, at);
			}
		} catch (error) {
			// The state stays: the next poll retries.
			this.#loading = false;
			logger.debug("transcript viewer: read failed", { error: String(error) });
		}
	}

	#applyFull(file: string, stat: AgentTranscriptStat, text: string): void {
		// A read that lands mid-append ends in a partial line (no terminating
		// newline). It stays unrendered past the offset; the next read starts
		// before the offset and takes it whole once its newline arrives. The
		// offset counts the bytes read, not `stat.size`, so growth between the
		// stat and the read is never rendered twice.
		const { complete } = splitComplete(text);
		const offset = Buffer.byteLength(complete, "utf-8");
		this.#localUnavailable = "";
		this.#local = {
			path: file,
			seen: { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino },
			offset,
			rendered: hashRendered(complete),
			...anchorAt(complete, offset),
		};
		this.model = undefined;
		this.#rebuild(this.#messages(this.deps.transcript.parseEntries(complete)));
	}

	/** Render the complete lines of `rest`, the text that follows the rendered end of `state`. */
	#appendLocal(state: LocalState, stat: AgentTranscriptStat, rest: string): void {
		const { complete } = splitComplete(rest);
		const offset = state.offset + Buffer.byteLength(complete, "utf-8");
		this.#local = {
			path: state.path,
			seen: { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino },
			offset,
			rendered: concatRendered(state.rendered, hashRendered(complete)),
			// A long append holds the whole anchor; a short one extends the previous one.
			...anchorAt(complete.length >= ANCHOR_CHARS ? complete : state.anchor + complete, offset),
		};
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
						const settings = this.deps.settings;
						if (settings && part.name === "edit") {
							const model = formatModelString({ provider: message.provider, id: message.model });
							call.setRenderContext({
								editMode: resolveEditToolMode({ settings, getActiveModelString: () => model }),
							});
						}
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
