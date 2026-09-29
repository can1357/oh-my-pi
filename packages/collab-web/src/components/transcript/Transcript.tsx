import type {
	AssistantMessage,
	CustomMessageEntry,
	ImageContent,
	SessionEntry,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-wire";
import { ArrowDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtClock, fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { BrandMark } from "../shell/BrandMark";
import { ActivityGroup } from "./ActivityGroup";
import { AsyncResultNotice, IrcNotice, SubagentCard } from "./AgentCards";
import { Markdown } from "./Markdown";
import { type AgentRowModel, buildTranscriptRows, type HumanRowModel } from "./rows";
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptScrollAnchor } from "./scroll-anchor";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** Completed execution results held until the matching toolResult entry arrives. */
	liveResults?: ReadonlyMap<string, ToolResultMessage>;
	/** Finished live messages whose persisted entries have not arrived yet. */
	completedStreams?: readonly AssistantMessage[];
	/** Latest real tool intent from the current run; null before an intent arrives. */
	workingIntent?: string | null;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Host participant's display name, shown on host prompts (falls back to "host"). */
	hostName?: string;
	/** Agent whose transcript is being viewed; used for incoming IRC attribution. */
	recipientName?: string;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
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

type Voice = "agent" | "host" | "guest";

/** Turn heading: a quiet byline — who is speaking, and when. Content, not identity chrome, carries the turn. */
function Speaker({ voice, name, timestamp }: { voice: Voice; name: string; timestamp?: string }): ReactNode {
	const clock = timestamp ? fmtClock(timestamp) : "";
	return (
		<div className={`tr-speaker tr-speaker--${voice}`}>
			{voice === "agent" && <BrandMark size={12} />}
			<span className="tr-speaker-name">{name}</span>
			{voice === "host" && name !== "host" && <span className="tr-speaker-meta">host</span>}
			{clock && (
				<time className="tr-speaker-meta" dateTime={timestamp} title={timestamp}>
					{clock}
				</time>
			)}
		</div>
	);
}

/**
 * One transcript turn. `speaker` is omitted when the previous visible row had the
 * same voice, so consecutive rows from one speaker read as one continuous turn.
 */
function Row({
	kind,
	speaker,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	speaker?: ReactNode;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}${speaker ? " tr-row--turn" : ""}`}>
			{speaker}
			<div className="tr-body">{children}</div>
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

/**
 * A host or guest prompt: the chat message the agent's turn answers. Takes the
 * model's fields, not the model object, which is rebuilt on every stream token.
 */
const HumanRow = memo(function HumanRow({
	entry,
	voice,
	from,
	continued,
	hostName,
}: Omit<HumanRowModel, "kind" | "key"> & { hostName?: string }): ReactNode {
	let content: string | readonly (TextContent | ImageContent)[] = "";
	if (entry.type === "message" && entry.message.role === "user") content = entry.message.content;
	else if (entry.type === "custom_message") content = entry.content;
	const name = voice === "host" ? (hostName ?? "host") : from;
	return (
		<Row
			kind="user"
			speaker={continued ? undefined : <Speaker voice={voice} name={name} timestamp={entry.timestamp} />}
		>
			<div className="tr-prompt">
				<MsgContent content={content} />
			</div>
		</Row>
	);
});

/** One run-level status, separate from immutable reasoning and tool output. */
function ThinkingStatus({ label }: { label?: string | null }): ReactNode {
	return (
		<div className="tr-think-status" role="status">
			<span className="tr-working-node" aria-hidden="true" />
			<span className="tr-working-label" title={label ?? undefined}>
				{label || "Thinking…"}
			</span>
		</div>
	);
}

/** Visible reasoning segment, styled like TUI thinking prose rather than a tool disclosure. */
const ThinkingBlock = memo(function ThinkingBlock({
	text,
	redacted,
	live,
	durationMs,
}: {
	text: string;
	redacted: boolean;
	live: boolean;
	durationMs?: number;
}): ReactNode {
	const measured = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0;
	const seconds = measured ? Math.round(durationMs / 1000) : 0;
	return (
		<div className="tr-think" aria-label="Reasoning" aria-busy={live}>
			{redacted ? <p className="tr-think-redacted">Reasoning hidden by the provider.</p> : <Markdown text={text} />}
			{!live && measured ? (
				<div className="tr-think-time">
					{seconds === 0
						? "Thought for less than a second"
						: `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}`}
				</div>
			) : null}
		</div>
	);
});

/** Agent turn: chat text and reasoning in the flow, tool calls folded into work blocks. */
function AgentRow({ row, host }: { row: AgentRowModel; host?: ToolRenderHost }): ReactNode {
	return (
		<Row
			kind="assistant"
			speaker={row.continued ? undefined : <Speaker voice="agent" name="agent" timestamp={row.timestamp} />}
		>
			{row.units.map(unit => {
				switch (unit.type) {
					case "text":
						return (
							<Anchored key={unit.key} keys={[unit.anchor]} className="tr-unit">
								<Markdown text={unit.text} />
							</Anchored>
						);
					case "thinking":
						return (
							<Anchored key={unit.key} keys={[unit.anchor]} className="tr-unit">
								<ThinkingBlock
									text={unit.text}
									redacted={unit.redacted}
									live={unit.live}
									durationMs={unit.durationMs}
								/>
							</Anchored>
						);
					case "activity":
						return (
							<Anchored key={unit.key} keys={unit.items.map(item => `tool:${item.id}`)} className="tr-unit">
								<ActivityGroup items={unit.items} host={host} />
							</Anchored>
						);
					case "subagents":
						return (
							<Anchored key={unit.key} keys={[`tool:${unit.item.id}`]} className="tr-unit">
								<SubagentCard item={unit.item} host={host} />
							</Anchored>
						);
					case "stop":
						return (
							<Anchored key={unit.key} keys={[unit.anchor]} className="tr-stop">
								<span className={`tr-chip ${unit.stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
									{unit.stop}
								</span>
								{unit.message !== undefined && unit.message.length > 0 && (
									<span className="tr-stop-msg">{unit.message}</span>
								)}
							</Anchored>
						);
				}
			})}
		</Row>
	);
}

