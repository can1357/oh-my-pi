import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
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

/**
 * The `path` a call searches. Models often pass the glob as `pattern` beside a
 * directory `path` (`{path: "src", pattern: "**\/*.ts"}`) or instead of it; each
 * `;` entry of `pattern` is scoped under each `path` entry unless it is absolute
 * or a URL. Approval, execution and the call's header all read this, so a
 * `pattern` reaching outside `path` is approved and shown where it actually searches.
 */
export function globSearchPath(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const base = typeof args.path === "string" ? args.path : undefined;
	if (typeof args.pattern !== "string") return base;
	const patterns = args.pattern
		.split(";")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
	const bases =
		base
			?.split(";")
			.map(entry => entry.trim())
			.filter(entry => entry.length > 0) ?? [];
	if (bases.length === 0) return patterns.join(";");
	const scoped = new Set<string>();
	for (const dir of bases) {
		for (const pattern of patterns) {
			const standalone =
				path.isAbsolute(pattern) || pattern.startsWith("~") || /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern);
			scoped.add(standalone ? pattern : `${dir.replace(/[\\/]+$/, "")}/${pattern}`);
		}
	}
	return [...scoped].join(";");
}
