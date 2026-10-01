/**
 * Deterministic memory-row triggers: `metadata.trigger` gates a row into the
 * recall block by keyword/path shape instead of embedding similarity, so an
 * environment rule or tool mandate surfaces even when the user's wording shares
 * nothing with the row's content. Research basis: `.superpowers/sdd/DAKERA_FRONTIER_RESEARCH.md`
 * (OpenHands keyword/task/path union, Claude Code path-scoped rules).
 */

import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { DakeraRecallHit } from "./client";

export interface DakeraTriggerSpec {
	keywords: string[];
	paths: string[];
}

/** Tools whose string `path` argument feeds the touched-path dimension. */
const TOUCHED_PATH_TOOLS: Record<string, true> = { read: true, edit: true, write: true };

/**
 * Value-level trigger validation: an object carrying at least one non-empty
 * string array. The `retain` tool runs incoming `trigger` values through this
 * so a malformed or empty trigger fails loud instead of storing an inert row.
 */
export function parseDakeraTriggerValue(value: unknown): DakeraTriggerSpec | undefined {
	if (!isRecord(value)) return undefined;
	const keywords = stringArrayOf(value.keywords);
	const paths = stringArrayOf(value.paths);
	if (keywords.length === 0 && paths.length === 0) return undefined;
	return { keywords, paths };
}

/**
 * Read `metadata.trigger`; `undefined` when absent, invalid, or both arrays are
 * empty. Unknown keys (e.g. a future `task` dimension) are ignored, and a
 * stored spec survives round-trips through redaction untouched.
 */
export function parseDakeraTrigger(metadata: unknown): DakeraTriggerSpec | undefined {
	if (!isRecord(metadata)) return undefined;
	return parseDakeraTriggerValue(metadata.trigger);
}

/** Lowercase `\p{L}\p{N}`+ tokens, non-empty — the shared compare form for queries and keywords. */
export function tokenizeTriggerQuery(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function stringArrayOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function globMatches(pattern: string, candidate: string): boolean {
	try {
		return new Bun.Glob(pattern).match(candidate);
	} catch {
		// An invalid pattern stored by an older build must never break recall —
		// it simply matches nothing.
		return false;
	}
}

/**
 * AND of the dimensions present: the keyword dimension hits when ANY keyword's
 * full token set appears in the query tokens (a multi-word keyword fires only
 * as a phrase, not on a stray word); the path dimension hits when ANY stored
 * glob matches ANY touched path. A dimension with no entries counts as hit, so
 * a keywords-only spec ignores paths and vice versa.
 */
export function triggerMatches(
	spec: DakeraTriggerSpec,
	input: { queryTokens: string[]; touchedPaths: string[] },
): boolean {
	const keywordHit =
		spec.keywords.length === 0 ||
		spec.keywords.some(keyword => {
			const tokens = tokenizeTriggerQuery(keyword);
			if (tokens.length === 0) return false;
			return tokens.every(token => input.queryTokens.includes(token));
		});
	if (!keywordHit) return false;
	const pathHit =
		spec.paths.length === 0 ||
		input.touchedPaths.some(path => spec.paths.some(pattern => globMatches(pattern, path)));
	return pathHit;
}

/** Rows whose parsed trigger matches; input order preserved. */
export function filterTriggerHits(
	rows: DakeraRecallHit[],
	input: { query: string; touchedPaths: string[] },
): DakeraRecallHit[] {
	const queryTokens = tokenizeTriggerQuery(input.query);
	return rows.filter(row => {
		const spec = parseDakeraTrigger(row.memory.metadata);
		return spec !== undefined && triggerMatches(spec, { queryTokens, touchedPaths: input.touchedPaths });
	});
}

/**
 * Paths from assistant tool calls named read/edit/write carrying a string
 * `arguments.path`; deduped, order of first appearance. Feeds the path
 * dimension of trigger matching for the current turn's recall.
 */
export function collectTouchedPaths(entries: readonly SessionEntry[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || TOUCHED_PATH_TOOLS[block.name] !== true) continue;
			const path = block.arguments.path;
			if (typeof path !== "string" || path.length === 0 || seen.has(path)) continue;
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}