/** Heading for a folded custom message: skill name + args for skill prompts, else the first text line. */
function customNoticeTitle(entry: CustomMessageEntry): { chip: string; label: string; detail?: string } {
	if (entry.customType === "skill-prompt" && entry.details !== null && typeof entry.details === "object") {
		const { name, args } = entry.details as Record<string, unknown>;
		if (typeof name === "string" && name.length > 0) {
			return { chip: "skill", label: name, detail: typeof args === "string" ? args.trim() || undefined : undefined };
		}
	}
	const text =
		typeof entry.content === "string"
			? entry.content
			: entry.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	const line =
		text
			.split("\n")
			.find(l => l.trim().length > 0)
			?.trim() ?? "";
	return { chip: entry.customType, label: line };
}

/**
 * Host-injected messages (skill prompts, hook notices) carry large expanded
 * bodies that aren't chat — folded to one line by default, expandable on click.
 */
function CustomNotice({ entry }: { entry: CustomMessageEntry }): ReactNode {
	const [open, setOpen] = useState(false);
	const title = customNoticeTitle(entry);
	return (
		<Row kind="custom">
			<div className={open ? "tr-custom tr-custom--open" : "tr-custom"}>
				<button type="button" className="tr-custom-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
					<ChevronRight size={13} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden="true" />
					<span className="tr-chip">{title.chip}</span>
					<span className="tr-custom-label">{title.label}</span>
					{title.detail && <span className="tr-custom-detail">{title.detail}</span>}
				</button>
				{open && (
					<div className="tr-custom-body">
						<MsgContent content={entry.content} />
					</div>
				)}
			</div>
		</Row>
	);
}

/** Dividers, marker lines, and custom notices. */
const NoticeRow = memo(function NoticeRow({ entry, host }: { entry: SessionEntry; host?: ToolRenderHost }): ReactNode {
	switch (entry.type) {
		case "custom_message":
			if (entry.customType === "async-result") return <AsyncResultNotice entry={entry} host={host} />;
			return <CustomNotice entry={entry} />;
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker">
					<span className="tr-marker" title={entry.timestamp}>
						model <span className="tr-marker-arrow">→</span> {entry.model}
					</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker">
					<span className="tr-marker" title={entry.timestamp}>
						thinking <span className="tr-marker-arrow">→</span> {entry.thinkingLevel ?? "off"}
					</span>
				</Row>
			);
		default:
			return null;
	}
});

