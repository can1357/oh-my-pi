import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase, HistoryState } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Paging state of a tail join; absent or `null` when every entry is already held. */
	history?: HistoryState | null;
	/** Requests the page before the oldest entry ("Load earlier"). */
	onLoadEarlier?: () => void;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

/** Rows carrying `data-entry-id`, in entry order. */
const ENTRY_ROW_SELECTOR = "[data-entry-id]";

interface AnchorRow {
	getAttribute(name: string): string | null;
	getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

interface AnchorRoot {
	scrollTop: number;
	getBoundingClientRect(): { readonly top: number };
	querySelectorAll(selector: string): ArrayLike<AnchorRow>;
}

/** An entry row and its offset from the top of the viewport. */
export interface ScrollAnchor {
	id: string;
	offset: number;
}

/** The topmost entry row still visible in the viewport, or `null` when no row is. */
export function captureScrollAnchor(root: AnchorRoot): ScrollAnchor | null {
	const viewportTop = root.getBoundingClientRect().top;
	const rows = root.querySelectorAll(ENTRY_ROW_SELECTOR);
	// Rows are laid out in entry order: binary-search the first one whose
	// bottom edge is below the viewport top, reading O(log n) rects.
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (rows[mid].getBoundingClientRect().bottom <= viewportTop) lo = mid + 1;
		else hi = mid;
	}
	if (lo >= rows.length) return null;
	const row = rows[lo];
	const id = row.getAttribute("data-entry-id");
	return id === null ? null : { id, offset: row.getBoundingClientRect().top - viewportTop };
}

/** Scroll so the anchor row sits at its captured offset again; `false` when the row is gone. */
export function restoreScrollAnchor(root: AnchorRoot, anchor: ScrollAnchor): boolean {
	const viewportTop = root.getBoundingClientRect().top;
	const rows = root.querySelectorAll(ENTRY_ROW_SELECTOR);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.getAttribute("data-entry-id") !== anchor.id) continue;
		root.scrollTop += row.getBoundingClientRect().top - viewportTop - anchor.offset;
		return true;
	}
	return false;
}

