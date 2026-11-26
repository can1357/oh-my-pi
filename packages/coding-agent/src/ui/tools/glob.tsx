/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Glob: `Glob src/*.{ts,tsx}  25 files · in src` (the globs' wildcards, classes
 * and alternations highlighted), then the files: a few as path rows, more
 * as wrapped chips; limits and skipped paths in one quiet footnote.
 *
 * Terminal look: `glob` (`src/ui/styles/tools/glob.ts`): a head line and a
 * branch tree of paths with file-type icons.
 */
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import { globSearchPath } from "../../tools/details/glob";
import { splitTopLevelDelimitedPath, toPathList } from "../../utils/render-utils";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { countText, FileChip, FileRow, inlineErrorView, spansText, StatsFoot } from "./search-common";

/** The args glob shows. */
export interface GlobArgs {
	readonly pattern?: string;
	readonly path?: string | string[];
	/** Pre-`path` argument name; kept so historical transcripts still show their scope. */
	readonly paths?: string | string[];
	readonly limit?: number;
}

/** Result details glob reports. */
export interface GlobDetails {
	readonly fileCount?: number;
	readonly files?: readonly string[];
	readonly error?: string;
	readonly scopePath?: string;
	readonly resultLimitReached?: number;
	readonly timedOut?: boolean;
	readonly missingPaths?: readonly string[];
	readonly truncation?: {
		readonly truncatedBy?: string;
		readonly artifactId?: string;
	};
	/** The checkout the paths are relative to (links them). */
	readonly cwd?: string;
}

/** Most files listed as rows; more wrap as chips. */
const LIST_MAX = 6;
/** Body rows shown while collapsed. */
const PREVIEW_LINES = 8;

/** Terminal facts of the `glob` look. */
export type GlobTerm = {
	readonly look: "glob";
	/** The view is a result (not the pending call). */
	readonly result?: boolean;
	/** The call named a path or pattern: results show it after the title. */
	readonly target?: boolean;
	/** Listed paths. */
	readonly files?: readonly string[];
	/** The paths came from plain text output (no icons). */
	readonly plain?: boolean;
	/** Notes under the list, one row each. */
	readonly notes?: readonly string[];
	/** The empty-result message. */
	readonly empty?: string;
	/** The empty message stands alone, without the head line (plain-text results). */
	readonly headless?: boolean;
	/** A failed search's message. */
	readonly error?: string;
	/** The checkout the listed paths are relative to: files link. */
	readonly cwd?: string;
};

/** `limit:50` for a call that caps its results. */
function limitMeta(args: GlobArgs | undefined): TspText[] {
	return args?.limit !== undefined ? [`limit:${args.limit}`] : [];
}

/** The regex grammar's operator style, so glob syntax reads like grep's. */
const GLOB_OPERATOR = "syntaxKeyword";

/**
 * Where the class opened at `open` closes: the first `]` after its `!`/`^`
 * negation and a leading `]` member; -1 when none follows (the `[` is drawn plain).
 */
function classClose(glob: string, open: number): number {
	let first = open + 1;
	if (glob[first] === "!" || glob[first] === "^") first++;
	if (glob[first] === "]") first++;
	return glob.indexOf("]", first);
}

/**
 * One glob as spans: wildcards (`*`, `**`, `?`), class brackets with their
 * negation, and `{a,b}` braces and commas as operators; the rest plain. Spans
 * are cut only at those ASCII characters, so no character splits. A `\` is
 * plain: glob reads it as a path separator, not an escape. A URL stays plain:
 * which of its parts glob depends on its scheme.
 */
function globSpans(glob: string): TspSpan[] {
	if (splitUrlScheme(glob)) return [{ t: glob }];

	const spans: TspSpan[] = [];
	let plainFrom = 0;
	const operator = (from: number, to: number): void => {
		if (plainFrom < from) spans.push({ t: glob.slice(plainFrom, from) });
		spans.push({ t: glob.slice(from, to), s: GLOB_OPERATOR });
		plainFrom = to;
	};

	let braceDepth = 0;
	// Once a `[` finds no `]` after it, no later `[` can: they are all literal.
	let classesClose = true;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*" || ch === "?") {
			operator(i, i + 1);
		} else if (ch === "{") {
			braceDepth++;
			operator(i, i + 1);
		} else if ((ch === "," || ch === "}") && braceDepth > 0) {
			if (ch === "}") braceDepth--;
			operator(i, i + 1);
		} else if (ch === "[" && classesClose) {
			const close = classClose(glob, i);
			if (close === -1) {
				classesClose = false;
			} else {
				const negated = glob[i + 1] === "!" || glob[i + 1] === "^";
				operator(i, negated ? i + 2 : i + 1);
				operator(close, close + 1);
				i = close;
			}
		}
	}
	if (plainFrom < glob.length) spans.push({ t: glob.slice(plainFrom) });
	return spans;
}

/**
 * The globs a call searches, highlighted: its path with a separate `pattern`
 * scoped under it, then listed and split at top-level `;`, as the tool does.
 * Empty when the call names none.
 */
