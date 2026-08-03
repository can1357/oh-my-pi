/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentHubRegistry — status, unread irc count,
 *   current/last task, last activity. Navigate with keys, wheel, hover, and
 *   click; `r` revives a parked agent, `x` aborts + releases one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Container, type OverlayHandle, type TUI } from "../tui";
import { matchesKey } from "../keys";
import { routeSelectListMouse, routeSgrMouseInput, type SelectListMouseTarget } from "../mouse";
import { padding, visibleWidth, wrapTextWithAnsi } from "../utils";
import { formatAge, formatNumber, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import {
	type AgentActivitySource,
	type AgentActivityKind,
	type AgentActivityRow,
	activityRowsFromProgress,
} from "./agent-activity";
import type { KeyId } from "../app-keybindings";
import type { MessageRenderer } from "../chat/extension-types";
import type { AgentLifecycleLike, IrcBusLike } from "./agent-hub-types";
import { type AgentRecordLike, type AgentHubRegistry, type AgentStatus, MAIN_AGENT_ID } from "./agent-hub-types";
import { USER_INTERRUPT_LABEL } from "../chat/messages";
import { shortenPath, truncateToWidth } from "../render/render-utils";
import { formatLocalDateTimeWithOffset } from "../chrome/local-date";
import type { ObservableSession, SessionObserverRegistry } from "./session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	type AgentMetrics,
	type AggregateMetrics,
	aggregateMetrics,
	progressMetrics,
	projectAgentTree,
	STATUS_ORDER,
} from "./agent-hub-projection";
import {
	clampHubLine,
	contextGauge,
	formatChildIds,
	formatCost,
	formatMetricColumns,
	formatMetricDuration,
	formatMetrics,
	formatRoleBadge,
	modelBadge,
	type RosterRender,
	sanitizeLine,
	statusGlyph,
	statusText,
	treeBranch,
	treeContinuation,
	treeMetadataIndent,
} from "./agent-hub-renderer";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { AgentTranscriptViewer, type AgentTranscriptSource } from "./agent-transcript-viewer";
import type { AgentRoleDisplay } from "./agent-hub-renderer";
import { fuzzyMatch } from "../fuzzy";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";

/** Two-pane mode needs a useful roster and a readable inspector. */
const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_MIN_WIDTH = 48;

export type AgentHubSection = "agents" | "activity";
type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";

type HubViewMode = "roster" | "tree";

/** Refresh cadence for the relative-time column. */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

function activityGlyph(row: AgentActivityRow): string {
	if (row.status === "error") return theme.fg("error", theme.status.error);
	if (row.status === "aborted") return theme.fg("warning", theme.status.aborted);
	if (row.status === "pending") return theme.fg("accent", theme.status.running);
	switch (row.kind) {
		case "response":
			return theme.fg("success", "◆");
		case "tool":
			return theme.fg("success", theme.status.success);
		case "irc":
			return theme.fg("accent", "→");
		case "lifecycle":
			return theme.fg("muted", "○");
	}
}

function activityClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}
/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubDeps<TRecord extends AgentRecordLike = AgentRecordLike> {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Resolve the current display metadata for a model role. */
	getRoleInfo?: (role: string) => AgentRoleDisplay;
	/** Host-backed transcript parsing and local reads. */
	transcript: AgentTranscriptSource;
	/** Register persisted roster entries while the overlay remains alive. */
	loadPersisted: (shouldContinue: () => boolean) => Promise<void>;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Registry supplying the roster. */
	registry: AgentHubRegistry<TRecord>;
	/** Resolve lifecycle actions lazily when a local action needs them. */
	lifecycle: () => AgentLifecycleLike<TRecord>;
	/** Host message bus supplying unread counts. */
	irc: IrcBusLike;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Initial top-level projection; slash commands deep-link into this surface. */
	initialSection?: AgentHubSection;
	/** Unified local or remote activity source. */
	activity: AgentActivitySource;
	/** Whether observer progress should update live activity rows. */
	manageActivityLive?: boolean;

	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
}

