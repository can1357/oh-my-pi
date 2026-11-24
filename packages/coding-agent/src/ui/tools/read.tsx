/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `read`: a file (or directory, image, URL, internal resource) read.
 *
 * The head names the file and range (`Read src/a.ts:40-50`), linked to the
 * resolved file; the body is the content as one numbered `code` block (or
 * Markdown, or the image), with a quiet foot for the resolved path and
 * truncation notes. URLs show through {@link readUrlPresenter}; internal
 * schemes with their own card (`proc://`, `cfg://`) through the presenter
 * registered for them ({@link registerReadScheme}).
 *
 * Terminal look: `read` (`src/ui/styles/tools/read.ts`), fed by {@link ReadTerm}.
 */
import { formatBytes, sanitizeText } from "@oh-my-pi/pi-utils";
import { type JSXNode, nativeSupports } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import { type ReadToolDetails, readSelectorRangeStart, splitPathAndSel } from "../../tools/details/read";
import {
	formatArtifactErrorNotice,
	formatFullOutputReference,
	formatTruncationMetaNotice,
	stripOutputNotice,
} from "../../tools/output-meta-format";
import { shortenPath } from "../../utils/render-utils";
import type { ToolActivity, ToolHead, ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { resultText } from "./default";
import { fileHref, pendingLinkPath } from "./file-common";
import { READ_IMAGE_ROLE } from "../transcript/image-links";
import { InlineMedia, inlineImageTerm } from "../transcript/messages/image";
import { imageSize } from "../transcript/tool-block";
import { isReadableUrlPath, readUrlPresenter } from "./read-url";
import { registerToolPresenter } from "./registry";
import { StatsFoot } from "./search-common";

/** Read call args. */
export interface ReadArgs {
	readonly path?: unknown;
	readonly file_path?: unknown;
	/** Legacy range args. */
	readonly offset?: number;
	readonly limit?: number;
	readonly raw?: boolean;
}

/** A read of an internal scheme with its own card (process table, settings tree). */
export interface ReadScheme {
	/** Compact activity label (`Process`). */
	readonly label: string;
	/** Activity detail when the URL names no target (`jobs & services`). */
	readonly rootDetail: string;
	/** The result details field that identifies the scheme's results. */
	readonly detailsKey: "proc" | "cfg";
	readonly presenter: ToolPresenter<ReadArgs, ReadToolDetails>;
}

const schemes = new Map<string, ReadScheme>();

/** Show reads of `scheme://…` through `entry` (its presenter gets the read's args and result). */
export function registerReadScheme(scheme: string, entry: ReadScheme): void {
	schemes.set(scheme, entry);
}

/** The scheme card a read routes to: result details first, then the URL's scheme. */
function routedScheme(rawPath: string, details?: ReadToolDetails): { scheme: ReadScheme; target: string } | undefined {
	const url = splitUrlScheme(rawPath);
	const target = url?.rest ?? "";
	if (details) {
		for (const entry of schemes.values())
			if (details[entry.detailsKey] !== undefined) return { scheme: entry, target };
	}
	const entry = url ? schemes.get(url.scheme) : undefined;
	return entry ? { scheme: entry, target } : undefined;
}

/** Terminal-only facts of a read (`term`). */
export interface ReadTerm {
	readonly look: "read";
	readonly phase: "call" | "error" | "image" | "code" | "markdown";
	/** `src/a.ts:40-50`: the shown path with its selector or legacy range. */
	readonly display: string;
	/** The file `display`'s first `length` characters (the path, not its selector) link to, opened at `line`. */
	readonly link?: { readonly path: string; readonly line?: number; readonly length: number };
	/** `(corrected from …)` note after the path. */
	readonly correctedFrom?: string;
	readonly error?: string;
	readonly summarySpans?: number;
	readonly conflicts?: number;
	readonly language?: string;
	/** The text the cell shows. */
	readonly content?: string;
	readonly startLine?: number;
	readonly lineNumbers?: readonly (number | null)[];
	/** Bracketed warnings under the content, `{ text, color }`. */
	readonly warnings?: readonly {
		readonly text: string;
		readonly color: string;
	}[];
}

function rawPathOf(args: ReadArgs | undefined): string {
	return typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
}

/** Path and selector of a read target (internal URLs keep their selectors inside). */
export function splitTarget(rawPath: string): { path: string; sel?: string } {
	return splitUrlScheme(rawPath) ? { path: rawPath } : splitPathAndSel(rawPath);
}

export function firstSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	const range = sel.split(":").find(chunk => chunk.toLowerCase() !== "raw");
	return range ? readSelectorRangeStart(range) : undefined;
}