/** Entries a reader would call a new message: prompts, agent replies with text, visible notices. */
function isChatEntry(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return entry.display;
	if (entry.type !== "message") return false;
	if (entry.message.role === "user") return true;
	return (
		entry.message.role === "assistant" &&
		entry.message.content.some(block => block.type === "text" && block.text.trim().length > 0)
	);
}

/**
 * Entries mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older entries mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		liveResults,
		completedStreams,
		workingIntent,
		working,
		compact,
		host,
		hostName,
		recipientName = "agent",
		phase,
	} = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows pair with visible entries and completed live tools.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		if (liveResults) {
			for (const [id, res] of liveResults) {
				if (!map.has(id)) map.set(id, res);
			}
		}
		return map;
	}, [visible, liveResults]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	// Entry count when the reader scrolled away from the tail; null while following it.
	const [unseenFrom, setUnseenFrom] = useState<number | null>(null);
	// Content identity survives prepending within a grouped turn and remounting its DOM.
	const prependRef = useRef<TranscriptScrollAnchor | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, liveResults, completedStreams, working, workingIntent]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		setUnseenFrom(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		restoreTranscriptAnchor(el, before);
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		prependRef.current = captureTranscriptAnchor(el);
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	const jumpToLatest = (): void => {
		const el = rootRef.current;
		if (el === null) return;
		setPinnedStart(null);
		setUnseenFrom(null);
		followTranscriptTail(el, lockRef, true);
	};

	// Chat-visible entries that arrived while the reader was scrolled up (tool results and markers don't count).
	const unseen = useMemo(
		() => (unseenFrom === null ? 0 : entries.slice(unseenFrom).filter(isChatEntry).length),
		[entries, unseenFrom],
	);

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
			if (
				completedStreams?.some(message =>
					message.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId),
				)
			)
				continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools, completedStreams]);
	const rows = useMemo(
		() =>
			buildTranscriptRows({
				visible,
				results,
				active: activeTools,
				completedStreams,
				stream,
				streamDone,
				tailTools,
			}),
		[visible, results, activeTools, completedStreams, stream, streamDone, tailTools],
	);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div className="tr-frame">
			<div
				ref={rootRef}
				className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
				onScroll={() => {
					const el = rootRef.current;
					if (el === null) return;
					updateTranscriptTailLock(el, lockRef);
					// Back at the bottom: drop the pin so the window trims to the tail again.
					if (lockRef.current) {
						if (pinnedStart !== null) setPinnedStart(null);
						if (unseenFrom !== null) setUnseenFrom(null);
					} else {
						if (pinnedStart === null) setPinnedStart(start);
						if (unseenFrom === null) setUnseenFrom(entries.length);
					}
					if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
				}}
			>
				{settled && entries.length === 0 && stream === null && !working && (
					<div className="tr-empty">no activity yet</div>
				)}
				{start > 0 && (
					<button type="button" className="tr-earlier" onClick={showEarlier}>
						show {start.toLocaleString("en-US")} earlier
					</button>
				)}
				{rows.map(row => {
					switch (row.kind) {
						case "agent":
							return <AgentRow key={row.key} row={row} host={host} />;
						case "human":
							return (
								<Anchored key={row.key} keys={[`entry:${row.key}`]}>
									<HumanRow
										entry={row.entry}
										voice={row.voice}
										from={row.from}
										continued={row.continued}
										hostName={hostName}
									/>
								</Anchored>
							);
						case "notice":
							return (
								<Anchored key={row.key} keys={[`entry:${row.key}`]}>
									<NoticeRow entry={row.entry} host={host} />
								</Anchored>
							);
						case "irc":
							return (
								<Anchored key={row.key} keys={[`entry:${row.key}`]}>
									<IrcNotice traffic={row.traffic} recipient={recipientName} />
								</Anchored>
							);
					}
				})}
				{working && (
					<div className="tr-live-status">
						<ThinkingStatus label={workingIntent} />
					</div>
				)}
			</div>
			{unseenFrom !== null && (
				<button type="button" className="tr-jump" onClick={jumpToLatest}>
					<ArrowDown size={13} aria-hidden="true" />
					{unseen > 0 ? `${unseen} new ${unseen === 1 ? "message" : "messages"}` : "Jump to latest"}
				</button>
			)}
		</div>
	);
}

function Anchored({
	keys,
	className,
	children,
}: {
	keys: string[];
	className?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={className} data-scroll-anchors={JSON.stringify(keys)}>
			{children}
		</div>
	);
}
