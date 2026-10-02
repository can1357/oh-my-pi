import { Shell } from "@oh-my-pi/pi-natives";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../sdk";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { DEFAULT_MAX_LINES, truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveReadPath } from "./path-utils";
import { buildInMemorySelectorResult, prependSuffixResolutionNotice, toReadTruncationStats } from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { parseSel } from "./read-selector";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

const JSON_PATH_PATTERN = /\.(?:jsonl?|ndjson)(?=(?::|\?|$))/gi;
const DEFAULT_JSON_QUERY_LIMIT = 100;
const MAX_JSON_QUERY_LIMIT = 1000;

export interface JsonPathCandidate {
	jsonPath: string;
	subPath: string;
	queryString: string;
}

export interface JsonSelector {
	kind: "query";
	query: string;
	raw?: boolean;
	compact?: boolean;
	limit?: number;
	offset?: number;
}

function splitJsonRemainder(remainder: string): { subPath: string; queryString: string } {
	const queryIndex = remainder.indexOf("?");
	if (queryIndex === -1) {
		return { subPath: remainder, queryString: "" };
	}
	return {
		subPath: remainder.slice(0, queryIndex),
		queryString: remainder.slice(queryIndex + 1),
	};
}

export function parseJsonPathCandidates(filePath: string): JsonPathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const seen = new Set<string>();
	const candidates: JsonPathCandidate[] = [];

	let match: RegExpExecArray | null;
	JSON_PATH_PATTERN.lastIndex = 0;
	while (true) {
		match = JSON_PATH_PATTERN.exec(normalized);
		if (match === null) break;

		const end = match.index + match[0].length;
		const jsonPath = filePath.slice(0, end);
		const remainder = normalized.slice(end);
		const { subPath, queryString } = splitJsonRemainder(remainder);
		const key = `${jsonPath}\0${subPath}\0${queryString}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ jsonPath, subPath, queryString });
	}

	return candidates.sort((left, right) => right.jsonPath.length - left.jsonPath.length);
}

export function parseJsonSelector(subPath: string, queryString: string): JsonSelector | null {
	const params = new URLSearchParams(queryString);
	let query = params.get("q") ?? params.get("query");

	const trimmedSubPath = subPath.replace(/^:+/, "").trim();
	if (!query && trimmedSubPath.startsWith("q=")) {
		query = trimmedSubPath.slice(2);
	}

	if (!query) return null;

	const rawParam = params.get("raw")?.toLowerCase();
	const raw = rawParam === "true" || rawParam === "1" || trimmedSubPath.includes("raw");

	const compactParam = params.get("compact")?.toLowerCase();
	const compact = compactParam === "true" || compactParam === "1" || trimmedSubPath.includes("compact");

	let limit: number | undefined;
	const limitParam = params.get("limit");
	if (limitParam !== null) {
		const parsed = Number.parseInt(limitParam, 10);
		if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, MAX_JSON_QUERY_LIMIT);
	}

	let offset: number | undefined;
	const offsetParam = params.get("offset");
	if (offsetParam !== null) {
		const parsed = Number.parseInt(offsetParam, 10);
		if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
	}

	return {
		kind: "query",
		query,
		raw,
		compact,
		limit,
		offset,
	};
}

function applyPagination(
	text: string,
	offset: number | undefined,
	limit: number | undefined,
): string {
	if (offset === undefined && limit === undefined) {
		return text;
	}
	const effectiveOffset = offset ?? 0;
	const effectiveLimit = limit ?? DEFAULT_JSON_QUERY_LIMIT;

	// Check if output is a single JSON array
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			const sliced = parsed.slice(effectiveOffset, effectiveOffset + effectiveLimit);
			let result = JSON.stringify(sliced, null, 2);
			const total = parsed.length;
			const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
			if (remaining > 0) {
				const nextOffset = effectiveOffset + sliced.length;
				result += `\n[${remaining} more items; append ?limit=${effectiveLimit}&offset=${nextOffset} to continue]`;
			}
			return result;
		}
	} catch {
		// Not a single JSON array, proceed to line-based pagination
	}

	const lines = text.trimEnd().split("\n");
	if (lines.length <= 1 && effectiveOffset === 0) {
		return text;
	}
	const sliced = lines.slice(effectiveOffset, effectiveOffset + effectiveLimit);
	let result = sliced.join("\n");
	const total = lines.length;
	const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
	if (remaining > 0) {
		const nextOffset = effectiveOffset + sliced.length;
		result += `\n[${remaining} more items; append ?limit=${effectiveLimit}&offset=${nextOffset} to continue]`;
	}
	return result;
}

export async function executeJsonQuery(
	filePath: string,
	selector: JsonSelector,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) {
		throw new ToolError("Operation aborted");
	}

	const shell = new Shell();
	const flags: string[] = [];
	if (selector.raw) flags.push("-r");
	if (selector.compact) flags.push("-c");

	const quotedQuery = `'${selector.query.replace(/'/g, "'\\''")}'`;
	const quotedPath = `'${filePath.replace(/'/g, "'\\''")}'`;
	const command = `jq ${flags.join(" ")} ${quotedQuery} ${quotedPath}`;

	let output = "";
	let hasError = false;

	const result = await shell.run(
		{
			command,
			signal,
		},
		(err, chunk) => {
			if (err) {
				hasError = true;
			}
			if (chunk) {
				output += chunk;
			}
		},
	);

	if (result.cancelled) {
		throw new ToolError("Operation aborted");
	}

	if (result.timedOut) {
		throw new ToolError("JSON query timed out");
	}

	if (result.exitCode !== 0 || hasError) {
		const errMsg = output.trim() || `jq exited with code ${result.exitCode}`;
		throw new ToolError(`Failed to execute JSON query: ${errMsg}`);
	}

	const trimmed = output.trimEnd();
	return applyPagination(trimmed, selector.offset, selector.limit);
}

