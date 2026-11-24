/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Pieces the file-changing tools (write, edit) share: display paths and file
 * links, LSP diagnostics (section and head chip) and line counts.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { shortenHome } from "@oh-my-pi/pi-tui/text/sanitize";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";
import { tryFileUri } from "../../utils/file-links";
import { cleanText } from "./agent-common";

/** LSP diagnostics a write or edit reports for one file. */
export interface FileDiagnostics {
	readonly server?: string;
	readonly messages: readonly string[];
	readonly summary: string;
	readonly errored: boolean;
}

/** A parsed `file:line:col [severity] [source] message (code)` diagnostic. */
export interface ParsedDiagnostic {
	readonly filePath: string;
	readonly line: number;
	readonly col: number;
	readonly severity: "error" | "warning" | "info" | "hint";
	readonly source?: string;
	readonly message: string;
	readonly code?: string;
}

const DIAGNOSTIC = /^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/;

/** A diagnostic line parsed, or undefined when it has another shape. */
export function parseDiagnostic(message: string): ParsedDiagnostic | undefined {
	const match = DIAGNOSTIC.exec(message);
	if (!match) return undefined;
	return {
		filePath: cleanText(match[1]!),
		line: Number.parseInt(match[2]!, 10),
		col: Number.parseInt(match[3]!, 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5] ? cleanText(match[5]) : undefined,
		message: cleanText(match[6]!),
		code: match[7] ? cleanText(match[7]) : undefined,
	};
}

const SEVERITY_RANK: Record<ParsedDiagnostic["severity"], number> = {
	error: 0,
	warning: 1,
	info: 2,
	hint: 3,
};
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
/** Diagnostic rows before `+N more`. */
const DIAGNOSTIC_ROWS = 5;

/** Most severe first, then by position. */
export function diagnosticOrder(a: ParsedDiagnostic, b: ParsedDiagnostic): number {
	return (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.line - b.line || a.col - b.col;
}

/** A path as heads show it: relative to the working directory when inside it, else `~`-shortened. */
export function displayPath(filePath: string): string {
	if (path.isAbsolute(filePath)) {
		const rel = path.relative(process.cwd(), filePath);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	}
	return shortenHome(filePath);
}

/** The native link (`href`) of an absolute path: a `file:` URI, or the configured `PI_LINK_SCHEME` handler's. */
export function fileHref(filePath: string | undefined): string | undefined {
	return filePath && path.isAbsolute(filePath) ? tryFileUri(filePath) : undefined;
}

/**
 * The local file a call's path argument points at before the tool resolves
 * it (the link of a pending read or write): `~` expanded, archive-member and
 * SQLite-row selectors dropped so the link opens the containing file.
 */
export function pendingLinkPath(inputPath: string): string {
	const expanded = inputPath.replace(/^~(?=$|[\\/])/, os.homedir());
	if (!expanded.includes(":")) return path.resolve(expanded);
	const archive = parseArchivePathCandidates(expanded).find(candidate => candidate.archivePath !== expanded);
	const sqlite = expanded.match(/^(.+\.(?:sqlite3?|db3?))(?=[:?])/i);
	return path.resolve(archive?.archivePath ?? sqlite?.[1] ?? expanded);
}

/** `1 line`, `4 lines` of a text (0 for empty). */
export function countLines(text: string): number {
	return text ? text.split("\n").length : 0;
}

/**
 * The LSP diagnostics section: severity icon, `line:col` (with the file when
 * the messages span several files) and message per row, most severe first,
 * five rows then `+N more`. The full report rides on `term.diagnostics` for
 * the terminal's tree.
 */
export function DiagnosticsSection(props: {
	readonly diagnostics?: FileDiagnostics;
	readonly withPath?: boolean;
}): JSXNode {
	const diagnostics = props.diagnostics;
	if (!diagnostics || diagnostics.messages.length === 0) return undefined;
	const parsed: ParsedDiagnostic[] = [];
	const unparsed: string[] = [];
	for (const message of diagnostics.messages) {
		const diagnostic = parseDiagnostic(cleanText(message).trim());
		if (diagnostic) parsed.push(diagnostic);
		else if (message.trim()) unparsed.push(cleanText(message).trim());
	}
	parsed.sort(diagnosticOrder);
	const withPath = props.withPath === true || new Set(parsed.map(d => d.filePath)).size > 1;
	const rows: JSXNode[] = [
		...parsed.map((d, i) => {
			const message: TspSpan[] = [{ t: d.message }];
			const source = [d.source, d.code].filter(Boolean).join(" ");
			if (source) message.push({ s: "muted", t: ` ${source}` });
			return (
				<row propKey={`d${i}`} role="omp.tool.diagnostic">
					<icon name={SEVERITY_ICON[d.severity] ?? "warn"} tone={SEVERITY_TONE[d.severity]} aria={d.severity} />
					<text
						spans={[
							{
								s: "muted",
								t: `${withPath ? `${displayPath(d.filePath)}:` : ""}${d.line}:${d.col}`,
							},
						]}
						wrap="none"
					/>
					<text spans={message} wrap="word" />
				</row>
			);
		}),
		...unparsed.map((message, i) => (
			<text propKey={`u${i}`} role="omp.tool.diagnostic" spans={[{ t: message }]} wrap="word" />
		)),
	];
	const shown = rows.slice(0, DIAGNOSTIC_ROWS);
	const hidden = rows.length - shown.length;
	if (hidden > 0)
		shown.push(<text propKey="more" role="omp.tool.stats" spans={[{ s: "muted", t: `+${hidden} more` }]} />);
	return (
		<section
			key="diagnostics"
			head={[{ t: "Diagnostics" }]}
			tone={diagnostics.errored ? "error" : "warning"}
			role="omp.tool.diagnostics"
			term={{ diagnostics }}
		>
			{shown}
		</section>
	);
}

/** Head chip counting diagnostics across files (`2 diagnostics`), or undefined when there are none. */
export function diagnosticsBadge(
	files: readonly (FileDiagnostics | undefined)[],
): { text: string; tone: TspTone } | undefined {
	let count = 0;
	let errored = false;
	for (const file of files) {
		if (!file) continue;
		count += file.messages.length;
		errored ||= file.errored;
	}
	if (count === 0) return undefined;
	return {
		text: count === 1 ? "1 diagnostic" : `${count} diagnostics`,
		tone: errored ? "error" : "warning",
	};
}
