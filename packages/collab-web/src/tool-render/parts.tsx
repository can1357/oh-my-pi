/**
 * Shared UI primitives for tool renderers. Every renderer composes these
 * instead of inventing new CSS — see tool-render.css for the `tv-` classes.
 */
import { formatBytes } from "@oh-my-pi/pi-utils/format";
import type { CollabElided } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { isPathPrefix } from "../lib/elided";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types";
import { getHljs, replaceTabs, resultImagesOf, resultTextOf, shortenPath, stripAnsi } from "./util";

export type Tone = "accent" | "ok" | "err" | "warn";

/** Inline chip. Renders nothing for empty content. */
export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

/** Chip row; falsy items are skipped. Usable inline (summaries) and in bodies. */
export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
	const visible = items.filter(item => item != null && item !== "" && item !== false);
	if (visible.length === 0) return null;
	return (
		<span className="tv-badges">
			{visible.map((item, i) => (
				<Badge key={i}>{item}</Badge>
			))}
		</span>
	);
}

/** File path with optional `:start-end` line range or raw selector suffix. */
export function PathText({
	path,
	from,
	to,
	sel,
}: {
	path: string;
	from?: number | null;
	to?: number | null;
	sel?: string | null;
}): ReactNode {
	let range = "";
	if (from != null || to != null) {
		const start = from ?? 1;
		range = to != null ? `:${start}-${to}` : `:${start}`;
	}
	return (
		<span className="tv-path">
			{shortenPath(path)}
			{range && <span className="tv-lines">{range}</span>}
			{sel && <span className="tv-lines">:{sel}</span>}
		</span>
	);
}

/** Key/value grid. */
export function KvGrid({ children }: { children: ReactNode }): ReactNode {
	return <div className="tv-kv">{children}</div>;
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return (
		<>
			<span className="tv-kv-key">{k}</span>
			<span className="tv-kv-val">{children}</span>
		</>
	);
}

function useHighlight(code: string, lang: string | null | undefined): string | null {
	return useMemo(() => {
		if (!lang) return null;
		const hljs = getHljs();
		if (!hljs) return null;
		try {
			if (!hljs.getLanguage(lang)) return null;
			return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} catch {
			return null;
		}
	}, [code, lang]);
}

export interface OutputProps {
	text: string;
	/** Lines shown before collapsing behind a "more" affordance. */
	maxLines?: number;
	/** highlight.js language (only applied when the host exposes hljs). */
	lang?: string | null;
	/** Render in error color. */
	error?: boolean;
	/** "code": horizontal scroll, inset bg. "plain": soft-wrapped. */
	variant?: "code" | "plain";
	/** Uppercase mini-title above the block. */
	title?: string;
	/** Drop the inset background (inline in flow). */
	bare?: boolean;
}

/**
 * Expandable text block — the workhorse for command output, file previews,
 * search results. Tabs are widened, ANSI escapes stripped.
 */
export function Output({ text, maxLines = 10, lang, error, variant = "plain", title, bare }: OutputProps): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const clean = useMemo(() => replaceTabs(stripAnsi(text)).replace(/\n+$/, ""), [text]);
	const lines = useMemo(() => clean.split("\n"), [clean]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : clean;
	const html = useHighlight(shown, error ? null : lang);
	const classes = ["tv-pre"];
	if (variant === "plain") classes.push("tv-pre--wrap");
	if (error) classes.push("tv-pre--error");
	if (bare) classes.push("tv-pre--bare");
	return (
		<div className="tv-out">
			{title && <div className="tv-out-title">{title}</div>}
			{html !== null ? (
				<pre className={classes.join(" ")} dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre className={classes.join(" ")}>{shown}</pre>
			)}
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? "collapse" : `⋯ ${lines.length - maxLines} more lines`}
				</button>
			)}
		</div>
	);
}