function Row({
	kind,
	gutter,
	title,
	entryId,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	/** Scroll-anchor key of a committed entry's row; absent for the stream ghost and live tools. */
	entryId?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`} data-entry-id={entryId}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, host }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter="host" title={entry.timestamp} entryId={entry.id}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp} entryId={entry.id}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row
						kind="user"
						gutter={<span className="tr-badge">{from}</span>}
						title={entry.timestamp}
						entryId={entry.id}
					>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp} entryId={entry.id}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary} data-entry-id={entry.id}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary} data-entry-id={entry.id}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp} entryId={entry.id}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp} entryId={entry.id}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase, history, onLoadEarlier } = props;

	// null follows the tail. An entry id pins the first mounted row while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them. An id, not
	// an index: a history page prepends entries and a reconnect's fresh tail
	// replaces them, and the reader's rows must stay mounted through both.
	const [pinnedId, setPinnedId] = useState<string | null>(null);
	const pinnedIndex = useMemo(
		() => (pinnedId === null ? -1 : entries.findIndex(entry => entry.id === pinnedId)),
		[entries, pinnedId],
	);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedIndex < 0 ? tailStart : Math.min(pinnedIndex, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	/** Entries of the last commit. */
	const committedEntriesRef = useRef(entries);
	/**
	 * The row the reader was looking at, captured before a commit that adds
	 * rows above it: earlier rows mounting, a history page, or a fresh tail.
	 */
	const anchorRef = useRef<ScrollAnchor | null>(null);
	/** Entries whose commit put the reader back on their row: the `live` jump leaves them there. */
	const anchoredEntriesRef = useRef<readonly SessionEntry[] | null>(null);
	/** Latest IntersectionObserver verdict: the sentinel is within a viewport of the top. */
	const nearTopRef = useRef(false);

	// A tail join's oldest entry changed: a history page was prepended, or a
	// reconnect swapped in a fresh tail. Remember the row the reader is on;
	// render runs before the commit, so the DOM still shows the previous
	// entries. A tail-locked view needs no anchor: it keeps following.
	const committed = committedEntriesRef.current;
	if (history != null && committed.length > 0 && entries.length > 0 && entries[0] !== committed[0]) {
		if (rootRef.current !== null && !lockRef.current) anchorRef.current = captureScrollAnchor(rootRef.current);
		// Every held row was mounted (the pin sat on the oldest one) and rows
		// landed above it: mount them too, or the page the reader asked for
		// would hide behind "show N earlier". The anchor keeps their row put.
		if (pinnedIndex > 0 && pinnedId === committed[0].id) setPinnedId(entries[0].id);
	}

	// Restore against the row, not the height delta: exact even when the same
	// commit also appends live entries.
	useLayoutEffect(() => {
		committedEntriesRef.current = entries;
		const anchor = anchorRef.current;
		const el = rootRef.current;
		anchorRef.current = null;
		if (anchor === null || el === null) return;
		if (restoreScrollAnchor(el, anchor)) anchoredEntriesRef.current = entries;
		// The reader's row is gone (a fresh tail no longer holds it): show the latest.
		else followTranscriptTail(el, lockRef, true);
	}, [entries, start]);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position, unless a reconnect's fresh tail
	// still held the reader's row. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null || anchoredEntriesRef.current === committedEntriesRef.current) return;
		setPinnedId(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Mount the previous window of held entries above the reader.
	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || anchorRef.current !== null) return;
		anchorRef.current = captureScrollAnchor(el);
		setPinnedId(entries[Math.max(0, start - WINDOW)].id);
	};

	// Every held entry is mounted: only then does the host get asked for more.
	const canAutoLoad = start === 0 && history?.hasEarlier === true && !history.loading && history.error === null;

	// Near the top, page in earlier history. The observer is rebuilt per commit
	// so each layout gets a fresh verdict (IntersectionObserver reports only
	// changes); a layout effect so the stale verdict is gone before the scroll
	// event of an anchor restore. A tail-locked view never loads: reflow at
	// the bottom (join, streaming) must not page history in.
	useLayoutEffect(() => {
		nearTopRef.current = false;
		const root = rootRef.current;
		const sentinel = sentinelRef.current;
		if (!canAutoLoad || onLoadEarlier === undefined || root === null || sentinel === null) return;
		const observer = new IntersectionObserver(
			records => {
				nearTopRef.current = records[records.length - 1]?.isIntersecting === true;
				if (nearTopRef.current && !lockRef.current) onLoadEarlier();
			},
			{ root, rootMargin: "100% 0px 0px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [entries, canAutoLoad, onLoadEarlier]);

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	const onScroll = (): void => {
		const el = rootRef.current;
		if (el === null) return;
		updateTranscriptTailLock(el, lockRef);
		// Back at the bottom: drop the pin so the window trims to the tail again.
		if (lockRef.current) {
			if (pinnedId !== null) setPinnedId(null);
		} else if (pinnedIndex < 0) {
			setPinnedId(visible[0]?.id ?? null);
		}
		if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
		// Scrolling up off the tail with the sentinel already in range.
		if (canAutoLoad && nearTopRef.current && !lockRef.current) onLoadEarlier?.();
	};

	return (
		<div ref={rootRef} className={`tr-root${compact === true ? " tr-root--compact" : ""}`} onScroll={onScroll}>
			{start === 0 && history?.hasEarlier === true && (
				<div className="tr-history">
					<div ref={sentinelRef} className="tr-history-sentinel" aria-hidden="true" />
					<button
						type="button"
						className="tr-earlier"
						disabled={history.loading || onLoadEarlier === undefined}
						onClick={onLoadEarlier}
					>
						{history.loading && <span className="tv-spin" aria-hidden="true" />}
						{history.loading ? "loading earlier messages…" : "load earlier messages"}
					</button>
					{history.error !== null && (
						// Hidden, not removed, during a retry: the rows below must not shift.
						<div className={`tr-history-err${history.loading ? " tr-history-err--retrying" : ""}`} role="alert">
							couldn't load earlier messages: {history.error}
						</div>
					)}
				</div>
			)}
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{visible.map(entry => (
				<EntryRow key={entry.id} entry={entry} results={results} active={activeTools} host={host} />
			))}
			{stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
