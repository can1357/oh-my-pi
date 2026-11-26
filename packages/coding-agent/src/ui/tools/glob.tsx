/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Glob: `Glob  25 files · in src`, then the files: a few as path rows, more
 * as wrapped chips; limits and skipped paths in one quiet footnote.
 *
 * Terminal look: `glob` (`src/ui/styles/tools/glob.ts`): a head line and a
 * branch tree of paths with file-type icons.
 */
import type { TspText } from "@oh-my-pi/pi-wire";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { toPathList } from "../../utils/render-utils";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { countText, FileChip, FileRow, inlineErrorView, StatsFoot } from "./search-common";

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

/** The searched paths as one label (`src, test`); empty when the call names none. */
function scopeLabel(args: GlobArgs | undefined): string {
	return toPathList(args?.path ?? args?.paths).join(", ");
}

function globHead(args: GlobArgs | undefined, meta: readonly TspText[]): ToolHead {
	return {
		title: "Glob",
		target: scopeLabel(args) || "*",
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
						target: scopeLabel(args) !== "",
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
					target: scopeLabel(args) !== "",
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
					target: scopeLabel(args) !== "",
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
				target: scopeLabel(args) !== "",
				files,
				notes: rowNotes,
				...(details.cwd ? { cwd: details.cwd } : {}),
			} satisfies GlobTerm,
		};
	},
};

registerToolPresenter("glob", globPresenter);