export class AgentHubOverlayComponent<TRecord extends AgentRecordLike = AgentRecordLike>
	extends Container
	implements SelectListMouseTarget
{
	#registry: AgentHubRegistry<TRecord>;
	#observers: SessionObserverRegistry;
	#getRoleInfo: ((role: string) => AgentRoleDisplay) | undefined;
	#transcript: AgentTranscriptSource;
	#irc: IrcBusLike;
	#lifecycle: () => AgentLifecycleLike<TRecord>;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#remote: AgentHubRemote | undefined;
	#disposed = false;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;
	/** Prevent the async persisted-session scan from flashing a false empty state. */
	#loadingPersistedSubagents = false;
	#section: AgentHubSection;
	#activity: AgentActivitySource;
	#manageActivityLive: boolean;
	#activityRows: AgentActivityRow[] = [];
	#selectedActivityRow = 0;
	#activityFilter: ActivityFilter = "all";
	#activityScope: ActivityScope = "all";
	#activitySearch = "";
	#activitySearchEditing = false;
	#activityFollow = true;
	#activitySyncGeneration = 0;
	#activitySyncStamp = new Map<string, string>();

	// Table state
	#rows: TRecord[] = [];
	#statusCounts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
	#selectedRow = 0;
	/** Stable roster order captured on first refresh: keyboard navigation must
	 *  not jump as agents heartbeat. Existing agent generations keep their rank
	 *  while the hub is open; newly appearing generations append at the end. */
	#rowOrder: Map<TRecord, number> | undefined;
	#nextRowOrder = 0;
	#hoveredRow: number | null = null;
	/** Per-render screen-line to agent-row map, shared by click and hover routing. */
	#hitRows: Array<number | undefined> = [];
	#notice: string | undefined;
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;
	/** Operational ordering by default; tree mode groups descendants under their spawner. */
	#viewMode: HubViewMode = "roster";
	#treeDepthById = new Map<string, number>();
	#treeParentById = new Map<string, string>();
	#treeLastSiblingById = new Map<string, boolean>();
	#treeMaxDepth = 0;
	/** Fuzzy agent filter (`/`), applied to id and display name. */
	#agentFilter = "";
	#agentFilterEditing = false;
	/** Current observer index and summary data, rebuilt on source changes rather than every paint. */
	#observedById = new Map<string, ObservableSession>();
	#aggregate: AggregateMetrics = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: 0,
		durationKind: "active",
		reportedAgents: 0,
		activeDurationAgents: 0,
	};
	#childrenByParent = new Map<string, TRecord[]>();
	/** Transcript-derived fallback stats are sampled only on the bounded age cadence. */
	#sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	/** Avoid a cadence-time row scan for the common persisted-only roster. */
	#hasFallbackLiveSessions = false;
	/** On narrow terminals Tab replaces the roster with the selected-agent inspector. */
	#narrowDetailsOpen = false;
	/** Pane-local roster hits from the last body render, translated to frame lines after layout. */
	#paneHitRows: Array<number | undefined> = [];
	#contentRowsLast = 1;
	#renderRosterPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? this.#contentRowsLast));
		const roster = this.#renderRosterPanel(width, rows, this.#observedById);
		this.#paneHitRows = roster.hitRows;
		return roster.lines;
	};
	#renderDetailPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? this.#contentRowsLast));
		return this.#renderDetailPanel(this.#rows[this.#selectedRow], width, rows, this.#observedById);
	};
	readonly #split = new SplitPane({
		left: this.#renderRosterPane,
		right: this.#renderDetailPane,
		leftSize: { ratio: 0.58, min: ROSTER_MIN_WIDTH },
		rightMinWidth: DETAIL_MIN_WIDTH,
		splitAt: SPLIT_MIN_WIDTH,
		narrowPane: "left",
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frameTop = new PanelRows();
	readonly #frameDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#frameTop, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#frameDivider, height: 1 },
			{ content: this.#frameFooter, height: 1 },
			{ content: this.#frameBottom, height: 1 },
		],
	});
	/** Scroll offset for the selected-agent inspector when its content overflows. */
	#detailScrollOffset = 0;
	#detailAgentId: string | undefined;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#isBuiltInTool: ((name: string) => boolean) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps<TRecord>) {
		super();
		this.#section = deps.initialSection ?? "agents";
		this.#activity = deps.activity;
		this.#manageActivityLive = deps.manageActivityLive ?? true;
		this.#registry = deps.registry;
		this.#observers = deps.observers;
		this.#getRoleInfo = deps.getRoleInfo;
		this.#transcript = deps.transcript;
		this.#irc = deps.irc;
		this.#lifecycle = deps.lifecycle;
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#loadingPersistedSubagents = !this.#remote && Boolean(deps.sessionFile?.endsWith(".jsonl"));
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#isBuiltInTool = deps.isBuiltInTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		this.#ageTimer = setInterval(() => {
			if (this.#hasFallbackLiveSessions) {
				this.#refreshAggregate(true);
			}
			this.#requestRender();
		}, AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: deps
					.loadPersisted(() => !this.#disposed)
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.finally(() => {
						// Clear the loading flag first so this refresh captures the
						// full status/recency ranking rather than a partial roster.
						this.#loadingPersistedSubagents = false;
						if (!this.#disposed) {
							this.#refreshRows();
							this.#requestRender();
						}
					});
		this.#refreshRows();
	}

	/**
	 * Whether the current table view has no agents to show (every registered agent
	 * except Main). Persisted historical rows may arrive later; callers that need
	 * those included must wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		const termHeight = this.#ui.terminal?.rows || process.stdout.rows || 40;
		const frame = (
			this.#section === "activity"
				? this.#renderActivityTable(width, termHeight)
				: this.#renderTable(width, termHeight)
		).map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;

		// A tiny terminal can leave less room than the fixed chrome needs. Keep
		// the title and footer visible instead of spilling into scrollback.
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}

	handleInput(keyData: string): void {
		if (
			routeSgrMouseInput(keyData, event => {
				if (event.wheel === null && this.#section === "agents" && this.#split.mode === "split") {
					const frameHit = this.#frame.locate(event.row, event.col);
					const pane = frameHit?.index === 1 ? this.#split.locate(frameHit.line, frameHit.col) : undefined;
					if (frameHit?.index === 1 && pane?.pane !== "left") return false;
				}
				return routeSelectListMouse(this, event, event.row);
			})
		) {
			return;
		}

		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (this.#section === "activity" && this.#activitySearchEditing) {
			this.#handleActivitySearchInput(keyData);
			return;
		}
		if (keyData === "1") {
			this.#switchSection("agents");
			return;
		}
		if (keyData === "2") {
			this.#switchSection("activity");
			return;
		}
		if (this.#section === "activity") this.#handleActivityInput(keyData);
		else this.#handleTableInput(keyData);
	}

	/**
	 * Seed the table's left-left close detector with the current time so a single
	 * subsequent `←` (within {@link LEFT_TAP_WINDOW_MS}) dismisses the hub.
	 *
	 * The editor's own double-tap detector consumes the `←←` that opens the hub,
	 * leaving this detector at its fresh `0` — without this handoff the user would
	 * have to press `←←` a second time to escape. Called by the opener when the hub
	 * was raised by that gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string, entryId?: string): void {
		if (this.#disposed || !this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			transcript: this.#transcript,
			initialEntryId: entryId,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			isBuiltInTool: this.#isBuiltInTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(viewer),
			onHubClose: () => {
				if (this.#disposed) return;
				this.#closeTranscriptOverlay(viewer);
				if (!this.#disposed) this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(expectedViewer?: AgentTranscriptViewer): void {
		if (expectedViewer && this.#transcriptViewer !== expectedViewer) return;
		const overlay = this.#transcriptOverlay;
		const viewer = this.#transcriptViewer;
		if (!overlay && !viewer) return;
		overlay?.hide();
		this.#transcriptOverlay = undefined;
		viewer?.dispose();
		this.#transcriptViewer = undefined;
		if (!this.#disposed) {
			if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
			this.#requestRender();
		}
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#onDataChange();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		// Remote proxies (murmur-q00p) are messaging peers, not local sessions: they have no
		// session/transcript and the hub's focus/revive/kill act on the local lifecycle, so exclude
		// them here. They stay discoverable via `hub list` and reachable by broadcast.
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID && ref.kind !== "remote");
		this.#observedById = new Map();
		for (const session of this.#observers.getSessions()) this.#observedById.set(session.id, session);
		// Stable roster order: capture the status+recency ranking once so keyboard
		// navigation is not disrupted by heartbeats (issue #10524). Existing rows
		// keep their rank while the hub is open; new agents append at the end.
		// Defer the capture until persisted-subagent discovery settles so a
		// mid-scan refresh cannot freeze a partial roster (the remaining agents
		// would otherwise append in readdir order instead of being ranked).
		const rowOrder = this.#rowOrder;
		let ordered: TRecord[];
		if (!rowOrder) {
			ordered = refs.sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					b.lastActivity - a.lastActivity ||
					a.id.localeCompare(b.id),
			);
			if (!this.#loadingPersistedSubagents && ordered.length > 0) {
				this.#rowOrder = new Map();
				for (const ref of ordered) this.#rowOrder.set(ref, this.#nextRowOrder++);
			}
		} else {
			for (const rankedRef of rowOrder.keys()) {
				if (!refs.includes(rankedRef)) rowOrder.delete(rankedRef);
			}
			ordered = refs.sort(
				(a, b) => (rowOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (rowOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
			);
			for (const ref of ordered) {
				if (!rowOrder.has(ref)) rowOrder.set(ref, this.#nextRowOrder++);
			}
		}
		const query = this.#agentFilter.trim();
		const rosterRows =
			query.length > 0
				? ordered.filter(ref => fuzzyMatch(query, `${ref.id} ${ref.displayName ?? ""}`).matches)
				: ordered;

		if (this.#viewMode === "tree") {
			const tree = projectAgentTree(rosterRows);
			this.#rows = tree.rows;
			this.#treeDepthById = tree.depthById;
			this.#treeParentById = tree.parentById;
			this.#treeLastSiblingById = tree.lastSiblingById;
			this.#treeMaxDepth = 0;
			for (const depth of tree.depthById.values()) this.#treeMaxDepth = Math.max(this.#treeMaxDepth, depth);
		} else {
			this.#rows = rosterRows;
			this.#treeDepthById.clear();
			this.#treeParentById.clear();
			this.#treeLastSiblingById.clear();
			this.#treeMaxDepth = 0;
		}
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		const detailAgentId = this.#rows[this.#selectedRow]?.id;
		if (detailAgentId !== this.#detailAgentId) {
			this.#detailAgentId = detailAgentId;
			this.#detailScrollOffset = 0;
		}

		this.#childrenByParent.clear();
		for (const ref of rosterRows) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const children = this.#childrenByParent.get(parent);
			if (children) children.push(ref);
			else this.#childrenByParent.set(parent, [ref]);
		}
		this.#statusCounts = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of rosterRows) this.#statusCounts[ref.status]++;
		this.#refreshAggregate();
		this.#refreshActivityData(rosterRows);
		this.#refreshActivityRows();
	}

	#refreshActivityData(refs: readonly TRecord[]): void {
		if (this.#manageActivityLive) {
			const liveIds = new Set<string>();
			for (const ref of refs) {
				const observed = this.#observedById.get(ref.id);
				if (observed?.progress) {
					liveIds.add(ref.id);
					this.#activity.setLive(ref.id, activityRowsFromProgress(observed.progress, observed.lastUpdate));
				}
			}
			for (const ref of refs) {
				if (!liveIds.has(ref.id)) this.#activity.setLive(ref.id, []);
			}
		}

		const generation = ++this.#activitySyncGeneration;
		const pending: Promise<void>[] = [];
		for (const ref of refs) {
			if (!this.#remote && !ref.sessionFile) continue;
			const stamp = `${ref.sessionFile ?? ""}:${ref.lastActivity}`;
			if (this.#activitySyncStamp.get(ref.id) === stamp) continue;
			this.#activitySyncStamp.set(ref.id, stamp);
			pending.push(this.#activity.sync(ref.id, ref.sessionFile));
		}
		if (pending.length === 0) return;
		void Promise.all(pending)
			.then(() => {
				if (this.#disposed || generation !== this.#activitySyncGeneration) return;
				this.#refreshActivityRows();
				this.#requestRender();
			})
			.catch(() => {
				// Individual sync paths already guard I/O failures; keep the hub render loop alive.
			});
	}

	#activityAgentIds(): ReadonlySet<string> | undefined {
		if (this.#activityScope === "all") return undefined;
		const selected = this.#rows[this.#selectedRow]?.id;
		if (!selected) return new Set();
		const ids = new Set([selected]);
		if (this.#activityScope === "agent") return ids;
		const queue = [selected];
		for (let index = 0; index < queue.length; index++) {
			for (const child of this.#childrenByParent.get(queue[index]!) ?? []) {
				if (ids.has(child.id)) continue;
				ids.add(child.id);
				queue.push(child.id);
			}
		}
		return ids;
	}

	#refreshActivityRows(): void {
		const kinds: ReadonlySet<AgentActivityKind> | undefined =
			this.#activityFilter === "responses"
				? new Set(["response"])
				: this.#activityFilter === "tools"
					? new Set(["tool"])
					: undefined;
		let rows = this.#activity.query({
			agentIds: this.#activityAgentIds(),
			kinds,
			search: this.#activitySearch,
			limit: 2_000,
		});
		if (this.#activityFilter === "errors") rows = rows.filter(row => row.status === "error");
		this.#activityRows = rows;
		if (rows.length === 0) this.#selectedActivityRow = 0;
		else if (this.#activityFollow) this.#selectedActivityRow = rows.length - 1;
		else this.#selectedActivityRow = Math.min(this.#selectedActivityRow, rows.length - 1);
	}

	#metricsFor(ref: TRecord, observed: ObservableSession | undefined): AgentMetrics | undefined {
		if (observed?.progress) return progressMetrics(observed);
		if (ref.history?.metrics) return ref.history.metrics;
		const session = this.#fallbackStatsSession(ref, observed);
		return session ? this.#sessionMetrics.get(session)?.metrics : undefined;
	}

	#fallbackStatsSession(
		ref: TRecord,
		observed: ObservableSession | undefined,
	): NonNullable<TRecord["session"]> | undefined {
		if (observed?.progress) return undefined;
		const session = ref.session;
		return session && typeof session.getSessionStats === "function" ? session : undefined;
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#sectionTabs(): string {
		const tab = (section: AgentHubSection, label: string): string =>
			this.#section === section
				? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)))
				: theme.fg("muted", ` ${label} `);
		return `${tab("agents", "1 Agents")}${theme.fg("dim", theme.sep.dot)}${tab("activity", "2 Activity")}`;
	}

	#renderActivityTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const innerWidth = Math.max(1, width - 4);
		const contentRows = Math.max(1, termHeight - 4);
		const body: string[] = [this.#sectionTabs()];
		const selectedAgent = this.#rows[this.#selectedRow]?.id;
		const scope =
			this.#activityScope === "all"
				? "all agents"
				: this.#activityScope === "agent"
					? (selectedAgent ?? "selected agent")
					: `${selectedAgent ?? "selected"} subtree`;
		const search = this.#activitySearchEditing
			? theme.fg("accent", `search: ${this.#activitySearch}▌`)
			: this.#activitySearch
				? `search: ${this.#activitySearch}`
				: "search: —";
		body.push(
			theme.fg(
				"dim",
				`${scope}${theme.sep.dot}${this.#activityFilter}${theme.sep.dot}${this.#activityFollow ? "following" : "paused"}${theme.sep.dot}${search}`,
			),
		);
		if (contentRows >= 8) body.push("");

		const budget = Math.max(0, contentRows - body.length);
		if (this.#activityRows.length === 0 && budget > 0) {
			body.push(theme.fg("muted", this.#activitySearch ? "No matching activity" : "No agent activity recorded yet"));
		} else if (budget > 0) {
			const selected = Math.min(this.#selectedActivityRow, this.#activityRows.length - 1);
			const start = this.#activityFollow
				? Math.max(0, this.#activityRows.length - budget)
				: Math.max(0, Math.min(selected - Math.floor(budget / 2), this.#activityRows.length - budget));
			const end = Math.min(this.#activityRows.length, start + budget);
			if (start > 0) {
				body.push(theme.fg("dim", `… ${start} earlier`));
			}
			for (let index = start + Number(start > 0); index < end; index++) {
				this.#hitRows[1 + body.length] = index;
				body.push(this.#formatActivityRow(this.#activityRows[index]!, index === selected, innerWidth));
			}
		}
		while (body.length < contentRows) body.push("");

		const lines = [topBorder(width, "Agent Hub")];
		for (const line of body.slice(0, contentRows)) lines.push(row(line, width));
		lines.push(divider(width));
		lines.push(
			row(
				theme.fg(
					"dim",
					"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close",
				),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}

	#formatActivityRow(activity: AgentActivityRow, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const ref = this.#registry.get(activity.agentId);
		const observed = this.#observedById.get(activity.agentId);
		const role = observed?.progress?.modelRole ?? ref?.history?.modelRole;
		const roleBadge = role && this.#getRoleInfo ? `${formatRoleBadge(role, this.#getRoleInfo(role))} ` : "";
		const agent = sanitizeLine(activity.agentId, Math.max(8, Math.min(18, Math.floor(width * 0.18))));
		const title = sanitizeLine(
			activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title,
			width,
		);
		const prefix =
			`${cursor} ${theme.fg("dim", activityClock(activity.timestamp))} ${activityGlyph(activity)} ` +
			`${roleBadge}${theme.bold(agent)} ${theme.fg(activity.kind === "response" ? "success" : "muted", title)}`;
		const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(theme.sep.dot));
		return `${prefix}${theme.fg("dim", theme.sep.dot)}${sanitizeLine(activity.summary, available)}`;
	}
	#renderTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const contentRows = Math.max(1, termHeight - 4);
		this.#contentRowsLast = contentRows;
		this.#paneHitRows = [];
		const selected = this.#rows[this.#selectedRow];
		this.#split.setNarrowPane(this.#narrowDetailsOpen ? "right" : "left");
		this.#split.setHeight(contentRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const innerWidth = Math.max(1, width - 4);
		let topLine: string;
		if (isSplit) {
			topLine = topBorderSplit(width, "Agent Hub", geometry.left?.width ?? 0);
		} else if (this.#narrowDetailsOpen && selected) {
			topLine = topBorder(width, `Agent Hub · ${selected.id}`);
		} else {
			topLine = topBorder(width, "Agent Hub");
		}
		const dividerLine = isSplit && geometry.left ? dividerSplit(width, geometry.left.width) : divider(width);
		this.#frameTop.setLines([topLine]);
		this.#frameDivider.setLines([dividerLine]);
		this.#frameFooter.setLines([row(this.#footer(isSplit ? false : this.#narrowDetailsOpen, innerWidth), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(contentRows + 4);
		const lines = [...this.#frame.render(width)];
		const bodyRow = this.#frame.childRect(1)?.row ?? 1;
		for (let i = 0; i < this.#paneHitRows.length; i++) {
			const hit = this.#paneHitRows[i];
			if (hit !== undefined) this.#hitRows[bodyRow + i] = hit;
		}
		return lines;
	}

	#footer(showingNarrowDetails: boolean, availableWidth: number): string {
		const nextView = this.#viewMode === "roster" ? "by parent" : "flat";
		const filter =
			this.#agentFilter.length > 0 ? `/${this.#agentFilter}${this.#agentFilterEditing ? "▌" : ""}  ·  ` : "";
		if (showingNarrowDetails) {
			return theme.fg(
				"dim",
				`${filter}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:${nextView}  Esc:roster`,
			);
		}
		if (availableWidth < 96) {
			return theme.fg("dim", `${filter}j/k:select  Enter:open  t:${nextView}  Tab:details  r/x:manage  Esc:close`);
		}
		return theme.fg(
			"dim",
			`${filter}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:${nextView}  r:revive  x:kill  Esc:close`,
		);
	}

	#renderRosterPanel(width: number, rows: number, observedById: ReadonlyMap<string, ObservableSession>): RosterRender {
		const lines = this.#summaryLines(width);
		const hitRows: Array<number | undefined> = Array.from({ length: lines.length });
		if (rows >= 8) {
			lines.push("");
			hitRows.push(undefined);
		}

		const noticeLines = this.#notice ? [theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width)))] : [];
		const budget = Math.max(0, rows - lines.length - noticeLines.length);
		if (this.#rows.length === 0) {
			if (this.#loadingPersistedSubagents) {
				if (budget > 0) {
					lines.push(`${statusGlyph("running")} ${theme.fg("accent", "Loading saved agents…")}`);
					hitRows.push(undefined);
				}
			} else {
				const emptyState = [
					`${theme.fg("muted", theme.status.shadowed)} ${theme.bold("No agents in this session")}`,
					theme.fg("dim", "Finished, parked, and killed subagents remain with the session that created them."),
					theme.fg("dim", "Resume that session with omp-dev --continue, or spawn a task here."),
				];
				for (const line of emptyState.slice(0, budget)) {
					lines.push(line);
					hitRows.push(undefined);
				}
			}
		} else if (budget > 0) {
			const window = this.#renderRosterWindow(width, budget, observedById);
			lines.push(...window.lines);
			hitRows.push(...window.hitRows);
		}
		for (const notice of noticeLines) {
			lines.push(notice);
			hitRows.push(undefined);
		}
		while (lines.length < rows) {
			lines.push("");
			hitRows.push(undefined);
		}
		return { lines: lines.slice(0, rows), hitRows: hitRows.slice(0, rows) };
	}

	#renderRosterWindow(
		width: number,
		budget: number,
		_observedById: ReadonlyMap<string, ObservableSession>,
	): RosterRender {
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];
		const rendered = new Map<number, string[]>();
		const entryAt = (index: number): string[] => {
			const cached = rendered.get(index);
			if (cached) return cached;
			const entry = this.#renderEntry(
				this.#rows[index],
				index === this.#selectedRow,
				width,
				this.#observableFor(this.#rows[index].id),
				index === this.#hoveredRow,
			);
			rendered.set(index, entry);
			return entry;
		};
		const appendEntry = (index: number, entry = entryAt(index)): void => {
			for (const line of entry) {
				lines.push(line);
				hitRows.push(index);
			}
		};

		let start = this.#selectedRow;
		let end = this.#selectedRow + 1;
		let used = entryAt(this.#selectedRow).length;
		if (used > budget) {
			appendEntry(this.#selectedRow, entryAt(this.#selectedRow).slice(0, budget));
			return { lines, hitRows };
		}

		// Grow a window around the selection. Only visible entries are rendered,
		// so the 5,000-agent Hub retains bounded paint cost.
		for (let grew = true; grew;) {
			grew = false;
			if (end < this.#rows.length) {
				const next = entryAt(end);
				if (used + next.length <= budget) {
					used += next.length;
					end++;
					grew = true;
				}
			}
			if (start > 0) {
				const previous = entryAt(start - 1);
				if (used + previous.length <= budget) {
					start--;
					used += previous.length;
					grew = true;
				}
			}
		}
		// Overflow labels consume real rows. Trim the farthest visible neighbors
		// before painting them so the selected entry and both labels fit.
		for (
			let markerRows = Number(start > 0) + Number(end < this.#rows.length);
			used + markerRows > budget && start < end;
			markerRows = Number(start > 0) + Number(end < this.#rows.length)
		) {
			if (end - 1 > this.#selectedRow) {
				end--;
				used -= entryAt(end).length;
			} else if (start < this.#selectedRow) {
				used -= entryAt(start).length;
				start++;
			} else {
				break;
			}
		}
		const showTopOverflow = start > 0 && used < budget;
		const showBottomOverflow = end < this.#rows.length && used + Number(showTopOverflow) < budget;
		if (showTopOverflow) {
			lines.push(theme.fg("dim", `… ${start} more`));
			hitRows.push(undefined);
		}
		for (let i = start; i < end; i++) appendEntry(i);
		if (showBottomOverflow) {
			lines.push(theme.fg("dim", `… ${this.#rows.length - end} more`));
			hitRows.push(undefined);
		}
		return { lines, hitRows };
	}

	#summaryLines(width: number): string[] {
		const active = (label: string): string => theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)));
		const inactive = (label: string): string => theme.fg("muted", ` ${label} `);
		const projection =
			this.#viewMode === "roster"
				? `${active("Flat")}${theme.fg("dim", "/")}${inactive("By parent")}`
				: `${inactive("Flat")}${theme.fg("dim", "/")}${active("By parent")}`;
		const counts = this.#statusSummary();
		const header = `${theme.bold("Roster")}${theme.fg("dim", theme.sep.dot)}${projection}${counts ? theme.fg("dim", theme.sep.dot) + counts : ""}`;
		const lines = wrapTextWithAnsi(header, Math.max(1, width));

		const metrics = this.#aggregate;
		if (metrics.reportedAgents === 0) {
			lines.push(
				...wrapTextWithAnsi(
					theme.fg("dim", `Usage —${theme.sep.dot}0/${this.#rows.length} measured`),
					Math.max(1, width),
				),
			);
			return lines;
		}
		const activeTime = formatMetricDuration(metrics);
		const usage = [
			theme.fg("statusLineCost", formatCost(metrics.cost)),
			theme.fg("dim", activeTime ? `${activeTime} agent time` : "agent time —"),
			theme.fg("dim", `${formatNumber(metrics.requests)} req`),
			theme.fg("dim", `${formatNumber(metrics.tools)} tools`),
			theme.fg("dim", `${formatNumber(metrics.tokens)} tok`),
			theme.fg("dim", `${metrics.activeDurationAgents}/${metrics.reportedAgents} timed`),
			theme.fg("dim", `${metrics.reportedAgents}/${this.#rows.length} measured`),
		].join(theme.fg("dim", theme.sep.dot));
		lines.push(...wrapTextWithAnsi(usage, Math.max(1, width)));
		return lines;
	}

	#statusSummary(): string {
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = this.#statusCounts[status];
			if (count > 0) parts.push(`${statusGlyph(status)} ${statusText(status, `${count} ${status}`)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#refreshAggregate(refreshFallback = false): void {
		const result = aggregateMetrics({
			rows: this.#rows,
			observedById: this.#observedById,
			metricsFor: (ref, observed) => this.#metricsFor(ref, observed),
			fallbackStatsSession: (ref, observed) => this.#fallbackStatsSession(ref, observed),
			sessionMetrics: this.#sessionMetrics,
			refreshFallback,
		});
		this.#aggregate = result.metrics;
		this.#hasFallbackLiveSessions = result.hasFallbackLiveSessions;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observedById.get(id) ?? this.#observers.getSession(id);
	}

	#renderDetailPanel(
		ref: TRecord | undefined,
		width: number,
		rows: number,
		_observedById: ReadonlyMap<string, ObservableSession>,
	): string[] {
		if (!ref) return [theme.fg("dim", "Select an agent to inspect"), ...Array.from({ length: rows - 1 }, () => "")];
		const observed = this.#observableFor(ref.id);
		const progress = observed?.progress;
		const metrics = this.#metricsFor(ref, observed);
		const children = this.#childrenByParent.get(ref.id) ?? [];
		const lines: string[] = [];
		const add = (line = ""): void => {
			lines.push(truncateToWidth(line, width));
		};
		const addWrapped = (text: string, maxRows = 2): void => {
			for (const wrapped of wrapTextWithAnsi(sanitizeLine(text), Math.max(1, width)).slice(0, maxRows)) add(wrapped);
		};
		const section = (label: string, contentRows = 0): void => {
			if (lines.length > 0 && lines.length + 1 + contentRows < rows) add();
			add(theme.bold(theme.fg("accent", label)));
		};

		add(`${statusGlyph(ref.status)} ${theme.bold(sanitizeDisplaySingleLine(ref.displayName || ref.id))}`);
		if (ref.displayName && ref.displayName !== ref.id) add(theme.fg("dim", sanitizeDisplaySingleLine(ref.id)));
		const lifecycleDetails = [
			metrics ? formatMetricDuration(metrics) : undefined,
			`active ${formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))}`,
		].filter(Boolean);
		add(
			`${statusText(ref.status, ref.status)}${theme.fg("dim", `${theme.sep.dot}${lifecycleDetails.join(theme.sep.dot)}`)}`,
		);
		const modelDetails: string[] = [];
		const modelRole = progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#getRoleInfo) modelDetails.push(formatRoleBadge(modelRole, this.#getRoleInfo(modelRole)));
		const badge = modelBadge(ref, observed);
		if (badge) modelDetails.push(badge);
		if (modelDetails.length > 0) add(modelDetails.join(theme.sep.dot));

		const task = observed?.description ?? progress?.task ?? ref.activity;
		if (task) {
			section("Task");
			addWrapped(task);
		}

		const current = progress?.currentTool
			? `${progress.currentTool}${progress.currentToolArgs ? ` · ${progress.currentToolArgs}` : ""}`
			: (progress?.lastIntent ?? ref.activity);
		if (current) {
			section("Current");
			addWrapped(current);
			if (progress?.retryState) {
				add(theme.fg("warning", `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`));
			}
		}

		section("Usage", 1);
		if (metrics) {
			addWrapped(formatMetrics(metrics), 3);
			if (metrics.contextTokens !== undefined && metrics.contextWindow) {
				add(contextGauge(metrics.contextTokens, metrics.contextWindow));
			}
		} else {
			add(theme.fg("dim", "usage —"));
		}

		section("Lineage");
		add(
			`Spawned by ${sanitizeDisplaySingleLine(ref.parentId ?? MAIN_AGENT_ID)}${children.length > 0 ? ` · ${children.length} children` : ""}`,
		);
		if (children.length > 0) add(theme.fg("dim", formatChildIds(children, width)));
		add(theme.fg("dim", `Registered ${formatLocalDateTimeWithOffset(new Date(ref.createdAt))}`));

		section("Changes");
		add(
			theme.fg(
				"dim",
				ref.kind === "advisor" || ref.history?.readOnly
					? "Read-only · 0 LoC"
					: "Shared workspace · per-agent LoC not attributable",
			),
		);
		const artifacts = ref.history;
		if (artifacts?.outputPath) addWrapped(`Output ${shortenPath(artifacts.outputPath)}`);
		if (artifacts?.patchPath) addWrapped(`Patch ${shortenPath(artifacts.patchPath)}`);
		for (const nestedPath of artifacts?.nestedPatchPaths ?? []) addWrapped(`Nested patch ${shortenPath(nestedPath)}`);
		if (artifacts?.branchName) addWrapped(`Worktree branch ${artifacts.branchName}`);

		if (lines.length < rows) add();
		if (lines.length < rows) add(theme.bold(theme.fg("accent", "Recent activity")));
		const activityBudget = Math.max(0, rows - lines.length);
		const activity = this.#activity.recent(ref.id, activityBudget);
		if (activity.length === 0 && activityBudget > 0) add(theme.fg("muted", "No response or tool activity yet"));
		else {
			for (const event of activity) {
				const title = sanitizeLine(event.kind === "tool" ? (event.toolName ?? event.title) : event.title, width);
				const prefix = `${theme.fg("dim", activityClock(event.timestamp))} ${activityGlyph(event)} ${theme.fg("muted", title)} `;
				add(`${prefix}${sanitizeLine(event.summary, Math.max(1, width - visibleWidth(prefix)))}`);
			}
		}
		const maxScroll = Math.max(0, lines.length - rows);
		this.#detailScrollOffset = Math.min(this.#detailScrollOffset, maxScroll);
		const visible = lines.slice(this.#detailScrollOffset, this.#detailScrollOffset + rows);
		while (visible.length < rows) visible.push("");
		return visible;
	}

	/**
	 * One agent entry keeps identity/model metadata on one line when it fits,
	 * then packs task and all five usage metrics together below. Narrow rows wrap
	 * only those dense secondary fields.
	 */
	#renderEntry(
		ref: TRecord,
		selected: boolean,
		width: number,
		observed: ObservableSession | undefined,
		hovered = false,
	): string[] {
		const max = Math.max(1, width);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const treeMode = this.#viewMode === "tree";
		// Tree rails descend from the status dot: the connector sits between the
		// cursor and the glyph, so child rows hang under their parent's dot.
		const branch = treeMode
			? treeBranch(ref, max, this.#treeDepthById, this.#treeParentById, this.#treeLastSiblingById)
			: "";
		const id = sanitizeDisplaySingleLine(ref.id);
		const styledId = selected ? theme.bold(theme.fg("accent", id)) : theme.bold(id);
		const fields: string[] = [`${cursor} ${branch}${statusGlyph(ref.status)} ${styledId}`];
		if (this.#viewMode === "roster" && ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
			fields.push(theme.fg("dim", `↳ ${sanitizeDisplaySingleLine(ref.parentId)}`));
		}
		if (ref.kind === "advisor") {
			fields.push(theme.fg("warning", "read-only"));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			fields.push(theme.fg("warning", `⧉ ${unread}`));
		}
		const left = fields.join("  ");

		// Line 1 right side carries variable-width badges only. Cost/turns/time
		// get their own always-present metadata line below so wrapping task text
		// can never mix with them.
		const metrics = this.#metricsFor(ref, observed);
		const meta: string[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#getRoleInfo) {
			meta.push(formatRoleBadge(modelRole, this.#getRoleInfo(modelRole)));
		}
		const badge = modelBadge(ref, observed);
		if (badge) meta.push(badge);
		const right = meta.join(theme.sep.dot);

		const entry: string[] = [];
		const detailIndent = Math.min(max - 1, 4 + visibleWidth(branch));
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (rightWidth > 0 && leftWidth + 2 + rightWidth <= max) {
			entry.push(left + padding(max - leftWidth - rightWidth) + right);
		} else {
			entry.push(truncateToWidth(left.replace(/[\r\n]+/g, " "), max));
		}

		const ownChildRail = this.#childrenByParent.has(ref.id) ? theme.fg("dim", "│ ") : "  ";
		const continuation = treeMode
			? `  ${treeContinuation(ref, max, this.#treeDepthById, this.#treeParentById, this.#treeLastSiblingById)}${ownChildRail}`
			: "";
		const indent = treeMode && visibleWidth(continuation) === detailIndent ? continuation : padding(detailIndent);
		const metadataIndent = treeMode ? treeMetadataIndent(max, this.#treeMaxDepth) : detailIndent;
		const metadataPrefix =
			treeMode && visibleWidth(continuation) === detailIndent
				? continuation + padding(metadataIndent - detailIndent)
				: padding(metadataIndent);
		const detailWidth = Math.max(1, max - detailIndent);
		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		if (task) {
			entry.push(`${indent}${theme.fg("muted", truncateToWidth(sanitizeLine(task, detailWidth), detailWidth))}`);
		}
		const age = formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)));
		const metadata = metrics ? formatMetricColumns(metrics, age) : `usage ${theme.sep.dot} ${age}`;
		entry.push(`${metadataPrefix}${theme.fg("dim", metadata)}`);
		if (!hovered) return entry;
		return entry.map(lineRow => {
			const rowWidth = visibleWidth(lineRow);
			return theme.bg("selectedBg", rowWidth < max ? lineRow + padding(max - rowWidth) : lineRow);
		});
	}

	#scrollDetails(direction: -1 | 1): void {
		this.#detailScrollOffset = Math.max(0, this.#detailScrollOffset + direction * 5);
		this.#requestRender();
	}

	#selectRow(index: number): void {
		if (index !== this.#selectedRow) {
			this.#detailScrollOffset = 0;
			this.#detailAgentId = this.#rows[index]?.id;
		}
		this.#selectedRow = index;
	}

	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		if (this.#section === "activity") {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.max(
					0,
					Math.min(this.#selectedActivityRow + delta, this.#activityRows.length - 1),
				);
			}
		} else if (this.#rows.length > 0) {
			this.#selectRow(Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1)));
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (index === this.#hoveredRow) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}

	clickItem(index: number): void {
		if (this.#section === "activity") {
			if (index === this.#selectedActivityRow) {
				const activity = this.#activityRows[index];
				if (activity) this.openChat(activity.agentId, activity.entryId);
				return;
			}
			this.#activityFollow = false;
			this.#selectedActivityRow = index;
			this.#requestRender();
			return;
		}
		const selected = this.#rows[index];
		if (!selected) return;
		this.#hoveredRow = index;
		this.#selectRow(index);
		this.#requestRender();
		this.#activateAgent(selected);
	}

	#switchSection(section: AgentHubSection): void {
		if (this.#section === section) return;
		this.#section = section;
		this.#hoveredRow = null;
		this.#narrowDetailsOpen = false;
		if (section === "activity") this.#refreshActivityRows();
		this.#requestRender();
	}

	#handleActivitySearchInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#activitySearchEditing = false;
		} else if (matchesKey(keyData, "backspace")) {
			this.#activitySearch = this.#activitySearch.slice(0, -1);
		} else if (keyData.length === 1 && keyData >= " " && keyData !== "\u007f") {
			this.#activitySearch += keyData;
		} else {
			return;
		}
		this.#refreshActivityRows();
		this.#requestRender();
	}

	#handleActivityInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#activitySearch) {
				this.#activitySearch = "";
				this.#refreshActivityRows();
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#switchSection("agents");
			return;
		}
		if (keyData === "/") {
			this.#activitySearchEditing = true;
			this.#requestRender();
			return;
		}
		if (keyData === " ") {
			this.#activityFollow = !this.#activityFollow;
			if (this.#activityFollow && this.#activityRows.length > 0) {
				this.#selectedActivityRow = this.#activityRows.length - 1;
			}
			this.#requestRender();
			return;
		}
		if (keyData === "f") {
			const filters: ActivityFilter[] = ["all", "errors", "responses", "tools"];
			this.#activityFilter = filters[(filters.indexOf(this.#activityFilter) + 1) % filters.length]!;
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (keyData === "s") {
			const scopes: ActivityScope[] = ["all", "agent", "subtree"];
			this.#activityScope = scopes[(scopes.indexOf(this.#activityScope) + 1) % scopes.length]!;
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.min(this.#selectedActivityRow + 1, this.#activityRows.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.max(this.#selectedActivityRow - 1, 0);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const activity = this.#activityRows[this.#selectedActivityRow];
			if (activity) this.openChat(activity.agentId, activity.entryId);
		}
	}

	#handleTableInput(keyData: string): void {
		if (this.#agentFilterEditing) {
			if (matchesKey(keyData, "escape") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
				this.#agentFilterEditing = false;
				if (matchesKey(keyData, "escape")) this.#agentFilter = "";
			} else if (matchesKey(keyData, "backspace")) {
				this.#agentFilter = this.#agentFilter.slice(0, -1);
			} else if (keyData.length === 1 && keyData >= " " && keyData !== "\u007f") {
				this.#agentFilter += keyData;
			} else {
				return;
			}
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "escape")) {
			if (this.#agentFilter) {
				this.#agentFilter = "";
				this.#refreshRows();
				this.#requestRender();
			} else if (this.#narrowDetailsOpen && this.#split.mode !== "split") {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if (keyData === "/") {
			this.#agentFilterEditing = true;
			this.#requestRender();
			return;
		}
		if ((matchesKey(keyData, "tab") || keyData === "\t") && this.#split.mode !== "split") {
			if (this.#rows.length > 0) this.#narrowDetailsOpen = !this.#narrowDetailsOpen;
			this.#requestRender();
			return;
		}
		if (this.#split.mode === "split" || this.#narrowDetailsOpen) {
			if (matchesKey(keyData, "pageUp")) {
				this.#scrollDetails(-1);
				return;
			}
			if (matchesKey(keyData, "pageDown")) {
				this.#scrollDetails(1);
				return;
			}
		}
		if (keyData === "t") {
			this.#hoveredRow = null;
			this.#viewMode = this.#viewMode === "roster" ? "tree" : "roster";
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "left")) {
			if (this.#narrowDetailsOpen && this.#split.mode !== "split") {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
				return;
			}
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		this.#hoveredRow = null;
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectRow(Math.min(this.#selectedRow + 1, this.#rows.length - 1));
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectRow(Math.max(this.#selectedRow - 1, 0));
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const selected = this.#rows[this.#selectedRow];
			if (selected) this.#activateAgent(selected);
			return;
		}
		if (keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (keyData === "x") {
			this.#killSelected();
			return;
		}
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: TRecord): void {
		this.#notice = undefined;
		const focusAgent = this.#focusAgent;
		// Aborted agents and advisor refs are read-only transcripts with no
		// revivable session; open the in-hub viewer instead of failing ensureLive.
		if (ref.kind === "advisor" || ref.status === "aborted" || this.#remote || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await focusAgent(ref.id); // ensureLive inside revives parked agents; no parking, no session files
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#reviveSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — nothing to revive.`;
			this.#requestRender();
			return;
		}
		if (ref.status !== "parked") {
			this.#notice = `Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
		// Fire-and-forget; failures surface as an inline notice
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — cannot be killed.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