export interface ResolvedJsonReadPath {
	absolutePath: string;
	jsonSubPath: string;
	queryString: string;
	selector: JsonSelector;
	suffixResolution?: { from: string; to: string };
}

export async function resolveJsonReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedJsonReadPath | null> {
	const candidates = parseJsonPathCandidates(readPath);
	for (const candidate of candidates) {
		const selector = parseJsonSelector(candidate.subPath, candidate.queryString);
		if (!selector) continue;

		let absolutePath = resolveReadPath(candidate.jsonPath, session.cwd);
		let suffixResolution: { from: string; to: string } | undefined;

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (!stat.isFile()) continue;

			return {
				absolutePath,
				jsonSubPath: candidate.subPath,
				queryString: candidate.queryString,
				selector,
				suffixResolution,
			};
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.jsonPath, signal);
			if (!suffixMatch) continue;

			try {
				const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
				if (!retryStat.isFile()) continue;

				return {
					absolutePath: suffixMatch.absolutePath,
					jsonSubPath: candidate.subPath,
					queryString: candidate.queryString,
					selector,
					suffixResolution: { from: candidate.jsonPath, to: suffixMatch.relativePath },
				};
			} catch {
				// Suffix retry failed, continue to next candidate
			}
		}
	}

	return null;
}

export async function readJson(
	session: ToolSession,
	resolvedJsonPath: ResolvedJsonReadPath,
	lineSelector?: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);

	const details: ReadToolDetails = {
		resolvedPath: resolvedJsonPath.absolutePath,
		suffixResolution: resolvedJsonPath.suffixResolution,
	};

	const queryOutput = await executeJsonQuery(
		resolvedJsonPath.absolutePath,
		resolvedJsonPath.selector,
		signal,
	);

	const output = prependSuffixResolutionNotice(queryOutput, resolvedJsonPath.suffixResolution);

	if (lineSelector) {
		const parsedSel = parseSel(lineSelector);
		if (parsedSel.kind !== "none") {
			return buildInMemorySelectorResult(session, output, parsedSel, {
				details,
				sourcePath: resolvedJsonPath.absolutePath,
				entityLabel: "JSON query output",
				immutable: true,
			});
		}
	}

	const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES });
	details.truncation = truncation.truncated ? toReadTruncationStats(truncation) : undefined;
	const resultBuilder = toolResult<ReadToolDetails>(details)
		.text(truncation.content)
		.sourcePath(resolvedJsonPath.absolutePath);
	if (truncation.truncated) {
		resultBuilder.truncation(truncation, { direction: "head" });
	}

	return resultBuilder.done();
}
