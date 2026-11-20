/**
 * The panel transcript: right-aligned user cards with tab chips, full-width replies, Claude-style step groups,
 * the working row, compaction progress and jump-to-latest. Laid out for a narrow column at every width.
 */
import { Markdown, StreamingMarkdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import type { Notice } from "@oh-my-pi/collab-web/src/lib/client";
import { messageText } from "@oh-my-pi/collab-web/src/lib/format";
import { ToolView } from "@oh-my-pi/collab-web/src/tool-render";
import type { ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import {
	ArrowDown,
	ArrowUpDown,
	BookmarkPlus,
	Bot,
	Camera,
	Check,
	ChevronRight,
	Copy,
	FileText,
	Globe,
	Hourglass,
	Keyboard,
	ListChecks,
	MessageCircleQuestion,
	MousePointer2,
	ScanText,
	Search,
	Sparkle,
	Terminal,
	Wrench,
} from "lucide-react";
import {
	createContext,
	memo,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { TabContext } from "../messages";
import type { StepIcon } from "./describe";
import { Lightbox, type LightboxImage, Thumb } from "./media";
import type { PanelSnapshot } from "./session";
import { faviconFor, hostOf, type TabRef } from "./tab-context";
import {
	buildCommitted,
	buildTimeline,
	imageSrc,
	isStep,
	liveVerb,
	resultError,
	resultImages,
	type Step,
	type Thought,
	type TimelineItem,
} from "./timeline";
import { Favicon } from "./ui";

/** Items mounted at the tail; older ones mount a window at a time so a long attached session stays cheap. */
const WINDOW = 80;
/** User text longer than this clamps behind “Show more”. */
const CLAMP_CHARS = 500;
const CLAMP_PX = 300;

function StepGlyph({ icon }: { icon: StepIcon }): ReactNode {
	const size = 16;
	switch (icon) {
		case "click":
			return <MousePointer2 size={size} />;
		case "type":
			return <Keyboard size={size} />;
		case "scroll":
			return <ArrowUpDown size={size} />;
		case "navigate":
			return <Globe size={size} />;
		case "screenshot":
			return <Camera size={size} />;
		case "terminal":
			return <Terminal size={size} />;
		case "file":
			return <FileText size={size} />;
		case "search":
			return <Search size={size} />;
		case "page":
			return <ScanText size={size} />;
		case "wait":
			return <Hourglass size={size} />;
		case "agent":
			return <Bot size={size} />;
		case "ask":
			return <MessageCircleQuestion size={size} />;
		case "plan":
			return <ListChecks size={size} />;
		default:
			return <Wrench size={size} />;
	}
}

/** A step label with its `code` spans set in mono. */
function LabelText({ text }: { text: string }): ReactNode {
	const parts = text.split("`");
	if (parts.length < 3) return text;
	return parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

/** Copy button that turns into a check and “Copied” for two seconds. */
function CopyAction({ text }: { text: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className="pn-rail-btn"
			aria-label="Copy"
			data-tip={copied ? undefined : "Copy"}
			data-tip-side="above"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => setCopied(true));
			}}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
			{copied && <span>Copied</span>}
		</button>
	);
}

function MessageRail(props: { text: string; align: "left" | "right"; pinned?: boolean; onSave(): void }): ReactNode {
	return (
		<div className={`pn-rail pn-rail--${props.align}${props.pinned ? " pn-rail--pinned" : ""}`}>
			<CopyAction text={props.text} />
			<button
				type="button"
				className="pn-rail-btn"
				aria-label="Save as shortcut"
				data-tip="Save as shortcut"
				data-tip-side="above"
				onClick={props.onSave}
			>
				<BookmarkPlus size={14} />
			</button>
		</div>
	);
}

/** The live active tab, whose favicon Chrome already has; pills for the same site use it. */
export const ActiveTabContext = createContext<TabContext | null>(null);

/** The `<chrome-tab>` block of a prompt as a 20px pill: favicon, `host · title`. */
export function TabPill({ tab }: { tab: TabRef }): ReactNode {
	const host = hostOf(tab.url);
	const active = useContext(ActiveTabContext);
	const favicon = active !== null && hostOf(active.url) === host ? active.favIconUrl : undefined;
	return (
		<span className="pn-tab-pill" title={tab.url}>
			<Favicon src={favicon ?? faviconFor(tab.url)} size={14} />
			<span className="pn-tab-pill-text">
				{tab.title === "" || tab.title === host ? host : `${host} · ${tab.title}`}
			</span>
		</span>
	);
}

const UserTurn = memo(function UserTurn(props: {
	item: Extract<TimelineItem, { kind: "user" }>;
	onOpenImage(image: LightboxImage): void;
	onSaveShortcut(prompt: string): void;
}): ReactNode {
	const { item } = props;
	const long = item.text.length > CLAMP_CHARS;
	const [expanded, setExpanded] = useState(false);
	const textRef = useRef<HTMLDivElement | null>(null);
	const [fullHeight, setFullHeight] = useState<number | null>(null);
	useLayoutEffect(() => {
		if (long && textRef.current !== null) setFullHeight(textRef.current.scrollHeight);
	}, [long]);
	return (
		<div className="pn-user">
			{item.images.length > 0 && (
				<div className="pn-user-images">
					{item.images.map((image, index) => (
						<button
							key={index}
							type="button"
							className="pn-user-image"
							aria-label="Preview attachment"
							onClick={() => props.onOpenImage({ src: imageSrc(image), alt: "attachment" })}
						>
							<img src={imageSrc(image)} alt="" draggable={false} />
						</button>
					))}
				</div>
			)}
			{(item.text !== "" || item.tabs.length > 0) && (
				<div className="pn-user-card">
					{item.tabs.length > 0 && (
						<div className="pn-user-tabs">
							{item.tabs.map((tab, index) => (
								<TabPill key={index} tab={tab} />
							))}
						</div>
					)}
					{item.text !== "" && (
						<div
							ref={textRef}
							className={`pn-user-text${long && !expanded ? " pn-user-text--clamped" : ""}`}
							style={long ? { maxHeight: expanded ? (fullHeight ?? "none") : CLAMP_PX } : undefined}
						>
							<Markdown text={item.text} />
						</div>
					)}
					{long && (
						<button type="button" className="pn-show-more" onClick={() => setExpanded(open => !open)}>
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}
			{item.text !== "" && (
				<MessageRail text={item.text} align="right" onSave={() => props.onSaveShortcut(item.text)} />
			)}
		</div>
	);
});

const COPY_GLYPH =
	'<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/><path class="pn-code-check" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/**
 * Dress the code blocks of rendered Markdown: language label, and a copy button in a sticky header so it stays
 * in view while a long block scrolls past. Only the inside of each `<pre>` changes; the Markdown root keeps its
 * direct children, which `StreamingMarkdown` counts.
 */
function dressCodeBlocks(root: HTMLElement): void {
	for (const pre of root.querySelectorAll<HTMLPreElement>("pre:not([data-pn])")) {
		const code = pre.querySelector("code");
		if (code === null) continue;
		pre.dataset.pn = "";
		const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? "";
		// A zero-height sticky row carries the button, so it rides along the top of the viewport over a long block.
		const head = document.createElement("div");
		head.className = "pn-code-head";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pn-code-copy";
		button.setAttribute("aria-label", "Copy code");
		button.innerHTML = COPY_GLYPH;
		head.append(button);
		const label = document.createElement("div");
		label.className = "pn-code-lang";
		label.textContent = language;
		const scroller = document.createElement("div");
		scroller.className = "pn-code-scroll";
		scroller.append(...pre.childNodes);
		pre.append(head, label, scroller);
	}
}

const Reply = memo(function Reply(props: {
	item: Extract<TimelineItem, { kind: "reply" }>;
	latest: boolean;
	/** The prompt this reply answers; “Save as shortcut” saves it. */
	prompt: string;
	onSaveShortcut(prompt: string): void;
}): ReactNode {
	const { item } = props;
	const ref = useRef<HTMLDivElement | null>(null);
	// Runs after the Markdown child's own layout effect, so it sees the nodes of this very update.
	useLayoutEffect(() => {
		if (ref.current !== null) dressCodeBlocks(ref.current);
	}, [item.text, item.streaming]);

	const onClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
		if (!(event.target instanceof Element)) return;
		const copy = event.target.closest<HTMLButtonElement>(".pn-code-copy");
		if (copy !== null) {
			const code = copy.closest("pre")?.querySelector(".pn-code-scroll")?.textContent ?? "";
			void navigator.clipboard.writeText(code.replace(/\n$/, "")).then(() => {
				copy.dataset.copied = "";
				window.setTimeout(() => delete copy.dataset.copied, 2000);
			});
			return;
		}
		const link = event.target.closest<HTMLAnchorElement>("a[href]");
		if (link !== null) {
			// Links open beside the page omp is working in, never over it and never stealing focus.
			event.preventDefault();
			void chrome.tabs.create({ url: link.href, active: false });
		}
	};

	return (
		<div className="pn-reply" ref={ref} onClick={onClick}>
			{item.streaming ? <StreamingMarkdown text={item.text} /> : <Markdown text={item.text} />}
			{!item.streaming && (
				<MessageRail
					text={item.text}
					align="left"
					pinned={props.latest}
					onSave={() => props.onSaveShortcut(props.prompt)}
				/>
			)}
		</div>
	);
});

function ThinkingBlock({ text, redacted }: { text: string; redacted: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think pn-think">
			<button type="button" className="tr-think-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

function stepImage(step: Step): LightboxImage | null {
	const images = resultImages(step.result);
	const last = images[images.length - 1];
	if (last === undefined) return null;
	return {
		src: imageSrc(last),
		alt: step.description.done,
		point: step.description.point,
		drag: step.description.drag,
	};
}

function StepRow(props: { step: Step; onOpenImage(image: LightboxImage): void }): ReactNode {
	const { step } = props;
	const [open, setOpen] = useState(false);
	const error = resultError(step.result);
	const image = stepImage(step);
	const state = step.running ? "run" : error !== null ? "err" : "ok";
	const partial =
		step.running && step.result === undefined
			? typeof step.partialResult === "string"
				? step.partialResult
				: messageText(step.partialResult)
			: "";
	return (
		<li className="pn-step" data-state={state}>
			<button type="button" className="pn-step-main" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<span className="pn-step-icon">
					<StepGlyph icon={step.description.icon} />
				</span>
				<span className={`pn-step-label${step.running ? " pn-shimmer-text" : ""}`}>
					<LabelText text={step.running ? step.description.live : step.description.done} />
				</span>
				{error !== null && (
					<span className="pn-step-error">
						<span className="pn-step-error-dot" />
						{error}
					</span>
				)}
			</button>
			{image !== null && <Thumb image={image} onOpen={props.onOpenImage} />}
			{open && (
				<div className="pn-step-card">
					<ToolView
						name={step.name}
						args={step.args}
						result={step.result}
						running={step.running}
						intent={step.intent}
						partial={partial === "" ? undefined : partial}
						defaultOpen
					/>
				</div>
			)}
		</li>
	);
}

function ThoughtRow({ thought }: { thought: Thought }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<li className="pn-step pn-step--thought">
			<button type="button" className="pn-step-main" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<span className="pn-step-icon">
					<Sparkle size={14} />
				</span>
				<span className="pn-step-label">{thought.redacted ? "Thought · redacted" : "Thought"}</span>
			</button>
			{open && (
				<div className="pn-step-card tr-think-body">
					{thought.redacted ? "(redacted by provider)" : thought.thought}
				</div>
			)}
		</li>
	);
}

const StepGroup = memo(function StepGroup(props: {
	item: Extract<TimelineItem, { kind: "steps" }>;
	/** Still the tail of a running turn: stays open until prose follows it. */
	live: boolean;
	onOpenImage(image: LightboxImage): void;
}): ReactNode {
	const { item, live } = props;
	// Null follows the default (open while live, collapsed once done); a click pins the user's choice.
	const [choice, setChoice] = useState<boolean | null>(null);
	const open = choice ?? live;
	const failed = item.rows.filter(row => isStep(row) && row.result?.isError === true).length;
	return (
		<div className="pn-steps" data-open={open || undefined}>
			<button type="button" className="pn-steps-head" aria-expanded={open} onClick={() => setChoice(!open)}>
				<ChevronRight size={12} className="pn-steps-chev" />
				{item.stepCount} {item.stepCount === 1 ? "step" : "steps"}
				{failed > 0 && <span className="pn-steps-failed">· {failed} failed</span>}
			</button>
			<div className="pn-collapse" data-open={open || undefined}>
				<div className="pn-collapse-inner" inert={!open}>
					<ol className="pn-steps-list">
						{item.rows.map(row =>
							isStep(row) ? (
								<StepRow key={row.id} step={row} onOpenImage={props.onOpenImage} />
							) : (
								<ThoughtRow key={row.id} thought={row} />
							),
						)}
					</ol>
				</div>
			</div>
		</div>
	);
});

/** The label of the working row; a change slides the old verb out before the new one comes in. */
function SwapLabel({ text }: { text: string }): ReactNode {
	const [shown, setShown] = useState(text);
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		if (text === shown) {
			setLeaving(false);
			return;
		}
		setLeaving(true);
		const timer = window.setTimeout(() => {
			setShown(text);
			setLeaving(false);
		}, 210);
		return () => window.clearTimeout(timer);
	}, [text, shown]);
	return (
		<span key={shown} className={`pn-working-label pn-shimmer-text${leaving ? " pn-working-label--out" : ""}`}>
			<LabelText text={shown} />…
		</span>
	);
}

function WorkingRow({ verb }: { verb: string }): ReactNode {
	return (
		<div className="pn-working" role="status" aria-live="polite">
			<span className="pn-sweep-mark" aria-hidden="true" />
			<SwapLabel text={verb} />
		</div>
	);
}

const COMPACT_START = /^compacting context/i;
const COMPACT_END = /^(?:context compacted|compaction (?:aborted|failed))/i;

/**
 * Compaction progress, or null when none is running. Hosts report only start and end, so the number follows the
 * curve `100·(1 − e^(−t/25s))` capped at 95, never going back; it snaps to 100 on finish and stays one second.
 */
function useCompactionPercent(
	notices: readonly Notice[],
	entries: readonly SessionEntry[],
	manual: boolean,
): number | null {
	const [run, setRun] = useState<{ startedAt: number; finishedAt: number | null } | null>(null);
	const [percent, setPercent] = useState(0);
	const seenNotice = useRef<number | null>(null);
	const compactions = useMemo(() => entries.filter(entry => entry.type === "compaction").length, [entries]);
	const seenCompactions = useRef(compactions);

	useEffect(() => {
		const last = notices[notices.length - 1];
		// Notices that predate this view describe compactions that are long over.
		if (seenNotice.current === null) {
			seenNotice.current = last?.id ?? 0;
			return;
		}
		for (const notice of notices) {
			if (notice.id <= seenNotice.current) continue;
			if (COMPACT_START.test(notice.message)) setRun({ startedAt: Date.now(), finishedAt: null });
			else if (COMPACT_END.test(notice.message))
				setRun(current => (current === null ? null : { ...current, finishedAt: Date.now() }));
		}
		if (last !== undefined) seenNotice.current = last.id;
	}, [notices]);

	useEffect(() => {
		if (manual) setRun({ startedAt: Date.now(), finishedAt: null });
		else setRun(current => (current === null ? null : { ...current, finishedAt: current.finishedAt ?? Date.now() }));
	}, [manual]);

	useEffect(() => {
		if (compactions > seenCompactions.current)
			setRun(current => (current === null ? null : { ...current, finishedAt: current.finishedAt ?? Date.now() }));
		seenCompactions.current = compactions;
	}, [compactions]);

	useEffect(() => {
		if (run === null) return;
		if (run.finishedAt !== null) {
			setPercent(100);
			const timer = window.setTimeout(() => setRun(null), 1000);
			return () => window.clearTimeout(timer);
		}
		setPercent(0);
		const timer = window.setInterval(() => {
			const elapsed = Date.now() - run.startedAt;
			setPercent(previous => Math.max(previous, Math.round(Math.min(95, 100 * (1 - Math.exp(-elapsed / 25_000))))));
		}, 100);
		return () => window.clearInterval(timer);
	}, [run]);

	return run === null ? null : percent;
}

/** What the transcript needs from the app. */
export interface TranscriptProps {
	snapshot: PanelSnapshot;
	/** A manual `/compact` is in flight. */
	compacting: boolean;
	/** Bumped whenever the user sends: jump to the latest message and follow again. */
	followSignal: number;
	/** Shown when the conversation has nothing in it yet. */
	empty: ReactNode;
	onSaveShortcut(prompt: string): void;
}

/** The scrolling conversation. */
export function Transcript(props: TranscriptProps): ReactNode {
	const { snapshot } = props;
	const { entries, activeTools, stream, streamDone, working } = snapshot;
	const base = useMemo(() => buildCommitted({ entries, activeTools }), [entries, activeTools]);
	const items = useMemo(
		() => buildTimeline(base, { stream, streamDone, activeTools }),
		[base, stream, streamDone, activeTools],
	);
	const compaction = useCompactionPercent(snapshot.notices, entries, props.compacting);

	const [extra, setExtra] = useState(0);
	const start = Math.max(0, items.length - WINDOW - extra);
	const visible = start === 0 ? items : items.slice(start);

	const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
	const openImage = useCallback((image: LightboxImage) => setLightbox(image), []);

	// ---- follow the tail ----
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const following = useRef(true);
	const lastTop = useRef(0);
	const [atBottom, setAtBottom] = useState(true);

	const toBottom = useCallback((): void => {
		const el = scrollRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
		lastTop.current = el.scrollTop;
	}, []);

	useLayoutEffect(() => {
		if (following.current) toBottom();
	}, [items, working, compaction, toBottom]);

	// Images and expanding cards grow the content, and a growing composer shrinks the viewport, without a render
	// of this component.
	useEffect(() => {
		const content = contentRef.current;
		const viewport = scrollRef.current;
		if (content === null || viewport === null) return;
		const observer = new ResizeObserver(() => {
			if (following.current) toBottom();
		});
		observer.observe(content);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [toBottom]);

	useEffect(() => {
		const root = scrollRef.current;
		const sentinel = sentinelRef.current;
		if (root === null || sentinel === null) return;
		const observer = new IntersectionObserver(found => setAtBottom(found[found.length - 1]?.isIntersecting ?? true), {
			root,
			rootMargin: "0px 0px 50px 0px",
		});
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		following.current = true;
		toBottom();
	}, [props.followSignal, toBottom]);

	const onScroll = (): void => {
		const el = scrollRef.current;
		if (el === null) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distance <= 8) following.current = true;
		else if (el.scrollTop < lastTop.current - 8) following.current = false;
		if (el.scrollTop > lastTop.current || following.current) lastTop.current = el.scrollTop;
		// Near the top of the mounted window: mount the one before it, keeping the reader's place.
		if (el.scrollTop < 200 && start > 0) {
			const before = el.scrollHeight;
			setExtra(count => count + WINDOW);
			requestAnimationFrame(() => {
				el.scrollTop += el.scrollHeight - before;
				lastTop.current = el.scrollTop;
			});
		}
	};

	let latestReply = -1;
	for (let i = visible.length - 1; i >= 0; i--) {
		const item = visible[i];
		if (item.kind === "user") break;
		if (item.kind === "reply") {
			latestReply = i;
			break;
		}
	}
	const liveGroup = working ? visible.length - 1 : -1;
	const isEmpty = items.length === 0 && !working && compaction === null;
	let prompt = "";

	return (
		<div className="pn-transcript-wrap">
			<div className="pn-transcript" ref={scrollRef} onScroll={onScroll}>
				<div className="pn-transcript-inner" ref={contentRef}>
					{isEmpty && props.empty}
					{start > 0 && (
						<button type="button" className="tr-earlier" onClick={() => setExtra(count => count + WINDOW)}>
							show {start.toLocaleString("en-US")} earlier
						</button>
					)}
					{visible.map((item, index) => {
						switch (item.kind) {
							case "user":
								prompt = item.text;
								return (
									<UserTurn
										key={item.key}
										item={item}
										onOpenImage={openImage}
										onSaveShortcut={props.onSaveShortcut}
									/>
								);
							case "reply":
								return (
									<Reply
										key={item.key}
										item={item}
										latest={index === latestReply && !working}
										prompt={prompt}
										onSaveShortcut={props.onSaveShortcut}
									/>
								);
							case "thinking":
								return <ThinkingBlock key={item.key} text={item.text} redacted={item.redacted} />;
							case "steps":
								return (
									<StepGroup
										key={item.key}
										item={item}
										live={item.running || index === liveGroup}
										onOpenImage={openImage}
									/>
								);
							case "stopped":
								return (
									<div key={item.key} className="tr-stop pn-stop">
										<span className={`tr-chip ${item.reason === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
											{item.reason === "aborted" ? "stopped" : "error"}
										</span>
										{item.message !== undefined && item.message !== "" && (
											<span className="tr-stop-msg">{item.message}</span>
										)}
									</div>
								);
							case "divider":
								return (
									<div key={item.key} className="tr-divider" title={item.detail}>
										<span>{item.label}</span>
									</div>
								);
							case "marker":
								return (
									<div key={item.key} className="tr-marker pn-marker">
										{item.label}
									</div>
								);
							case "custom":
								return (
									<div key={item.key} className="tr-custom pn-custom">
										<span className="tr-chip">{item.customType}</span>
										<Markdown text={item.text} />
									</div>
								);
							default:
								return null;
						}
					})}
					{compaction !== null && (
						<div className="pn-compaction" role="status">
							<span className="pn-shimmer-text">Compacting the conversation…</span>
							<span className="pn-compaction-pct">{compaction}%</span>
						</div>
					)}
					{working && compaction === null && <WorkingRow verb={liveVerb(snapshot)} />}
					<div ref={sentinelRef} className="pn-sentinel" />
				</div>
			</div>
			{!atBottom && (
				<button
					type="button"
					className={`pn-jump${working ? " pn-jump--live" : ""}`}
					aria-label="Jump to latest"
					onClick={() => {
						following.current = true;
						toBottom();
					}}
				>
					<ArrowDown size={16} />
				</button>
			)}
			{lightbox !== null && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
		</div>
	);
}

/** Every screenshot of the latest turn with what omp did on it, for GIF export. */
export function latestRunShots(items: readonly TimelineItem[]): { image: ImageContent; step: Step }[] {
	let from = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].kind === "user") {
			from = i + 1;
			break;
		}
	}
	const shots: { image: ImageContent; step: Step }[] = [];
	for (const item of items.slice(from)) {
		if (item.kind !== "steps") continue;
		for (const row of item.rows) {
			if (!isStep(row)) continue;
			const images = resultImages(row.result);
			const image = images[images.length - 1];
			if (image !== undefined) shots.push({ image, step: row });
		}
	}
	return shots;
}
