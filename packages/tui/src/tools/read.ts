import type { SummaryResult } from "@oh-my-pi/pi-natives";
import { formatNumberedLine } from "./hashline-format";
import { LINE_RANGE_CHUNK_SOURCE, parseLineRanges } from "./line-ranges";
import * as os from "node:os";
import * as path from "node:path";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";
import type { Component } from "../tui";
import { Text } from "../components/text";
import type { RenderResultOptions, ToolActivityContext, ToolActivitySummary, ToolRenderer } from "./renderer";
import { getLanguageFromPath } from "../lang-from-path";
import type { Theme } from "../theme/theme";
import { fileHyperlink, renderCodeCell, renderMarkdownCell, renderStatusLine } from "../render";
import { markFramedBlockComponent } from "../render/output-block";
import { framedToolCard } from "../render/tool-card";
import { type ReadUrlToolDetails, renderReadUrlCall, renderReadUrlResult } from "./fetch";
import { formatFullOutputReference, formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import { formatBytes, sanitizeDisplayLines, shortenPath, wrapBrackets } from "../render/render-utils";

import type { OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { renderProcRead, type ProcReadDetails } from "./proc-render";
import { renderCfgRead, type CfgReadDetails } from "./cfg-render";
import type { CardToolResult } from "./result-card";
import { type InternalUrlSchemeSpec, internalUrlSchemeSpec, splitUrlScheme } from "./url-scheme-host";

/** Read result metadata retains truncation statistics, not a second copy of the body. */
export type ReadTruncationStats = Omit<TruncationResult, "content">;

/** Display metadata for file and URL reads. */
export interface ReadToolDetails {
	kind?: "file" | "url";
	proc?: ProcReadDetails;
	cfg?: CfgReadDetails;
	/** Filesystem hyperlink target resolved by the executing tool. */
	displayTarget?: string;
	truncation?: ReadTruncationStats;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Full on-disk byte size recorded before applying a file range. */
	fileSize?: number;
	/** Full source line count when the read reached EOF and the count is exact. */
	totalLines?: number;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: {
		text: string;
		startLine: number;
		lineNumbers?: Array<number | null>;
	};
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `⚠ N` badge). */
	conflictCount?: number;
	/** Paths recovered from a delimited read argument; used only by the TUI to render one call as multiple read rows. */
	displayReadTargets?: string[];
	/**
	 * Resolved filesystem link target for each {@link displayReadTargets} entry, aligned by index; `null` when a
	 * delimited part has no linkable fs path. Lets the TUI hyperlink each grouped row the same way a standalone read row is.
	 */
	displayReadTargetLinks?: Array<string | null>;
}

// Parsing also recognizes incomplete counts to explain their errors; path splitting
// only peels complete selectors (not a trailing `+` or `L`).
const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
const RANGE_LIST_SRC = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
// A tail selector: `-N` reads the last N lines. Keep in sync with TAIL_SELECTOR_RE.
const TAIL_CHUNK_SRC = String.raw`-\d+`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC}|raw|conflicts|img)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC})$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;
// Permissive selector chunk for internal URLs — accepts well-formed selectors
// plus common malformed shapes (e.g. `:-N-M`) so the read tool peels the entire
// selector chain off before dispatching to a protocol handler.
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|img|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);
/** Split a filesystem path from its trailing read selector. */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	// Allow a compound trailing selector: `path:1-50:raw`, `path:raw:1-50`, or
	// `path:raw:-60`. The two chunks must be one line-range (or tail) plus one
	// `raw`, in either order.
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

/**
 * Variant of {@link splitPathAndSel} for internal URLs (`scheme://...`).
 *
 * The filesystem-path splitter is intentionally conservative: it refuses to
 * peel a trailing `:<chunk>` unless that chunk matches the strict selector
 * grammar. That rule is right for filesystem paths (a file named `a:1-50` is
 * legal) but wrong for internal URLs, where any trailing `:<chunk>` after the
 * scheme is unambiguously a read-tool selector — even if malformed (e.g.
 * `artifact://3:raw:-100-5`).
 *
 * This function iteratively peels selector-shaped chunks (well-formed plus
 * common malformed shapes like `:-N-M`) so the rest of the read tool can pass a
 * clean URL to the protocol handler and surface selector errors via parseSel
 * instead of as misleading "host invalid" errors from the handler.
 *
 * Only schemes whose spec declares `lines` selectors peel; server-defined URIs
 * (`opaque`), selector-free schemes, and unregistered schemes pass through
 * verbatim. `specOf` defaults to the installed scheme host, so nothing peels
 * before a host is installed.
 *
 * Falls back to the input unchanged when nothing matches.
 */
