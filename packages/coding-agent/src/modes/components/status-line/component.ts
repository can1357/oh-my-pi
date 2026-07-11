import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, UsageLimit, UsageReport } from "@pk-nerdsaver-ai/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { getProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { theme } from "../../theme/theme";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { getPreset } from "./presets";
import { renderSegment, type SegmentContext } from "./segments";
import { getSeparator } from "./separators";
import { calculateTokensPerSecond } from "./token-rate";
import type {
	CollabStatus,
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

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
					textLen += b.arguments === undefined ? 0 : JSON.stringify(b.arguments).length;
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
}

const EMPTY_MESSAGES: readonly AgentMessage[] = [];
const STATUS_USAGE_START_DELAY_MS = 0;
const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
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
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	#sessionStartTime: number = Date.now();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;

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
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
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
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd };
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
		if (sessionChanged) this.#invalidateSessionCaches();
		this.invalidate();
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

	/** Active subagent count as currently displayed (collab state mirroring). */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	setSessionStartTime(time: number): void {
		this.#sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: { enabled: boolean } | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collabStatus = status;
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
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		if (!this.#gitEnabled() || !this.#hasGitBackedSegment()) {
			this.#invalidateGitCaches();
			return;
		}

		const { effectiveGitCwd } = this.#resolveActiveRepoCache();
		const repository = git.repo.resolveSync(effectiveGitCwd);
		if (!repository) return;

		const watchPath = git.repo.isReftableSync(repository)
			? path.join(repository.gitDir, "reftable")
			: repository.headPath;

		try {
			this.#gitWatcher = fs.watch(watchPath, () => {
				if (this.#disposed) return;
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#onBranchChange = null;
		this.#clearUsageStartTimer();
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	#clearUsageStartTimer(): void {
		if (!this.#usageStartTimer) return;
		clearTimeout(this.#usageStartTimer);
		this.#usageStartTimer = null;
	}

	invalidate(): void {
		this.#invalidateGitCaches();
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

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(effectiveGitCwd?: string): string | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === gitCwd) {
			return this.#cachedBranch;
		}

		const head = git.head.resolveSync(gitCwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = gitCwd;
		this.#cachedBranchRepoId = gitHeadPath;
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
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
				}
			}
		})();

		return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
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
				// Requires `gh repo set-default` to be configured; fails gracefully if not
				const result = await $`gh pr view --json number,url`.cwd(lookupCwd).quiet().nothrow();
				if (this.#disposed) return;
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout.toString()) as { number: number; url: string };
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

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider ?? "";
		if (!activeProvider) return "";
		const identity = session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId);
		return [activeProvider, identity?.accountId ?? "", identity?.email ?? "", identity?.projectId ?? ""].join("\0");
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
		const signal = AbortSignal.timeout(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let reportsPromise: Promise<unknown> | undefined;
		try {
			reportsPromise = fetcher.call(session, signal);
			this.#applyUsageRefreshReports(session, await this.#raceUsageRefreshWithSignal(reportsPromise, signal));
		} catch {
			if (this.session !== session) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && reportsPromise) {
				this.#observeLateUsageRefresh(session, reportsPromise);
			}
		} finally {
			if (this.session === session) this.#usageInFlight = false;
		}
	}

	#applyUsageRefreshReports(session: AgentSession, reports: unknown): void {
		if (this.#disposed || this.session !== session) return;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const activeIdentity =
			activeProvider && session.modelRegistry?.authStorage
				? session.modelRegistry.authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId)
				: undefined;
		this.#cachedUsage = this.#normalizeUsageReports(reports, activeProvider, activeIdentity);
		this.#usageFetchedAt = Date.now();
	}

	#observeLateUsageRefresh(session: AgentSession, reportsPromise: Promise<unknown>): void {
		void reportsPromise
			.then(reports => {
				this.#applyUsageRefreshReports(session, reports);
			})
			.catch(() => {
				if (this.#disposed || this.session !== session) return;
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

	#normalizeUsageReports(
		reports: unknown,
		activeProvider?: string,
		activeIdentity?: OAuthAccountIdentity,
	): {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		let fiveHourTier: string | undefined;
		let sevenDayTier: string | undefined;
		const now = Date.now();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = (report as { provider?: unknown }).provider;
			if (activeProvider && provider !== activeProvider) continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				if (
					activeIdentity &&
					!limitMatchesActiveAccount(report as UsageReport, limit as UsageLimit, activeIdentity)
				) {
					continue;
				}
				const l = limit as {
					scope?: { windowId?: string; tier?: string };
					window?: { resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const windowId = l.scope?.windowId;
				const tier = l.scope?.tier;
				const resetsAt = l.window?.resetsAt;
				// Accept tiered limits, but prefer untiered (backward compat with Anthropic).
				// An untiered limit always replaces a tiered one; among same-tieredness, first wins.
				if (windowId === "5h" && (!fiveHour || (fiveHourTier !== undefined && !tier))) {
					fiveHour = {
						percent: fraction * 100,
						resetMinutes:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
					};
					fiveHourTier = tier || undefined;
				}
				if (windowId === "7d" && (!sevenDay || (sevenDayTier !== undefined && !tier))) {
					sevenDay = {
						percent: fraction * 100,
						resetHours:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
					};
					sevenDayTier = tier || undefined;
				}
			}
		}
		if (!fiveHour && !sevenDay) return null;
		// Single compact label; prefer the five-hour tier if displayed windows ever disagree.
		const effectiveTier = fiveHourTier ?? sevenDayTier;
		return { tier: effectiveTier, fiveHour, sevenDay };
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

		const usage = this.session.getContextUsage();
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
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
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
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		let contextPercent: number | null = 0;
		let contextTokens = 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextTokens = breakdown.usedTokens;
			contextWindow = breakdown.contextWindow || contextWindow;
			contextPercent = contextWindow > 0 ? (breakdown.usedTokens / contextWindow) * 100 : null;
		}

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
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir };
		const gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		const gitStatus = includeGit ? this.#getGitStatus(activeRepoCache.effectiveGitCwd) : null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		return {
			session: this.session,
			focusedAgentId: this.#focusedAgentId,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			goalMode: this.#goalModeStatus,
			collab: this.#collabStatus,
			usageStats,
			contextPercent,
			contextTokens,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			sessionStartTime: this.#sessionStartTime,
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
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

	#buildStatusLine(width: number): string {
		const effectiveSettings = this.#resolveSettings();
		const includePath =
			hasPathSegment(effectiveSettings.leftSegments) || hasPathSegment(effectiveSettings.rightSegments);
		const includeContext =
			hasContextSegment(effectiveSettings.leftSegments) || hasContextSegment(effectiveSettings.rightSegments);
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
			includeContext,
			includeGit,
			includePr,
		);
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		// `transparent` reuses the empty-string sentinel (`\x1b[49m`) so the bar
		// inherits the terminal's default background, matching custom themes that
		// set `statusLineBg: ""`. Powerline end caps need a contrasting fill to
		// bridge the bar into the surrounding terminal; without one they read as
		// stray glyphs, so the cap renderer drops them when the fill is empty.
		const TRANSPARENT_BG_ANSI = "\x1b[49m";
		const themeBgAnsi = theme.getBgAnsi("statusLineBg");
		const bgAnsi = effectiveSettings.transparent ? TRANSPARENT_BG_ANSI : themeBgAnsi;
		const transparentBg = bgAnsi === TRANSPARENT_BG_ANSI;
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");
		const subagentBadge = this.#subagentBadgeText();

		// Collect visible segment contents
		const leftParts: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
		if (runningBackgroundJobs > 0) {
			rightParts.unshift(theme.fg("statusLineSubagents", `${theme.icon.job} ${runningBackgroundJobs}`));
		}
		if (subagentBadge) {
			rightParts.unshift(subagentBadge);
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
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftSegIds.pop();
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
			const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

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

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const sessionName =
			effectiveSettings.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		let content = this.#buildStatusLine(width);
		if (this.#focusedAgentId && content) {
			// Dim the whole bar while focus-proxied. Group/cap terminators emit full
			// `\x1b[0m` resets that would cancel faint mid-bar, so re-open it after each.
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): readonly string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}
