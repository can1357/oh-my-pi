/**
 * Session query/control layer for the future `/sessions` manager.
 *
 * `enumerateSessions` merges the persisted session listing (from
 * {@link listAllSessions}/{@link listSessions}) with in-process truth that is
 * knowable from this process only:
 *   - the current session file (via injected deps, mirroring the AgentHubDeps
 *     seam pattern),
 *   - live agent counts + pause state from the process-global registry/gate,
 *   - best-effort cost/token totals from the omp-stats DB,
 *   - git branch/dirty state at each session's `cwd` when cheaply resolvable,
 *   - an archive sentinel sidecar (`<sessionFile>.archived`) that never mutates
 *     the foreign JSONL.
 *
 * Cross-process control is out of scope: only the current session is "live" in
 * this process, so `liveState`/`agentCounts`/`model`/`profile` are populated
 * for it alone. Anything not knowable is left `undefined` — the UI renders
 * `—`, never a fabricated zero.
 *
 * Heavy best-effort reads (stats DB, git) are cached in-module keyed by
 * `path@mtime`; {@link clearSessionMetricsCache} forces a refresh.
 */

import { existsSync, statSync } from "node:fs";
import { getSessionSummaries as fetchSessionSummaries, type SessionSummary } from "@oh-my-pi/omp-stats";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { settings, type Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import { branch as gitBranch, status as gitStatusCmd } from "../utils/git";
import { listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import { FileSessionStorage } from "./session-storage";

const ARCHIVED_SENTINEL_SUFFIX = ".archived";

/** Minimal agent registry projection the layer reads. */
interface AgentRegistryLike {
	list(): Array<{ status: string }>;
}

/** Resolved git state for a working directory, or `undefined` when unavailable. */
export interface GitRepoStatus {
	branch: string | null;
	dirty: { staged: number; unstaged: number; untracked: number };
}

/**
 * Injected dependencies. Every field is optional and falls back to a production
 * default (process-global registry/gate, the live SessionManager, the omp-stats
 * DB, and a best-effort git resolver). Tests supply fakes to exercise the layer
 * without touching the real registry, DB, or filesystem. Only the seams the
 * contract requires are exposed: registry, gate, and current-session knowledge.
 */
export interface SessionControlDeps {
	/** Process-global agent registry (defaults to `AgentRegistry.global()`). */
	registry?: AgentRegistryLike;
	/** Process-global pause gate (defaults to `agentPauseGate`). */
	gate?: { readonly paused: boolean };
	/** Live current session: its file path + model. Production supplies the running AgentSession. */
	session?: { sessionFile?: string; model?: string };
	/** Explicit override for the current session file (alternative to `session`). */
	currentSessionFile?: string;
	/** Override for the active profile (defaults to `settings.getActiveProfile()`). */
	profile?: string;
}

/** A single enumerated session with merged in-process + best-effort metrics. */
export interface SessionRow {
	info: SessionInfo;
	isCurrent: boolean;
	archived: boolean;
	/** Only for sessions live in THIS process (currently: the current one). */
	liveState?: "streaming" | "idle" | "paused";
	/** Registry-derived agent counts (this process only). */
	agentCounts?: { running: number; idle: number; parked: number };
	/** provider/model-id, current session only unless trivially available. */
	model?: string;
	/** `settings.getActiveProfile()`, current session only. */
	profile?: string;
	/** Best-effort omp-stats DB totals, any session. */
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** Git branch at `info.cwd` when cheaply resolvable (`null` = detached). */
	branch?: string | null;
	dirty?: { staged: number; unstaged: number; untracked: number };
	/** From the checkpoint service; undefined when unavailable/disabled. */
	checkpointCount?: number;
}

export type SessionFilter = "current" | "active" | "paused" | "archived" | "all";
export type SessionSort = "recent" | "created" | "cost" | "agents";

export interface EnumerateOptions {
	cwd: string;
	sessionDir?: string;
	includeAllProjects?: boolean;
	/** Bounded race (ms) for the stats read; on timeout metrics stay undefined. */
	statsTimeoutMs?: number;
	/** Restrict the result set. Defaults to `"all"`. */
	filter?: SessionFilter;
	/** Order the result set. Defaults to `"recent"`. */
	sort?: SessionSort;
	/** Seams for testing and for callers that already hold live process state. */
	deps?: SessionControlDeps;
}

interface CachedRowMetrics {
	mtime: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	branch?: string | null;
	dirty?: { staged: number; unstaged: number; untracked: number };
	agentCounts?: { running: number; idle: number; parked: number };
	liveState?: "streaming" | "idle" | "paused";
}

/** In-module cache of best-effort metrics, keyed by `path@mtime`. */
const metricsCache = new Map<string, CachedRowMetrics>();

/** Drop cached best-effort metrics. Call after a known data change. */
export function clearSessionMetricsCache(): void {
	metricsCache.clear();
}

function getMtime(filePath: string): number {
	try {
		return statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

async function defaultGitResolver(cwd: string): Promise<GitRepoStatus | undefined> {
	try {
		const [summary, branchName] = await Promise.all([gitStatusCmd.summary(cwd), gitBranch.current(cwd)]);
		if (!summary && branchName === null) return undefined;
		return {
			branch: branchName,
			dirty: summary
				? { staged: summary.staged, unstaged: summary.unstaged, untracked: summary.untracked }
				: { staged: 0, unstaged: 0, untracked: 0 },
		};
	} catch {
		return undefined;
	}
}

function deriveLiveState(
	registry: AgentRegistryLike,
	gate: { readonly paused: boolean },
): "streaming" | "idle" | "paused" {
	if (gate.paused) return "paused";
	const anyRunning = registry.list().some(ref => ref.status === "running");
	return anyRunning ? "streaming" : "idle";
}

function countAgents(registry: AgentRegistryLike): { running: number; idle: number; parked: number } {
	const counts = { running: 0, idle: 0, parked: 0 };
	for (const ref of registry.list()) {
		if (ref.status === "running") counts.running++;
		else if (ref.status === "idle") counts.idle++;
		else if (ref.status === "parked") counts.parked++;
	}
	return counts;
}

async function fetchSummaryMap(timeoutMs?: number): Promise<Map<string, SessionSummary>> {
	try {
		let summaries: SessionSummary[];
		if (timeoutMs && timeoutMs > 0) {
			const raced = await Promise.race([
				fetchSessionSummaries(),
				new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs)),
			]);
			if (raced === undefined) return new Map();
			summaries = raced;
		} else {
			summaries = await fetchSessionSummaries();
		}
		const map = new Map<string, SessionSummary>();
		for (const summary of summaries) map.set(summary.sessionFile, summary);
		return map;
	} catch {
		return new Map();
	}
}

async function getBaseSessions(opts: EnumerateOptions): Promise<SessionInfo[]> {
	const storage = new FileSessionStorage();
	if (opts.sessionDir && !opts.includeAllProjects) {
		return listSessions(opts.sessionDir, storage);
	}
	return listAllSessions(storage);
}

/**
 * Enumerate sessions with merged in-process truth and best-effort metrics.
 *
 * Honors {@link EnumerateOptions.filter} and {@link EnumerateOptions.sort}.
 */
export async function enumerateSessions(opts: EnumerateOptions): Promise<SessionRow[]> {
	const deps = opts.deps ?? {};
	const registry: AgentRegistryLike = deps.registry ?? AgentRegistry.global();
	const gate = deps.gate ?? agentPauseGate;
	const currentSessionFile = deps.currentSessionFile ?? deps.session?.sessionFile ?? null;

	const baseSessions = await getBaseSessions(opts);
	const summaryMap = await fetchSummaryMap(opts.statsTimeoutMs);

	const rows: SessionRow[] = [];
	for (const info of baseSessions) {
		const isCurrent = currentSessionFile !== null && info.path === currentSessionFile;
		const archived = isArchived(info.path);
		const mtime = getMtime(info.path);
		const cacheKey = `${info.path}@${mtime}`;
		const cached = metricsCache.get(cacheKey);

		let cost: number | undefined;
		let tokensIn: number | undefined;
		let tokensOut: number | undefined;
		let branch: string | null | undefined;
		let dirty: { staged: number; unstaged: number; untracked: number } | undefined;
		let agentCounts: { running: number; idle: number; parked: number } | undefined;
		let liveState: "streaming" | "idle" | "paused" | undefined;

		if (cached && cached.mtime === mtime) {
			cost = cached.cost;
			tokensIn = cached.tokensIn;
			tokensOut = cached.tokensOut;
			branch = cached.branch;
			dirty = cached.dirty;
			agentCounts = cached.agentCounts;
			liveState = cached.liveState;
		} else {
			const summary = summaryMap.get(info.path);
			if (summary) {
				cost = summary.cost;
				tokensIn = summary.inputTokens;
				tokensOut = summary.outputTokens;
			}
			if (info.cwd) {
				const git = await defaultGitResolver(info.cwd);
				if (git) {
					branch = git.branch;
					dirty = git.dirty;
				}
			}
			if (isCurrent) {
				liveState = deriveLiveState(registry, gate);
				agentCounts = countAgents(registry);
			}
			metricsCache.set(cacheKey, {
				mtime,
				cost,
				tokensIn,
				tokensOut,
				branch,
				dirty,
				agentCounts,
				liveState,
			});
		}

		const row: SessionRow = {
			info,
			isCurrent,
			archived,
			liveState,
			agentCounts,
			cost,
			tokensIn,
			tokensOut,
			branch,
			dirty,
		};

		if (isCurrent) {
			if (deps.session?.model !== undefined) row.model = deps.session.model;
			const settingsWithProfile = settings as Settings & { getActiveProfile?: () => string };
			const profile = deps.profile ?? (typeof settingsWithProfile.getActiveProfile === "function"
				? settingsWithProfile.getActiveProfile()
				: undefined);
			if (profile) row.profile = profile;
		}

		rows.push(row);
	}

	return applySort(applyFilter(rows, opts.filter ?? "all"), opts.sort ?? "recent");
}

function applyFilter(rows: SessionRow[], filter: SessionFilter): SessionRow[] {
	switch (filter) {
		case "current":
			return rows.filter(row => row.isCurrent);
		case "archived":
			return rows.filter(row => row.archived);
		case "paused":
			return rows.filter(row => row.liveState === "paused");
		case "active":
			return rows.filter(row => !row.archived);
		default:
			return rows;
	}
}

function applySort(rows: SessionRow[], sort: SessionSort): SessionRow[] {
	const copy = [...rows];
	switch (sort) {
		case "created":
			copy.sort((a, b) => b.info.created.getTime() - a.info.created.getTime());
			break;
		case "cost":
			copy.sort((a, b) => (b.cost ?? -Infinity) - (a.cost ?? -Infinity));
			break;
		case "agents": {
			const total = (c: { running: number; idle: number; parked: number } | undefined) =>
				c ? c.running + c.idle + c.parked : 0;
			copy.sort((a, b) => total(b.agentCounts) - total(a.agentCounts));
			break;
		}
		default:
			copy.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
			break;
	}
	return copy;
}

/**
 * Write or remove the archive sentinel for a session. The sentinel is an empty
 * sidecar file `<sessionFile>.archived`; the JSONL is never mutated, so the
 * operation is cross-process safe and reversible.
 */
export async function setArchived(sessionPath: string, archived: boolean): Promise<void> {
	const sentinel = sessionPath + ARCHIVED_SENTINEL_SUFFIX;
	if (archived) {
		await Bun.write(sentinel, "");
	} else {
		await Bun.file(sentinel).delete();
	}
}

/** Whether the archive sentinel exists for a session. */
export function isArchived(sessionPath: string): boolean {
	return existsSync(sessionPath + ARCHIVED_SENTINEL_SUFFIX);
}
