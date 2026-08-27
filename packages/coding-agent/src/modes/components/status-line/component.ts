import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import {
	type Component,
	type ComposerStyle,
	claudeComposerStyle,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { adjustHsv, formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import { settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import * as jj from "../../../utils/jj";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { calculateTokensPerSecond } from "../../../utils/token-rate";
import { sanitizeStatusText } from "../../shared";
import { theme } from "../../theme/theme";
import { type CompactionBoundaries, computeCompactionBoundaries } from "../../utils/context-usage";
import {
	type CodexResetFireworksEvent,
	type CodexResetUsageSnapshot,
	detectCodexResetFireworks,
} from "../codex-reset-fireworks";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { getPreset } from "./presets";
import { renderSegment, type SegmentContext } from "./segments";
import { getSeparator } from "./separators";
import type {
	CollabStatus,
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

const JJ_REFRESH_TTL_MS = 5000;
const WATCHER_FAILURE_POLL_TTL_MS = 5000;

/** A displayable limit after provider, account, model, and window filtering. */
interface UsageWindowCandidate {
	id?: string;
	windowClass: "5h" | "7d" | "monthly";
	fraction: number;
	resetsAt?: number;
}

/** Limits sharing one model/tier scope, ranked as an indivisible display unit. */
interface UsageScopeGroup {
	priority: number;
	tier?: string;
	candidates: UsageWindowCandidate[];
}

function normalizeUsageScopeValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Fireworks are stateful, so their report match must be stricter than the
 * status display's fallback matching: every known credential identifier must
 * be present and equal or a workspace sibling can mutate this account's
 * baseline.
 */
function codexReportMatchesExactIdentity(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	const accountId = normalizeUsageScopeValue(identity.accountId);
	const email = normalizeUsageScopeValue(identity.email);
	const projectId = normalizeUsageScopeValue(identity.projectId);
	const orgId = normalizeUsageScopeValue(identity.orgId);
	if (!accountId && !email && !projectId && !orgId) return false;

	const metadata = report.metadata ?? {};
	const reportAccountId =
		normalizeUsageScopeValue(metadata.accountId) ?? normalizeUsageScopeValue(metadata.account_id);
	const reportProjectId =
		normalizeUsageScopeValue(metadata.projectId) ?? normalizeUsageScopeValue(metadata.project_id);
	if (accountId && reportAccountId !== accountId) return false;
	if (email && normalizeUsageScopeValue(metadata.email) !== email) return false;
	if (projectId && reportProjectId !== projectId) return false;
	if (orgId && normalizeUsageScopeValue(metadata.orgId) !== orgId) return false;
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Context-usage memo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cheap structural fingerprint of a message's tokenizable content. O(blocks) —
 * only reads string `.length` and primitives, never copies or serializes.
 * Detects in-place growth of the streaming tail (and other in-place mutations)
 * so the cached `getContextUsage()` result is recomputed when — and only when —
 * the numbers it depends on change.
 */
function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const usageExt = assistantMsg.usage as unknown as { promptTokensDetails?: unknown };
		const usageTotal = assistantMsg.usage?.totalTokens ?? 0;
		const promptBuckets = usageExt?.promptTokensDetails ? 1 : 0;
		const stopReason = assistantMsg.stopReason ?? "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		const thinkingSignature = msgExt.thinkingSignature;
		if (typeof thinkingSignature === "string") {
			signatureLen += thinkingSignature.length;
		}
		const textSignature = msgExt.textSignature;
		if (typeof textSignature === "string") {
			signatureLen += textSignature.length;
		}
		const thoughtSignature = msgExt.thoughtSignature;
		if (typeof thoughtSignature === "string") {
			signatureLen += thoughtSignature.length;
		}
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") {
			redactedLen += redactedData.length;
		}

		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as {
					type?: string;
					text?: string;
					thinking?: string;
					thinkingSignature?: string;
					signature?: string;
					textSignature?: string;
					thoughtSignature?: string;
					data?: string;
					name?: string;
					arguments?: unknown;
				};
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking") {
					if (typeof b.thinking === "string") textLen += b.thinking.length;
					if (typeof b.thinkingSignature === "string") signatureLen += b.thinkingSignature.length;
					if (typeof b.signature === "string") signatureLen += b.signature.length;
					if (typeof b.textSignature === "string") signatureLen += b.textSignature.length;
					if (typeof b.thoughtSignature === "string") signatureLen += b.thoughtSignature.length;
				} else if (b.type === "redactedThinking" && typeof b.data === "string") {
					redactedLen += b.data.length;
				} else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					if (b.arguments !== undefined) {
						try {
							textLen += JSON.stringify(b.arguments, (_key, value) =>
								typeof value === "bigint" ? value.toString() : value,
							).length;
						} catch {
							textLen += String(b.arguments).length;
						}
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${promptBuckets}:${stopReason}`;
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly any[] | undefined;
	skillsRef: readonly any[] | undefined;
}

interface ActiveRepoCache {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	/** Project + worktree dir name when `projectDir` is a linked worktree, else null. */
	worktree: WorktreeContext | null;
}

interface BranchResolveRequest {
	id: number;
	cwd: string;
	controller: AbortController;
}

interface JjResolveRequest {
	id: number;
	controller: AbortController;
}

interface WorktreeContext {
	/** Primary-checkout (project) name shown by the path segment. */
	projectName: string;
	/** Worktree directory name — suppressed from the path when it equals the branch. */
	worktreeName: string;
}

/**
 * Project + worktree-dir names when `cwd` is a linked git worktree, else null.
 * The project name comes from the shared primary checkout; bare-repo worktrees
 * resolve to the shared `foo.git` dir, so a trailing `.git` is stripped.
 */
function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

/**
 * Per-{@link AgentSession} active-processing meter for the `time_spent`
 * segment. `activeMs` is the union of every completed `agent_start`→
 * `agent_end` window; `activeStartedAt` is the start timestamp of the
 * currently-running window, or `null` when idle.
 *
 * `sessionFile` snapshots the loaded session-file path at meter-creation
 * time. `AgentSession.switchSession` (/resume, /move, ACP fork, RPC
 * `switch_session`, extension `switchSession`) mutates the loaded file
 * under the same {@link AgentSession} ref, so the WeakMap key alone
 * cannot tell two conversations apart. `#meter()` compares this snapshot
 * against the live `session.sessionFile`, and a real-to-real change
 * starts the meter fresh instead of crediting the new conversation with
 * the previous one's accumulated active time. The undefined → real
 * first-save transition does not reset, since the session identity has
 * not changed.
 */
interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	sessionFile: string | undefined;
}

const EMPTY_MESSAGES: readonly AgentMessage[] = [];
const STATUS_USAGE_START_DELAY_MS = 0;
const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

function isContextSegment(segment: StatusLineSegmentId): boolean {
	return segment === "context_pct" || segment === "context_total";
}

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}

function hasNonContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	for (const segment of segments) {
		if (!isContextSegment(segment)) return true;
	}
	return false;
}

function removeContextSegments(parts: string[], segments: StatusLineSegmentId[]): void {
	let writeIndex = 0;
	for (let readIndex = 0; readIndex < segments.length; readIndex++) {
		const segment = segments[readIndex];
		if (isContextSegment(segment)) continue;
		parts[writeIndex] = parts[readIndex];
		segments[writeIndex] = segment;
		writeIndex++;
	}
	parts.length = writeIndex;
	segments.length = writeIndex;
}

function formatEmbeddedContextPercent(percent: number): string {
	return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}
function hasGitSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("git");
}

function hasPrSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("pr");
}
function hasPathSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("path");
}

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#standalone: false | "full" | "left-only" = false;
	#standaloneGap = false;
	#autocompleteActiveProbe: (() => boolean) | undefined;
	#renderRevision = 0;
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#cachedBranchHasGitRepository = false;
	// In-flight reftable resolve slot. Ownership is the launch id, not the cwd:
	// two live resolves can share a cwd string across an invalidation, and a
	// stale one must never free (or poison) a slot it no longer owns.
	#branchResolveSeq = 0;
	#branchResolveActive: BranchResolveRequest | undefined = undefined;
	// Bumped on every branch-cache reset (#invalidateGitCaches — a HEAD move or
	// repo-context change). An in-flight reftable resolve captures this at
	// launch; a mismatch on resolve means the cache was invalidated underneath
	// it (a newer resolve superseded it), so its result is stale and must be
	// dropped rather than overwrite the value the newer resolve committed.
	// Mirrors #jjCacheGeneration / #getJjBranch in this file.
	// Timestamp of the latest branch read; only bounds cache freshness when the
	// HEAD watcher could not be installed.
	#branchLastFetch: number | undefined = undefined;
	// Bumped on every branch-cache reset (invalidateGitCaches — a HEAD move or
	// repo-context change). An in-flight reftable resolve captures this at
	// launch; a mismatch on resolve means the cache was invalidated underneath
	// it (a newer resolve superseded it), so its result is stale and must be
	// dropped rather than overwrite the value the newer resolve committed.
	// Mirrors #jjCacheGeneration / #getJjBranch in this file.
	#branchCacheGeneration = 0;
	#gitUnwatch: (() => void) | null = null;
	#gitWatcherUnavailable = false;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	/** Pulse timer for the running-speculation indicator; live only while speculation runs. */
	#speculationBlinkTimer: NodeJS.Timeout | undefined;
	#speculationBlinkOn = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	/**
	 * Active-processing accounting for the `time_spent` segment, keyed per
	 * {@link AgentSession} so the focus-controller mid-turn attach path
	 * cannot leak an unmatched synthesized `agent_start` from a subagent
	 * into the main session's meter.
	 *
	 * Each meter is `{ activeMs, activeStartedAt }`: `activeMs` is the union
	 * of every completed `agent_start`→`agent_end` window since
	 * {@link resetActiveTime} last reset it; `activeStartedAt` is the start
	 * timestamp of the currently-running window (or `null` when idle).
	 * `getActiveMs()` returns `activeMs + (now - activeStartedAt)` for the
	 * currently-attached session, so the counter ticks live during a turn
	 * and freezes the instant the agent yields.
	 *
	 * WeakMap so meters die with their session (e.g. a parked subagent
	 * dropped from the registry); the main session's meter survives focus
	 * round-trips because the same {@link AgentSession} ref is reused.
	 */
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: SegmentContext["loopMode"] = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#vibeModeStatus: { enabled: boolean } | null = null;
	/**
	 * Injected aggregator that returns the aggregate tok/s of this session's
	 * live vibe worker sessions, or null when no workers are streaming. Kept as
	 * a callback so the render layer doesn't import the heavy vibe/task
	 * dependency graph; interactive-mode wires it to VibeSessionRegistry.
	 */
	#vibeWorkerTokenRate: (() => number | null) | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;
	#jjRoot: string | null | undefined = undefined;
	#jjRootCwd: string | undefined = undefined;
	#cachedJjBranch: string | null = null;
	#jjBranchLastFetch = 0;
	#jjResolveSeq = 0;
	#jjBranchActive: JjResolveRequest | undefined = undefined;
	#cachedJjStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#jjStatusLastFetch = 0;
	#jjStatusActive: JjResolveRequest | undefined = undefined;
	// Bumped on every jj-cache reset — a cwd switch (#jjRootFor) or a HEAD /
	// bookmark move (#invalidateGitCaches). An in-flight jj query captures this
	// at launch; a mismatch on resolve means the caches were reset underneath it
	// (including a reset that re-resolves to the SAME root, which a root-equality
	// check cannot detect), so the result is stale and must be dropped rather
	// than poison the fresh cache or advance its throttle.
	#jjCacheGeneration = 0;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchCwd: string | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	// Provider usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
		monthly?: { percent: number; resetHours?: number };
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
	// A timed-out request may still resolve. Its result remains eligible only
	// until a newer request has applied.
	#usageRefreshSequence = 0;
	#latestAppliedUsageRefreshSequence = 0;
	#codexResetSnapshots = new Map<string, CodexResetUsageSnapshot>();
	#onCodexResetFireworks: ((event: CodexResetFireworksEvent) => void) | undefined;
	// Context-usage memo. The status line redraws on every agent event, so the
	// hot path must not recompute context tokens unless an input changed.
	// `getContextUsage()` anchors on the last assistant's real prompt-token
	// count (matching the provider and the `/context` panel), so a stable
	// message list + model window yields a stable result we can return verbatim.
	#contextUsageCache: ContextUsageMemo | undefined;

	constructor(private session: AgentSession) {
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
			contextLine: settings.get("statusLine.contextLine"),
		};
	}

	#gitEnabled(): boolean {
		return settings.get("git.enabled");
	}
	#hasGitBackedSegment(): boolean {
		const effectiveSettings = this.#resolveSettings();
		return (
			hasGitBackedSegment(effectiveSettings.leftSegments) || hasGitBackedSegment(effectiveSettings.rightSegments)
		);
	}

	#resolveActiveRepoCache(): ActiveRepoCache {
		const projectDir = getProjectDir();
		if (this.#activeRepoCache?.projectDir === projectDir) {
			return this.#activeRepoCache;
		}

		const activeRepo = resolveActiveRepoContextSync(projectDir);
		const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
		// Only collapse the bare-cwd case: a single-direct-child-repo context
		// (activeRepo set) renders `<parent> ↳ <child>`, which we leave intact.
		const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd, worktree };
		return this.#activeRepoCache;
	}

	/**
	 * Re-point the status line at another session (focus proxy). Invalidate: model/context/usage all derive
	 * from it. `focusedAgentId` is the focused subagent id while the view is proxied, undefined for main.
	 */
	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.session = session;
		this.#focusedAgentId = focusedAgentId;
		if (sessionChanged) {
			this.#invalidateSessionCaches();
			this.#closeStaleActiveWindow();
		}
		this.invalidate();
	}

	/**
	 * Drop a meter's in-flight window when the newly-attached session is no
	 * longer streaming. Handles the case where the focus controller
	 * synthesized an `agent_start` on a mid-turn attach but the matching
	 * real `agent_end` never reached us — the user detached before it
	 * fired, and re-focusing later (after the agent finished) would
	 * otherwise tick over the entire detached gap. Crediting that gap to
	 * `activeMs` would be wrong (the agent finished at some point we never
	 * observed), so the window is dropped rather than folded in.
	 */
	#closeStaleActiveWindow(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		if (this.session.isStreaming) return;
		meter.activeStartedAt = null;
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
		this.#effectiveSettings = undefined;
		if (this.#onBranchChange) this.#setupGitWatcher();
	}

	getEffectiveSettingsForTest(): EffectiveStatusLineSettings {
		return this.#resolveSettings();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	/**
	 * Compatibility shim for callers predating the simplified subagent badge.
	 * The status line now intentionally shows only the active count.
	 */
	setSubagentHubHint(_hint: string | undefined): void {}

	/** Active subagent count as currently displayed (collab state mirroring). */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	/**
	 * Reset the currently-attached session's active-time accumulators so
	 * the `time_spent` segment starts from zero. Called from `/clear`,
	 * fresh-session, and joined-collab paths; both the completed
	 * accumulator and any in-flight window are dropped, so a reset
	 * mid-turn ignores the running window (the matching `markActivityEnd`
	 * will see an idle meter and no-op).
	 */
	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
	}

	/**
	 * Mark the currently-attached session as having started a unit of
	 * active processing. Idempotent: a second start while a window is
	 * already open is a no-op, so reentrant `agent_start` events (e.g.
	 * nested auto-compaction loops, focus-controller mid-turn attach onto
	 * an already-running window) do not double-count.
	 */
	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	/**
	 * Close the currently-attached session's open active-processing
	 * window, folding its elapsed time into the accumulator. Idempotent
	 * when the meter is already idle so callers can fire it on every
	 * `agent_end` without guarding.
	 */
	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		meter.activeMs += Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeStartedAt = null;
	}

	/**
	 * Snapshot of total active-processing time for the currently-attached
	 * session, including any in-flight window. Exposed for the segment
	 * context builder; tests assert against this too.
	 */
	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

	/**
	 * Return (lazily creating) the meter for the currently-attached
	 * session. Detects an in-place session-file swap under the same
	 * {@link AgentSession} ref (`switchSession` paths: `/resume`, `/move`,
	 * ACP fork/load, RPC `switch_session`, extension `switchSession`):
	 * a real-to-real change starts the meter fresh so the new
	 * conversation does not inherit the previous one's accumulated active
	 * time. The undefined → real first-save transition only refreshes the
	 * snapshot — the conversation identity has not changed.
	 */
	#meter(): ActiveMeter {
		const currentFile = this.session.sessionFile;
		let meter = this.#activeMeters.get(this.session);
		if (meter) {
			const switched =
				currentFile !== undefined && meter.sessionFile !== undefined && meter.sessionFile !== currentFile;
			if (switched) {
				meter = undefined;
			} else {
				meter.sessionFile = currentFile;
			}
		}
		if (!meter) {
			meter = { activeMs: 0, activeStartedAt: null, sessionFile: currentFile };
			this.#activeMeters.set(this.session, meter);
		}
		return meter;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: NonNullable<SegmentContext["loopMode"]> | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setVibeModeStatus(status: { enabled: boolean } | undefined): void {
		this.#vibeModeStatus = status ?? null;
	}

	/**
	 * Inject the aggregator that returns the aggregate tok/s of this session's
	 * live vibe worker sessions (null when no workers are streaming). Wired by
	 * interactive-mode, which owns the VibeSessionRegistry coupling, so the
	 * render layer stays off the heavy vibe/task dependency graph. Pass
	 * `undefined` to clear.
	 */
	setVibeWorkerTokenRateProvider(provider: (() => number | null) | undefined): void {
		this.#vibeWorkerTokenRate = provider ?? null;
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collabStatus = status;
	}

	/** Set the callback that presents detected Codex reset celebrations, or clear it with `undefined`. */
	setCodexResetFireworksHandler(handler: ((event: CodexResetFireworksEvent) => void) | undefined): void {
		this.#onCodexResetFireworks = handler;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		this.#retireGitWatcher();
		this.#gitWatcherUnavailable = false;

		if (!this.#gitEnabled() || !this.#hasGitBackedSegment()) {
			this.invalidateGitCaches();
			return;
		}

		const { effectiveGitCwd } = this.#resolveActiveRepoCache();
		const repository = git.repo.resolveSync(effectiveGitCwd);
		if (!repository) {
			// There is no path to watch yet. Cache the negative result only for the
			// fallback poll interval so a later `git init` becomes visible without
			// generic invalidations or a render-path probe on every paint.
			this.#gitWatcherUnavailable = true;
			return;
		}

		// git swaps HEAD via `HEAD.lock` + atomic rename. That both unlinks the
		// HEAD inode (freezing a file-bound `fs.watch` after the first switch —
		// issue #8412) and, on Bun/Linux, permanently wedges an inotify-backed
		// directory watch after the first rename event (oven-sh/bun#24875).
		// `git.head.watch` stat-polls the HEAD path (or the reftable dir), which
		// survives inode swaps on every platform. A vanished repo surfaces as a
		// stat change too, so there is no separate watcher error path.
		try {
			const unwatch = git.head.watch(repository, () => {
				if (this.#disposed || this.#gitUnwatch !== unwatch) return;
				this.invalidateGitCaches();
				this.#onBranchChange?.();
			});
			this.#gitUnwatch = unwatch;
		} catch {
			this.#gitWatcherUnavailable = true;
		}
	}

	#retireGitWatcher(): void {
		const unwatch = this.#gitUnwatch;
		this.#gitUnwatch = null;
		unwatch?.();
	}

	dispose(): void {
		this.#disposed = true;
		this.#branchResolveActive?.controller.abort();
		this.#branchResolveActive = undefined;
		this.#resetJjRequests();
		this.#onBranchChange = null;
		this.#stopSpeculationBlink();
		this.#clearUsageStartTimer();
		this.#onCodexResetFireworks = undefined;
		this.#codexResetSnapshots.clear();
		this.#retireGitWatcher();
	}

	/**
	 * Drive the context segment's pulse while a background speculative
	 * compaction runs: a slow toggle that invalidates and repaints through the
	 * same host callback async git/PR resolves use. Stops (and resets phase)
	 * the first render after speculation leaves the running state.
	 */
	#syncSpeculationBlink(state: "idle" | "running" | "armed"): void {
		if (state === "running" && !this.#disposed) {
			this.#speculationBlinkTimer ??= setInterval(() => {
				this.#speculationBlinkOn = !this.#speculationBlinkOn;
				this.invalidate();
				this.#onBranchChange?.();
			}, 600);
			return;
		}
		this.#stopSpeculationBlink();
	}

	#stopSpeculationBlink(): void {
		if (!this.#speculationBlinkTimer) return;
		clearInterval(this.#speculationBlinkTimer);
		this.#speculationBlinkTimer = undefined;
		this.#speculationBlinkOn = true;
	}

	#clearUsageStartTimer(): void {
		if (!this.#usageStartTimer) return;
		clearTimeout(this.#usageStartTimer);
		this.#usageStartTimer = null;
	}

	invalidate(): void {
		this.#renderRevision++;
		// Generic repaint invalidation (theme change, message event, model
		// switch, …). Must NOT abort or restart a live reftable HEAD/PR resolve:
		// the render path self-invalidates via cwd/context cache-miss checks, so
		// a generic paint only needs to re-render — not tear down in-flight VCS
		// work. Aborting here would fan out a new git subprocess on every agent
		// event, re-introducing the render-path spawn churn the async resolve
		// was designed to avoid. Explicit Git/repository invalidation (watcher
		// HEAD-move, cwd/repo switch) goes through {@link invalidateGitCaches}.
		// A tool may open, close, or merge a PR without moving HEAD. Expire the
		// settled PR context on ordinary activity while leaving HEAD work intact.
		this.#cachedPrContext = undefined;
	}
	#invalidateSessionCaches(): void {
		this.#clearUsageStartTimer();
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#contextUsageCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondTimestamp = null;
	}

	/**
	 * Explicit Git/repository cache invalidation. Aborts any in-flight
	 * reftable HEAD/PR resolve, bumps the stale-result generation, and drops
	 * the branch/PR/jj caches so the next render refetches from disk. Called
	 * by the git watcher on a HEAD move and by {@link applyCwdChange} on a
	 * repo/cwd switch. Generic repaints use {@link invalidate} instead and
	 * must never reach this path.
	 */
	invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedBranchHasGitRepository = false;
		// Abort before releasing the in-flight slot. Releasing alone would allow
		// repeated invalidations to fan out still-running git subprocesses.
		this.#branchResolveActive?.controller.abort();
		this.#branchResolveActive = undefined;
		this.#branchLastFetch = undefined;
		this.#branchCacheGeneration++;
		this.#cachedPrContext = undefined;
		// jj label/status share the git segment's lifecycle: a HEAD move (e.g. a
		// colocated `jj new`/bookmark move) must drop the throttled jj caches too,
		// mirroring #jjRootFor's per-cwd reset so the next render refetches.
		this.#resetJjRequests();
		this.#jjRoot = undefined;
		this.#jjRootCwd = undefined;
		this.#cachedJjBranch = null;
		this.#jjBranchLastFetch = 0;
		this.#cachedJjStatus = null;
		this.#jjStatusLastFetch = 0;
		this.#jjCacheGeneration++;
	}

	/**
	 * Re-point the status line's VCS watcher and caches at a new cwd/repository.
	 * Atomically retires the old watcher/listeners, invalidates VCS caches and
	 * in-flight controllers, then runs watcher setup for the new cwd and requests
	 * a repaint. Called by {@link InteractiveMode.applyCwdChange} after the
	 * SessionManager's cwd has moved — the watcher ownership always follows the
	 * effective cwd/repo, so a stale watcher for the previous repo can never
	 * invalidate the new one. Generic repaints use {@link invalidate} and must
	 * never retire the watcher or abort a live resolve.
	 */
	applyCwdChange(): void {
		this.#retireGitWatcher();
		this.invalidateGitCaches();
		this.#setupGitWatcher();
		this.#onBranchChange?.();
	}

	#resetJjRequests(): void {
		this.#jjBranchActive?.controller.abort();
		this.#jjBranchActive = undefined;
		this.#jjStatusActive?.controller.abort();
		this.#jjStatusActive = undefined;
	}
	#getCurrentBranch(effectiveGitCwd?: string): string | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const fallbackCacheExpired =
			this.#gitWatcherUnavailable &&
			(this.#branchLastFetch === undefined || Date.now() - this.#branchLastFetch >= WATCHER_FAILURE_POLL_TTL_MS);
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === gitCwd && !fallbackCacheExpired) {
			return this.#cachedBranch;
		}

		// A reftable repo resolves HEAD by spawning `git symbolic-ref` +
		// `git rev-parse` — the unbounded spawn that froze the render path (F7).
		// A non-reftable repo resolves HEAD with cheap sync filesystem reads, so
		// only the reftable branch moves off the render path, mirroring
		// #getGitStatus and #getJjBranch in this file.
		const repository = git.repo.resolveSync(gitCwd);
		if (repository && git.repo.isReftableSync(repository)) {
			if (this.#branchResolveActive !== undefined) {
				return this.#branchResolveActive.cwd === gitCwd && this.#cachedBranchCwd === gitCwd
					? (this.#cachedBranch ?? null)
					: null;
			}
			const request: BranchResolveRequest = {
				id: ++this.#branchResolveSeq,
				cwd: gitCwd,
				controller: new AbortController(),
			};
			this.#branchResolveActive = request;
			// Capture the cache generation at launch. invalidateGitCaches bumps it
			// on a HEAD move and clears the in-flight slot, so a fresher resolve can
			// start while this one is still pending. Without a generation check the
			// older resolve would finish later, install its stale HEAD, and clear the
			// slot — dropping the fresh result and freezing the status line on the
			// pre-change branch. Mirrors #jjCacheGeneration / #getJjBranch.
			const generation = this.#branchCacheGeneration;
			(async () => {
				let next: string | null = null;
				let repoId: string | null = null;
				try {
					const headState = await git.head.resolve(gitCwd, request.controller.signal);
					repoId = headState?.headPath ?? null;
					next = !headState
						? null
						: headState.kind === "ref"
							? (headState.branchName ?? headState.ref)
							: "detached";
				} catch {
					next = null;
				} finally {
					// Release the slot only if this resolve still owns it: after an
					// invalidation a fresher resolve may hold it, and freeing that
					// slot here would let a third same-generation resolve launch and
					// race the fresh one to the cache commit.
					if (this.#branchResolveActive?.id === request.id) this.#branchResolveActive = undefined;
				}
				// Only the latest generation may update the cache; a mismatch means a
				// newer resolve superseded this one (or the component disposed).
				if (this.#branchCacheGeneration !== generation || this.#disposed) return;
				const prev = this.#cachedBranchCwd === gitCwd ? this.#cachedBranch : undefined;
				this.#cachedBranchCwd = gitCwd;
				this.#cachedBranchRepoId = repoId;
				this.#cachedBranchHasGitRepository = next === null;
				this.#cachedBranch = next;
				this.#branchLastFetch = Date.now();
				if (prev !== next && this.#onBranchChange) this.#onBranchChange();
			})();
			return this.#cachedBranchCwd === gitCwd ? (this.#cachedBranch ?? null) : null;
		}

		// Non-reftable: cheap sync filesystem read, safe on the render path.
		const head = git.head.resolveSync(gitCwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = gitCwd;
		this.#cachedBranchRepoId = gitHeadPath;
		this.#branchLastFetch = Date.now();
		if (!head) {
			this.#cachedBranch = null;
			return null;
		}
		this.#cachedBranch = head.kind === "ref" ? (head.branchName ?? head.ref) : "detached";
		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string, effectiveGitCwd: string): boolean {
		if (this.#defaultBranchCwd !== effectiveGitCwd) {
			this.#defaultBranch = undefined;
			this.#defaultBranchCwd = effectiveGitCwd;
		}

		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			const lookupCwd = effectiveGitCwd;
			(async () => {
				const resolved = await git.branch.default(lookupCwd);
				if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(effectiveGitCwd?: string): { staged: number; unstaged: number; untracked: number } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#gitStatusInFlightCwd !== undefined) {
			return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
		}
		if (this.#cachedGitStatusCwd === gitCwd && Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlightCwd = gitCwd;

		(async () => {
			let nextStatus: { staged: number; unstaged: number; untracked: number } | null = null;
			try {
				nextStatus = await git.status.summary(gitCwd);
			} catch {
				nextStatus = null;
			} finally {
				if (this.#gitStatusInFlightCwd === gitCwd) {
					const prev = this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
					if (!this.#disposed && this.#onBranchChange && JSON.stringify(prev) !== JSON.stringify(nextStatus)) {
						this.#onBranchChange();
					}
				}
			}
		})();

		return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
	}

	// Resolve (and cache per cwd) the jj workspace root, resetting both jj caches
	// on a cwd change so a directory switch refetches label + status.
	#jjRootFor(cwd: string): string | null {
		if (this.#jjRoot === undefined || this.#jjRootCwd !== cwd) {
			this.#jjRootCwd = cwd;
			this.#jjRoot = jj.repo.rootSync(cwd);
			this.#cachedJjBranch = null;
			this.#jjBranchLastFetch = 0;
			this.#cachedJjStatus = null;
			this.#jjStatusLastFetch = 0;
			this.#jjCacheGeneration++;
		}
		return this.#jjRoot;
	}

	// jj working-copy bookmark label (nearest bookmark, change-id fallback), shown
	// in the `git` segment where git HEAD is detached/absent under jj. Throttled,
	// cached, and repaints on resolve.
	#getJjBranch(effectiveGitCwd?: string): string | null {
		const cwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const root = this.#jjRootFor(cwd);
		if (!root) return null;
		if (this.#jjBranchActive || Date.now() - this.#jjBranchLastFetch < JJ_REFRESH_TTL_MS) {
			return this.#cachedJjBranch;
		}
		const request: JjResolveRequest = {
			id: ++this.#jjResolveSeq,
			controller: new AbortController(),
		};
		this.#jjBranchActive = request;
		const generation = this.#jjCacheGeneration;
		(async () => {
			let next: string | null = null;
			try {
				next = await jj.workingCopy.label(root, {
					signal: request.controller.signal,
					timeoutMs: jj.JJ_COMMAND_TIMEOUT_MS,
				});
			} finally {
				if (this.#jjBranchActive?.id === request.id) this.#jjBranchActive = undefined;
				// Advance the throttle only if no reset raced this query; a reset
				// leaves LastFetch at 0 so the current root refetches instead of
				// being throttled on a superseded result.
				if (this.#jjCacheGeneration === generation) this.#jjBranchLastFetch = Date.now();
			}
			// Drop a result whose caches were reset mid-flight — a repo switch OR a
			// same-root HEAD/bookmark move — so a superseded label never lands in
			// the live cache.
			if (this.#jjCacheGeneration !== generation || this.#disposed) return;
			const changed = next !== this.#cachedJjBranch;
			this.#cachedJjBranch = next;
			if (changed) this.#onBranchChange?.();
		})();
		return this.#cachedJjBranch;
	}

	// jj working-copy status counts (`@` vs its parent), used in place of git
	// status in a jj repo where `git status` has no `.git` to read. Throttled,
	// cached, and repaints on resolve like #getJjBranch.
	#getJjStatus(effectiveGitCwd?: string): { staged: number; unstaged: number; untracked: number } | null {
		const cwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const root = this.#jjRootFor(cwd);
		if (!root) return null;
		if (this.#jjStatusActive || Date.now() - this.#jjStatusLastFetch < JJ_REFRESH_TTL_MS) {
			return this.#cachedJjStatus;
		}
		const request: JjResolveRequest = {
			id: ++this.#jjResolveSeq,
			controller: new AbortController(),
		};
		this.#jjStatusActive = request;
		const generation = this.#jjCacheGeneration;
		(async () => {
			let next: { staged: number; unstaged: number; untracked: number } | null = null;
			try {
				next = await jj.status.summary(root, {
					signal: request.controller.signal,
					timeoutMs: jj.JJ_COMMAND_TIMEOUT_MS,
				});
			} finally {
				if (this.#jjStatusActive?.id === request.id) this.#jjStatusActive = undefined;
				if (this.#jjCacheGeneration === generation) this.#jjStatusLastFetch = Date.now();
			}
			if (this.#jjCacheGeneration !== generation || this.#disposed) return;
			const prev = this.#cachedJjStatus;
			this.#cachedJjStatus = next;
			if (JSON.stringify(prev) !== JSON.stringify(next)) this.#onBranchChange?.();
		})();
		return this.#cachedJjStatus;
	}

	#lookupPr(effectiveGitCwd?: string): { number: number; url: string } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const branch = this.#getCurrentBranch(gitCwd);
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		if (!branch) {
			this.#cachedPr = null;
			this.#cachedPrContext = undefined;
			return null;
		}

		// Don't look up if detached, default branch, or already in flight.
		if (branch === "detached" || this.#isDefaultBranch(branch, gitCwd) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const lookupCwd = gitCwd;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch(lookupCwd);
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Route through the shared `gh` helper so the child inherits
				// `GH_NON_INTERACTIVE_ENV` (disables terminal/keychain prompts) and
				// hard-terminates on the git command deadline instead of stalling
				// the status-line indefinitely (#4234). Requires `gh repo set-default`;
				// non-zero exit still falls through to the null cache below.
				const result = await git.github.run(
					lookupCwd,
					["pr", "view", "--json", "number,url"],
					AbortSignal.timeout(git.GIT_COMMAND_TIMEOUT_MS),
				);
				if (this.#disposed) return;
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				if (this.#disposed) return;
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (!this.#disposed && this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		// Aggregate tok/s across the main session AND every live vibe worker.
		// In vibe mode the director is often idle while workers stream, so the
		// main session's own rate alone would show a stale/zero value while
		// parallel work is actively generating tokens.
		const workerRate = this.#getVibeWorkerTokensPerSecond();
		if (workerRate !== null) {
			// At least one worker is streaming — add the director's live rate
			// only when it is itself streaming (a finalized last-turn rate would
			// double-count and overstate throughput).
			const mainRate = this.session.isStreaming ? calculateTokensPerSecond(this.session.state.messages, true) : 0;
			return (mainRate ?? 0) + workerRate;
		}

		// No workers streaming — fall back to the main session's own rate with
		// its sticky per-assistant-message cache so the badge doesn't flicker
		// off in the brief gap between stream end and the finalized message.
		return this.#getMainSessionTokensPerSecond();
	}

	/**
	 * Main session's tok/s with sticky caching keyed on the last assistant
	 * message timestamp. Preserves the pre-aggregation behavior when no vibe
	 * workers are active.
	 */
	#getMainSessionTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	/**
	 * Aggregate tok/s across every live vibe worker session owned by this
	 * session. Returns null when no workers are streaming (so the main
	 * session's own rate shines through unchanged). The aggregation itself is
	 * injected via {@link setVibeWorkerTokenRateProvider} to keep this render
	 * layer off the heavy vibe/task dependency graph.
	 */
	#getVibeWorkerTokensPerSecond(): number | null {
		return this.#vibeWorkerTokenRate?.() ?? null;
	}

	#formatUsageContextKey(activeProvider: string | undefined, identity: OAuthAccountIdentity | undefined): string {
		if (!activeProvider) return "";
		// orgId is part of the key: rotating between two same-email Anthropic
		// subscriptions must invalidate the cached usage immediately instead of
		// showing the previous org's quota for the rest of the cache TTL.
		return [
			activeProvider,
			identity?.accountId ?? "",
			identity?.email ?? "",
			identity?.projectId ?? "",
			identity?.orgId ?? "",
		].join("\0");
	}

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const identity = activeProvider
			? session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId)
			: undefined;
		// Model id is part of the invalidation key (but not the account-scoped
		// fireworks key): normalized usage now selects a model-scoped window group,
		// so switching models must drop the previous model's cached scope instead
		// of showing it for the rest of the TTL.
		const activeModelId = session.state.model?.id ?? session.model?.id ?? "";
		return `${this.#formatUsageContextKey(activeProvider, identity)}\0${activeModelId}`;
	}

	/**
	 * Startup redraws only arm a short-delayed task; timeout releases the render
	 * cadence while a late successful fetch can still refresh the cached segment.
	 */
	refreshUsageInBackground(): void {
		const now = Date.now();
		const session = this.session;
		const usageContextKey = this.#getUsageContextKey(session);
		if (this.#cachedUsageContextKey !== usageContextKey) {
			this.#cachedUsage = null;
			this.#usageFetchedAt = 0;
			this.#cachedUsageContextKey = usageContextKey;
		}
		if (this.#usageInFlight || this.#usageStartTimer) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const fetcher = (session as { fetchUsageReports?: (signal?: AbortSignal) => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		this.#usageStartTimer = setTimeout(() => {
			this.#usageStartTimer = null;
			void this.#runUsageRefresh(session, fetcher);
		}, STATUS_USAGE_START_DELAY_MS);
	}

	async #runUsageRefresh(session: AgentSession, fetcher: (signal?: AbortSignal) => Promise<unknown>): Promise<void> {
		if (this.#disposed || this.session !== session) {
			this.#usageInFlight = false;
			return;
		}
		const sequence = ++this.#usageRefreshSequence;
		const signal = AbortSignal.timeout(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let reportsPromise: Promise<unknown> | undefined;
		try {
			reportsPromise = fetcher.call(session, signal);
			this.#applyUsageRefreshReports(
				session,
				await this.#raceUsageRefreshWithSignal(reportsPromise, signal),
				sequence,
			);
		} catch {
			if (this.session !== session) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && reportsPromise) {
				this.#observeLateUsageRefresh(session, reportsPromise, sequence);
			}
		} finally {
			if (this.session === session) this.#usageInFlight = false;
		}
	}

	#applyUsageRefreshReports(session: AgentSession, reports: unknown, sequence: number): void {
		if (this.#disposed || this.session !== session || sequence < this.#latestAppliedUsageRefreshSequence) {
			return;
		}
		this.#latestAppliedUsageRefreshSequence = sequence;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const activeModelId = session.state.model?.id ?? session.model?.id;
		const activeIdentity =
			activeProvider && session.modelRegistry?.authStorage
				? session.modelRegistry.authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId)
				: undefined;
		const normalized = this.#normalizeUsageReports(reports, {
			provider: activeProvider,
			modelId: activeModelId,
			identity: activeIdentity,
		});
		const resetSnapshot =
			activeProvider === "openai-codex" ? this.#normalizeCodexResetSnapshot(reports, activeIdentity) : null;
		const usageChanged = this.#cachedUsage !== normalized;
		this.#cachedUsage = normalized;
		this.#usageFetchedAt = Date.now();
		// Usage fetch is async; without a repaint the top border stays blank until
		// some unrelated event (git resolve, keystroke, …) rebuilds it.
		if (usageChanged) this.#onBranchChange?.();
		if (!resetSnapshot) return;
		const contextKey = this.#formatUsageContextKey(activeProvider, activeIdentity);
		const previous = this.#codexResetSnapshots.get(contextKey);
		this.#codexResetSnapshots.set(contextKey, resetSnapshot);
		if (!previous || !settings.get("tui.codexResetFireworks")) return;
		const event = detectCodexResetFireworks(previous, resetSnapshot);
		if (event) this.#onCodexResetFireworks?.(event);
	}

	#observeLateUsageRefresh(session: AgentSession, reportsPromise: Promise<unknown>, sequence: number): void {
		void reportsPromise
			.then(reports => {
				this.#applyUsageRefreshReports(session, reports, sequence);
			})
			.catch(() => {
				if (this.#disposed || this.session !== session || sequence < this.#latestAppliedUsageRefreshSequence) {
					return;
				}
				this.#usageFetchedAt = Date.now();
			});
	}

	async #raceUsageRefreshWithSignal(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw signal.reason;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#normalizeCodexResetSnapshot(
		reports: unknown,
		activeIdentity: OAuthAccountIdentity | undefined,
	): CodexResetUsageSnapshot | null {
		if (!Array.isArray(reports)) return null;
		let matchingReport: UsageReport | undefined;
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			if (
				!("provider" in report) ||
				report.provider !== "openai-codex" ||
				!("limits" in report) ||
				!Array.isArray(report.limits)
			) {
				continue;
			}
			// The report boundary above validates the fields this extractor iterates;
			// optional metadata and credit fields are narrowed again before use.
			const usageReport = report as UsageReport;
			if (!codexReportMatchesExactIdentity(usageReport, activeIdentity)) continue;
			matchingReport = usageReport;
			break;
		}
		if (!matchingReport) return null;

		const plan =
			typeof matchingReport.metadata?.planType === "string" && matchingReport.metadata.planType
				? matchingReport.metadata.planType
				: undefined;
		let sevenDay: CodexResetUsageSnapshot["sevenDay"];
		let sevenDayTier: string | undefined;
		for (const limit of matchingReport.limits) {
			if (!limit || typeof limit !== "object") continue;
			const candidate = limit as {
				scope?: { windowId?: string; tier?: string };
				window?: { resetsAt?: number };
				amount?: { usedFraction?: number };
			};
			const fraction = candidate.amount?.usedFraction;
			if (candidate.scope?.windowId !== "7d" || typeof fraction !== "number" || !Number.isFinite(fraction)) {
				continue;
			}
			const tier =
				typeof candidate.scope?.tier === "string" && candidate.scope.tier ? candidate.scope.tier : undefined;
			if (sevenDay && (sevenDayTier === undefined || tier)) continue;
			const resetsAt = candidate.window?.resetsAt;
			sevenDay = {
				percent: fraction * 100,
				resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
				tier,
				plan,
			};
			sevenDayTier = tier;
		}

		const fetchedAt = matchingReport.fetchedAt;
		const availableCount = matchingReport.resetCredits?.availableCount;
		const observedAt = typeof fetchedAt === "number" && Number.isFinite(fetchedAt) ? fetchedAt : undefined;
		const savedResets =
			typeof availableCount === "number" && Number.isFinite(availableCount)
				? Math.max(0, Math.trunc(availableCount))
				: undefined;
		if (!sevenDay && savedResets === undefined) return null;
		return { observedAt, sevenDay, savedResets };
	}

	#normalizeUsageReports(
		reports: unknown,
		context: { provider?: string; modelId?: string; identity?: OAuthAccountIdentity },
	): {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
		monthly?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		const now = Date.now();
		const activeModelId = normalizeUsageScopeValue(context.modelId);
		const scopeGroups = new Map<string, UsageScopeGroup>();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = "provider" in report ? report.provider : undefined;
			if (context.provider && provider !== context.provider) continue;
			const limits = "limits" in report ? report.limits : undefined;
			if (!Array.isArray(limits)) continue;
			// fetchUsageReports supplies normalized rows; the guards above protect
			// the unknown session boundary before the account matcher reads metadata.
			const usageReport = report as UsageReport;
			for (const limit of limits) {
				if (
					!limit ||
					typeof limit !== "object" ||
					!("scope" in limit) ||
					!limit.scope ||
					typeof limit.scope !== "object" ||
					!("amount" in limit) ||
					!limit.amount ||
					typeof limit.amount !== "object"
				) {
					continue;
				}
				const scope = limit.scope;
				const amount = limit.amount;
				// The matcher only reads scope identity fields, whose object boundary
				// is validated above; other required UsageLimit fields are irrelevant.
				const usageLimit = limit as UsageLimit;
				if (context.identity && !limitMatchesActiveAccount(usageReport, usageLimit, context.identity)) continue;

				const fraction = "usedFraction" in amount ? amount.usedFraction : undefined;
				if (typeof fraction !== "number") continue;
				const window =
					"window" in limit && limit.window && typeof limit.window === "object" ? limit.window : undefined;
				const windowId = "windowId" in scope ? scope.windowId : undefined;
				const durationValue = window && "durationMs" in window ? window.durationMs : undefined;
				const durationMs = typeof durationValue === "number" ? durationValue : undefined;
				const subscriptionWindow =
					windowId === "5h" || windowId === "7d"
						? windowId
						: durationMs !== undefined && Math.abs(durationMs - 5 * 3_600_000) <= 60_000
							? "5h"
							: durationMs !== undefined && Math.abs(durationMs - 7 * 86_400_000) <= 60_000
								? "7d"
								: undefined;
				const windowClass =
					subscriptionWindow ??
					((context.provider === "cursor" || context.provider === "opencode-go") &&
					(windowId === "monthly" || windowId === "30d")
						? "monthly"
						: undefined);
				if (!windowClass) continue;

				const modelId = normalizeUsageScopeValue("modelId" in scope ? scope.modelId : undefined);
				if (modelId && modelId !== activeModelId) continue;
				const rawTier = "tier" in scope ? scope.tier : undefined;
				const rawPlanType = usageReport.metadata?.planType;
				// Scoped tiers (Claude Fable, Codex Spark) win; plan-wide tiers
				// (Z.AI `pro`, Codex `pro`) label otherwise-untiered windows.
				const tier =
					(typeof rawTier === "string" && rawTier.trim() ? rawTier.trim() : undefined) ??
					(typeof rawPlanType === "string" && rawPlanType.trim() ? rawPlanType.trim() : undefined);
				const normalizedTier = normalizeUsageScopeValue(tier);
				const scopeKey = `${modelId ?? ""}\0${normalizedTier ?? ""}`;
				// Exact-model groups outrank provider-wide groups; within either
				// specificity, untiered limits preserve the historical preference.
				const priority = modelId ? (normalizedTier ? 1 : 0) : normalizedTier ? 3 : 2;
				const id = "id" in limit && typeof limit.id === "string" ? limit.id : undefined;
				const resetValue = window && "resetsAt" in window ? window.resetsAt : undefined;
				const displayCandidate: UsageWindowCandidate = {
					id,
					windowClass,
					fraction,
					resetsAt: typeof resetValue === "number" ? resetValue : undefined,
				};
				const group = scopeGroups.get(scopeKey);
				if (group) {
					group.candidates.push(displayCandidate);
				} else {
					scopeGroups.set(scopeKey, { priority, tier, candidates: [displayCandidate] });
				}
			}
		}

		let selectedGroup: UsageScopeGroup | undefined;
		for (const group of scopeGroups.values()) {
			if (!selectedGroup || group.priority < selectedGroup.priority) selectedGroup = group;
		}
		if (!selectedGroup) return null;

		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		let monthly: { percent: number; resetHours?: number } | undefined;
		let monthlyPriority = Number.POSITIVE_INFINITY;
		const cursorMonthlyPriority = (limitId: unknown): number => {
			// When /auth/usage and /api/usage-summary are merged, prefer the personal
			// dashboard rails over legacy per-model request fractions.
			if (limitId === "cursor:usd:individual-auto") return 0;
			if (limitId === "cursor:usd:individual-plan" || limitId === "cursor:usd:individual-overall") return 1;
			if (typeof limitId === "string" && limitId.startsWith("cursor:usd:individual-")) return 2;
			return 3;
		};
		for (const candidate of selectedGroup.candidates) {
			if (candidate.windowClass === "5h" && !fiveHour) {
				fiveHour = {
					percent: candidate.fraction * 100,
					resetMinutes:
						typeof candidate.resetsAt === "number"
							? Math.max(0, Math.round((candidate.resetsAt - now) / 60_000))
							: undefined,
				};
			}
			if (candidate.windowClass === "7d" && !sevenDay) {
				sevenDay = {
					percent: candidate.fraction * 100,
					resetHours:
						typeof candidate.resetsAt === "number"
							? Math.max(0, Math.round((candidate.resetsAt - now) / 3_600_000))
							: undefined,
				};
			}
			if (candidate.windowClass === "monthly") {
				const priority = cursorMonthlyPriority(candidate.id);
				if (priority < monthlyPriority) {
					monthly = {
						percent: candidate.fraction * 100,
						resetHours:
							typeof candidate.resetsAt === "number"
								? Math.max(0, Math.round((candidate.resetsAt - now) / 3_600_000))
								: undefined,
					};
					monthlyPriority = priority;
				}
			}
		}
		if (!fiveHour && !sevenDay && !monthly) return null;
		return { tier: selectedGroup.tier, fiveHour, sevenDay, monthly };
	}

	/**
	 * Used-tokens / context-window totals for the status-line context% segment,
	 * memoized so the per-event redraw stays O(1) when nothing changed.
	 *
	 * The numerator comes from `session.getContextUsage()`, which anchors on the
	 * last assistant's real prompt-token count — so the bar matches the provider
	 * and the `/context` panel — and reports `null` while that count is unknown
	 * (right after compaction, before the next response). Exposed (non-private)
	 * for unit tests and the collab host's state broadcast.
	 */
	getCachedContextBreakdown(): { usedTokens: number; contextWindow: number } {
		const messages = this.session.messages ?? EMPTY_MESSAGES;
		const modelContextWindow = this.session.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		// Bumps when the in-flight pending snapshot is set/cleared. Without it a
		// value computed mid-turn (estimate of the active tail) would survive after
		// the turn ends/aborts, since clearing the snapshot touches no message.
		const contextUsageRevision = this.session.contextUsageRevision ?? 0;

		const systemPrompt = this.session.systemPrompt;
		const tools = this.session.agent?.state?.tools;
		const skills = this.session.skills;

		const cache = this.#contextUsageCache;
		if (
			cache &&
			cache.messagesRef === messages &&
			cache.length === length &&
			cache.lastFingerprint === lastFingerprint &&
			cache.modelContextWindow === modelContextWindow &&
			cache.contextUsageRevision === contextUsageRevision &&
			cache.systemPromptRef === systemPrompt &&
			cache.toolsRef === tools &&
			cache.skillsRef === skills
		) {
			return { usedTokens: cache.usedTokens, contextWindow: cache.contextWindow };
		}

		const usage = typeof this.session.getContextUsage === "function" ? this.session.getContextUsage() : undefined;
		const usedTokens = usage?.tokens ?? 0;
		const contextWindow = usage?.contextWindow ?? modelContextWindow;
		this.#contextUsageCache = {
			messagesRef: messages,
			length,
			lastFingerprint,
			modelContextWindow,
			contextUsageRevision,
			usedTokens,
			contextWindow,
			systemPromptRef: systemPrompt,
			toolsRef: tools,
			skillsRef: skills,
		};
		return { usedTokens, contextWindow };
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeGit: boolean,
		includePr: boolean,
		previewTitle?: string,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		const breakdown = this.getCachedContextBreakdown();
		let contextTokens = breakdown.usedTokens;
		contextWindow = breakdown.contextWindow || contextWindow;
		let contextPercent: number | null = contextWindow > 0 ? (breakdown.usedTokens / contextWindow) * 100 : null;
		// Collab guest: context comes from the host's state frames — the local
		// replica does no accounting of its own.
		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			contextTokens = collabState.contextUsage.tokens ?? contextTokens;
			contextPercent = collabState.contextUsage.percent ?? contextPercent;
		}

		const shouldResolveActiveRepo = this.#gitEnabled() && (includePath || includeGit || includePr);
		const projectDir = getProjectDir();
		const activeRepoCache = shouldResolveActiveRepo
			? this.#resolveActiveRepoCache()
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir, worktree: null };
		let gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		// A jj repo has no git branch to read: git HEAD is detached (colocated) or
		// absent. A pending reftable resolve owns this cwd as an explicit Git repo,
		// so it must not be mistaken for an absent Git checkout and fall through to
		// an ancestor jj workspace.
		const gitHeadResolvePending = this.#branchResolveActive?.cwd === activeRepoCache.effectiveGitCwd;
		const gitHeadIsJjLike =
			!this.#cachedBranchHasGitRepository &&
			!gitHeadResolvePending &&
			(gitBranch === "detached" || gitBranch === null);
		if (includeGit && gitHeadIsJjLike) {
			gitBranch = this.#getJjBranch(activeRepoCache.effectiveGitCwd) ?? gitBranch;
		}
		const gitStatus = includeGit
			? ((gitHeadIsJjLike ? this.#getJjStatus(activeRepoCache.effectiveGitCwd) : null) ??
				this.#getGitStatus(activeRepoCache.effectiveGitCwd))
			: null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		const compactionSpeculation = this.session.compactionSpeculation ?? "idle";
		this.#syncSpeculationBlink(compactionSpeculation);
		return {
			session: this.session,
			focusedAgentId: this.#focusedAgentId,
			sessionAccent: this.#resolveSettings().sessionAccent !== false,
			previewTitle,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			compactThinkingLevel: this.#resolveSettings().compactThinkingLevel ?? false,
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			prewalk:
				typeof this.session.getPrewalkState === "function" && this.session.getPrewalkState()
					? { enabled: true }
					: null,
			goalMode: this.#goalModeStatus,
			vibeMode: this.#vibeModeStatus,
			collab: this.#collabStatus,
			usageStats,
			contextPercent,
			contextTokens,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			compactionSpeculation,
			speculationBlinkOn: this.#speculationBlinkOn,
			subagentCount: this.#subagentCount,
			activeMs: this.getActiveMs(),
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
			worktree: activeRepoCache.worktree,
			usage: this.#cachedUsage,
		};
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#subagentBadgeText(): string | undefined {
		if (this.#subagentCount === 0) return undefined;
		const noun = this.#subagentCount === 1 ? "agent" : "agents";
		return theme.fg("statusLineSubagents", `${theme.icon.agents} ${this.#subagentCount} ${noun}`);
	}

	/**
	 * Build the status bar for one of four layouts:
	 * - `box`: powerline groups joined by the context-reactive gauge line
	 *   (embedded in the editor's top border).
	 * - `plain-full`: no background, no powerline caps, dot separators, gap is
	 *   plain spaces — the standalone bottom bar for pi/borderless composers.
	 * - `plain-left`: left segments only (claude composer; the right group
	 *   lives in the editor's top rule).
	 * - `plain-right`: right segments only (claude composer's top rule).
	 *
	 * `previewTitle` is a stand-in session title for composer previews; the
	 * `session_name` segment renders it when the session is unnamed.
	 */
	#buildStatusLine(
		width: number,
		layout: "box" | "plain-full" | "plain-left" | "plain-right" = "box",
		previewTitle?: string,
	): string {
		const effectiveSettings = this.#resolveSettings();
		const plain = layout !== "box";
		const includePath =
			hasPathSegment(effectiveSettings.leftSegments) || hasPathSegment(effectiveSettings.rightSegments);
		const gitEnabled = this.#gitEnabled();
		const includeGit =
			gitEnabled &&
			(hasGitSegment(effectiveSettings.leftSegments) || hasGitSegment(effectiveSettings.rightSegments));
		const includePr =
			gitEnabled && (hasPrSegment(effectiveSettings.leftSegments) || hasPrSegment(effectiveSettings.rightSegments));
		const ctx = this.#buildSegmentContext(
			width,
			effectiveSettings.segmentOptions,
			includePath,
			includeGit,
			includePr,
			previewTitle,
		);
		const separatorDef = plain
			? { left: "·", right: "·" }
			: getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		// `transparent` reuses the empty-string sentinel (`\x1b[49m`) so the bar
		// inherits the terminal's default background, matching custom themes that
		// set `statusLineBg: ""`. Powerline end caps need a contrasting fill to
		// bridge the bar into the surrounding terminal; without one they read as
		// stray glyphs, so the cap renderer drops them when the fill is empty.
		const TRANSPARENT_BG_ANSI = "\x1b[49m";
		const themeBgAnsi = theme.getBgAnsi("statusLineBg");
		// Plain bottom bars drop the background entirely; the claude top-rule
		// chip (`plain-right`) keeps it so the group reads as a chip on the rule.
		const transparentLayout = layout === "plain-full" || layout === "plain-left";
		const bgAnsi = transparentLayout || effectiveSettings.transparent ? TRANSPARENT_BG_ANSI : themeBgAnsi;
		const transparentBg = bgAnsi === TRANSPARENT_BG_ANSI;
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");
		const subagentBadge = this.#subagentBadgeText();

		// Collect visible segment contents
		const leftParts: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		const leftSegmentIds = layout === "plain-right" ? [] : effectiveSettings.leftSegments;
		for (const segId of leftSegmentIds) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		const rightParts: string[] = [];
		const rightSegIds: StatusLineSegmentId[] = [];
		const rightSegmentIds = layout === "plain-left" ? [] : effectiveSettings.rightSegments;
		for (const segId of rightSegmentIds) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
				rightSegIds.push(segId);
			}
		}

		const embedContext =
			!plain &&
			effectiveSettings.contextLine === "embedded" &&
			ctx.contextPercent !== null &&
			ctx.contextPercent !== undefined &&
			ctx.contextWindow > 0 &&
			(hasContextSegment(leftSegIds) || hasContextSegment(rightSegIds)) &&
			(hasNonContextSegment(leftSegIds) || hasNonContextSegment(rightSegIds));
		if (embedContext) {
			removeContextSegments(leftParts, leftSegIds);
			removeContextSegments(rightParts, rightSegIds);
		}

		if (layout !== "plain-left") {
			const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
			if (runningBackgroundJobs > 0) {
				rightParts.unshift(theme.fg("statusLineSubagents", `${theme.icon.job} ${runningBackgroundJobs}`));
			}
			if (subagentBadge) {
				rightParts.unshift(subagentBadge);
			}
		}
		const topFillWidth = Math.max(0, width);
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		// Transparent mode drops powerline caps (they need a bg fill to bridge),
		// so the width budget excludes them too.
		const leftCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			// Truncate the session-name segment before dropping right segments —
			// the title is the only elastic one on the right, and dropping it
			// wholesale left narrow bars (and the ≤76-col composer previews)
			// without any title.
			const nameSegIdx = rightSegIds.indexOf("session_name");
			if (nameSegIdx >= 0 && totalWidth() > topFillWidth) {
				// Badge/job parts were unshifted ahead of the tracked segment ids.
				const nameIdx = nameSegIdx + (right.length - rightSegIds.length);
				const currentNameVW = visibleWidth(right[nameIdx]);
				const minNameVW = 8;
				const shrinkBy = Math.min(Math.max(0, currentNameVW - minNameVW), totalWidth() - topFillWidth);
				if (shrinkBy > 0) {
					right[nameIdx] = truncateToWidth(right[nameIdx], currentNameVW - shrinkBy);
					rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
				}
			}
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			// Shrink path before dropping left segments — path is the only elastic segment
			const pathIdx = leftSegIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > topFillWidth) {
				const overflow = totalWidth() - topFillWidth;
				const currentPathVW = visibleWidth(left[pathIdx]);
				const minPathVW = 8; // icon + ellipsis + a few chars
				const shrinkable = currentPathVW - minPathVW;
				if (shrinkable > 0) {
					const shrinkBy = Math.min(shrinkable, overflow);
					const currentMaxLen = ctx.options.path?.maxLength ?? 40;
					let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
					const pathCtx = (maxLen: number): SegmentContext => ({
						...ctx,
						options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
					});
					let reRendered = renderSegment("path", pathCtx(newMaxLen));
					if (reRendered.visible && reRendered.content) {
						// maxLength governs path text, not icon prefix; iterate to compensate
						for (let i = 0; i < 8; i++) {
							const saved = currentPathVW - visibleWidth(reRendered.content);
							if (saved >= shrinkBy) break;
							const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
							if (nextMaxLen >= newMaxLen) break; // no progress or hit floor
							newMaxLen = nextMaxLen;
							const adjusted = renderSegment("path", pathCtx(newMaxLen));
							if (!adjusted.visible || !adjusted.content) break;
							reRendered = adjusted;
						}
						left[pathIdx] = reRendered.content;
						leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
					}
				}
			}
			const leftOverflowDropIndex = (): number => {
				// Preserve the current working directory as long as possible. The
				// previous right-to-left pop could collapse a normal-width bar to
				// just the model segment, hiding the path before less-critical left
				// segments such as model/mode/collab were removed.
				for (let i = leftSegIds.length - 1; i >= 0; i--) {
					if (leftSegIds[i] !== "path") return i;
				}
				return left.length - 1;
			};

			while (totalWidth() > topFillWidth && left.length > 0) {
				const dropIdx = leftOverflowDropIndex();
				left.splice(dropIdx, 1);
				leftSegIds.splice(dropIdx, 1);
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap =
				separatorDef.endCaps && !transparentBg
					? direction === "left"
						? separatorDef.endCaps.right
						: separatorDef.endCaps.left
					: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${this.#focusedAgentId ? "\x1b[22m" : ""}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || (plain && (left.length === 0 || right.length === 0))) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		if (plain) {
			// Standalone composers: no gauge line between the groups, just air.
			return leftGroup + padding(gapWidth) + rightGroup;
		}
		// Box layout: with one group absent (an unnamed session hides
		// `session_name`, emptying the default preset's right group) the gauge
		// runs to the border edge instead of disappearing, so embedded context
		// labels don't fall back to a context chip until the session is titled.
		return leftGroup + this.#buildContextGaugeFill(gapWidth, ctx, effectiveSettings, embedContext) + rightGroup;
	}

	/**
	 * The gauge line bridging the left and right groups in box layout. Driven
	 * by `statusLine.contextLine`:
	 * - `off`: solid accent line (no context feedback).
	 * - `percentage`: used portion in accent, remainder in the border color.
	 * - `annotated` : percentage plus preset-aware markers where
	 *   speculative compaction starts and where auto-compaction fires.
	 * - `embedded` (default): annotated markers plus percentage/window labels absorbed
	 *   from configured context segments.
	 */
	#buildContextGaugeFill(
		gapWidth: number,
		ctx: SegmentContext,
		effectiveSettings: EffectiveStatusLineSettings,
		embedContext: boolean,
	): string {
		const sessionName =
			effectiveSettings.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const usedColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("borderAccent");
		const horizontal = theme.boxRound.horizontal;
		const mode = effectiveSettings.contextLine ?? "embedded";
		const pct = ctx.contextPercent;
		if (mode === "off" || pct === null || pct === undefined) {
			return `\x1b[49m${usedColor}${horizontal.repeat(gapWidth)}\x1b[39m`;
		}

		const clampedPct = Math.min(100, Math.max(0, pct));
		let percentLabel = "";
		let windowLabel = "";
		let percentStart = -1;
		let windowStart = -1;
		let scaleWidth = gapWidth;
		// >100%: usage anchored past the active window (e.g. model switch to a
		// smaller window). The bar clamps full, but the embedded label breaks
		// past the window label — `──200K─120%` with the percent in error color.
		const percentOverflow = pct > 100;
		if (embedContext) {
			const candidatePercent = formatEmbeddedContextPercent(percentOverflow ? pct : clampedPct);
			const candidateWindow = formatNumber(ctx.contextWindow);
			if (gapWidth >= candidatePercent.length + candidateWindow.length + 4) {
				percentLabel = candidatePercent;
				windowLabel = candidateWindow;
				if (percentOverflow) {
					percentStart = gapWidth - percentLabel.length;
					windowStart = percentStart - 1 - windowLabel.length;
				} else {
					windowStart = gapWidth - windowLabel.length - 1;
				}
				scaleWidth = windowStart;
			}
		}

		// At least one accent cell: a fresh session still shows the session-accent
		// line starting at the left instead of a fully dim bar.
		const usedCount = Math.min(scaleWidth, Math.max(1, Math.round((clampedPct / 100) * scaleWidth)));
		const unusedColor = theme.getFgAnsi("border");

		// Boundary markers are only meaningful when auto-compaction can fire and
		// the line is long enough for the markers to read as positions.
		let speculationIdx = -1;
		let thresholdIdx = -1;
		if ((mode === "annotated" || mode === "embedded") && ctx.autoCompactEnabled && gapWidth >= 8) {
			const boundaries = this.#compactionBoundaries(ctx.contextWindow);
			if (boundaries) {
				const cellFor = (percent: number) =>
					Math.min(scaleWidth - 1, Math.max(0, Math.round((percent / 100) * scaleWidth)));
				thresholdIdx = cellFor(boundaries.thresholdPercent);
				// null = no background speculation will run (async disabled or the
				// first available method is local/instant) — no tick to show.
				if (boundaries.speculationPercent !== null) speculationIdx = cellFor(boundaries.speculationPercent);
				if (speculationIdx === thresholdIdx) speculationIdx = -1; // threshold wins the cell
			}
		}

		if (percentLabel && percentStart < 0) {
			const maxStart = scaleWidth - percentLabel.length - 1;
			const preferredStart = Math.min(maxStart, Math.max(1, usedCount));
			const overlapsBoundary = (start: number): boolean => {
				const end = start + percentLabel.length;
				return (speculationIdx >= start && speculationIdx < end) || (thresholdIdx >= start && thresholdIdx < end);
			};
			for (let distance = 0; distance <= maxStart; distance++) {
				const left = preferredStart - distance;
				if (left >= 1 && !overlapsBoundary(left)) {
					percentStart = left;
					break;
				}
				if (distance === 0) continue;
				const right = preferredStart + distance;
				if (right <= maxStart && !overlapsBoundary(right)) {
					percentStart = right;
					break;
				}
			}
		}

		const speculationGlyph = theme.symbol("context.speculation");
		const thresholdGlyph = theme.symbol("context.compaction");
		const speculationColor = theme.getFgAnsi("muted");
		const overflowColor = theme.getFgAnsi("error");
		const rawAccentHex = accentHex ?? theme.getColorHex("borderAccent");
		const dimmedAccentHex = adjustHsv(rawAccentHex, { s: 0.7, v: 0.75 });
		const thresholdColor = getSessionAccentAnsi(dimmedAccentHex) ?? usedColor;

		let out = "\x1b[49m";
		let activeColor = "";
		for (let i = 0; i < gapWidth; i++) {
			let color = i < usedCount ? usedColor : unusedColor;
			let glyph = horizontal;
			if (percentStart >= 0 && i >= percentStart && i < percentStart + percentLabel.length) {
				color = percentOverflow ? overflowColor : usedColor;
				glyph = percentLabel.charAt(i - percentStart);
			} else if (i === thresholdIdx) {
				color = thresholdColor;
				glyph = thresholdGlyph;
			} else if (i === speculationIdx) {
				color = speculationColor;
				glyph = speculationGlyph;
			} else if (windowStart >= 0 && i >= windowStart && i < windowStart + windowLabel.length) {
				color = thresholdColor;
				glyph = windowLabel.charAt(i - windowStart);
			}
			if (color !== activeColor) {
				out += color;
				activeColor = color;
			}
			out += glyph;
		}
		return `${out}\x1b[39m`;
	}

	/** Auto-compaction boundary percents, or null when unavailable (disabled, no window). */
	#compactionBoundaries(contextWindow: number): CompactionBoundaries | null {
		// Collab-guest replicas and test mocks have no session-scoped settings;
		// the global store carries the same compaction knobs.
		const source = typeof this.session.settings?.getGroup === "function" ? this.session.settings : settings;
		// The active model gates which compaction method a real pass would run
		// (and therefore whether a speculation tick is meaningful).
		const model = this.session.state?.model ?? this.session.model;
		try {
			return computeCompactionBoundaries(source, contextWindow, model);
		} catch {
			return null;
		}
	}

	getTopBorder(width: number, previewTitle?: string): { content: string; width: number; revision: number } {
		let content = this.#buildStatusLine(width, "box", previewTitle);
		if (this.#focusedAgentId && content) {
			// Dim the whole bar while focus-proxied. Group/cap terminators emit full
			// `\x1b[0m` resets that would cancel faint mid-bar, so re-open it after each.
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return {
			content,
			width: visibleWidth(content),
			revision: this.#renderRevision,
		};
	}
	/**
	 * Standalone bar placement derived from the composer style. `bottomBar`
	 * `"full"` renders both groups on the bottom bar (pi/borderless/field/rail);
	 * `"left"` renders just the left group there — the right group attaches to
	 * the editor's top rule via {@link getStandaloneTopBorder} (claude/rule);
	 * `"none"` returns the bar to the box composer's embedded top border.
	 * `bottomBarGap` inserts a blank spacer row above the bar for styles whose
	 * editor has no bottom chrome.
	 */
	setComposerStyle(style: Pick<ComposerStyle, "bottomBar" | "bottomBarGap">): void {
		this.#standalone = style.bottomBar === "none" ? false : style.bottomBar === "left" ? "left-only" : "full";
		this.#standaloneGap = style.bottomBarGap;
	}

	/** While true, the standalone bar yields its row to the editor's autocomplete menu. */
	setAutocompleteActiveProbe(probe: (() => boolean) | undefined): void {
		this.#autocompleteActiveProbe = probe;
	}

	/** Plain right-group content for the claude composer's top rule. */
	getStandaloneTopBorder(width: number, previewTitle?: string): { content: string; width: number; revision: number } {
		let content = this.#buildStatusLine(width, "plain-right", previewTitle);
		if (this.#focusedAgentId && content) {
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return {
			content,
			width: visibleWidth(content),
			revision: this.#renderRevision,
		};
	}

	/**
	 * The plain standalone bottom bar through the real segment/gauge pipeline —
	 * `groups` picks which segment groups it carries. Used by the live render
	 * loop and by composer previews (which inject a candidate layout instead of
	 * the active one).
	 */
	renderBottomBar(width: number, groups: "left" | "full", previewTitle?: string): string {
		let content = this.#buildStatusLine(width, groups === "left" ? "plain-left" : "plain-full", previewTitle);
		if (this.#focusedAgentId && content) {
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return content;
	}
	/**
	 * Status bar lines for a composer layout, rendered through the real
	 * pipeline — the single source for the /settings appearance preview.
	 * `style` overrides the layout (candidate composer shape); omitted, the
	 * active layout is used. Ignores the autocomplete probe: previews always
	 * render.
	 */
	getPreviewLines(width: number, style?: Pick<ComposerStyle, "statusAttachment" | "bottomBar">): string[] {
		const attachment =
			style?.statusAttachment ??
			(this.#standalone === false ? "top-border" : this.#standalone === "left-only" ? "top-rule-chip" : "none");
		const bottomBar =
			style?.bottomBar ?? (this.#standalone === false ? "none" : this.#standalone === "left-only" ? "left" : "full");
		const lines: string[] = [];
		if (attachment === "top-border") {
			const border = this.getTopBorder(width);
			if (border.content) lines.push(border.content);
		} else if (attachment === "top-rule-chip") {
			// Render the chip on its rule exactly as the claude composer does.
			const rule = claudeComposerStyle.renderTop({
				width,
				paddingX: 0,
				borderColor: str => theme.fg("border", str),
				accentColor: str => theme.fg("accent", str),
				surfaceColor: str => theme.bgFill("userMessageBg", str),
				box: theme.boxRound,
				topBorder: this.getStandaloneTopBorder(width),
			});
			if (rule !== undefined) lines.push(rule);
		}
		if (bottomBar !== "none") {
			const main = this.renderBottomBar(width, bottomBar);
			if (main) lines.push(main);
		}
		return lines;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		if (this.#standalone && !this.#autocompleteActiveProbe?.()) {
			const content = this.renderBottomBar(width, this.#standalone === "left-only" ? "left" : "full");
			if (content) {
				if (this.#standaloneGap) lines.push("");
				lines.push(content);
			}
		}
		const showHooks = this.#settings.showHookStatus ?? true;
		if (showHooks && this.#hookStatuses.size > 0) {
			const hookLines = Array.from(this.#hookStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => truncateToWidth(sanitizeStatusText(text), width));
			lines.push(...hookLines);
		}
		return lines;
	}
}
