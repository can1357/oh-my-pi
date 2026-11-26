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
import { toPathList } from "../../utils/render-utils";
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
	/** The call named a path: results show it after the title. */
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

// Theme keys the regex grammar gives the equivalent regex tokens, so glob and grep heads read alike.
// No escapes: glob reads every `\` as a path separator.
/** Wildcards, class brackets, alternation braces and commas. */
const OPERATOR = "syntaxKeyword";
/** A class range (`a-z`). */
const RANGE = "syntaxNumber";

/** The index of the `]` closing the class opened at `start`; -1 when it never closes (the `[` is literal). */
function classEnd(glob: string, start: number): number {
	let i = start + 1;
	if (glob[i] === "!" || glob[i] === "^") i++;
	if (glob[i] === "]") i++; // A leading `]` is a member.
	return glob.indexOf("]", i);
}

/** The class `[start, end]` (`[!a-z_]`) as spans: brackets and negation operators, ranges numbers, members plain. */
function classSpans(glob: string, start: number, end: number): TspSpan[] {
	const open = glob[start + 1] === "!" || glob[start + 1] === "^" ? 2 : 1;
	const spans: TspSpan[] = [{ t: glob.slice(start, start + open), s: OPERATOR }];
	for (let i = start + open; i < end;) {
		const range = glob[i + 1] === "-" && i + 2 < end;
		const length = range ? 3 : 1;
		const t = glob.slice(i, i + length);
		spans.push(range ? { t, s: RANGE } : { t });
		i += length;
	}
	spans.push({ t: "]", s: OPERATOR });
	return spans;
}

/**
 * A glob (or a `;` list of them) as spans: wildcards (`*`, `**`, `?`), classes
 * and `{a,b}` alternations styled as the regex grammar styles the equivalent
 * tokens; path text unstyled.
 */
function globSpans(glob: string): TspSpan[] {
	const spans: TspSpan[] = [];
	let i = 0;
	const take = (length: number, s?: string): void => {
		const t = glob.slice(i, i + length);
		spans.push(s === undefined ? { t } : { t, s });
		i += length;
	};
	let depth = 0; // Open `{` alternations.
	while (i < glob.length) {
		const ch = glob[i]!;
		const classClose = ch === "[" ? classEnd(glob, i) : -1;
		if (ch === "*" || ch === "?") take(1, OPERATOR);
		else if (classClose >= 0) {
			spans.push(...classSpans(glob, i, classClose));
			i = classClose + 1;
		} else if (ch === "{") {
			depth++;
			take(1, OPERATOR);
		} else if ((ch === "}" || ch === ",") && depth > 0) {
			if (ch === "}") depth--;
			take(1, OPERATOR);
		} else take(1);
	}
	return spans;
}

/** The searched paths as one label (`src/*.ts, test`), each highlighted as a glob; empty when the call names none. */
function scopeText(args: GlobArgs | undefined): TspText {
	// Lenient arg validation lets malformed entries through; skip them as grep does.
	const entries = toPathList(args?.path ?? args?.paths).filter(entry => typeof entry === "string" && entry !== "");
	return spansText(entries.flatMap((entry, i) => (i === 0 ? globSpans(entry) : [{ t: ", " }, ...globSpans(entry)])));
}

function globHead(args: GlobArgs | undefined, meta: readonly TspText[]): ToolHead {
	return {
		title: "Glob",
		target: scopeText(args) || "*",
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
			head: globHead(args, limitMeta(args)),
			term: { look: "glob" } satisfies GlobTerm,
		};
	},
	result(result, _state, args): ToolView {
		const details = result.details;
		if (result.isError || details?.error) {
			const message = details?.error || resultText(result) || "Unknown error";
			return inlineErrorView(globHead(args, limitMeta(args)), message, {
				term: { look: "glob", result: true, error: message } satisfies GlobTerm,
			});
		}
		const head = (meta: TspText[], extra?: Partial<ToolHead>): ToolHead => ({
			...globHead(args, meta),
			...extra,
		});
		const scoped = scopeText(args) !== "";
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