/** Source-code block: inset background, no soft wrap, optional title chip. */
export function CodeBlock({
	code,
	lang,
	title,
	maxLines = 14,
}: {
	code: string;
	lang?: string | null;
	title?: string;
	maxLines?: number;
}): ReactNode {
	if (!code) return null;
	return <Output text={code} lang={lang} maxLines={maxLines} variant="code" title={title} />;
}

/**
 * Result text of a tool result, styled for success or error automatically.
 * Renders nothing when the result is absent or has no text.
 */
export function ResultText({
	result,
	maxLines = 10,
	lang,
	variant,
	title,
}: {
	result: ToolResultLike | undefined;
	maxLines?: number;
	lang?: string | null;
	variant?: "code" | "plain";
	title?: string;
}): ReactNode {
	const text = resultTextOf(result).trim();
	if (!text) return null;
	return (
		<Output
			text={text}
			maxLines={maxLines}
			lang={result?.isError ? null : lang}
			error={result?.isError === true}
			variant={variant ?? (lang ? "code" : "plain")}
			title={title}
		/>
	);
}

function openImage(img: ToolResultImage): void {
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
		window.open(url, "_blank", "noopener");
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		// undecodable image data — the broken thumbnail already conveys it
	}
}

/** Thumbnails for every image block in a result; click opens full size. */
export function ResultImages({ result }: { result: ToolResultLike | undefined }): ReactNode {
	const images = resultImagesOf(result);
	if (images.length === 0) return null;
	return (
		<div className="tv-imgs">
			{images.map((img, i) => (
				<button
					key={i}
					type="button"
					style={{ all: "unset", display: "inline-flex" }}
					onClick={() => openImage(img)}
					aria-label={`Open tool result image ${i + 1}`}
				>
					<img className="tv-img" src={`data:${img.mimeType};base64,${img.data}`} alt={`tool result ${i + 1}`} />
				</button>
			))}
		</div>
	);
}

interface LoadState {
	loading: boolean;
	error: string | null;
}

const LOAD_IDLE: LoadState = { loading: false, error: null };

/**
 * Load `records` of entry `entryId` through the host, one at a time and
 * shallowest path first: a whole-entry or array load already restores what
 * the records nested inside it trimmed, which the host then drops.
 */
function useLoadFull(
	host: ToolRenderHost | undefined,
	entryId: string | undefined,
	records: readonly CollabElided[],
): { state: LoadState; load: (() => void) | undefined } {
	const [state, setState] = useState<LoadState>(LOAD_IDLE);
	const loadFull = host?.loadFull;
	if (loadFull === undefined || entryId === undefined || records.length === 0) return { state, load: undefined };
	const load = (): void => {
		setState({ loading: true, error: null });
		void (async () => {
			const ordered = [...records].sort((a, b) => a.path.length - b.path.length);
			for (const record of ordered) {
				const error = await loadFull(entryId, record);
				if (error !== null) {
					setState({ loading: false, error });
					return;
				}
			}
			setState(LOAD_IDLE);
		})();
	};
	return { state, load };
}

/** Bytes a load of `records` transfers: nested records are covered by their ancestors. */
function loadBytes(records: readonly CollabElided[]): number {
	let total = 0;
	for (const record of records) {
		const nested = records.some(
			other => other !== record && other.path.length < record.path.length && isPathPrefix(other.path, record.path),
		);
		if (!nested) total += record.bytes;
	}
	return total;
}

/**
 * "load full" control for values the collab host trimmed from one entry.
 * Renders nothing when the host cannot load (HTML exports) or nothing is
 * trimmed; the placeholders themselves stay as sent.
 */
export function LoadFull({
	host,
	entryId,
	records,
	label,
}: {
	host: ToolRenderHost | undefined;
	entryId: string | undefined;
	records: readonly CollabElided[];
	/** e.g. "load full output"; the size is appended. */
	label: string;
}): ReactNode {
	const { state, load } = useLoadFull(host, entryId, records);
	if (load === undefined) return null;
	return (
		<span className="tv-load">
			<button type="button" className="tv-expand tv-load-btn" disabled={state.loading} onClick={load}>
				{state.loading && <span className="tv-spin" aria-hidden="true" />}
				{state.loading ? "loading…" : `⤓ ${label} (${formatBytes(loadBytes(records))})`}
			</button>
			{state.error !== null && (
				<span className="tv-load-err" role="alert">
					{state.error}
				</span>
			)}
		</span>
	);
}

