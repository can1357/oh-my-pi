/**
 * Shared pieces of the tool renderers' TSP describe hooks: result text,
 * card heads, error views, notes and notices. No layout: every helper returns
 * semantic nodes/spans only, with ANSI-free, sanitized text.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { ansi, code, compact, keyed, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { type ParsedDiagnostic, parseDiagnosticMessage, shortenPath } from "../render/render-utils";
import { plainText } from "../native/spans";
import type { FileDiagnosticsResult } from "./lsp";
import { formatArtifactErrorNotice, formatTruncationMetaNotice, type OutputMeta } from "./output-meta";
import type { NativeToolHead, NativeToolView, ToolRenderResult } from "./renderer";

/** A path for native heads: relative to the working directory when inside it, else `~`-shortened. */
export function displayPath(filePath: string): string {
	if (path.isAbsolute(filePath)) {
		const rel = path.relative(process.cwd(), filePath);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	}
	return shortenPath(filePath);
}

/** `file://` link for a head's path target, when the path is absolute. */
export function fileHref(filePath: string | undefined): string | undefined {
	return filePath && path.isAbsolute(filePath) ? pathToFileURL(filePath).href : undefined;
}

/** Diff stats as one head `meta` string, `+8 −1` (U+2212 minus), or undefined when nothing changed. */
export function diffStatsMeta(added: number, removed: number): string | undefined {
	const parts: string[] = [];
	if (added > 0) parts.push(`+${added}`);
	if (removed > 0) parts.push(`\u2212${removed}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * One file of a multi-file edit: a borderless `section` headed by the path
 * (→ rename) and its `+a −d`, over the file's body (its diff, diagnostics).
 */
export function fileDiffSection(
	file: { path: string; rename?: string; added?: number; removed?: number },
	body: readonly NativeChild[],
	p: { role: string; tone?: TspTone },
): NativeNode {
	const head: TspSpan[] = [span(displayPath(file.path), "path")];
	if (file.rename) head.push(span(" → ", "muted"), span(displayPath(file.rename), "path"));
	if (file.added) head.push(span(` +${file.added}`, "ins"));
	if (file.removed) head.push(span(` \u2212${file.removed}`, "del"));
	return node("section", { head, role: p.role, tone: p.tone }, body, file.path);
}

/**
 * One 22px file row (role `omp.tool.file`) for read groups, grep files, glob
 * lists and find hits: a leading glyph (the file icon unless `lead` replaces
 * it), the path with a dim directory and a strong name (cut in the middle),
 * a quiet `range` suffix (`:13-36`), then an optional count `chip` and a
 * muted `detail`.
 */
export function fileRow(
	filePath: string,
	p: {
		range?: string;
		chip?: { text: string; title?: string };
		detail?: TspText;
		href?: string;
		lead?: NativeNode;
		icon?: string;
		tone?: TspTone;
		title?: string;
		key?: string;
	} = {},
): NativeNode {
	const isDir = filePath.endsWith("/");
	const bare = isDir ? filePath.slice(0, -1) : filePath;
	const cut = bare.lastIndexOf("/") + 1;
	const spans: TspSpan[] = [];
	if (cut > 0) spans.push(span(bare.slice(0, cut), "dim"));
	spans.push(span(`${bare.slice(cut) || "…"}${isDir ? "/" : ""}`, "strong", p.href ? { href: p.href } : undefined));
	if (p.range) spans.push(span(p.range, "muted"));
	const children: NativeChild[] = [
		p.lead ?? node("icon", { name: p.icon ?? (isDir ? "folder" : "file"), tone: p.tone }),
		text(spans, { lines: 1, truncate: "middle", shrink: 1, title: p.title ?? filePath }),
	];
	if (p.chip) children.push(node("badge", { text: p.chip.text, title: p.chip.title }));
	if (p.detail !== undefined) {
		const detail = typeof p.detail === "string" ? [span(plainText(p.detail), "muted")] : p.detail;
		children.push(text(detail, { lines: 1, truncate: "end", shrink: 1 }));
	}
	return keyed(row(children, { role: "omp.tool.file", tone: p.tone }), p.key ?? filePath);
}

/** Longest error excerpt an inline head carries before the body takes the full message. */
const ERROR_GIST_CHARS = 120;

/**
 * Inline error view (§7.3 read error): error tone, the message's first line
 * after `—` in the head's meta, so a collapsed inline call never hides it,
 * and the full message as the body only when the head had to cut it short.
 */
export function inlineErrorView(head: NativeToolHead, message: string): NativeToolView {
	const full = plainText(message).trim() || "failed";
	const first = full.split("\n", 1)[0]!.trim();
	const gist = first.length > ERROR_GIST_CHARS ? `${first.slice(0, ERROR_GIST_CHARS - 1)}…` : first;
	return {
		tool: { ...head, meta: [...(head.meta ?? []), [span(`— ${gist}`, "muted")]] },
		tone: "error",
		inline: true,
		body: gist === full ? undefined : [errorText(full)],
	};
}

/** Text blocks of a tool result joined by newlines, or `""`. */
export function resultText(result: ToolRenderResult<unknown>): string {
	let out = "";
	for (const block of result.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") out += out ? `\n${block.text}` : block.text;
	}
	return out;
}

/**
 * Card head: the bold `toolTitle` title, then detail spans; string details
 * become muted plain text, empty details are skipped.
 */
export function toolHead(title: string, ...details: readonly (TspSpan | string | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [span(title, "toolTitle strong")];
	for (const detail of details) {
		if (detail === undefined) continue;
		const value = typeof detail === "string" ? span(plainText(detail), "muted") : detail;
		if (!value.t) continue;
		spans.push(span(" "), value);
	}
	return spans;
}

/** Error body: wrapped error text, or a JSON `code` block when the message is structured. */
export function errorText(message: string): NativeNode {
	const body = plainText(message).trim();
	return body.includes("\n") && /^[{[]/.test(body)
		? code(body, { lang: "json", tone: "error", role: "omp.tool.error" })
		: text([span(body, "error")], { wrap: "word", role: "omp.tool.error" });
}

/** Error card view: error tone, the tool head and the error body (`<title> failed` when empty). */
export function errorView(title: string, message: string, ...meta: readonly (string | undefined)[]): NativeToolView {
	return {
		head: toolHead(title, ...meta),
		tone: "error",
		body: [errorText(plainText(message).trim() || `${title} failed`)],
	};
}

/** Wrapped placeholder or secondary line (`(no output)`, `No matches`, …); `lines` clamps it. */
export function noteText(message: string, token = "muted", lines?: number): NativeNode {
	return text([span(plainText(message), token)], lines === undefined ? { wrap: "word" } : { wrap: "word", lines });
}

/** Muted `a · b · c` metadata line, or undefined when there are no parts. */
export function statsText(parts: readonly string[]): NativeNode | undefined {
	if (parts.length === 0) return undefined;
	return text([span(parts.join(" · "), "muted")], { wrap: "word", role: "omp.tool.stats" });
}

/** Warning line for truncation / artifact capture failures, or undefined. */
export function truncationNotice(meta: OutputMeta | undefined): NativeNode | undefined {
	if (!meta?.truncation && !meta?.artifactError) return undefined;
	const parts: string[] = [];
	if (meta.truncation) parts.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	if (meta.artifactError) parts.push(formatArtifactErrorNotice(meta.artifactError));
	return text([span(parts.join(". "), "warning")], { wrap: "word", role: "omp.tool.notice" });
}

/**
 * The one final quiet line of a tool body (§7.2): `a · b` facts, then any
 * truncation / artifact-capture notice from `meta`; undefined when empty.
 */
export function footnoteText(parts: readonly string[], meta?: OutputMeta): NativeNode | undefined {
	const all = parts.map(part => plainText(part)).filter(part => part.length > 0);
	if (meta?.truncation) all.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	if (meta?.artifactError) all.push(formatArtifactErrorNotice(meta.artifactError));
	if (all.length === 0) return undefined;
	const notice = meta?.truncation !== undefined || meta?.artifactError !== undefined;
	return {
		...text([span(all.join(" · "), "muted")], { wrap: "word", role: notice ? "omp.tool.notice" : "omp.tool.stats" }),
		key: "foot",
	};
}

/** Drawn lines of a run's input (command, cell code) before its "N more lines" button. */
export const RUN_INPUT_PREVIEW_LINES = 6;

/**
 * What a run's foot names: `running` (live clock), `background` (an async job
 * outlives the call), and the settled outcomes. A failure with an exit code
 * reads `exit N`; without one, `Failed`.
 */
export type RunState = "running" | "background" | "done" | "failed" | "cancelled" | "timed-out";

const RUN_STATE: Record<RunState, { readonly word: string; readonly tone: TspTone }> = {
	running: { word: "Running", tone: "pending" },
	background: { word: "In background", tone: "pending" },
	done: { word: "Done", tone: "success" },
	failed: { word: "Failed", tone: "error" },
	cancelled: { word: "Cancelled", tone: "muted" },
	"timed-out": { word: "Timed out", tone: "warning" },
};

/** Inputs of {@link runFoot}. */
export interface RunFootInput {
	readonly state: RunState;
	/** Exit code of a `failed` run; a non-zero code names the state `exit N`. */
	readonly exitCode?: number;
	/** Milliseconds run so far (`running`) or in total; the time is omitted when undefined. */
	readonly elapsedMs?: number;
	/** Quiet facts (job id, service state, artifact), muted and ` · `-joined. */
	readonly facts?: readonly string[];
	/** Truncation / artifact-capture notices, appended to the facts in `warning`. */
	readonly meta?: OutputMeta;
}

/**
 * The foot line of a run box (`omp.run.foot`): the state word in its tone,
 * the run time (a live clock while running, frozen once settled) and the
 * quiet facts. Glyphs are the terminal's styling, never text.
 */
export function runFoot(input: RunFootInput): NativeNode {
	const failedWithCode = input.state === "failed" && input.exitCode !== undefined && input.exitCode !== 0;
	const state = failedWithCode
		? { word: `exit ${input.exitCode}`, tone: RUN_STATE.failed.tone }
		: RUN_STATE[input.state];
	const facts = (input.facts ?? []).map(fact => plainText(fact).trim()).filter(fact => fact.length > 0);
	const notices: string[] = [];
	if (input.meta?.truncation) notices.push(formatTruncationMetaNotice(input.meta.truncation, input.meta.source));
	if (input.meta?.artifactError) notices.push(formatArtifactErrorNotice(input.meta.artifactError));
	const factSpans: TspSpan[] = [];
	if (facts.length > 0) factSpans.push(span(facts.join(" · "), "muted"));
	for (const notice of notices) {
		if (factSpans.length > 0) factSpans.push(span(" · ", "muted"));
		factSpans.push(span(notice, "warning"));
	}
	const ms = input.elapsedMs === undefined ? undefined : Math.max(0, Math.round(input.elapsedMs));
	const time =
		ms === undefined
			? undefined
			: node(
					"elapsed",
					input.state === "running"
						? { role: "omp.run.time", age: ms, format: "short" }
						: { role: "omp.run.time", age: ms, stopped: ms, format: "short" },
					undefined,
					"time",
				);
	return node(
		"row",
		{ role: "omp.run.foot", gap: "sm", align: "center" },
		compact<NativeNode>([
			keyed(text([span(state.word)], { role: "omp.run.state", tone: state.tone }), "state"),
			time,
			factSpans.length > 0 && keyed(text(factSpans, { role: "omp.run.facts", wrap: "word" }), "facts"),
		]),
		"foot",
	);
}

/** A run's input section: the command or cell source, clamped to {@link RUN_INPUT_PREVIEW_LINES}. */
export function runInput(source: string, p: { role: string; lang: string; wrap: boolean }): NativeNode {
	return keyed(
		code(source.trimEnd(), { role: p.role, lang: p.lang, wrap: p.wrap, preview: { lines: RUN_INPUT_PREVIEW_LINES } }),
		"input",
	);
}

/** A run's terminal output: follows its tail, clamped to the last `previewLines` lines while folded. */
export function runOutput(output: string, p: { role: string; previewLines: number; key?: string }): NativeNode {
	return keyed(ansi(output, { role: p.role, follow: true, preview: { lines: p.previewLines } }), p.key ?? "output");
}

/**
 * One run as one box (`omp.run`): input, output, status lines and foot in
 * order. `tone` tints the box: `error` for a failed run, `warning` for a
 * timed-out one.
 */
export function runBox(
	children: readonly (NativeChild | undefined | false)[],
	p: { key: string; tone?: TspTone },
): NativeNode {
	return node("col", { role: "omp.run", gap: "none", tone: p.tone }, compact(children), p.key);
}

/** Diagnostic rows shown before `+N more`. */
const DIAGNOSTIC_ROWS = 5;

const SEVERITY_RANK: Record<ParsedDiagnostic["severity"], number> = { error: 0, warning: 1, info: 2, hint: 3 };
const SEVERITY_ICON: Record<ParsedDiagnostic["severity"], string> = {
	error: "x-circle",
	warning: "warn",
	info: "info",
	hint: "lightbulb",
};
const SEVERITY_TONE: Record<ParsedDiagnostic["severity"], TspTone> = {
	error: "error",
	warning: "warning",
	info: "info",
	hint: "muted",
};

/** A diagnostic's severity glyph: `x-circle` error, `warn` warning, `info`, `lightbulb` hint, in the severity tone. */
export function diagnosticGlyph(severity: ParsedDiagnostic["severity"]): NativeNode {
	return node("icon", { name: SEVERITY_ICON[severity] ?? "warn", tone: SEVERITY_TONE[severity], aria: severity });
}

/** One diagnostic row: severity icon · `line:col` (with the file when `withPath`) · message and source. */
function diagnosticRow(diagnostic: ParsedDiagnostic, withPath: boolean, key: string): NativeNode {
	const where = `${withPath ? `${displayPath(diagnostic.filePath)}:` : ""}${diagnostic.line}:${diagnostic.col}`;
	const message: TspSpan[] = [span(diagnostic.message)];
	const source = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
	if (source) message.push(span(` ${source}`, "muted"));
	return row(
		[
			node("icon", {
				name: SEVERITY_ICON[diagnostic.severity] ?? "warn",
				tone: SEVERITY_TONE[diagnostic.severity],
				aria: diagnostic.severity,
			}),
			text([span(where, "muted")], { wrap: "none" }),
			text(message, { wrap: "word" }),
		],
		{ role: "omp.tool.diagnostic", key },
	);
}

/**
 * LSP diagnostics section for write/edit results: rows of severity icon ·
 * `line:col` · message, most severe first, capped at five with `+N more`.
 * Rows name the file too when the messages span several files (or `withPath`).
 * Undefined when there is nothing to show.
 */
export function diagnosticsSection(
	diagnostics: FileDiagnosticsResult | undefined,
	opts?: { withPath?: boolean },
): NativeNode | undefined {
	if (!diagnostics || diagnostics.messages.length === 0) return undefined;
	const parsed: ParsedDiagnostic[] = [];
	const unparsed: string[] = [];
	for (const message of diagnostics.messages) {
		const diagnostic = parseDiagnosticMessage(plainText(message).trim());
		if (diagnostic) parsed.push(diagnostic);
		else if (message.trim()) unparsed.push(plainText(message).trim());
	}
	parsed.sort(
		(a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.line - b.line || a.col - b.col,
	);
	const withPath = opts?.withPath === true || new Set(parsed.map(d => d.filePath)).size > 1;
	const rows: NativeNode[] = [
		...parsed.map((d, i) => diagnosticRow(d, withPath, `d${i}`)),
		...unparsed.map((message, i) =>
			text([span(message)], { wrap: "word", role: "omp.tool.diagnostic", key: `u${i}` }),
		),
	];
	const shown = rows.slice(0, DIAGNOSTIC_ROWS);
	const hidden = rows.length - shown.length;
	if (hidden > 0) {
		shown.push(text([span(`+${hidden} more`, "muted")], { role: "omp.tool.stats", key: "more" }));
	}
	return node(
		"section",
		{
			head: [span("Diagnostics")],
			tone: diagnostics.errored ? "error" : "warning",
			role: "omp.tool.diagnostics",
		},
		shown,
		"diagnostics",
	);
}

/** Head chip counting LSP diagnostics across files (`2 diagnostics`), or undefined when there are none. */
export function diagnosticsBadge(
	files: readonly (FileDiagnosticsResult | undefined)[],
): { text: string; tone: TspTone } | undefined {
	let count = 0;
	let errored = false;
	for (const file of files) {
		if (!file) continue;
		count += file.messages.length;
		errored ||= file.errored;
	}
	if (count === 0) return undefined;
	return { text: count === 1 ? "1 diagnostic" : `${count} diagnostics`, tone: errored ? "error" : "warning" };
}
