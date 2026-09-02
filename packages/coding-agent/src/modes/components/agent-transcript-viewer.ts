/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * Local transcripts tail append-only growth: unchanged file identity plus stable
 * sentinels means only newly appended JSONL is parsed and rendered. Rewrites,
 * truncation, rotation, or sentinel drift fall back to a full rebuild so changed
 * historical entries cannot leave stale components behind. Collab guests use the
 * same append path over the host's byte-capped transcript reads.
 */
import * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Editor, matchesKey, routeSgrMouseInput, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

export interface AgentTranscriptViewerDeps {
	agentId: string;
	/** Persisted entry to reveal on first paint when opened from an activity row. */
	initialEntryId?: string;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress/cost snapshot source for the stats line. */
	observers?: SessionObserverRegistry;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;

const SENTINEL_BYTES = 4096;

/** Sanitize wire-delivered error text for a single TUI row: tabs → spaces,
 *  newlines collapsed, absolute paths shortened, truncated to `maxWidth`.
 *  `#remoteError` arrives as `String(err)` from the host — it can carry
 *  multi-line stacks and absolute host paths that would break the frame's
 *  1-row accounting and leak host filesystem layout to guests. */
function sanitizeErrorLine(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, p => shortenPath(p));
	return truncateToWidth(singleLine, Math.max(10, maxWidth));
}

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	pending: string;
	sentinels: LocalTranscriptSentinel[];
}

function readFileRangeSync(file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromBuffer(buffer: Buffer): LocalTranscriptSentinel[] {
	const size = buffer.byteLength;
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({
		offset,
		bytes: Buffer.from(buffer.subarray(offset, offset + length)),
	}));
}

function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}

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
	#scrollView: ScrollView;
	#followBottom = true;
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
	#initialEntryId: string | undefined;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#initialEntryId = deps.initialEntryId;
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor and aborted-agent transcripts are read-only. */
	get #sendable(): boolean {
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
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

	/** Refresh the transcript from a local file or remote host. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#localState;
		if (state && this.#canAppendLocal(sessionFile, stat, state)) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
			if (stat.size > state.size) {
				this.#appendLocal(sessionFile, stat, state);
				return;
			}
		}
		this.#loadLocalFull(sessionFile, stat);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#rebuild([]);
	}

	#canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(sessionFile, sentinel.offset, sentinel.bytes.byteLength);
			} catch (err) {
				// The file can be unlinked/rotated between statSync and this read.
				// Treat as not-appendable so #refresh falls back to a guarded full load.
				logger.debug("transcript viewer: sentinel read failed", { err: String(err) });
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	#loadLocalFull(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = fs.readFileSync(sessionFile);
		} catch (err) {
			// Leave #localState unchanged so a transient read error retries next poll.
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		// The file may have grown between the earlier `statSync` and this read.
		// Anchor the tail cursor to what we actually consumed so the next poll's
		// `#appendLocal` never re-renders bytes already in the rebuilt transcript;
		// re-stat for mtime/identity so the post-read clock matches what's on disk.
		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
		} catch {
			post = stat;
		}
		// A reader that opens the file mid-append sees a trailing partial line
		// (no terminating newline). Carry those bytes as `pending` so the next
		// poll's `#appendLocal` joins them with the completion bytes instead of
		// parsing a headless line fragment and dropping the entry.
		const text = data.toString("utf-8");
		const lastNewline = text.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
		const pending = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			dev: post.dev,
			ino: post.ino,
			size: data.byteLength,
			mtimeMs: post.mtimeMs,
			offset: data.byteLength,
			pending,
			sentinels: sentinelsFromBuffer(data),
		};
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(parseSessionEntries(complete)));
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let chunk: string;
		try {
			chunk = readFileRangeSync(sessionFile, state.offset, stat.size - state.offset).toString("utf-8");
		} catch (err) {
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		const combined = state.pending + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
		const previousModel = this.#model;
		const parsed = complete ? this.#extractMessages(parseSessionEntries(complete)) : [];
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			// File unlinked/rotated mid-poll: fall back to a guarded full reload
			// instead of letting the open escape the poll timer.
			logger.debug("transcript viewer: sentinel recompute failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		this.#localState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: stat.size,
			pending: lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined,
			sentinels,
		};
		if (parsed.length > 0) {
			this.#append(parsed);
		} else if (this.#model !== previousModel) {
			this.deps.requestRender();
		}
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.deps.agentId;
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
						this.deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.deps.requestRender();
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
					const parsed = this.#extractMessages(parseSessionEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
					if (this.#model !== previousModel) {
						this.deps.requestRender();
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		const messages: SessionMessageEntry[] = [];
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

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#builder.rebuild(entries);
		this.deps.requestRender();
	}

	#append(entries: SessionMessageEntry[]): void {
		this.#builder.append(entries);
		this.deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#syncFollow();
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.deps.onHubClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			if (this.#editor && this.#editor.getText().trim() !== "") {
				this.#editor.setText("");
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		// Once the reader starts typing a message, the editor owns every key.
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.deps.requestRender();
		}
	}

	/** Returns true when the key was a scroll command. ScrollView owns the offset. */
	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.deps.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, trimmed);
			this.deps.requestRender();
			return;
		}
		const lifecycle = this.deps.lifecycle;
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
			this.deps.requestRender();
		})();
		this.deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// `innerWidth` widths the editor/notice chrome (gutter-prefixed below).
		// `contentWidth` widths the transcript: ScrollView reserves the last column
		// for the scrollbar, and the transcript components carry their own 1-col left
		// gutter — so body rows are emitted WITHOUT an extra outer space, sharing that
		// gutter with the header/footer (which add one). Stacking both shifted the body
		// one column right of the title.
		const innerWidth = Math.max(20, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice
			? ` ${theme.fg("error", sanitizeErrorLine(this.#notice, innerWidth))}`
			: this.#remoteError && !this.#builder.isEmpty
				? ` ${theme.fg("error", sanitizeErrorLine(this.#remoteError, innerWidth))}`
				: undefined;
		const editorLines = this.#editor ? this.#editor.render(innerWidth) : [];

		// Chrome: top border + header rows + divider border + (notice) + editor + footer + bottom border.
		const chrome = headerLines.length + 2 + editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		const viewportHeight = Math.max(3, termHeight - chrome);

		const contentLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder(Math.max(10, contentWidth - 1)))}`]
			: this.#builder.container.render(contentWidth);
		this.#scrollView.setLines(contentLines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#initialEntryId) {
			const targetRow = this.#builder.rowForEntry(this.#initialEntryId);
			if (targetRow !== undefined) {
				this.#followBottom = false;
				this.#scrollView.setScrollOffset(Math.max(0, targetRow - 1));
				this.#initialEntryId = undefined;
			}
		} else if (this.#followBottom) {
			this.#scrollView.scrollToBottom();
		}

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(` ${headerLine}`);
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		if (noticeLine) lines.push(noticeLine);
		for (const editorLine of editorLines) lines.push(` ${editorLine}`);
		lines.push(...footerLines);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Hub ${theme.sep.dot} ${this.deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(` ${statsLine}`);
		const hint = this.#editor
			? `Enter:send  Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → j/k:scroll  g/G:top/bottom`
			: `Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  j/k:scroll  g/G:top/bottom`;
		lines.push(` ${theme.fg("dim", hint)}`);
		return lines;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.deps.observers?.getSession(this.deps.agentId);
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
		if (this.deps.remote) {
			if (this.#remoteError) return sanitizeErrorLine(this.#remoteError, maxWidth);
			if (this.#remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.#hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
