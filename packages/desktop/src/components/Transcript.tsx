import { Markdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { compactionMethodLabel, compactTokens } from "../rpc/compaction";
import type { CompactionEntry, TranscriptEntry } from "../rpc/transcript";
import { messageText, thinkingText } from "../rpc/transcript";
import { useContextMenu } from "../shell/contextMenu";
import { ToolCard } from "./ToolCard";
import { codeBlockAt, selectionWithin, transcriptMenuItems } from "./transcriptMenu";

/**
 * Not virtualized, deliberately. collab-web renders full transcripts the same
 * way and holds up; virtualizing breaks the browser's own find-in-page and
 * complicates auto-scroll. Revisit with a measurement, not a hunch.
 */
export const Transcript = memo(function Transcript({
	entries,
	streaming,
	onError,
}: {
	entries: readonly TranscriptEntry[];
	streaming?: boolean;
	/** Where a copy that failed goes, instead of nowhere. */
	onError(cause: unknown): void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	// Only follow the tail while the user is already at the bottom, so reading
	// scrollback is not yanked away by a streaming turn.
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		const onScroll = () => {
			const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
			pinned.current = distance < 80;
		};
		node.addEventListener("scroll", onScroll, { passive: true });
		return () => node.removeEventListener("scroll", onScroll);
	}, []);

	useLayoutEffect(() => {
		const node = scroller.current;
		if (node && pinned.current) node.scrollTop = node.scrollHeight;
	}, [entries, streaming]);

	/*
	 * Re-pin when the transcript itself is resized. `.omp-main` is
	 * `grid-template-rows: 1fr auto`, so a growing composer shrinks this pane —
	 * and the browser preserves `scrollTop`, which means the conversation slides
	 * up and away while you type. The effect above only fires on new entries.
	 *
	 * Setting `scrollTop` resizes nothing, so observing the same node we write to
	 * is not a loop. This also fixes the same drift on window resize.
	 */
	useEffect(() => {
		const node = scroller.current;
		if (!node) return;
		const observer = new ResizeObserver(() => {
			if (pinned.current) node.scrollTop = node.scrollHeight;
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	/*
	 * Links leave for the system browser.
	 *
	 * The renderer emits `target="_blank"`, which in a webview opens a second
	 * webview rather than a browser. Delegated here instead of per-link because
	 * the markup comes from `dangerouslySetInnerHTML` and has no React handlers
	 * to attach to.
	 */
	const onLinkClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		const anchor = (event.target as HTMLElement).closest?.("a[href]");
		const href = anchor?.getAttribute("href");
		if (!href || !/^(?:https?:|mailto:)/i.test(href)) return;
		event.preventDefault();
		void openUrl(href).catch(() => {});
	}, []);

	if (entries.length === 0 && !streaming) {
		return (
			<div className="omp-transcript" ref={scroller}>
				<div className="omp-empty">Ask the agent something to get started.</div>
			</div>
		);
	}

	// An assistant bubble with no text yet renders nothing, so a turn that opens
	// with a long thinking phase looked frozen. Show the agent is alive whenever
	// it is streaming and has not produced visible output for the last entry.
	const tail = entries.at(-1);
	/*
	 * A message the server has not confirmed yet is its own proof that work is
	 * starting: `streaming` comes from `state.isStreaming`, which is only
	 * refreshed at turn boundaries, so for the whole gap between Send and the
	 * turn opening it still reads false. Without this the message would appear
	 * instantly and then sit there looking ignored.
	 */
	const awaitingOutput =
		(tail?.kind === "message" && tail.pending !== undefined) ||
		(streaming &&
			(!tail ||
				(tail.kind === "message" && tail.role === "user") ||
				(tail.kind === "message" && tail.streaming && !messageText(tail.content) && !thinkingText(tail.content))));

	return (
		// Delegated click: the anchors it catches are keyboard-native already.
		<div className="omp-transcript" ref={scroller} onClick={onLinkClick}>
			{entries.map(entry => {
				if (entry.kind === "tool") {
					return (
						<div className="omp-entry omp-entry--tool" key={entry.id}>
							<ToolCard entry={entry} onError={onError} />
						</div>
					);
				}
				if (entry.kind === "compaction") return <CompactionRule key={entry.id} entry={entry} />;
				return <MessageBubble key={entry.id} entry={entry} onError={onError} />;
			})}

			{awaitingOutput ? <WorkingIndicator /> : null}
		</div>
	);
});

/**
 * The rule the TUI draws where a compaction rewrote the history.
 *
 * Everything above it was replaced by a summary, so this is not decoration: it
 * is the boundary between what the model still remembers and what it does not.
 * The summary itself opens on demand — it is long, and the point of the line is
 * that the rewrite happened here.
 */
function CompactionRule({ entry }: { entry: CompactionEntry }) {
	const amount =
		entry.tokensBefore !== undefined && entry.tokensAfter !== undefined
			? `${compactTokens(entry.tokensBefore)}→${compactTokens(entry.tokensAfter)}`
			: undefined;
	const summary = entry.summary ?? entry.shortSummary;

	return (
		<div className="omp-entry omp-compaction">
			<div className="omp-compaction__bar">
				<span className="omp-compaction__label">{compactionMethodLabel(entry.method)}</span>
				{amount ? <span className="omp-compaction__amount">{amount}</span> : null}
				{entry.warning ? (
					<span className="omp-compaction__warning" title={entry.warning}>
						{entry.warning}
					</span>
				) : null}
			</div>
			{summary ? (
				<details className="omp-compaction__details">
					<summary>What was kept</summary>
					<div className="omp-compaction__summary">{summary}</div>
				</details>
			) : null}
		</div>
	);
}

/** Three dots is the smallest honest "it is alive" signal. */
function WorkingIndicator() {
	return (
		<div className="omp-entry omp-entry--working" aria-live="polite">
			<div className="omp-entry__role">assistant</div>
			<div className="omp-working">
				<span />
				<span />
				<span />
			</div>
		</div>
	);
}

const MessageBubble = memo(function MessageBubble({
	entry,
	onError,
}: {
	entry: Extract<TranscriptEntry, { kind: "message" }>;
	onError(cause: unknown): void;
}) {
	const { open: openMenu } = useContextMenu();
	const thinking = thinkingText(entry.content);
	const text = messageText(entry.content);
	if (!thinking && !text) return null;

	return (
		<>
			{thinking ? (
				<div className="omp-entry omp-entry--thinking">
					<div className="omp-entry__role">thinking</div>
					<div className="omp-entry__body">{thinking}</div>
				</div>
			) : null}
			{text ? (
				<div
					className={`omp-entry omp-entry--${entry.role}`}
					onContextMenu={event => {
						openMenu(
							event,
							transcriptMenuItems({
								text,
								selection: selectionWithin(event.currentTarget),
								codeBlock: codeBlockAt(event.target),
								report: onError,
							}),
						);
					}}
				>
					<div className="omp-entry__role">{entry.role}</div>
					{/*
					 * Rendered, not printed. The transcript showed the model's markdown
					 * verbatim — `**bold**` with its asterisks, backticks around every
					 * path, list dashes flush left.
					 *
					 * This is collab-web's renderer, the same one the hosted client uses.
					 * It never emits raw HTML (its `html` token handler escapes) and
					 * `safeHref` drops `javascript:` and `data:`, which is what makes the
					 * `dangerouslySetInnerHTML` behind it defensible for model output.
					 */}
					<div className="omp-entry__body">
						<Markdown text={text} />
					</div>
				</div>
			) : null}
		</>
	);
});
