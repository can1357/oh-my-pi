import type { Component } from "../tui";
import { Text } from "../components/text";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";
import { col, compact, keyed, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { fileHref, fileRow, footnoteText, inlineErrorView, resultText } from "./native-view";
import { type Theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { toPathList } from "../render/render-utils";
import * as path from "node:path";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "../render/render-utils";
import { formatFullOutputReference } from "./output-meta";

/** Display metadata for glob tool results. */
export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	/** The scan hit the tool deadline, so the listed files are an incomplete
	 * set rather than a complete answer. Distinct from `truncated`, which also
	 * covers result-limit and output truncation. */
	timedOut?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

/** Most files a native glob lists as rows; more wrap as chips (§7.3 glob). */
const NATIVE_LIST_MAX = 6;
/** Collapsed clamp: the whole ≤ 6-row list, or about six rows of chips. */
const NATIVE_PREVIEW_LINES = 8;

/**
 * Native glob files: 22px path rows when there are few, else a wrap of
 * chips (glyph and name, the full path in the tooltip). Paths link when the
 * search `cwd` is known.
 */
function describeGlobFiles(files: readonly string[], cwd: string | undefined): NativeNode {
	const links = files.map(file => (cwd && !file.endsWith("/") ? fileHref(path.resolve(cwd, file)) : undefined));
	if (files.length <= NATIVE_LIST_MAX) {
		return col(
			files.map((file, i) => fileRow(file, { href: links[i] })),
			{ role: "omp.tool.files", gap: "none" },
		);
	}
	return row(
		files.map((file, i) => {
			const isDir = file.endsWith("/");
			const name = path.basename(file) + (isDir ? "/" : "");
			const link = links[i];
			return keyed(
				row(
					[
						node("icon", { name: isDir ? "folder" : "file" }),
						text([span(name, "strong", link ? { href: link } : undefined)], { wrap: "none" }),
					],
					{ role: "omp.tool.chip", gap: "xs", align: "center", title: file },
				),
				file,
			);
		}),
		{ role: "omp.tool.files", gap: "xs", wrap: true },
	);
}

/** Native glob head: the pattern, then `meta` (the result counts, or the call's `limit`). */
function globNativeHead(args: GlobRenderArgs | undefined, meta: readonly string[] = []): NativeToolHead {
	const parts = [...meta];
	if (meta.length === 0 && args?.limit !== undefined) parts.push(`limit:${args.limit}`);
	return { title: "Glob", target: formatGlobRenderPaths(args) || "*", targetKind: "pattern", meta: parts };
}

/** Render glob calls and results in the transcript. */
export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		// A non-empty timed-out result is the case `truncated` alone cannot
		// explain: the listing is short because the scan died, not because it
		// finished. Say which one it was.
		const timedOut = Boolean(details?.timedOut);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found". `timedOut`
			// states it outright; the inference stays for old transcripts that
			// predate the field.
			const emptyTimedOut = timedOut || truncated;
			const emptyLabel = emptyTimedOut ? "No matches before timeout (scan incomplete)" : "No files found";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: emptyTimedOut ? ["0 files", uiTheme.fg("warning", "timed out")] : ["0 files"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", timedOut ? "timed out" : "truncated"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	describeCall(args: GlobRenderArgs): NativeToolView {
		return { tool: globNativeHead(args), inline: true };
	},

	/**
	 * Inline (§7.3 glob): `Glob “pattern”  5 files`, then the files as rows
	 * (≤ 6) or a wrap of chips; one quiet footnote for limits and skipped paths.
	 */
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: GlobRenderArgs,
	): NativeToolView {
		const details = result.details;
		if (result.isError || details?.error) {
			return inlineErrorView(globNativeHead(args), details?.error || resultText(result) || "Unknown error");
		}
		if (details?.fileCount === undefined) {
			const textContent = resultText(result);
			if (
				!textContent.trim() ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found")
			) {
				return { tool: globNativeHead(args, ["0 files"]), tone: "warning", inline: true };
			}
			const lines = textContent.split("\n").filter(l => l.trim());
			return {
				tool: globNativeHead(args, [formatCount("file", lines.length)]),
				inline: true,
				body: [describeGlobFiles(lines, undefined)],
				preview: { lines: NATIVE_PREVIEW_LINES },
			};
		}
		const truncation = details.truncation ?? details.meta?.truncation;
		const limits = details.meta?.limits;
		const truncated = Boolean(details.truncated || truncation || details.resultLimitReached || limits?.resultLimit);
		const timedOut = Boolean(details.timedOut);
		const missingPaths = details.missingPaths ?? [];
		const missingNote = missingPaths.length > 0 ? `skipped missing: ${missingPaths.join(", ")}` : undefined;
		const scope = details.scopePath ? `in ${details.scopePath}` : undefined;
		if (details.fileCount === 0) {
			const foot = footnoteText(compact([missingNote]));
			return {
				// `truncated` on an empty result means the scan timed out mid-walk.
				tool: {
					...globNativeHead(args, compact(["0 files", scope])),
					note: timedOut || truncated ? "timed out" : undefined,
				},
				tone: "warning",
				inline: true,
				body: foot ? [foot] : undefined,
			};
		}
		const reasons: string[] = [];
		if (details.resultLimitReached) reasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) reasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) reasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) reasons.push(formatFullOutputReference(artifactId));
		const head = globNativeHead(args, compact([formatCount("file", details.fileCount), scope]));
		return {
			tool: truncated
				? { ...head, badges: [{ text: timedOut ? "timed out" : "truncated", tone: "warning" }] }
				: head,
			inline: true,
			body: compact<NativeChild>([
				describeGlobFiles(details.files ?? [], details.cwd),
				footnoteText(compact([reasons.length > 0 && `truncated: ${reasons.join(", ")}`, missingNote])),
			]),
			preview: { lines: NATIVE_PREVIEW_LINES },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<GlobRenderArgs, GlobToolDetails>;
