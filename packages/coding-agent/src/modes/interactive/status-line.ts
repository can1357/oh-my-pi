/**
 * The status line's data (see {@link StatusLineModel}): one {@link StatusFacts}
 * snapshot, recomputed when the viewed session emits an event, when the app
 * moves a mode or a badge, when a background read (git, usage quota, pull
 * request) lands, and on the wall clock while a segment shows time.
 * Streaming deltas sample context usage and token rate; only changes propagate
 * to the bar. Foreground tool progress samples the job badge, account status,
 * speculation and rate without invalidating the transcript or compaction policy.
 *
 * Git/jj facts are read again when a run starts (edits made while idle) and
 * when a turn ends (what its tools did), and after a user `!`/`$` command
 * ({@link SessionStatusLine.refreshVcs}); nothing polls the repository. Those
 * reads start at most {@link VCS_READ_INTERVAL_MS} apart: one skipped as too
 * soon runs on a timer once the run yields, so the bar never stays stale.
 * None of it happens while the terminal reads and shows the checkout itself
 * ({@link SessionStatusLine.setCheckoutHomed}: Tern's `checkout` event).
 *
 * Session state is not reactive, so the session's events bump a revision the
 * snapshot reads; {@link SessionStatusLine.refresh} does the same for changes
 * that emit no event (a model switch through the API, a settings edit).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { getNextTimeBasedPricingTransition, getTimeBasedPricingPeriod } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type Accessor, computed, type Signal, signal } from "@oh-my-pi/pi-tui";
import { getActiveProfile, getProjectDir } from "@oh-my-pi/pi-utils";
import { formatModelStringWithRouting } from "../../config/model-resolver";
import { MAX_THINKING_SUFFIX_OPTIONS, parseThinkingSuffix } from "../../config/model-selector";
import type { AgentViewSession } from "../../session/agent-session-handle";
import { type AiuTotals, sessionAiu } from "../../session/aiu-billing";
import { latestJobWidget } from "../../tools/details/job-widget";
import { BRAND_FADE_MS, type StatusFacts, type StatusLineSettings } from "../../ui/status/facts";
import type { CollabStatus, StatusLineModel } from "../types";
import { statusLineHost } from "../status-line-host";
import type { LoopConditionConfig, LoopLimitRuntime } from "../view-model/status-line/loop";
import {
	type CodexResetFireworksEvent,
	type CodexResetUsageSnapshot,
	detectCodexResetFireworks,
} from "../view-model/overlays/codex-reset-fireworks";
import { codexResetSnapshot, quotaFromReports } from "./status-quota";

/** Least time between the starts of two git/jj reads asked for by run starts, turn ends and user commands. */
const VCS_READ_INTERVAL_MS = 5_000;
/** Usage reports are fetched at most this often. */
const USAGE_TTL_MS = 5 * 60_000;
/** First usage fetch waits this long so startup paints first. */
const USAGE_START_DELAY_MS = 1_500;
const USAGE_TIMEOUT_MS = 2_000;
/** A streaming reply's deltas refresh the facts at most this often (tokens and rate move with it). */
const STREAM_REFRESH_MS = 100;
/** A pull request lookup is repeated at most this often per branch. */
const PR_TTL_MS = 60_000;

