import type { OutputMeta } from "../output-meta-format";
import type { TruncationResult } from "../streaming-output";

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
