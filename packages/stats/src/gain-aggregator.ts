/**
 * Aggregates token-savings data for the Gain dashboard.
 *
 * Source:
 *   1. Snapcompact: colocated with stats.db as snapcompact-savings.jsonl
 *
 * Missing files are treated as zero records — never an error.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getStatsDbPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getTimeRangeConfig } from "./aggregator";
import { initDb } from "./db";
import type { GainDashboardStats, GainSourceTotals, GainTimeSeriesPoint } from "./shared-types";

const BYTES_PER_TOKEN_ESTIMATE = 4;
const SQLITE_VARIABLE_CHUNK_SIZE = 500;

// Paths that carry no dashboard signal — temp/internal locations.
const TEMP_PATH_RE = /(?:^|\/)(?:T|tmp|pi-bash-exec|omp-bash-exec|pi-bash-detach)(?:\/|$)|^\/var\/folders(?:\/|$)/;

// ---------------------------------------------------------------------------
// Project-match helper
// ---------------------------------------------------------------------------

function canonicalProjectPath(p: string): string {
	const normalized = p.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized || "/";
}

/** True when `candidate` exactly equals `parent` or is a separator-bounded sub-path. */
function isSameOrSubPath(candidate: string, parent: string): boolean {
	const normalizedCandidate = canonicalProjectPath(candidate);
	const normalizedParent = canonicalProjectPath(parent);
	return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

/**
 * True when `cwd` (or its normalized project root) exactly equals `project`
 * or is a direct sub-path of it.
 *
 * Normalization is applied so that a cwd of `/repo/.worktrees/lane/src`
 * matches a project root of `/repo` — the selector shows normalized roots, so
 * the filter must compare apples-to-apples.
 */
function matchesProject(cwd: string | undefined, project: string): boolean {
	if (!cwd) return false;
	const normalizedCwd = normalizeProjectPath(cwd) ?? canonicalProjectPath(cwd);
	const normalizedProject = normalizeProjectPath(project) ?? canonicalProjectPath(project);
	return isSameOrSubPath(normalizedCwd, normalizedProject) || isSameOrSubPath(cwd, normalizedProject);
}

// ---------------------------------------------------------------------------
// Project normalization & deduplication
// ---------------------------------------------------------------------------

/**
 * Collapse conventional worktree sub-paths to their logical project root.
 *
 * Rules are generic: omp internal wt paths are dropped; conventional worktree
 * suffixes (`.wt/`, `-wt/`, `.worktrees/`, `-worktrees/`) are stripped. No
 * author-specific IDE or tool paths are baked in.
 *
 * Returns null to drop temp/internal paths entirely.
 */
export function normalizeProjectPath(p: string): string | null {
	const clean = canonicalProjectPath(p);
	if (TEMP_PATH_RE.test(clean)) return null;
	if (/\/\.omp\/wt\//u.test(clean)) return null;

	const worktreePatterns = [
		/^(.+)\/\.wt\/[^/]+(?:\/.*)?$/u,
		/^(.+)\/\.worktrees\/[^/]+(?:\/.*)?$/u,
		/^(.+)-wt\/[^/]+(?:\/.*)?$/u,
		/^(.+)-worktrees\/[^/]+(?:\/.*)?$/u,
		/^(.+)\.wt\/[^/]+(?:\/.*)?$/u,
	];
	for (const pattern of worktreePatterns) {
		const match = clean.match(pattern);
		if (match?.[1]) return canonicalProjectPath(match[1]);
	}

	return clean;
}

/**
 * Given a raw set of paths, normalize worktree paths and remove sub-paths
 * that are already covered by a shorter parent at depth ≥ 4.
 * Returns a sorted, deduped list of meaningful project roots.
 */
export function dedupeProjects(rawPaths: Set<string>): string[] {
	const normalized = new Set<string>();
	for (const p of rawPaths) {
		const n = normalizeProjectPath(p);
		if (n) normalized.add(n);
	}
	const sorted = Array.from(normalized).sort();
	return sorted.filter(p => {
		return !sorted.some(
			other =>
				other !== p &&
				other.length < p.length &&
				isSameOrSubPath(p, other) &&
				other.split("/").filter(Boolean).length >= 4,
		);
	});
}

// ---------------------------------------------------------------------------
// Snapcompact record schema
// ---------------------------------------------------------------------------

interface SnapcompactRecord {
	ts: number; // epoch ms
	session: string;
	provider: string;
	model: string;
	toolCallId: string;
	savedTokens: number;
}

interface SnapcompactSets {
	records: SnapcompactRecord[];
	projects: Set<string>;
}

async function readProjectsBySession(sessions: readonly string[]): Promise<Map<string, Set<string>>> {
	const uniqueSessions = Array.from(new Set(sessions.filter(Boolean)));
	const projectsBySession = new Map<string, Set<string>>();
	if (uniqueSessions.length === 0) return projectsBySession;

	const database = await initDb();
	for (let i = 0; i < uniqueSessions.length; i += SQLITE_VARIABLE_CHUNK_SIZE) {
		const chunk = uniqueSessions.slice(i, i + SQLITE_VARIABLE_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const rows = database
			.prepare(`SELECT DISTINCT session_file, folder FROM messages WHERE session_file IN (${placeholders})`)
			.all(...chunk) as Array<{ session_file: string; folder: string }>;
		for (const row of rows) {
			if (!row.folder) continue;
			let projects = projectsBySession.get(row.session_file);
			if (!projects) {
				projects = new Set<string>();
				projectsBySession.set(row.session_file, projects);
			}
			projects.add(row.folder);
		}
	}
	return projectsBySession;
}

interface SnapcompactCache {
	key: string;
	records: SnapcompactRecord[];
}

let snapcompactCache: SnapcompactCache | undefined;

async function readSnapcompactRecords(cutoff: number | null, project: string | null): Promise<SnapcompactSets> {
	const filePath = path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl");

	let stat: Stats;
	try {
		stat = await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) return { records: [], projects: new Set() };
		logger.debug("gain-aggregator: failed to stat snapcompact-savings.jsonl", { err: String(err) });
		return { records: [], projects: new Set() };
	}

	const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
	let parsed: SnapcompactRecord[];
	if (snapcompactCache?.key === cacheKey) {
		parsed = snapcompactCache.records;
	} else {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch (readErr) {
			if (isEnoent(readErr)) return { records: [], projects: new Set() };
			logger.debug("gain-aggregator: failed to read snapcompact-savings.jsonl", { err: String(readErr) });
			return { records: [], projects: new Set() };
		}

		parsed = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as SnapcompactRecord;
				parsed.push(rec);
			} catch {
				/* skip malformed line */
			}
		}
		snapcompactCache = { key: cacheKey, records: parsed };
	}

	const filtered = cutoff === null ? parsed : parsed.filter(rec => rec.ts >= cutoff);
	const seen = new Set<string>();
	const deduped: SnapcompactRecord[] = [];
	for (const rec of filtered) {
		const key = `${rec.session}:${rec.toolCallId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(rec);
	}
	const projectsBySession = await readProjectsBySession(deduped.map(rec => rec.session));
	const projects = new Set<string>();
	const records: SnapcompactRecord[] = [];
	for (const rec of deduped) {
		const sessionProjects = projectsBySession.get(rec.session);
		if (sessionProjects) {
			for (const sessionProject of sessionProjects) projects.add(sessionProject);
		}
		if (project !== null) {
			if (
				!sessionProjects ||
				!Array.from(sessionProjects).some(sessionProject => matchesProject(sessionProject, project))
			) {
				continue;
			}
		}
		records.push(rec);
	}

	return { records, projects };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function emptyTotals(): GainSourceTotals {
	return {
		savedTokens: 0,
		savedBytes: 0,
		hits: 0,
		outputBytes: 0,
		originalBytes: 0,
		reductionPercent: null,
	};
}

/** ISO date string from epoch ms, bucketed to the day. */
function toDateBucket(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export async function getGainDashboardStats(
	range?: string | null,
	project?: string | null,
): Promise<GainDashboardStats> {
	const { cutoff: effectiveCutoff } = getTimeRangeConfig(range);
	const effectiveProject: string | null = project?.trim() || null;

	const { records: snapcompactRecords, projects: snapcompactProjects } = await readSnapcompactRecords(
		effectiveCutoff,
		effectiveProject,
	);

	const snapcompactTotals = emptyTotals();
	const timeMap = new Map<string, { snapcompact: number }>();

	for (const rec of snapcompactRecords) {
		snapcompactTotals.savedTokens += rec.savedTokens;
		const approxBytes = rec.savedTokens * BYTES_PER_TOKEN_ESTIMATE;
		snapcompactTotals.savedBytes += approxBytes;
		snapcompactTotals.hits += 1;

		const date = toDateBucket(rec.ts);
		const bucket = timeMap.get(date) ?? { snapcompact: 0 };
		bucket.snapcompact += rec.savedTokens;
		timeMap.set(date, bucket);
	}
	// No originalBytes for snapcompact — reductionPercent stays null.

	const overall: GainSourceTotals = {
		savedTokens: snapcompactTotals.savedTokens,
		savedBytes: snapcompactTotals.savedBytes,
		hits: snapcompactTotals.hits,
		outputBytes: 0,
		originalBytes: 0,
		reductionPercent: null,
	};

	const timeSeries: GainTimeSeriesPoint[] = Array.from(timeMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bucket]) => ({
			date,
			snapcompact: bucket.snapcompact,
			total: bucket.snapcompact,
		}));

	const projects = dedupeProjects(snapcompactProjects);

	return {
		overall,
		bySource: {
			snapcompact: snapcompactTotals,
		},
		timeSeries,
		project: effectiveProject,
		projects,
	};
}