function scopeText(args: GlobArgs | undefined): TspText {
	// An array (old transcripts' `paths`, a lenient model's `path`) is the `;` list it
	// stands for; malformed entries are skipped.
	const raw = args?.path ?? args?.paths;
	const path = Array.isArray(raw) ? raw.filter(entry => typeof entry === "string" && entry !== "").join(";") : raw;
	const searched = globSearchPath({ path, pattern: args?.pattern });
	if (!searched) return "";

	const entries = toPathList(searched).flatMap(entry => splitTopLevelDelimitedPath(entry, "semicolon"));
	const spans: TspSpan[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (i > 0) spans.push({ t: ";" });
		spans.push(...globSpans(entries[i]!));
	}
	return spansText(spans);
}

function globHead(target: TspText, meta: readonly TspText[]): ToolHead {
	return {
		title: "Glob",
		target: target || "*",
		targetKind: "pattern",
		meta,
	};
}

function truncationNote(details: GlobDetails | undefined): string | undefined {
	const parts: string[] = [];
	if (details?.resultLimitReached) parts.push(`limit ${details.resultLimitReached} results`);
	if (details?.truncation?.truncatedBy === "lines") parts.push("line limit");
	else if (details?.truncation?.truncatedBy) parts.push(`${details.truncation.truncatedBy} limit`);
	if (details?.truncation?.artifactId) parts.push(`Read local://${details.truncation.artifactId}.log for full output`);
	return parts.length > 0 ? `truncated: ${parts.join(", ")}` : undefined;
}

function fileList(files: readonly string[], cwd?: string) {
	if (files.length <= LIST_MAX) {
		return (
			<col role="omp.tool.files" gap="none">
				{files.map(file => (
					<FileRow id={file} path={file} cwd={cwd} />
				))}
			</col>
		);
	}
	return (
		<row role="omp.tool.files" gap="xs" wrap>
			{files.map(file => (
				<FileChip path={file} />
			))}
		</row>
	);
}

export const globPresenter: ToolPresenter<GlobArgs, GlobDetails> = {
	inline: true,
	merge: true,
	call(args) {
		return {
			head: globHead(scopeText(args), limitMeta(args)),
			term: { look: "glob" } satisfies GlobTerm,
		};
	},
	result(result, _state, args): ToolView {
		const details = result.details;
		const target = scopeText(args);
		if (result.isError || details?.error) {
			const message = details?.error || resultText(result) || "Unknown error";
			return inlineErrorView(globHead(target, limitMeta(args)), message, {
				term: { look: "glob", result: true, error: message } satisfies GlobTerm,
			});
		}
		const head = (meta: TspText[], extra?: Partial<ToolHead>): ToolHead => ({
			...globHead(target, meta),
			...extra,
		});
		const scoped = target !== "";
		if (details?.fileCount === undefined) {
			const text = resultText(result);
			const files = text.split("\n").filter(line => line.trim() !== "");
			if (!text || text === "No files found" || files.length === 0) {
				return {
					head: head(["0 files"]),
					tone: "warning",
					term: {
						look: "glob",
						result: true,
						target: scoped,
						empty: "No files found",
						headless: true,
					} satisfies GlobTerm,
				};
			}
			return {
				head: head([countText(files.length, "file")]),
				preview: { lines: PREVIEW_LINES },
				body: fileList(files),
				term: {
					look: "glob",
					result: true,
					target: scoped,
					files,
					plain: true,
				} satisfies GlobTerm,
			};
		}
		const files = details.files ?? [];
		const missing = details.missingPaths ?? [];
		const notes = [
			truncationNote(details),
			missing.length > 0 ? `skipped missing: ${missing.join(", ")}` : undefined,
		];
		const rowNotes = notes.filter((note): note is string => note !== undefined);
		const meta: TspText[] = [countText(details.fileCount, "file")];
		if (details.scopePath) meta.push(`in ${details.scopePath}`);
		const truncated = Boolean(details.resultLimitReached || details.truncation);
		const extra: Partial<ToolHead> = {
			...(details.timedOut ? { note: "timed out" } : {}),
			...(truncated ? { badges: [{ text: "truncated", tone: "warning" as const }] } : {}),
		};
		if (details.fileCount === 0) {
			return {
				head: head(meta, extra),
				tone: "warning",
				body: <StatsFoot notes={notes} />,
				term: {
					look: "glob",
					result: true,
					target: scoped,
					empty: details.timedOut ? "No matches before timeout (scan incomplete)" : "No files found",
					notes: rowNotes,
				} satisfies GlobTerm,
			};
		}
		return {
			head: head(meta, extra),
			preview: { lines: PREVIEW_LINES },
			body: [fileList(files, details.cwd), <StatsFoot notes={notes} />],
			term: {
				look: "glob",
				result: true,
				target: scoped,
				files,
				notes: rowNotes,
				...(details.cwd ? { cwd: details.cwd } : {}),
			} satisfies GlobTerm,
		};
	},
};

registerToolPresenter("glob", globPresenter);
