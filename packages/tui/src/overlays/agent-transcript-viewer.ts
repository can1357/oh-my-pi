/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * Local transcripts are read through the host's session storage and tail
 * append-only growth: while the bytes just before the rendered end are
 * unchanged, only newly appended JSONL is parsed and rendered. A rewrite,
 * truncation, or rotation falls back to a full rebuild so changed historical
 * entries cannot leave stale components behind. Collab guests use the same
 * append path over the host's byte-capped transcript reads.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { Component, TUI } from "../tui";
import { Editor } from "../components/editor";
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import { formatKeyHint, formatKeyHints, type KeyId } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import type { MessageRenderer } from "../chat/extension-types";
import type { AgentLifecycleLike } from "./agent-hub-types";
import type { AgentHubRegistry, AgentStatus } from "./agent-hub-types";
import type { SessionMessageEntryLike } from "../chat/transcript-entry";
import type { ObservableSession, SessionObserverRegistry } from "./session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import {
	TranscriptBrowser,
	type TranscriptBrowserFrame,
	type TranscriptBrowserRenderContext,
} from "../chat/transcript-browser";
import { sanitizeErrorLine } from "../chrome/error-block";
import type { ScrollRangeAnchor } from "../components/scroll-view";
import { formatContextUsage } from "../chrome/context-thresholds";
import { node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, escCloseButton, hintsRow, overlayCard } from "../native/overlay";

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry = SessionMessageEntryLike | { type: "model_change"; model: string };

/** Size and modification time of a stored transcript. */
export interface AgentTranscriptStat {
	size: number;
	mtimeMs: number;
}

/** Transcript reads and session parsing supplied by the host. */
export interface AgentTranscriptSource {
	/**
	 * Size and modification time of the transcript at `path`; throws when there
	 * is none. Every poll calls it, so it must be cheap.
	 */
	stat(path: string): AgentTranscriptStat;
	/**
	 * The UTF-8 text of the transcript at `path` from byte `offset` (a character
	 * boundary) to its end; rejects when there is none.
	 */
	readFrom(path: string, offset: number): Promise<string>;
	parseEntries(text: string): AgentTranscriptEntry[];
}

export interface AgentTranscriptViewerDeps {
	agentId: string;
	transcript: AgentTranscriptSource;
	/** Persisted entry to reveal on first paint when opened from an activity row. */
	initialEntryId?: string;
	registry: AgentHubRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress/cost snapshot source for the stats line. */
	observers?: SessionObserverRegistry;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleLike;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
}

/** How often to re-stat a local transcript for growth (advisor/live tail). */
const POLL_MS = 250;
/** Every Nth idle poll re-reads the anchor, catching a rewrite that keeps size and mtime. */
const IDLE_VERIFY_EVERY = 5;
/** UTF-16 units of rendered text a tail read must find unchanged before it appends. */
const ANCHOR_CHARS = 4096;

interface LocalTranscriptState {
	path: string;
	/** The stat the last read answered; an unchanged stat makes a poll idle. */
	seen: AgentTranscriptStat;
	/** Byte offset just past the last complete line rendered. */
	offset: number;
	/** The rendered text that ends at {@link offset}, starting at byte {@link anchorOffset}. */
	anchor: string;
	anchorOffset: number;
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

/**
 * `sanitizeErrorLine` width for described text, which the terminal truncates
 * itself: effectively unbounded, but within the native truncate's i32 range.
 */
const NATIVE_LINE_WIDTH = 0x7fff_ffff;

const STATUS_TONE: Record<AgentStatus, TspTone> = {
	running: "success",
	idle: "accent",
	parked: "muted",
	aborted: "error",
};

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

export class AgentTranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#browser: TranscriptBrowser;
	#editor: Editor | undefined;
	#notice: string | undefined;
	#expanded = false;

	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#model: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	/** Local read in flight; polls are skipped until it lands. */
	#localReadInFlight = false;
	/** Idle polls since the anchor was last verified. */
	#idlePolls = 0;
	#initialEntryId: string | undefined;
	/** Last described node and the visible inputs it was built from. */
	#nativeCache: { signature: string; node: NativeNode } | undefined;

	readonly #deps: AgentTranscriptViewerDeps;