/** Project and worktree directory names of a linked git worktree (the project from its primary checkout). */
function linkedWorktreeNames(
	linked: { readonly root: string; readonly primaryRoot: string } | null | undefined,
): { projectName: string; worktreeName: string } | undefined {
	if (!linked) return undefined;
	const base = path.basename(linked.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	return projectName ? { projectName, worktreeName: path.basename(linked.root) } : undefined;
}

/** Short machine name, resolved once (`os.hostname()` is a syscall). */
let shortHostname: string | undefined;

/** Session members the facts read beyond {@link AgentViewSession}; optional so collab replicas still draw. */
interface StatusSessionExtras {
	readonly isStreaming?: boolean;
	getPromptCacheStatus?(nowMs: number, nextTokens?: number): StatusFacts["promptCache"];
	getAdvisorStatusOverview?(): {
		configured: boolean;
		advisors: readonly { status: string; yielded: boolean }[];
	};
}

type StatusSession = AgentViewSession & StatusSessionExtras;

/**
 * Whether a retry fallback serves as the displayed model. Attribution moves only
 * once a model settles a turn, so after `/model` or a primary restore it still
 * names the fallback while `model` is already the newly selected one. The
 * selector is the routed id plus an optional thinking suffix; the suffix is
 * stripped only after the id matches, since ids can end in a level word
 * (`ollama/phi3:medium`).
 */
function displaysServingFallback(session: AgentViewSession, model: Model | undefined): boolean {
	const serving = session.servingModel;
	if (!serving?.isFallback || !model) return false;
	const identity = formatModelStringWithRouting(model);
	if (serving.selector === identity) return true;
	if (!serving.selector.startsWith(`${identity}:`)) return false;
	return parseThinkingSuffix(serving.selector.slice(identity.length + 1), MAX_THINKING_SUFFIX_OPTIONS) !== undefined;
}

type SessionFacts = Omit<
	StatusFacts,
	"context" | "compaction" | "tokensPerSecond" | "promptCache" | "jobs" | "jobGlance" | "speculation" | "slowModeLabel"
>;

/** One viewed session's active-processing meter. */
interface ActiveMeter {
	/** Completed active windows since the last reset. */
	activeMs: number;
	/** The open window's start; undefined while idle. */
	since: number | undefined;
	/** The session file the meter counts for. */
	file: string | undefined;
}

/** Modes and badges the interactive mode pushes. */
export interface StatusModes {
	plan?: { enabled: boolean; paused: boolean };
	goal?: { enabled: boolean; paused: boolean };
	vibe?: boolean;
	loop?: { state: "waiting" | "running" | "paused"; limit?: LoopLimitRuntime; condition?: LoopConditionConfig };
	vim?: StatusFacts["vim"];
	stream?: { viewers: number };
	recording?: boolean;
	pinned?: boolean;
	subagentTreeCost?: number;
	/** AI credits of the subagent tree, from the same roll-up as {@link subagentTreeCost}. */
	subagentTreeAiu?: AiuTotals;
	vibeWorkerTokenRate?: () => number | null;
}

interface VcsSnapshot {
	readonly cwd: string;
	readonly branch: string | null;
	readonly status: { staged: number; unstaged: number; untracked: number } | null;
	readonly pr: { number: number; url: string } | null;
	readonly worktree?: { projectName: string; worktreeName: string };
	readonly activeRepoRoot?: string;
}

/** See the module docs. */
export class SessionStatusLine implements StatusLineModel {
	readonly #revision = signal(0);
	readonly #streamRevision = signal(0);
	readonly #toolRevision = signal(0);
	/** Wall clock, advanced once a second while a segment shows time. */
	readonly #clock = signal(Date.now());
	readonly #saved: Signal<StatusLineSettings>;
	readonly #preview = signal<Partial<StatusLineSettings> | undefined>(undefined);
	readonly #hooks = signal<ReadonlyMap<string, string>>(new Map());
	readonly #awaiting = signal(false);
	readonly #collab = signal<CollabStatus | null>(null);
	/** The running subagents the agents badge counts. */
	readonly #subagents = signal<ReadonlySet<string>>(new Set());
	readonly #modes = signal<StatusModes>({});
	readonly #autoCompact = signal(true);
	readonly #vcs = signal<VcsSnapshot | undefined>(undefined);
	readonly #quota = signal<StatusFacts["quota"]>(undefined);

	#session: StatusSession;
	#focusedAgentId: string | undefined;
	#unsubscribe: (() => void) | undefined;
	#bumpQueued: "session" | "tool" | undefined;
	#streamBump: NodeJS.Timeout | undefined;
	#clockTimer: NodeJS.Timeout | undefined;
	/**
	 * Active-processing time per viewed session (a focused subagent's turns never feed main's): the
	 * completed windows since the last reset and the open one's start. A session whose file changed in
	 * place (`/resume`, `/move`, a fork) starts a fresh meter ({@link #meter}).
	 */
	readonly #meters = new WeakMap<AgentViewSession, ActiveMeter>();
	/** The active model's next tariff change, and the wakeup repainting the cost at it. */
	#pricingTimer: NodeJS.Timeout | undefined;
	#pricingAt: number | undefined;
	/** When the working state last changed (the brand's color fades across it). */
	#brandEdgeAt: number | undefined;
	/** Drops {@link #brandEdgeAt} once its fade is over. */
	#brandFade: NodeJS.Timeout | undefined;
	/** The git/jj facts are read again on the next paint; cleared when a read starts. */
	#vcsStale = true;
	/** When the last git/jj read started. */
	#vcsReadAt = 0;
	/** A read was skipped as too soon after the last one; paid by {@link #settleVcs}. */
	#vcsOwed = false;
	/** Pays an owed read once {@link VCS_READ_INTERVAL_MS} has passed. */
	#vcsTimer: NodeJS.Timeout | undefined;
	#vcsInFlight = false;
	#vcsGeneration = 0;
	/** The terminal reads and shows this session's checkout itself (Tern): no git/jj read and no `gh` here. */
	#checkoutHomed = false;
	readonly #defaultBranches = new Map<string, string>();
	/** Pull request lookups by `cwd\0branch`, each kept for {@link PR_TTL_MS}. */
	readonly #prs = new Map<string, { at: number; pr: { number: number; url: string } | null }>();
	#usageKey = "";
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageTimer: NodeJS.Timeout | undefined;
	/** Bumped per usage fetch. */
	#usageSequence = 0;
	/** The newest fetch whose answer applied: an older fetch's late answer is dropped. */
	#usageApplied = 0;
	#onResetExpiryNotice: ((notice: string) => void) | undefined;
	/** The last Codex weekly/saved-reset snapshot per account (provider + identity, not model). */
	readonly #codexResetSnapshots = new Map<string, CodexResetUsageSnapshot>();
	#onCodexResetFireworks: ((event: CodexResetFireworksEvent) => void) | undefined;
	#onPullRequest: ((pr: { number: number; url: string } | undefined) => void) | undefined;
	#lastPr: { number: number; url: string } | undefined;
	#disposed = false;
	readonly #live: Signal<boolean>;

	readonly settings: Accessor<StatusLineSettings> = computed(() => ({ ...this.#saved(), ...this.#preview() }));

	readonly #sessionFacts = computed(() => this.#buildSessionFacts());
	readonly #context = computed((previous: StatusFacts["context"] | undefined) => this.#readContext(previous));
	readonly #jobs = computed((previous: Pick<StatusFacts, "jobs" | "jobGlance"> | undefined) => {
		this.#revision();
		this.#toolRevision();
		const subagents = this.#subagents();
		let jobs = 0;
		for (const job of this.#session.getAsyncJobSnapshot({ recentLimit: 0 })?.running ?? []) {
			if (job.type !== "task" || job.agentId === undefined || !subagents.has(job.agentId)) jobs++;
		}
		const jobGlance = jobs > 0 ? latestJobWidget(this.#session.getRunningJobWidgets?.() ?? [])?.view : undefined;
		return previous?.jobs === jobs && previous.jobGlance === jobGlance
			? previous
			: { jobs, ...(jobGlance ? { jobGlance } : {}) };
	});
	// A long tool wait can cross a quota TTL or the active account's usage-limit reset.
	readonly #accountLabel = computed(() => {
		this.#sessionFacts();
		this.#toolRevision();
		const session = this.#session;
		const model = session.state.model ?? session.model;
		if (this.#live()) this.#syncUsage(model?.provider, model?.id);
		return session.getAnthropicSlowModeLabel();
	});
	readonly #speculation = computed(() => {
		this.#revision();
		this.#toolRevision();
		return this.#session.compactionSpeculation;
	});
	readonly #rate = computed(() => {
		this.#revision();
		this.#streamRevision();
		this.#toolRevision();
		this.#clock();
		return this.#tokensPerSecond(this.#modes());
	});

	/** The composer's live meter, independent of whether any status-bar segment changed. */
	readonly composerRate = computed(() => {
		this.#revision();
		this.#streamRevision();
		this.#clock();
		const rate = this.#session.tokenRate.rate();
		return rate === null ? undefined : Math.round(rate * 10) / 10;
	});
	// Compaction boundaries depend on capacity, not on the growing token count.
	readonly #contextWindow = computed(() => this.#context().window);
	readonly #boundaries = computed(() => {
		if (!this.#sessionFacts().autoCompact) return null;
		const contextWindow = this.#contextWindow();
		const session = this.#session;
		return contextWindow > 0
			? statusLineHost.computeCompactionBoundaries(session, contextWindow, session.state.model ?? session.model)
			: null;
	});

	readonly facts: Accessor<StatusFacts> = computed(() => {
		const sessionFacts = this.#sessionFacts();
		const context = this.#context();
		const boundaries = this.#boundaries();
		const settings = this.settings();
		const slowModeLabel = this.#accountLabel();
		return {
			...sessionFacts,
			context,
			...(boundaries ? { compaction: boundaries } : {}),
			...this.#jobs(),
			...(slowModeLabel ? { slowModeLabel } : {}),
			speculation: this.#speculation(),
			tokensPerSecond: this.#rate(),
			...(settings.leftSegments?.includes("cache") || settings.rightSegments?.includes("cache")
				? { promptCache: this.#session.getPromptCacheStatus?.(sessionFacts.now, context.tokens) }
				: {}),
		};
	});

	constructor(session: AgentViewSession, options?: { deferStartupReads?: boolean }) {
		this.#session = session;
		this.#live = signal(!options?.deferStartupReads);
		this.#saved = signal(statusLineHost.getSettings());
		this.#attach(session);
	}

	/** Start reading context, checkout and account usage once startup can spare the event loop. */
	finishStartup(): void {
		this.#live.set(true);
	}

	/** Called with the first PR the active branch resolves to (terminal title). */
	set onPullRequest(handler: ((pr: { number: number; url: string } | undefined) => void) | undefined) {
		this.#onPullRequest = handler;
	}

	/** Called with a warning about saved usage resets about to expire. */
	set onResetExpiryNotice(handler: ((notice: string) => void) | undefined) {
		this.#onResetExpiryNotice = handler;
	}

	/** Called when a Codex usage refresh shows a weekly reset arriving early or a saved reset banked. */
	set onCodexResetFireworks(handler: ((event: CodexResetFireworksEvent) => void) | undefined) {
		this.#onCodexResetFireworks = handler;
	}

	refresh(): void {
		clearTimeout(this.#streamBump);
		this.#streamBump = undefined;
		this.#revision.set(this.#revision.peek() + 1);
	}

	/** A job widget or the running job roster changed independently of the conversation. */
	refreshJobs(): void {
		this.#queueBump("tool");
	}

	refreshVcs(): void {
		this.#markVcsStale();
		// No run follows a user command to yield: settle now.
		this.#settleVcs();
		this.refresh();
	}

	/**
	 * Follow whether the terminal reads and shows this session's checkout
	 * itself (Tern's `checkout` event). While it does, git/jj and the branch's
	 * pull request are read from it, so none is read here and the title's pull
	 * request is released; turning it off reads again.
	 */
	setCheckoutHomed(homed: boolean): void {
		if (homed === this.#checkoutHomed) return;
		this.#checkoutHomed = homed;
		this.#vcsGeneration++;
		this.#vcs.set(undefined);
		this.#lastPr = undefined;
		this.#onPullRequest?.(undefined);
		this.refresh();
	}

	/** Zero the viewed session's active time; a running window is dropped too (its end then finds the meter idle). */
	resetActiveTime(): void {
		const meter = this.#meter();
		if (meter.activeMs === 0 && meter.since === undefined) return;
		meter.activeMs = 0;
		meter.since = undefined;
		this.#syncClock();
		this.refresh();
	}

	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.since !== undefined) return;
		meter.since = Date.now();
		this.#setBrandEdge(meter.since);
		this.#syncClock();
		this.refresh();
	}

	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.since === undefined) return;
		meter.activeMs += Math.max(0, Date.now() - meter.since);
		meter.since = undefined;
		this.#setBrandEdge(Date.now());
		this.#syncClock();
		this.refresh();
	}

	/**
	 * Mark the working-state edge and forget it once its fade is over. While a
	 * stale edge stands the bar keeps reading the terminal clock to ease the
	 * brand's color, which makes the renderer tick and repaint every frame for
	 * the rest of the session; dropping it after {@link BRAND_FADE_MS} leaves
	 * the same final color and stops the idle repaints.
	 */
	#setBrandEdge(at: number): void {
		this.#brandEdgeAt = at;
		clearTimeout(this.#brandFade);
		this.#brandFade = setTimeout(() => {
			this.#brandFade = undefined;
			if (this.#disposed) return;
			this.#brandEdgeAt = undefined;
			this.refresh();
		}, BRAND_FADE_MS);
		this.#brandFade.unref?.();
	}

	/** The viewed session's active time at `now`, the open window included. */
	activeMs(now = Date.now()): number {
		const meter = this.#meter();
		return meter.activeMs + (meter.since === undefined ? 0 : Math.max(0, now - meter.since));
	}

	#meter(): ActiveMeter {
		const session = this.#session;
		const file = session.sessionFile;
		let meter = this.#meters.get(session);
		if (!meter || (file !== undefined && meter.file !== undefined && meter.file !== file)) {
			// An open window outlives a file change while the run goes on (a fork or `/wt` during a background
			// wait), counted from this first read on the new file; its clock already ticks. A closed one
			// stays closed: a run starting on the new file opens it.
			const open = meter?.since !== undefined && session.runStartedAt !== undefined;
			meter = { activeMs: 0, since: open ? Date.now() : undefined, file };
			this.#meters.set(session, meter);
		}
		meter.file = file;
		return meter;
	}

	setHookStatus(key: string, text: string | undefined): void {
		const next = new Map(this.#hooks.peek());
		if (text === undefined) next.delete(key);
		else next.set(key, text);
		this.#hooks.set(next);
	}

	setAwaitingAnswer(awaiting: boolean): void {
		this.#awaiting.set(awaiting);
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collab.set(status);
	}

	setRunningSubagents(agentIds: readonly string[]): boolean {
		const current = this.#subagents.peek();
		if (current.size === agentIds.length && agentIds.every(id => current.has(id))) return false;
		this.#subagents.set(new Set(agentIds));
		return true;
	}

	/** Running subagents the badge counts. */
	get subagentCount(): number {
		return this.#subagents.peek().size;
	}

	setSession(session: AgentViewSession, focusedAgentId?: string): void {
		this.#focusedAgentId = focusedAgentId;
		if (session !== this.#session) {
			this.#session = session;
			this.#attach(session);
		}
		this.refresh();
	}

	previewSettings(settings: Partial<StatusLineSettings> | undefined): void {
		this.#preview.set(settings);
		if (settings === undefined) this.#saved.set(statusLineHost.getSettings());
		this.#syncClock();
	}

	/** Re-read the saved `statusLine.*` settings (after a settings change). */
	reloadSettings(): void {
		this.#saved.set(statusLineHost.getSettings());
		this.#syncClock();
	}

	/** Merge mode and badge facts the app owns. */
	setModes(update: Partial<StatusModes>): void {
		this.#modes.set({ ...this.#modes.peek(), ...update });
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompact.set(enabled);
	}

	/** The cwd or child-repository policy changed: discard facts and reads for the old checkout. */
	invalidateVcs(): void {
		this.#vcsGeneration++;
		this.#vcs.set(undefined);
		this.#vcsStale = true;
		if (this.#lastPr) {
			this.#lastPr = undefined;
			this.#onPullRequest?.(undefined);
		}
		this.refresh();
	}

	/** Context tokens and window as the bar shows them (the collab host broadcasts these). */
	contextBreakdown(): { usedTokens: number; contextWindow: number } {
		const usage = this.#session.getContextUsage();
		return {
			usedTokens: usage?.tokens ?? 0,
			contextWindow: usage?.contextWindow ?? this.#session.model?.contextWindow ?? 0,
		};
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		clearTimeout(this.#streamBump);
		clearInterval(this.#clockTimer);
		clearTimeout(this.#usageTimer);
		clearTimeout(this.#pricingTimer);
		clearTimeout(this.#brandFade);
		clearTimeout(this.#vcsTimer);
	}

	/** Wake at the shown cost's next time-based tariff change (peak/off-peak), idle or not, to repaint it. */
	#syncPricingTimer(cost: ModelCost | undefined, now: number): void {
		const at = cost?.timeBased && !this.#disposed ? getNextTimeBasedPricingTransition(cost, now) : undefined;
		if (at === this.#pricingAt) return;
		clearTimeout(this.#pricingTimer);
		this.#pricingTimer = undefined;
		this.#pricingAt = at;
		if (at === undefined) return;
		this.#pricingTimer = setTimeout(
			() => {
				this.#pricingTimer = undefined;
				this.#pricingAt = undefined;
				if (!this.#disposed) this.#clock.set(Date.now());
			},
			Math.max(0, at - now),
		);
		this.#pricingTimer.unref?.();
	}

	#attach(session: AgentViewSession): void {
		this.#unsubscribe?.();
		this.#unsubscribe = session.subscribe(event => {
			// Every delta would rebuild the facts (account, context usage, compaction) hundreds of times a second.
			if (event.type === "message_update") {
				this.#queueStreamBump();
				return;
			}
			if (event.type === "tool_execution_update" || event.type === "tool_stream_update") {
				this.#queueBump("tool");
				return;
			}
			if (event.type === "agent_start" || event.type === "turn_end") this.#markVcsStale();
			else if (event.type === "agent_end") this.#settleVcs();
			this.#queueBump("session");
		});
		this.#quota.set(undefined);
		this.#usageKey = "";
	}

	/** A full session refresh also covers tool progress in the same event burst. */
	#queueBump(kind: "session" | "tool"): void {
		if (this.#bumpQueued) {
			if (kind === "session") this.#bumpQueued = kind;
			return;
		}
		this.#bumpQueued = kind;
		queueMicrotask(() => {
			const queued = this.#bumpQueued;
			this.#bumpQueued = undefined;
			if (this.#disposed) return;
			if (queued === "tool") this.#toolRevision.set(this.#toolRevision.peek() + 1);
			else this.refresh();
		});
	}

	/** Refresh once {@link STREAM_REFRESH_MS} after a streaming delta, whatever arrives meanwhile. */
	#queueStreamBump(): void {
		if (this.#streamBump) return;
		this.#streamBump = setTimeout(() => {
			this.#streamBump = undefined;
			this.#streamRevision.set(this.#streamRevision.peek() + 1);
		}, STREAM_REFRESH_MS);
		this.#streamBump.unref?.();
	}

	/** Tick the wall clock once a second while a segment shows time or a turn's active window is open. */
	#syncClock(): void {
		const settings = this.settings();
		const segments = [...(settings.leftSegments ?? []), ...(settings.rightSegments ?? [])];
		const needs =
			segments.includes("time") ||
			(segments.includes("time_spent") && this.#meter().since !== undefined) ||
			this.#modes.peek().loop?.limit?.kind === "duration";
		if (needs && !this.#clockTimer) {
			this.#clockTimer = setInterval(() => this.#clock.set(Date.now()), 1_000);
			this.#clockTimer.unref?.();
		} else if (!needs && this.#clockTimer) {
			clearInterval(this.#clockTimer);
			this.#clockTimer = undefined;
		}
	}

	#readContext(previous: StatusFacts["context"] | undefined): StatusFacts["context"] {
		// Also re-read on full refreshes: a settings edit may change live tool metadata.
		this.#sessionFacts();
		this.#streamRevision();
		const session = this.#session;
		const model = session.state.model ?? session.model;
		const live = this.#live();
		const usage = live ? session.getContextUsage() : undefined;
		let contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
		let tokens = usage?.tokens ?? 0;
		let percent: number | null =
			!live || usage?.percent === null || contextWindow === 0 ? null : (tokens / contextWindow) * 100;
		const collab = this.#collab();
		const override = collab?.stateOverride?.contextUsage;
		if (override) {
			contextWindow = override.contextWindow || contextWindow;
			tokens = override.tokens ?? tokens;
			percent = override.percent ?? percent;
		}
		return previous?.tokens === tokens && previous.window === contextWindow && previous.percent === percent
			? previous
			: { tokens, window: contextWindow, percent };
	}

	#buildSessionFacts(): SessionFacts {
		this.#revision();
		const now = this.#clock();
		const session = this.#session;
		const settings = this.settings();
		const modes = this.#modes();
		const model = session.state.model ?? session.model;
		const segments = [...(settings.leftSegments ?? []), ...(settings.rightSegments ?? [])];
		const stats = session.sessionManager.getUsageStatistics();
		const collab = this.#collab();
		const autoCompact = this.#autoCompact();

		const advisorOverview = session.getAdvisorStatusOverview?.();
		const advisorStatuses = advisorOverview?.configured ? advisorOverview.advisors.map(a => a.status) : [];
		const advisorCost = session.getAdvisorCost();
		// Own calls plus the subagent tree, pushed with its dollars so the tree is summed once.
		const aiu = sessionAiu(
			{ nano: stats.aiuNano ?? 0, unknownCalls: stats.aiuUnknownCalls ?? 0 },
			this.#focusedAgentId === undefined ? modes.subagentTreeAiu : undefined,
		);
		const vcsFacts = this.#vcsFacts(segments);
		const goal = modes.goal ? session.getGoalModeState()?.goal : undefined;
		const thinkingLevel = session.state.thinkingLevel;
		const sessionManager = session.sessionManager;
		const subagents = this.#subagents();
		const turnStartedAt = this.#meter().since;
		const activeMs = this.activeMs(now);
		this.#syncPricingTimer(segments.includes("cost") ? model?.cost : undefined, now);
		const fastTier =
			model && session.isFastModeActive()
				? session.effectiveServiceTier(model) === "ultrafast"
					? "ultrafast"
					: "priority"
				: undefined;

		return {
			...(model
				? {
						model: {
							id: model.id,
							...(model.name ? { name: model.name } : {}),
							...(model.provider ? { provider: model.provider } : {}),
							thinking: model.thinking !== undefined,
							...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
						},
					}
				: {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(session.isAutoThinking ? { autoThinking: true } : {}),
			...(session.isAutoThinking && session.autoResolvedThinkingLevel()
				? { autoResolvedLevel: session.autoResolvedThinkingLevel() }
				: {}),
			...(fastTier ? { fastTier } : {}),
			...(displaysServingFallback(session, model) ? { servingFallback: true } : {}),
			...(advisorStatuses.length > 0
				? {
						advisor: {
							status: advisorStatuses.includes("error")
								? "error"
								: advisorStatuses.includes("quota_exhausted")
									? "quota_exhausted"
									: advisorStatuses.includes("running")
										? "running"
										: "idle",
							yielded: advisorOverview!.advisors.every(a => a.yielded),
						},
					}
				: {}),
			...(sessionManager.getSessionName() ? { sessionName: sessionManager.getSessionName() } : {}),
			sessionId: sessionManager.getSessionId(),
			...(modes.pinned ? { pinned: true } : {}),
			...(this.#focusedAgentId ? { focusedAgentId: this.#focusedAgentId } : {}),
			...(getActiveProfile() ? { profile: getActiveProfile() } : {}),
			usage: {
				input: stats.input,
				output: stats.output,
				cacheRead: stats.cacheRead,
				cacheWrite: stats.cacheWrite,
				orchestrationInput: stats.orchestrationInput,
				orchestrationOutput: stats.orchestrationOutput,
				premiumRequests: stats.premiumRequests,
				cost: stats.cost,
				subagentCost: stats.subagentCost,
				...(aiu ? { aiu } : {}),
			},
			usingSubscription: model ? session.modelRegistry.isUsingSubscription(model) : false,
			...(this.#focusedAgentId === undefined && modes.subagentTreeCost
				? { subagentTreeCost: modes.subagentTreeCost }
				: {}),
			...(advisorCost
				? { advisorCost: { cost: advisorCost, usingSubscription: session.isAdvisorUsingSubscription() } }
				: {}),
			...(model?.cost ? { pricingPeriod: getTimeBasedPricingPeriod(model.cost, now) } : {}),
			autoCompact,
			cwd: getProjectDir(),
			home: os.homedir(),
			...vcsFacts,
			...(segments.includes("hostname") ? { hostname: (shortHostname ??= os.hostname().split(".")[0]) } : {}),
			now,
			...(modes.plan ? { plan: modes.plan } : {}),
			...(session.getPrewalkState() ? { prewalk: true } : {}),
			...(modes.goal
				? {
						goal: {
							...modes.goal,
							...(goal ? { status: goal.status, tokensUsed: goal.tokensUsed } : {}),
							...(goal?.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
							showBudget: statusLineHost.goalStatusInFooter(session),
						},
					}
				: {}),
			...(modes.vibe ? { vibe: true } : {}),
			...(modes.loop ? { loop: modes.loop } : {}),
			...(modes.vim ? { vim: modes.vim } : {}),
			...(collab ? { collab: { role: collab.role, participantCount: collab.participantCount } } : {}),
			...(modes.stream ? { stream: modes.stream } : {}),
			...(modes.recording ? { recording: true } : {}),
			subagents: subagents.size,
			activeMs,
			...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
			...(this.#brandEdgeAt !== undefined ? { brandEdgeAt: this.#brandEdgeAt } : {}),
			...(this.#awaiting() ? { awaitingAnswer: true } : {}),
			...(this.#focusedAgentId === undefined ? { treePosition: this.#treePosition() } : {}),
			...(this.#quota() ? { quota: this.#quota() } : {}),
			hooks: [...this.#hooks()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
		};
	}

	/** The `tree` segment's position; only the main session's tree has one. */
	#treePosition(): StatusFacts["treePosition"] {
		const manager = this.#session.sessionManager as { getTreePosition?(): StatusFacts["treePosition"] };
		return manager.getTreePosition?.();
	}

	#tokensPerSecond(modes: StatusModes): number | null {
		const vibe = modes.vibe ? modes.vibeWorkerTokenRate?.() : null;
		if (vibe !== null && vibe !== undefined) return vibe;
		return statusLineHost.calculateTokensPerSecond(this.#session.messages, this.#session.isStreaming === true);
	}

	// ─── VCS ────────────────────────────────────────────────────────────────

	/** Git facts for the bar when a git segment shows; starts a refresh when the cached ones are stale. */
	#vcsFacts(segments: readonly string[]): Pick<StatusFacts, "git" | "worktree" | "activeRepoRoot"> {
		// Tern reads and shows the checkout itself: nothing to read here.
		if (!this.#live() || this.#checkoutHomed) return {};
		const wantsGit = segments.includes("git") || segments.includes("pr");
		const wantsPath = segments.includes("path");
		if (!statusLineHost.gitEnabled() || (!wantsGit && !wantsPath)) return {};
		const snapshot = this.#vcs();
		const cwd = getProjectDir();
		if (!this.#vcsInFlight && (this.#vcsStale || snapshot?.cwd !== cwd)) {
			void this.#readVcs(cwd, segments.includes("pr"));
		}
		if (!snapshot || snapshot.cwd !== cwd) return {};
		return {
			...(wantsGit ? { git: { branch: snapshot.branch, status: snapshot.status, pr: snapshot.pr } } : {}),
			...(snapshot.worktree ? { worktree: snapshot.worktree } : {}),
			...(snapshot.activeRepoRoot ? { activeRepoRoot: snapshot.activeRepoRoot } : {}),
		};
	}

	/** The repository may have changed: read again on the next paint, or owe the read when the last one started too recently. */
	#markVcsStale(): void {
		if (Date.now() - this.#vcsReadAt >= VCS_READ_INTERVAL_MS) this.#vcsStale = true;
		else this.#vcsOwed = true;
	}

	/** Nothing will mark the facts stale for a while (the run yielded): pay an owed read once the interval has passed. */
	#settleVcs(): void {
		if (!this.#vcsOwed || this.#vcsTimer || this.#disposed) return;
		this.#vcsTimer = setTimeout(
			() => {
				this.#vcsTimer = undefined;
				if (this.#disposed) return;
				this.#vcsStale = true;
				this.refresh();
			},
			Math.max(0, this.#vcsReadAt + VCS_READ_INTERVAL_MS - Date.now()),
		);
		this.#vcsTimer.unref?.();
	}

	async #readVcs(cwd: string, wantsPr: boolean): Promise<void> {
		this.#vcsInFlight = true;
		this.#vcsStale = false;
		this.#vcsReadAt = Date.now();
		this.#vcsOwed = false;
		clearTimeout(this.#vcsTimer);
		this.#vcsTimer = undefined;
		const generation = this.#vcsGeneration;
		let next: VcsSnapshot | undefined;
		try {
			const active = statusLineHost.resolveActiveRepo(cwd);
			const gitCwd = active?.repoRoot ?? cwd;
			const repository = vcs.repoForDisplay(gitCwd) ?? vcs.repo(gitCwd);
			if (!repository) {
				next = { cwd, branch: null, status: null, pr: null };
			} else {
				const git = repository.asGit();
				const headBranch = (head: ReturnType<NonNullable<typeof git>["headSync"]> | undefined) =>
					head?.kind === "ref" ? (head.branch ?? head.refName ?? "HEAD") : head ? "detached" : null;
				const branch = git ? headBranch(git.headSync()) : ((await repository.label()) ?? null);
				// A colocated jj repository shows its own label; pull requests follow the git branch beneath it.
				const operational = git ?? vcs.repo(gitCwd)?.asGit();
				const prBranch = git ? branch : operational ? headBranch(operational.headSync()) : null;
				const status = (await repository.statusSummary().catch(() => null)) ?? null;
				const worktree = linkedWorktreeNames(git?.linkedWorktree());
				// The default branch has no pull request of its own: no lookup for it.
				const pr =
					wantsPr && prBranch && prBranch !== "detached" && prBranch !== (await this.#defaultBranch(gitCwd))
						? await this.#lookupPr(gitCwd, prBranch)
						: null;
				next = {
					cwd,
					branch,
					status: status && { staged: status.staged, unstaged: status.unstaged, untracked: status.untracked },
					pr,
					...(worktree ? { worktree } : {}),
					...(active ? { activeRepoRoot: active.relativeRepoRoot } : {}),
				};
			}
		} catch {
			next = { cwd, branch: null, status: null, pr: null };
		} finally {
			this.#vcsInFlight = false;
		}
		if (this.#disposed) return;
		// Invalidated while this read ran (a turn ended, the cwd moved): read again.
		if (this.#vcsStale) this.refresh();
		if (generation !== this.#vcsGeneration) return;
		const previous = this.#vcs.peek();
		if (JSON.stringify(previous) !== JSON.stringify(next)) this.#vcs.set(next);
		const pr = next.pr ?? undefined;
		if (pr?.url !== this.#lastPr?.url) {
			this.#lastPr = pr;
			this.#onPullRequest?.(pr);
		}
	}

	/** The repository's default branch (`main` until resolved), cached per directory. */
	async #defaultBranch(cwd: string): Promise<string> {
		let branch = this.#defaultBranches.get(cwd);
		if (branch === undefined) {
			branch =
				(await vcs
					.git(cwd)
					?.defaultBranch()
					.catch(() => undefined)) ?? "main";
			this.#defaultBranches.set(cwd, branch);
		}
		return branch;
	}

	async #lookupPr(cwd: string, branch: string): Promise<{ number: number; url: string } | null> {
		const key = `${cwd}\0${branch}`;
		const cached = this.#prs.get(key);
		if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.pr;
		const entry: { at: number; pr: { number: number; url: string } | null } = { at: Date.now(), pr: null };
		this.#prs.set(key, entry);
		try {
			const result = await statusLineHost.lookupPullRequest(cwd);
			if (result.exitCode !== 0) return null;
			const parsed = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
			entry.pr =
				typeof parsed.number === "number" && typeof parsed.url === "string"
					? { number: parsed.number, url: parsed.url }
					: null;
			return entry.pr;
		} catch {
			return null;
		}
	}

	// ─── Usage quota ────────────────────────────────────────────────────────

	/** Compare the account's Codex snapshot with the previous refresh's; a celebration-worthy change fires the handler. */
	#noteCodexResets(reports: readonly UsageReport[], context: Parameters<typeof quotaFromReports>[1]): void {
		const snapshot = codexResetSnapshot(reports, context.identity);
		if (!snapshot) return;
		const account = `${context.provider}\0${JSON.stringify(context.identity ?? {})}`;
		const previous = this.#codexResetSnapshots.get(account);
		this.#codexResetSnapshots.set(account, snapshot);
		if (!previous || !statusLineHost.codexResetFireworksEnabled()) return;
		const event = detectCodexResetFireworks(previous, snapshot);
		if (event) this.#onCodexResetFireworks?.(event);
	}

	#syncUsage(provider: string | undefined, modelId: string | undefined): void {
		const session = this.#session;
		if (this.#disposed || !provider || !statusLineHost.canFetchUsageReports(session)) return;
		const identity = statusLineHost.activeAccount(session, provider);
		const key = [provider, modelId ?? "", JSON.stringify(identity ?? {})].join("\0");
		if (key !== this.#usageKey) {
			this.#usageKey = key;
			this.#usageFetchedAt = 0;
			if (this.#quota.peek() !== undefined) queueMicrotask(() => this.#quota.set(undefined));
		}
		if (this.#usageInFlight || (this.#usageFetchedAt > 0 && Date.now() - this.#usageFetchedAt < USAGE_TTL_MS)) return;
		this.#usageInFlight = true;
		this.#usageTimer = setTimeout(
			() => void this.#fetchUsage(session, key, { provider, modelId, identity }),
			USAGE_START_DELAY_MS,
		);
		this.#usageTimer.unref?.();
	}

	async #fetchUsage(
		session: StatusSession,
		key: string,
		context: Parameters<typeof quotaFromReports>[1],
	): Promise<void> {
		const sequence = ++this.#usageSequence;
		const controller = new AbortController();
		// At the deadline the next refresh may run; a late answer still applies unless a newer one did.
		const release = (): void => {
			if (this.#usageSequence !== sequence || !this.#usageInFlight) return;
			this.#usageInFlight = false;
			this.#usageFetchedAt = Date.now();
		};
		const deadline = setTimeout(() => {
			controller.abort();
			release();
		}, USAGE_TIMEOUT_MS);
		deadline.unref?.();
		try {
			const reports = await statusLineHost.fetchUsageReports(session, controller.signal);
			if (this.#disposed || this.#session !== session || this.#usageKey !== key) return;
			if (sequence < this.#usageApplied) return;
			this.#usageApplied = sequence;
			this.#quota.set(quotaFromReports(reports, context, statusLineHost, Date.now()));
			if (this.#focusedAgentId === undefined && Array.isArray(reports) && this.#onResetExpiryNotice) {
				const notice = statusLineHost.resetExpiryNotice?.(session, reports, Date.now());
				if (notice) this.#onResetExpiryNotice(notice);
			}
			if (context.provider === "openai-codex" && Array.isArray(reports)) this.#noteCodexResets(reports, context);
		} catch {
			// A failed fetch keeps the last quota; the TTL retries.
		} finally {
			clearTimeout(deadline);
			release();
		}
	}
}