export function splitInternalUrlSel(
	rawPath: string,
	specOf: (scheme: string) => InternalUrlSchemeSpec | undefined = internalUrlSchemeSpec,
): { path: string; sel?: string } {
	const url = splitUrlScheme(rawPath);
	if (!url) return { path: rawPath };
	const spec = specOf(url.scheme);
	if (spec?.selectors !== "lines") return { path: rawPath };
	// With no `/path` after the authority, a trailing `:N` is the port
	// (ssh://host:2222), not a read selector.
	if (spec.portAuthority && !url.rest.includes("/")) return { path: rawPath };

	const schemeEnd = rawPath.length - url.rest.length;
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		// Stop before crossing into the scheme separator `://`.
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

/** Recognize HTTP URLs and www-prefixed external read targets. */
export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

/** Return the first selected line when every range has valid one-based bounds. */
export function readSelectorRangeStart(selector: string): number | undefined {
	try {
		const start = parseLineRanges(selector)?.[0].startLine;
		return start !== undefined && Number.isFinite(start) ? start : undefined;
	} catch {
		return undefined;
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

export interface ReadRenderArgs {
	path?: unknown;
	file_path?: unknown;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

/** Transcript card for reads of a scheme with its own UI (process table, settings tree). */
interface ReadUrlCard {
	/** Activity label, e.g. `Process · web`. */
	readonly label: string;
	/** Activity detail when the URL names no target. */
	readonly rootDetail: string;
	/** Result details field whose presence identifies this card. */
	readonly detailsKey: "proc" | "cfg";
	/** Pending call card when `result` is undefined, else the finished result card. */
	render(
		url: string,
		target: string,
		result: CardToolResult | undefined,
		details: ReadToolDetails | undefined,
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component;
}

/** Read cards keyed by URL scheme. */
const READ_URL_CARDS: Record<string, ReadUrlCard> = {
	proc: {
		label: "Process",
		rootDetail: "jobs & services",
		detailsKey: "proc",
		render: (_url, target, result, details, options, uiTheme) =>
			renderProcRead(target, result, details?.proc, options, uiTheme),
	},
	cfg: {
		label: "Config",
		rootDetail: "all settings",
		detailsKey: "cfg",
		render: (url, _target, result, details, options, uiTheme) =>
			renderCfgRead(splitInternalUrlSel(url).path, result, details?.cfg, options, uiTheme),
	},
};

/**
 * Card that renders a read of `rawPath` with the text after `scheme://` as its target.
 * Result details identify the card before the URL scheme does.
 */
function readUrlCard(rawPath: string, details?: ReadToolDetails): { card: ReadUrlCard; target: string } | undefined {
	const url = splitUrlScheme(rawPath);
	const target = url?.rest ?? "";
	if (details) {
		for (const scheme in READ_URL_CARDS) {
			const card = READ_URL_CARDS[scheme];
			if (details[card.detailsKey] !== undefined) return { card, target };
		}
	}
	if (!url || !Object.hasOwn(READ_URL_CARDS, url.scheme)) return undefined;
	return { card: READ_URL_CARDS[url.scheme], target };
}

const INTERNAL_URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// A scheme-less host followed by a slash can be a web target. Do not force a
// file: link onto it; explicit relative paths (./host/path) remain filesystem paths.
const BARE_WEB_HOST_RE = /^(?:(?:[a-z][a-z0-9-]*|\[[0-9a-f:]+\])(?::\d+)|(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?)\//i;

/** Local file a pending read/write input points at, before the tool resolves it:
 * expands `~` and drops archive-member / SQLite-row selectors so the link opens
 * the containing file. */
export function pendingFileLinkPath(inputPath: string): string {
	const expanded = inputPath.replace(/^~(?=$|[\\/])/, os.homedir());
	if (!expanded.includes(":")) return path.resolve(expanded);
	const archive = parseArchivePathCandidates(expanded).find(candidate => candidate.archivePath !== expanded);
	const sqlite = expanded.match(/^(.+\.(?:sqlite3?|db3?))(?=[:?])/i);
	return path.resolve(archive?.archivePath ?? sqlite?.[1] ?? expanded);
}

function splitReadRenderPath(rawPath: string): { path: string; sel?: string } {
	if (INTERNAL_URL_LIKE_RE.test(rawPath)) {
		const internal = splitInternalUrlSel(rawPath);
		if (internal.sel) return internal;
	}
	return splitPathAndSel(rawPath);
}

function firstReadSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	const range = sel.split(":").find(chunk => chunk.toLowerCase() !== "raw");
	return range ? readSelectorRangeStart(range) : undefined;
}

/** Absolute fs path the read result actually resolved to, used as the OSC 8 link
 * target when the structured `resolvedPath` isn't set (the common plain-file and
 * image reads only record the path in `meta.source`). URL/internal sources are
 * not fs paths, so only `type: "path"` qualifies. */
export function readSourceFsPath(details: ReadToolDetails | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

function formatReadPathLink(
	rawPath: string,
	options: {
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		offset?: number;
		fallbackLabel?: string;
	},
): string {
	const split = splitReadRenderPath(rawPath);
	const basePath = split.path || rawPath;
	const selectorSuffix = split.sel ? `:${split.sel}` : "";
	const plainDisplayPath = options.suffixResolution
		? shortenPath(options.suffixResolution.to)
		: shortenPath(basePath || options.resolvedPath || options.fallbackLabel || rawPath);
	// Calls render before the tool has resolved a filesystem target. Preserve
	// protocol resources as plain text, but resolve direct relative file paths
	// so terminals receive an explicit file: link rather than guessing HTTPS.
	const inputPath =
		basePath && !INTERNAL_URL_LIKE_RE.test(basePath) && !BARE_WEB_HOST_RE.test(basePath)
			? pendingFileLinkPath(basePath)
			: undefined;
	const target = options.resolvedPath ?? options.sourcePath ?? inputPath;
	const line = firstReadSelectorLine(split.sel) ?? options.offset;
	const linkOptions = line !== undefined ? { line } : undefined;
	const linkedPath = target ? fileHyperlink(target, plainDisplayPath, linkOptions) : plainDisplayPath;
	return `${linkedPath}${selectorSuffix}`;
}

/** Render file, image, and URL reads in the transcript. */
export const readToolRenderer = {
	activitySummary(args: unknown, _context: ToolActivityContext): ToolActivitySummary {
		const input = args as ReadRenderArgs | undefined;
		const rawPath =
			typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : "";
		const routed = readUrlCard(rawPath);
		if (routed) return { label: routed.card.label, detail: routed.target || routed.card.rootDetail };
		return { label: "Read", detail: shortenPath(rawPath) };
	},
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const routed = readUrlCard(rawPath);
		if (routed) return routed.card.render(rawPath, routed.target, undefined, undefined, _options, uiTheme);
		if (isReadableUrlPath(rawPath)) {
			return renderReadUrlCall({ path: rawPath, raw: args.raw }, _options, uiTheme);
		}

		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = formatReadPathLink(rawPath, { offset, fallbackLabel: "…" }) || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine({ icon: "pending", title: "Read", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		const baseRawPathForKind =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const routed = readUrlCard(baseRawPathForKind, result.details);
		if (routed)
			return routed.card.render(baseRawPathForKind, routed.target, result, result.details, options, uiTheme);
		if (urlDetails?.kind === "url" || isReadableUrlPath(baseRawPathForKind)) {
			return renderReadUrlResult(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: ReadUrlToolDetails;
					isError?: boolean;
				},
				options,
				uiTheme,
			);
		}

		if (result.isError) {
			const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const errorText = (rawErrorText || "Unknown error").replace(/^Error:\s*/, "");
			const rawPath =
				typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
			const filePath =
				formatReadPathLink(rawPath, {
					offset: args?.offset,
					sourcePath: result.details?.displayTarget ?? readSourceFsPath(result.details),
				}) || shortenPath(rawPath);
			let title = filePath ? `Read ${filePath}` : "Read";
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			const header = renderStatusLine({ icon: "error", title }, uiTheme);
			const errorLines = sanitizeDisplayLines(errorText).map(line => uiTheme.fg("error", line));
			return framedToolCard(uiTheme, () => ({
				header,
				phase: "error",
				sections: [{ content: errorLines }],
			}));
		}
		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		// Prefer structured `displayContent` from details when available so the TUI
		// shows clean file content (no model-only hashline anchors) without parsing the formatted text.
		// Fall back to the raw text, but strip the LLM-facing notice so it doesn't
		// echo next to the styled warning line below.
		const contentText = details?.displayContent?.text ?? stripOutputNotice(rawText, details?.meta);
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const renderPath = splitReadRenderPath(rawPath);
		const lang = getLanguageFromPath(renderPath.path);

		const warningLines: string[] = [];
		const truncation = details?.meta?.truncation;
		const fallback = details?.truncation;
		if (details?.resolvedPath) {
			warningLines.push(uiTheme.fg("dim", wrapBrackets(`Resolved path: ${details.resolvedPath}`, uiTheme)));
		}
		if (truncation) {
			if (fallback?.firstLineExceedsLimit) {
				let warning = `First line exceeds ${formatBytes(fallback.outputBytes ?? fallback.totalBytes)} limit`;
				if (truncation.artifactId) {
					warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
				}
				warningLines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			} else {
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) warningLines.push(warning);
			}
		}

		if (imageContent) {
			const suffix = details?.suffixResolution;
			const displayPath = formatReadPathLink(rawPath, {
				resolvedPath: details?.resolvedPath,
				sourcePath: details?.displayTarget ?? readSourceFsPath(details),
				suffixResolution: suffix,
				fallbackLabel: "image",
			});
			const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
			const header = renderStatusLine(
				{ icon: suffix ? "warning" : "success", title: "Read", description: `${displayPath}${correction}` },
				uiTheme,
			);
			const detailLines = contentText
				? sanitizeDisplayLines(contentText).map(line => uiTheme.fg("toolOutput", line))
				: [];
			const lines = [...detailLines, ...warningLines];
			return framedToolCard(uiTheme, () => ({
				header,
				phase: "success",
				sections: [
					{
						label: uiTheme.fg("toolTitle", "Details"),
						content: lines.length > 0 ? lines : [uiTheme.fg("dim", "(image)")],
					},
				],
			}));
		}

		const suffix = details?.suffixResolution;
		// resolvedPath is the absolute fs path when a read resolved/corrected the
		// input (suffix match, internal URL, archive/sqlite/notebook); plain file
		// reads only record the absolute path in meta.source, so fall back to that
		// to keep the title clickable.
		const displayPath = formatReadPathLink(rawPath, {
			resolvedPath: details?.resolvedPath,
			sourcePath: details?.displayTarget ?? readSourceFsPath(details),
			suffixResolution: suffix,
			offset: args?.offset,
		});
		const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
		let title = displayPath ? `Read ${displayPath}${correction}` : "Read";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		if (details?.summary) {
			title += ` (summary: ${details.summary.elidedSpans} elided span${details.summary.elidedSpans === 1 ? "" : "s"})`;
		}
		if (details?.conflictCount && details.conflictCount > 0) {
			const n = details.conflictCount;
			title += ` ${uiTheme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
		}
		const rawRequested =
			args?.raw === true || renderPath.sel?.split(":").some(chunk => chunk.toLowerCase() === "raw") === true;
		const isMarkdown = details?.contentType === "text/markdown" && !rawRequested;
		let cachedWidth: number | undefined;
		let cachedExpanded: boolean | undefined;
		let cachedLines: string[] | undefined;
		return markFramedBlockComponent({
			render: (width: number) => {
				const expanded = options.expanded;
				if (cachedLines && cachedWidth === width && cachedExpanded === expanded) return cachedLines;
				cachedLines = isMarkdown
					? renderMarkdownCell(
							{
								content: contentText,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								width,
							},
							uiTheme,
						)
					: renderCodeCell(
							{
								code: contentText,
								language: lang,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								codeStartLine: details?.displayContent?.startLine,
								codeLineNumbers: details?.displayContent?.lineNumbers,
								width,
							},
							uiTheme,
						);
				cachedWidth = width;
				cachedExpanded = expanded;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedExpanded = undefined;
				cachedLines = undefined;
			},
		});
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<ReadRenderArgs, ReadToolDetails>;

/** Inclusive line range describing one elided span in a structural summary. */
export interface ElidedRange {
	start: number;
	end: number;
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

/** Format one summary line with the selected line-prefix mode. */
export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

/** Format the boundary lines around an elided brace-pair body. */
export function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

/** Format a structural summary using the supplied file-display preferences. */
export function formatReadSummary(
	displayMode: { hashLines: boolean; lineNumbers: boolean },
	summary: SummaryResult,
): {
	text: string;
	displayText: string;
	elidedRanges: ElidedRange[];
	elidedLines: number;
} {
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	// Flatten segments into per-line units so we can merge a kept-head /
	// elided / kept-tail sandwich into a single brace-pair line when the
	// boundary lines look like `… {` and `}` (or matching variants).
	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| {
				kind: "merged";
				startLine: number;
				endLine: number;
				headText: string;
				tailText: string;
		  };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i];
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1] : null;
			const next = i + 1 < raw.length ? raw[i + 1] : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const displayParts: string[] = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	for (const unit of units) {
		if (unit.kind === "elided") {
			modelParts.push("…");
			displayParts.push("…");
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
			continue;
		}
		if (unit.kind === "merged") {
			const formatted = formatMergedBraceLine(
				unit.startLine,
				unit.endLine,
				unit.headText,
				unit.tailText,
				shouldAddHashLines,
				shouldAddLineNumbers,
			);
			modelParts.push(formatted.model);
			displayParts.push(formatted.display);
			// Suggest the full brace range so re-reading shows both braces
			// plus the elided body in one shot.
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			// Merged brace pair encloses (start+1)..(end-1) as elided.
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
			continue;
		}
		modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
		displayParts.push(unit.text);
	}

	return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedRanges, elidedLines };
}