	constructor(deps: AgentTranscriptViewerDeps) {
		this.#deps = deps;
		this.#initialEntryId = deps.initialEntryId;
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			expandThinkingBlocks: deps.expandThinkingBlocks,
			// Charts are for the main session's answers, not parked subagent, advisor, or guest transcripts.
			tableCharts: false,
			requestRender: deps.requestRender,
		});
		this.#browser = new TranscriptBrowser({
			getHeight: () => this.#deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context),
			followBottom: true,
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		// The first read starts now; polls re-stat the transcript for growth.
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor transcripts are read-only; every other agent revives on send. */
	get #sendable(): boolean {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		if (!ref || ref.kind === "advisor") return false;
		return Boolean(this.#deps.remote || this.#deps.lifecycle);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#remoteToken++;
		this.#builder.dispose();
	}

	#stopPolling(): void {
		if (!this.#pollTimer) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Refresh the transcript from local storage or the remote host. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.#deps.remote) {
			this.#fetchRemote();
			return;
		}
		if (this.#localReadInFlight) return;
		const sessionFile = this.#deps.registry.get(this.#deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: AgentTranscriptStat;
		try {
			stat = this.#deps.transcript.stat(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#localState;
		if (!state || state.path !== sessionFile || stat.size < state.offset) {
			// A new transcript, or one cut below what is rendered: rebuild.
			this.#readLocal(sessionFile, stat, undefined);
			return;
		}
		// Idle fast path: an unchanged size and mtime costs one stat; the anchor is
		// re-read only every Nth idle poll so a rewrite that keeps both is still noticed.
		if (
			stat.size === state.seen.size &&
			stat.mtimeMs === state.seen.mtimeMs &&
			++this.#idlePolls < IDLE_VERIFY_EVERY
		) {
			return;
		}
		this.#idlePolls = 0;
		this.#readLocal(sessionFile, stat, state);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#rebuild([]);
	}

	/**
	 * Read the transcript from the anchor of `state` and append what follows the
	 * rendered end. Without a state, or when the anchor text changed (a rewrite,
	 * not an append), read all of it and rebuild.
	 */
	#readLocal(sessionFile: string, stat: AgentTranscriptStat, state: LocalTranscriptState | undefined): void {
		this.#localReadInFlight = true;
		const from = state?.anchorOffset ?? 0;
		void this.#deps.transcript
			.readFrom(sessionFile, from)
			.then(text => {
				this.#localReadInFlight = false;
				if (this.#disposed) return;
				if (state && text.startsWith(state.anchor)) this.#appendLocal(state, stat, text.slice(state.anchor.length));
				else if (from > 0) this.#readLocal(sessionFile, stat, undefined);
				else this.#applyLocalFull(sessionFile, stat, text);
			})
			.catch((err: unknown) => {
				// Leave #localState unchanged so a transient read error retries next poll.
				this.#localReadInFlight = false;
				logger.debug("transcript viewer: read failed", { err: String(err) });
			});
	}

	#applyLocalFull(sessionFile: string, stat: AgentTranscriptStat, text: string): void {
		// A read that lands mid-append ends in a partial line (no terminating
		// newline). It stays unrendered past the offset; the next read starts
		// before the offset and takes it whole once its newline arrives. The
		// offset counts the bytes read, not `stat.size`, so growth between the
		// stat and the read is never rendered twice.
		const complete = text.slice(0, text.lastIndexOf("\n") + 1);
		const offset = Buffer.byteLength(complete, "utf-8");
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			seen: { size: stat.size, mtimeMs: stat.mtimeMs },
			offset,
			...anchorAt(complete, offset),
		};
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(this.#deps.transcript.parseEntries(complete)));
	}

	/** Render the complete lines of `rest`, the text that follows the rendered end of `state`. */
	#appendLocal(state: LocalTranscriptState, stat: AgentTranscriptStat, rest: string): void {
		const complete = rest.slice(0, rest.lastIndexOf("\n") + 1);
		const offset = state.offset + Buffer.byteLength(complete, "utf-8");
		const previousModel = this.#model;
		const parsed = complete ? this.#extractMessages(this.#deps.transcript.parseEntries(complete)) : [];
		this.#localState = {
			path: state.path,
			seen: { size: stat.size, mtimeMs: stat.mtimeMs },
			offset,
			// A long append holds the whole anchor; a short one extends the previous one.
			...anchorAt(complete.length >= ANCHOR_CHARS ? complete : state.anchor + complete, offset),
		};
		if (parsed.length > 0) {
			this.#append(parsed);
		} else if (this.#model !== previousModel) {
			this.#deps.requestRender();
		}
	}

	#fetchRemote(): void {
		const remote = this.#deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.#deps.agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.#deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.#deps.requestRender();
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — drop the stale rendered rows
					// before restarting; otherwise the post-rotation fetch would stack
					// new content under the pre-rotation history.
					this.#remoteBytes = 0;
					this.#remoteError = "";
					this.#hasRemoteData = false;
					this.#model = undefined;
					this.#rebuild([]);
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				this.#remoteError = "";
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const completeChunk = result.text.slice(0, lastNewline + 1);
					this.#remoteBytes = fromByte + Buffer.byteLength(completeChunk, "utf-8");
					const previousModel = this.#model;
					const parsed = this.#extractMessages(this.#deps.transcript.parseEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
					if (this.#model !== previousModel) {
						this.#deps.requestRender();
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.#deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: AgentTranscriptEntry[]): SessionMessageEntryLike[] {
		const messages: SessionMessageEntryLike[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntryLike[]): void {
		this.#builder.rebuild(entries);
		this.#deps.requestRender();
	}

	#append(entries: SessionMessageEntryLike[]): void {
		this.#builder.append(entries);
		this.#deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#browser.scroll(event.wheel * 3);
					this.#deps.requestRender();
				}
				return true;
			});
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.#deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.#deps.onHubClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			this.#escape();
			return;
		}

		for (const key of this.#deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.#deps.requestRender();
				return;
			}
		}

		// Once the reader starts typing a message, the editor owns every key.
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.#deps.requestRender();
		}
	}

	/** Returns true when the key was a scroll command. The browser owns the offset. */
	#handleScroll(data: string): boolean {
		if (this.#browser.handleScrollKey(data)) {
			this.#deps.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#browser.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#browser.scroll(-1);
		} else if (data === "g") {
			this.#browser.scrollToTop();
		} else if (data === "G") {
			this.#browser.scrollToBottom();
		} else {
			return false;
		}
		this.#deps.requestRender();
		return true;
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.#deps.agentId;
		if (this.#deps.remote) {
			this.#deps.remote.chat(id, trimmed);
			this.#deps.requestRender();
			return;
		}
		const lifecycle = this.#deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await lifecycle().ensureLive(id);
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#deps.requestRender();
		})();
		this.#deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const lines = this.#browser.render(width);
		if (this.#initialEntryId && this.#browser.hasAnchored(this.#initialEntryId)) {
			this.#initialEntryId = undefined;
		}
		return lines;
	}

	/** The top-right `esc` runs Esc. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#escape();
	}

	/** Esc: clear a non-empty draft first, else close the viewer. */
	#escape(): void {
		if (this.#editor && this.#editor.getText().trim() !== "") {
			this.#editor.setText("");
			this.#deps.requestRender();
			return;
		}
		this.#deps.onClose();
	}

	/**
	 * Header, transcript body (the builder's container, which describes its own
	 * blocks), notice, message editor, stats and key hints. Scrolling is the
	 * terminal's, so the j/k/g/G scroll hints are omitted.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const ref = this.#deps.registry.get(this.#deps.agentId);
		const notice = this.#notice ?? (this.#remoteError && !this.#builder.isEmpty ? this.#remoteError : undefined);
		const placeholder = this.#builder.isEmpty ? this.#placeholder(NATIVE_LINE_WIDTH) : undefined;
		const progress = this.#deps.observers?.getSession(this.#deps.agentId)?.progress;
		const stats = progress
			? [progress.contextTokens, progress.contextWindow, progress.durationMs, progress.toolCount, progress.cost]
			: undefined;
		const signature = JSON.stringify([
			ref?.status,
			ref?.kind,
			ref?.parentId,
			this.#model,
			notice,
			placeholder,
			stats,
			this.#deps.expandKeys[0],
		]);
		const cached = this.#nativeCache;
		if (cached?.signature === signature) return cached.node;

		const id = this.#deps.agentId;
		const children: NativeChild[] = [];
		// Top row: the agent's meta on the left, a clickable `esc` (close) on the right.
		const top: NativeChild[] = [];
		if (ref) {
			const kindTag = ref.parentId ? `${ref.kind} ${theme.sep.dot} of ${ref.parentId}` : ref.kind;
			const meta: NativeChild[] = [
				text([span(id, "strong")]),
				node("badge", { text: ref.status, tone: STATUS_TONE[ref.status] }),
				text([span(kindTag, "dim")], { truncate: "end" }),
			];
			if (this.#model) meta.push(text([span(this.#model, "muted")], { truncate: "end" }));
			top.push(node("row", { gap: "sm", align: "center", grow: 1, min: { w: 0 } }, meta, "meta"));
		} else {
			top.push(node("spacer", { grow: 1 }));
		}
		top.push(escCloseButton());
		children.push(node("row", { gap: "md", align: "center" }, top, "top"));
		children.push(
			placeholder === undefined
				? node("col", { grow: 1 }, [this.#builder.container], "transcript")
				: node("text", { spans: [span(placeholder, "dim")], wrap: "word" }, undefined, "placeholder"),
		);
		if (notice) {
			children.push(
				node(
					"text",
					{ text: sanitizeErrorLine(notice, NATIVE_LINE_WIDTH), tone: "error", truncate: "end" },
					undefined,
					"notice",
				),
			);
		}
		if (this.#editor) children.push(this.#editor);
		if (progress) {
			const statSpans: TspSpan[] = [];
			const sep = (): void => {
				if (statSpans.length > 0) statSpans.push(span(theme.sep.dot, "dim"));
			};
			if (progress.toolCount > 0) {
				statSpans.push(span(`${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}`, "dim"));
			}
			if (
				progress.contextTokens &&
				progress.contextTokens > 0 &&
				!(progress.contextWindow && progress.contextWindow > 0)
			) {
				sep();
				statSpans.push(span(formatNumber(progress.contextTokens), "dim"));
			}
			if (progress.durationMs > 0) {
				sep();
				statSpans.push(span(formatDuration(progress.durationMs), "dim"));
			}
			if (progress.cost > 0) {
				sep();
				statSpans.push(span(`$${progress.cost.toFixed(2)}`, "statusLineCost"));
			}
			const statsRow: NativeChild[] = [];
			if (
				progress.contextTokens &&
				progress.contextTokens > 0 &&
				progress.contextWindow &&
				progress.contextWindow > 0
			) {
				const fraction = progress.contextTokens / progress.contextWindow;
				statsRow.push(
					node("progress", {
						value: Math.min(1, fraction),
						label: formatContextUsage(fraction * 100, progress.contextWindow),
						max: { w: "24ch" },
					}),
				);
			}
			if (statSpans.length > 0) statsRow.push(text(statSpans, { truncate: "end" }));
			if (statsRow.length > 0) children.push(node("row", { gap: "md", align: "center" }, statsRow, "stats"));
		}
		children.push(
			hintsRow([
				this.#editor ? actionHint("tui.input.submit", "send") : undefined,
				{ keys: [this.#deps.expandKeys[0] ?? "ctrl+o"], label: "expand" },
			]),
		);
		const head = [span("Agent Hub", "accent"), span(` ${theme.sep.dot} `, "dim"), span(id, "accent")];
		const described = overlayCard("omp.hub.transcript", head, children);
		this.#nativeCache = { signature, node: described };
		return described;
	}

	#frame(context: TranscriptBrowserRenderContext): TranscriptBrowserFrame {
		// The transcript components carry their own 1-col left gutter, so body
		// rows are emitted WITHOUT an extra outer space; header/footer rows are
		// returned raw and the browser adds the one-column inset.
		const { contentWidth, chromeWidth } = context;
		const ref = this.#deps.registry.get(this.#deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice
			? theme.fg("error", sanitizeErrorLine(this.#notice, chromeWidth))
			: this.#remoteError && !this.#builder.isEmpty
				? theme.fg("error", sanitizeErrorLine(this.#remoteError, chromeWidth))
				: undefined;
		// The editor carries no outer gutter; it renders at chrome width and the
		// browser insets each row.
		const editorLines = this.#editor ? this.#editor.render(chromeWidth) : [];

		const contentLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder(Math.max(10, contentWidth - 1)))}`]
			: this.#builder.container.render(contentWidth);
		let anchor: ScrollRangeAnchor | undefined;
		if (this.#initialEntryId) {
			const targetRow = this.#builder.rowForEntry(this.#initialEntryId);
			if (targetRow !== undefined) {
				anchor = {
					id: this.#initialEntryId,
					start: targetRow,
					end: targetRow + 1,
					mode: "once",
					alignment: "start",
				};
			}
		}
		return {
			header: headerLines,
			body: { lines: contentLines, anchor },
			footer: [...(noticeLine ? [noticeLine] : []), ...editorLines, ...footerLines],
		};
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Hub ${theme.sep.dot} ${this.#deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.#deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(statsLine);
		const keys =
			`${formatKeyHint("escape")}:close  ${formatKeyHint(this.#deps.expandKeys[0] ?? "ctrl+o")}:expand  ` +
			`${this.#editor ? "empty input → " : ""}${formatKeyHints(["j", "k"])}:scroll  ${formatKeyHints(["g", "shift+g"])}:top/bottom`;
		const hint = this.#editor ? `${editorKey("tui.input.submit")}:send  ${keys}` : keys;
		lines.push(theme.fg("dim", hint));
		return lines;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.#deps.observers?.getSession(this.#deps.agentId);
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : "";
			parts.push(theme.fg("dim", [toolStat, ...stats].filter(Boolean).join(theme.sep.dot)));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#placeholder(maxWidth: number): string {
		if (this.#deps.remote) {
			if (this.#remoteError) return sanitizeErrorLine(this.#remoteError, maxWidth);
			if (this.#remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.#hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		if (!this.#deps.registry.get(this.#deps.agentId)?.sessionFile) return "No session file available yet.";
		// Until the first read lands there is neither a transcript nor a reason it is missing.
		if (!this.#localState && !this.#localUnavailable) return "Loading transcript…";
		return "No messages yet.";
	}
}