/**
 * Tile standing in for an image the collab host did not send; the loaded
 * entry renders the image itself. Renders nothing when the host cannot load.
 */
export function ElidedImage({
	host,
	entryId,
	elided,
	placeholder,
}: {
	host: ToolRenderHost | undefined;
	entryId: string | undefined;
	elided: CollabElided;
	/** The host's text placeholder, shown as sent; omitted where it is already on screen. */
	placeholder?: string;
}): ReactNode {
	const records = useMemo(() => [elided], [elided]);
	const { state, load } = useLoadFull(host, entryId, records);
	if (load === undefined) return null;
	return (
		<button
			type="button"
			className="tv-img-tile"
			disabled={state.loading}
			onClick={load}
			aria-label={`Load image (${elided.mimeType ?? "unknown type"}, ${formatBytes(elided.bytes)})`}
		>
			{placeholder !== undefined && <span className="tv-img-tile-text">{placeholder}</span>}
			<span className="tv-img-tile-action">
				{state.loading && <span className="tv-spin" aria-hidden="true" />}
				{state.loading ? "loading image…" : "tap to load image"}
			</span>
			{state.error !== null && <span className="tv-load-err">{state.error}</span>}
		</button>
	);
}

/** Callout block. */
export function Note({ tone, children }: { tone?: "err" | "warn" | "ok"; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

/** Labeled row inside a `.tv-list`. */
export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="tv-row">
			{k != null && k !== "" && <span className="tv-row-key">{k}</span>}
			<span className="tv-row-val">{children}</span>
		</div>
	);
}

/** Marker for arguments that arrived with the wrong JSON type. */
export function InvalidArg({ what }: { what?: string }): ReactNode {
	return <span className="tv-err-text">[invalid {what ?? "arg"}]</span>;
}

/**
 * Unified-diff-ish block: `+` rows added, `-` rows removed, `@@` hunk headers
 * faint, blank rows render as `…` gaps (non-contiguous regions).
 */
export function DiffBlock({ diff, maxLines = 80 }: { diff: string; maxLines?: number }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const lines = useMemo(() => replaceTabs(stripAnsi(diff)).replace(/\n+$/, "").split("\n"), [diff]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;
	return (
		<div className="tv-out">
			<div className="tv-diff">
				{shown.map((line, i) => {
					let cls = "";
					if (line.trim().length === 0) cls = "--gap";
					else if (line.startsWith("+")) cls = "--add";
					else if (line.startsWith("-")) cls = "--del";
					else if (line.startsWith("@@")) cls = "--hunk";
					return (
						<div key={i} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
							{line.trim().length === 0 ? "…" : line}
						</div>
					);
				})}
			</div>
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? "collapse" : `⋯ ${lines.length - maxLines} more lines`}
				</button>
			)}
		</div>
	);
}

/**
 * Agent id chip. Becomes a drill-down button when the host can open that
 * agent's sub-session; otherwise renders as a plain accent badge.
 */
export function AgentLink({
	id,
	host,
	children,
}: {
	id: string;
	host?: ToolRenderHost;
	children?: ReactNode;
}): ReactNode {
	const clickable = host?.openAgent !== undefined && (host.hasAgent === undefined || host.hasAgent(id));
	if (!clickable) return <Badge tone="accent">{children ?? id}</Badge>;
	return (
		<button type="button" className="tv-badge tv-badge--accent tv-agent-link" onClick={() => host.openAgent?.(id)}>
			{children ?? id}
			<span className="tv-agent-link-arrow" aria-hidden="true">
				{" ↗"}
			</span>
		</button>
	);
}