/** `:start-end` of legacy offset/limit args ("" without them). */
function legacyRange(args: ReadArgs | undefined): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : "";
	return `:${start}${end ? `-${end}` : ""}`;
}

/** The fs path a read resolved to (its link). */
export function readLinkPath(details: ReadToolDetails | undefined): string | undefined {
	if (details?.resolvedPath) return details.resolvedPath;
	if (details?.displayTarget) return details.displayTarget;
	const source = details?.meta?.source as { type?: string; value?: unknown } | undefined;
	return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

function readHead(rawPath: string, args: ReadArgs | undefined, details?: ReadToolDetails): ToolHead {
	const split = splitTarget(rawPath);
	const suffix = details?.suffixResolution;
	let target = suffix ? shortenPath(suffix.to) : shortenPath(split.path || rawPath);
	if (split.sel) target += `:${split.sel}`;
	target += legacyRange(args);
	const meta: string[] = [];
	if (suffix) meta.push(`corrected from ${shortenPath(suffix.from)}`);
	const summary = (details as { summary?: { elidedSpans: number } } | undefined)?.summary;
	if (summary) meta.push(`summary: ${summary.elidedSpans} elided span${summary.elidedSpans === 1 ? "" : "s"}`);
	const conflicts = (details as { conflictCount?: number } | undefined)?.conflictCount ?? 0;
	const href = fileHref(readLinkPath(details));
	return {
		title: "Read",
		target: sanitizeText(target) || "…",
		targetKind: "path",
		...(href ? { href } : {}),
		meta,
		...(conflicts > 0
			? {
					badges: [
						{
							text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
							tone: "warning" as const,
						},
					],
				}
			: {}),
	};
}

/** `src/a.ts:40-50` as the terminal head shows it (suffix correction applied). */
function displayPath(rawPath: string, args: ReadArgs | undefined, details?: ReadToolDetails, fallback = "…"): string {
	const split = splitTarget(rawPath);
	return `${shownPath(rawPath, details, fallback)}${split.sel ? `:${split.sel}` : ""}${legacyRange(args)}`;
}

/** The path part of {@link displayPath}. */
function shownPath(rawPath: string, details: ReadToolDetails | undefined, fallback: string): string {
	const split = splitTarget(rawPath);
	const suffix = details?.suffixResolution;
	return sanitizeText(suffix ? shortenPath(suffix.to) : shortenPath(split.path || rawPath)) || fallback;
}

/**
 * The terminal link of a read's shown path: the file the read resolved to,
 * else (a call, or a result without it) the file its argument names; opened
 * at the selector's (or legacy offset's) first line.
 */
function readTermLink(
	rawPath: string,
	args: ReadArgs | undefined,
	details?: ReadToolDetails,
	fallback = "…",
): Pick<ReadTerm, "link"> {
	const split = splitTarget(rawPath);
	const base = split.path || rawPath;
	const target = readLinkPath(details) ?? (base && !splitUrlScheme(base) ? pendingLinkPath(base) : undefined);
	if (!target) return {};
	const line = firstSelectorLine(split.sel) ?? args?.offset;
	return {
		link: {
			path: target,
			...(line !== undefined ? { line } : {}),
			length: shownPath(rawPath, details, fallback).length,
		},
	};
}

/** Characters of an error's first line the head keeps. */
const ERROR_GIST_CHARS = 120;

function ErrorText(props: { readonly message: string }): JSXNode {
	const body = props.message;
	if (body.includes("\n") && /^[{[]/.test(body))
		return <code text={body} lang="json" tone="error" role="omp.tool.error" />;
	return <text spans={[{ t: body, s: "error" }]} wrap="word" role="omp.tool.error" />;
}

/** One numbered code block of read content (gaps where numbers jump; `null` numbers dropped). */
export function ContentCode(props: {
	readonly content: string;
	readonly start: number;
	readonly numbers: readonly (number | null)[] | undefined;
	readonly path: string | undefined;
}): JSXNode {
	const lines = props.content.split("\n");
	const nums: number[] = [];
	const body: string[] = [];
	let contiguous = true;
	lines.forEach((text, i) => {
		const n = props.numbers && props.numbers.length === lines.length ? props.numbers[i]! : props.start + i;
		if (n === null) return;
		if (nums.length > 0 && n !== nums[nums.length - 1]! + 1) contiguous = false;
		nums.push(n);
		body.push(text);
	});
	if (nums.length === 0) return undefined;
	return (
		<code
			key={`c${nums[0]}`}
			text={body.join("\n")}
			start={contiguous ? nums[0] : undefined}
			nums={contiguous ? undefined : nums}
			numbers
			path={props.path}
			wrap
		/>
	);
}

/** Whether a read shows as Markdown: tagged `text/markdown` and not asked for raw source. */
export function isMarkdown(details: ReadToolDetails | undefined, args: ReadArgs | undefined): boolean {
	if (details?.contentType !== "text/markdown" || args?.raw === true) return false;
	return (
		splitTarget(rawPathOf(args))
			.sel?.split(":")
			.some(chunk => chunk.toLowerCase() === "raw") !== true
	);
}

/** Bracketed warnings the terminal shows under the content. */
function readWarnings(details: ReadToolDetails | undefined): { text: string; color: string }[] {
	const warnings: { text: string; color: string }[] = [];
	if (details?.resolvedPath)
		warnings.push({
			text: `Resolved path: ${shortenPath(details.resolvedPath)}`,
			color: "dim",
		});
	const truncation = details?.meta?.truncation;
	const fallback = details?.truncation;
	if (truncation) {
		if (fallback?.firstLineExceedsLimit) {
			let warning = `First line exceeds ${formatBytes(fallback.outputBytes ?? fallback.totalBytes)} limit`;
			if (truncation.artifactId) warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
			warnings.push({ text: warning, color: "warning" });
		} else {
			const parts = [formatTruncationMetaNotice(truncation, details?.meta?.source)];
			if (details?.meta?.artifactError) parts.push(formatArtifactErrorNotice(details.meta.artifactError));
			warnings.push({ text: parts.join(". "), color: "warning" });
		}
	}
	return warnings;
}

function readActivity(args: ReadArgs): ToolActivity {
	const rawPath = rawPathOf(args);
	const routed = routedScheme(rawPath);
	if (routed)
		return {
			label: routed.scheme.label,
			detail: routed.target || routed.scheme.rootDetail,
		};
	return { label: "Read", detail: sanitizeText(shortenPath(rawPath)) };
}

function readResult(result: ToolResult<ReadToolDetails>, state: ToolViewState, args?: ReadArgs): ToolView | undefined {
	const details = result.details;
	const rawPath = rawPathOf(args);
	const routed = routedScheme(rawPath, details);
	if (routed) return routed.scheme.presenter.result?.(result, state, args);
	if (details?.kind === "url" || isReadableUrlPath(rawPath))
		return readUrlPresenter.result?.(result as ToolResult<never>, state, {
			path: rawPath,
			raw: args?.raw,
		});
	const head = readHead(rawPath, args, details);
	if (result.isError) {
		const message = (resultText(result) || "Unknown error").replace(/^Error:\s*/, "");
		const full = sanitizeText(message).trim() || "failed";
		const first = full.split("\n", 1)[0]!.trim();
		const gist = first.length > ERROR_GIST_CHARS ? `${first.slice(0, ERROR_GIST_CHARS - 1)}…` : first;
		return {
			head: {
				...head,
				meta: [...(head.meta ?? []), [{ t: `— ${gist}`, s: "muted" }]],
			},
			tone: "error",
			inline: true,
			...(gist === full ? {} : { body: <ErrorText message={full} /> }),
			term: {
				look: "read",
				phase: "error",
				display: displayPath(rawPath, args, details, ""),
				...readTermLink(rawPath, args, details, ""),
				error: (result.content.find(block => block.type === "text")?.text || "Unknown error").replace(
					/^Error:\s*/,
					"",
				),
			} satisfies ReadTerm,
		};
	}
	const suffix = details?.suffixResolution;
	const truncation = details?.meta?.truncation;
	const fallback = details?.truncation;
	const firstLineTooLong = truncation !== undefined && fallback?.firstLineExceedsLimit === true;
	const foot = (
		<StatsFoot
			notes={[
				details?.resolvedPath !== undefined ? `resolved ${shortenPath(details.resolvedPath)}` : "",
				firstLineTooLong
					? `First line exceeds ${formatBytes(fallback!.outputBytes ?? fallback!.totalBytes)} limit${truncation!.artifactId ? `. ${formatFullOutputReference(truncation!.artifactId)}` : ""}`
					: "",
			]}
			meta={firstLineTooLong ? { artifactError: details?.meta?.artifactError } : details?.meta}
		/>
	);
	const content = details?.displayContent?.text ?? stripOutputNotice(resultText(result), details?.meta);
	const split = splitTarget(rawPath);
	const warnings = readWarnings(details);
	const mediaPath = details?.mediaPath;
	const media = mediaPath && nativeSupports("media") ? <InlineMedia nodeKey="media" path={mediaPath} /> : undefined;
	const image = result.content.find(
		block => block.type === "image" && typeof (block as { data?: unknown }).data === "string",
	) as { data: string; mimeType: string } | undefined;
	if (image) {
		const size = imageSize(image.data);
		const detail = content.trim();
		return {
			head,
			...(suffix ? { tone: "warning" as const } : {}),
			inline: true,
			body: [
				media ?? (
					<image
						blob={registerBlob(Buffer.from(image.data, "base64"), image.mimeType)}
						alt={shortenPath(suffix?.to ?? split.path) || "image"}
						w={size?.w}
						h={size?.h}
						role={READ_IMAGE_ROLE}
						term={inlineImageTerm()}
					/>
				),
				detail.length > 0 && <ansi text={detail} />,
				foot,
			],
			term: {
				look: "read",
				phase: "image",
				display: displayPath(rawPath, args, details, "image"),
				...readTermLink(rawPath, args, details, "image"),
				...(suffix ? { correctedFrom: shortenPath(suffix.from) } : {}),
				content,
				warnings,
			} satisfies ReadTerm,
		};
	}
	const markdown = isMarkdown(details, args);
	const summary = (details as { summary?: { elidedSpans: number } } | undefined)?.summary;
	const conflicts = (details as { conflictCount?: number } | undefined)?.conflictCount ?? 0;
	return {
		head,
		inline: true,
		body: [
			media,
			markdown ? (
				<md text={content} />
			) : (
				<ContentCode
					content={content}
					start={details?.displayContent?.startLine ?? firstSelectorLine(split.sel) ?? args?.offset ?? 1}
					numbers={details?.displayContent?.lineNumbers}
					path={split.path}
				/>
			),
			foot,
		],
		term: {
			look: "read",
			phase: markdown ? "markdown" : "code",
			display: displayPath(rawPath, args, details, ""),
			...readTermLink(rawPath, args, details, ""),
			...(languageFromPath(split.path) ? { language: languageFromPath(split.path) } : {}),
			...(suffix ? { correctedFrom: shortenPath(suffix.from) } : {}),
			...(summary ? { summarySpans: summary.elidedSpans } : {}),
			...(conflicts > 0 ? { conflicts } : {}),
			content,
			...(details?.displayContent ? { startLine: details.displayContent.startLine } : {}),
			...(details?.displayContent?.lineNumbers ? { lineNumbers: details.displayContent.lineNumbers } : {}),
			warnings,
		} satisfies ReadTerm,
	};
}

export const readPresenter: ToolPresenter<ReadArgs, ReadToolDetails> = {
	merge: true,
	activity: args => readActivity(args),
	call(args, state): ToolView | undefined {
		const rawPath = rawPathOf(args);
		const routed = routedScheme(rawPath);
		if (routed) return routed.scheme.presenter.call?.(args, state);
		if (isReadableUrlPath(rawPath)) return readUrlPresenter.call?.({ path: rawPath, raw: args.raw }, state);
		return {
			head: readHead(rawPath, args),
			inline: true,
			term: {
				look: "read",
				phase: "call",
				display: displayPath(rawPath, args),
				...readTermLink(rawPath, args),
			} satisfies ReadTerm,
		};
	},
	result: readResult,
};

registerToolPresenter("read", readPresenter);
