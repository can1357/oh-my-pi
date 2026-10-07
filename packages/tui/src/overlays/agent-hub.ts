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
import type {
	TspPickerAction,
	TspPickerColumn,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
	TspTreeNode,
} from "@oh-my-pi/pi-wire";
import { Container, type OverlayHandle, type TUI } from "../tui";
import { matchesKey } from "../keys";
import { routeSelectListMouse, routeSgrMouseInput, type SelectListMouseTarget } from "../mouse";
import { padding, visibleWidth, wrapTextWithAnsi } from "../utils";
import { formatAge, formatDuration, formatNumber, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import {
	type AgentActivitySource,
	type AgentActivityKind,
	type AgentActivityRow,
	activityRowsFromProgress,
} from "./agent-activity";
import { formatKeyHint, formatKeyHints, type KeyId } from "../app-keybindings";
import type { MessageRenderer } from "../chat/extension-types";
import type { AgentLifecycleLike, IrcBusLike } from "./agent-hub-types";
import { type AgentRecordLike, type AgentHubRegistry, type AgentStatus, MAIN_AGENT_ID } from "./agent-hub-types";
import { USER_INTERRUPT_LABEL } from "../chat/messages";
import { shortenPath, truncateToWidth } from "../render/render-utils";
import { formatLocalDateTimeWithOffset } from "../chrome/local-date";
import { getContextUsageLevel, getContextUsageTone } from "../chrome/context-thresholds";
import type { ObservableSession, SessionObserverRegistry } from "./session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	type AgentMetrics,
	type AggregateMetrics,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
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
	metricsText,
	modelBadge,
	modelBadgeSpans,
	modelChip,
	roleBadgeSpan,
	type RosterRender,
	sanitizeLine,
	statusGlyph,
	statusDot,
	statusGlyphSpan,
	statusText,
	statusTone,
	taskSummary,
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
import { node, span, stableKey, text } from "../native/describe";
import { type DescribeContext, leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { hintsRow, type NativeHint, overlayCard } from "../native/overlay";
import { CLOSE_ACTION, picker, pickerQuery } from "../native/picker";
import { Input } from "../components/input";

/** A chrome-less search field: the hub draws its own prompt. */
function filterInput(): Input {
	const input = new Input();
	input.prompt = "";
	return input;
}

/** The field's text with its caret drawn, sized to the value (no trailing padding). */
function filterText(input: Input): string {
	return input.render(visibleWidth(input.getValue()) + 1)[0] ?? "";
}

/** Two-pane mode needs a useful roster and a readable inspector. */
const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_MIN_WIDTH = 48;

export type AgentHubSection = "agents" | "activity";
type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";

type HubViewMode = "roster" | "tree";

const SECTION_TABS = [
	{ id: "agents", label: "1 Agents" },
	{ id: "activity", label: "2 Activity" },
] as const satisfies ReadonlyArray<{ id: AgentHubSection; label: string }>;
const VIEW_TABS = [
	{ id: "roster", label: "Flat" },
	{ id: "tree", label: "By parent" },
] as const satisfies ReadonlyArray<{ id: HubViewMode; label: string }>;
const AGENT_HINTS: Readonly<Record<HubViewMode, readonly NativeHint[]>> = {
	roster: agentHints("by parent"),
	tree: agentHints("flat"),
};
const ACTIVITY_HINTS: readonly NativeHint[] = [
	{ keys: ["j", "k"], label: "select" },
	{ keys: ["enter"], label: "transcript" },
	{ keys: ["space"], label: "follow" },
	{ keys: ["f"], label: "filter" },
	{ keys: ["s"], label: "scope" },
	{ keys: ["/"], label: "search" },
	{ keys: ["escape"], label: "close" },
];
/** Recent-activity entries the native inspector lists for the selected agent. */
const NATIVE_RECENT_ACTIVITY = 20;
/** Child ids the native inspector names before summarizing the rest. */
const NATIVE_CHILD_IDS = 12;

/** Picker tabs: the two top-level projections (keys 1/2). */
const PICKER_TABS = [
	{ id: "agents", label: "Agents" },
	{ id: "activity", label: "Activity" },
] as const satisfies ReadonlyArray<{ id: AgentHubSection; label: string }>;
/** Roster fact columns; lower priorities hide first on narrow sheets. */
const AGENT_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "cost", head: "Cost", format: "price", priority: 6 },
	{ id: "time", head: "Time", format: "elapsed", priority: 5 },
	{ id: "req", head: "Req", format: "num", priority: 2 },
	{ id: "tools", head: "Tools", format: "num", priority: 1 },
	{ id: "tok", head: "Tok", format: "num", priority: 3 },
	{ id: "ctx", head: "Ctx", format: "bar", priority: 4 },
];
const ACTIVITY_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "agent", head: "Agent", format: "text", priority: 2 },
	{ id: "at", head: "Time", format: "dim", priority: 1 },
];
/** What the roster/activity projections contribute to the picker (the shared head is added once). */
type PickerBody = Omit<Partial<TspPickerProps>, "title">;
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "errors", "responses", "tools"];
/** Activity filters as the picker's scope column (`f` cycles them). */
const ACTIVITY_FILTER_SCOPES: readonly TspPickerScope[] = [
	{ id: "all", label: "All", icon: "list", group: "Show" },
	{ id: "errors", label: "Errors", icon: "x-circle", group: "Show" },
	{ id: "responses", label: "Responses", icon: "message", group: "Show" },
	{ id: "tools", label: "Tools", icon: "wrench", group: "Show" },
];
const ACTIVITY_KIND_ICON: Readonly<Record<AgentActivityKind, string>> = {
	response: "message",
	tool: "wrench",
	irc: "send",
	lifecycle: "activity",
};

function agentHints(nextView: string): readonly NativeHint[] {
	return [
		{ keys: ["j", "k"], label: "select" },
		{ keys: ["enter"], label: "open" },
		{ keys: ["t"], label: nextView },
		{ keys: ["/"], label: "filter" },
		{ keys: ["r"], label: "revive" },
		{ keys: ["x"], label: "kill" },
		{ keys: ["escape"], label: "close" },
	];
}

/** A tree node whose children are still being attached while the roster projects. */
interface AgentTreeEntry extends TspTreeNode {
	children?: AgentTreeEntry[];
}

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

/** Native span of {@link activityGlyph}. */
function activityGlyphSpan(row: AgentActivityRow): TspSpan {
	if (row.status === "error") return span(theme.status.error, "error");
	if (row.status === "aborted") return span(theme.status.aborted, "warning");
	if (row.status === "pending") return span(theme.status.running, "accent");
	switch (row.kind) {
		case "response":
			return span("◆", "success");
		case "tool":
			return span(theme.status.success, "success");
		case "irc":
			return span("→", "accent");
		case "lifecycle":
			return span("○", "muted");
	}
}

const ACTIVITY_CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});
const ACTIVITY_CLOCK_CACHE_LIMIT = 512;
const activityClockCache = new Map<number, string>();

function activityClock(timestamp: number): string {
	let text = activityClockCache.get(timestamp);
	if (text === undefined) {
		text = ACTIVITY_CLOCK_FORMAT.format(timestamp);
		if (activityClockCache.size >= ACTIVITY_CLOCK_CACHE_LIMIT) activityClockCache.clear();
		activityClockCache.set(timestamp, text);
	}
	return text;
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
	expandThinkingBlocks?: () => boolean;
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
	/** Activity search (`/`); shown while editing or non-empty. */
	readonly #activitySearch = filterInput();
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
	readonly #agentFilter = filterInput();
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
	#expandThinkingBlocks: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	/** Last native description; every visible state change goes through requestRender, which drops it. */
	#native: NativeNode | undefined;
	/** Which terminal kinds {@link #native} was described for (support may change between frames). */
	#nativeVariant = "";
	/** Preview recent-activity rows by node key, for their pointer actions. */
	#recentByKey = new Map<string, AgentActivityRow>();

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
		this.#requestRender = () => {
			this.#native = undefined;
			deps.requestRender();
		};
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
		this.#expandThinkingBlocks = deps.expandThinkingBlocks;
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

	/** Show `section`, as a slash-command deep link into an already-open hub does. */
	showSection(section: AgentHubSection): void {
		this.#switchSection(section);
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
			expandThinkingBlocks: this.#expandThinkingBlocks,
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
	// Native description
	// ========================================================================

	/** A `picker` is its own sheet: the backend mounts it in `layer` without an `overlay` wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	override describe(cx: DescribeContext): NativeNode {
		const usePicker = cx.supports("picker");
		const nativeTree = cx.supports("tree");
		const meter = cx.supports("meter");
		const variant = usePicker ? `picker:${meter}` : nativeTree ? "tree" : "list";
		if (this.#native && this.#nativeVariant === variant) return this.#native;
		this.#nativeVariant = variant;
		if (usePicker) {
			this.#native = this.#describePicker(meter);
			return this.#native;
		}
		const tabs = node("tabs", { items: SECTION_TABS, active: this.#section }, undefined, "section");
		const body = this.#section === "activity" ? this.#describeActivity() : this.#describeAgents(nativeTree);
		this.#native = overlayCard("omp.overlay.agentHub", "Agent Hub", [tabs, ...body]);
		return this.#native;
	}

	/**
	 * Pointer actions on the described hub. `select` mirrors keyboard selection
	 * (roster row, activity row, section tab, projection tab); `activate` does
	 * what Enter does on that row. Picker actions run the key handlers' paths.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key === "") {
			this.#handlePickerEvent(event);
			return;
		}
		if (event.type === "action") {
			const activity = this.#recentByKey.get(leafKey(event.key));
			if (event.act === "transcript" && activity) this.openChat(activity.agentId, activity.entryId);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		const target = leafKey(event.key);
		const item = event.item;
		switch (target) {
			case "section":
				if (item === "agents" || item === "activity") this.#switchSection(item);
				return;
			case "view":
				if ((item === "roster" || item === "tree") && item !== this.#viewMode) {
					this.#hoveredRow = null;
					this.#viewMode = item;
					this.#refreshRows();
					this.#requestRender();
				}
				return;
			case "agents": {
				const index = this.#rows.findIndex(ref => ref.id === item);
				const ref = this.#rows[index];
				if (!ref) return;
				this.#hoveredRow = null;
				this.#selectRow(index);
				this.#requestRender();
				if (event.type === "activate") this.#activateAgent(ref);
				return;
			}
			case "activity": {
				const index = this.#activityRows.findIndex(row => row.id === item);
				const activity = this.#activityRows[index];
				if (!activity) return;
				if (event.type === "activate") {
					this.openChat(activity.agentId, activity.entryId);
					return;
				}
				this.#activityFollow = false;
				this.#selectedActivityRow = index;
				this.#requestRender();
				return;
			}
			case "recent": {
				const agentId = this.#rows[this.#selectedRow]?.id;
				if (event.type !== "activate" || !agentId) return;
				const activity = this.#activity.recent(agentId, NATIVE_RECENT_ACTIVITY).find(row => row.id === item);
				if (activity) this.openChat(activity.agentId, activity.entryId);
				return;
			}
		}
	}

	/** Picker events (the sheet is this component's root): same paths as the keys. */
	#handlePickerEvent(event: NativeUiEvent): void {
		const activity = this.#section === "activity";
		if (event.type === "select" || event.type === "activate") {
			if (activity) {
				const index = this.#activityRows.findIndex(row => row.id === event.item);
				const row = this.#activityRows[index];
				if (!row) return;
				if (event.type === "activate") {
					this.openChat(row.agentId, row.entryId);
					return;
				}
				this.#activityFollow = false;
				this.#selectedActivityRow = index;
				this.#requestRender();
				return;
			}
			const index = this.#rows.findIndex(ref => ref.id === event.item);
			const ref = this.#rows[index];
			if (!ref) return;
			this.#hoveredRow = null;
			this.#selectRow(index);
			this.#requestRender();
			if (event.type === "activate") this.#activateAgent(ref);
			return;
		}
		if (event.type !== "action") return;
		switch (event.act) {
			case "tab":
				if (event.value === "agents" || event.value === "activity") this.#switchSection(event.value);
				return;
			case "scope":
				if (activity && ACTIVITY_FILTERS.includes(event.value as ActivityFilter)) {
					this.#setActivityFilter(event.value as ActivityFilter);
				}
				return;
			case "close":
				this.#onDone();
				return;
			case "filter":
				if (activity) this.#activitySearchEditing = true;
				else this.#agentFilterEditing = true;
				this.#requestRender();
				return;
		}
		if (activity) {
			switch (event.act) {
				case "open": {
					const row = this.#activityRows[this.#selectedActivityRow];
					if (row) this.openChat(row.agentId, row.entryId);
					return;
				}
				case "follow":
					this.#toggleActivityFollow();
					return;
				case "agents":
					this.#cycleActivityScope();
					return;
			}
			return;
		}
		switch (event.act) {
			case "open": {
				const ref = this.#rows[this.#selectedRow];
				if (ref) this.#activateAgent(ref);
				return;
			}
			case "revive":
				this.#reviveSelected();
				return;
			case "kill":
				this.#killSelected();
				return;
			case "view":
				this.#toggleViewMode();
				return;
		}
	}

	/** The hub as a data-first `picker` (§9.1): roster or activity log, selected agent as preview. */
	#describePicker(meter: boolean): NativeNode {
		const activity = this.#section === "activity";
		const props: TspPickerProps = {
			title: "Agents",
			subtitle: this.#pickerSubtitle(),
			icon: "users",
			size: "lg",
			tabs: PICKER_TABS,
			tab: this.#section,
			...(activity ? this.#activityPickerProps() : this.#agentPickerProps()),
		};
		const preview = activity ? [] : this.#describePreview(this.#rows[this.#selectedRow], meter);
		return picker(props, preview);
	}

	/** Roster totals: `$0.389 · 18.7s · 6 req · 114K tok`. */
	#pickerSubtitle(): string {
		const metrics = this.#aggregate;
		if (metrics.reportedAgents === 0) return "No usage reported yet";
		const parts = [formatCost(metrics.cost)];
		if (metrics.durationMs > 0) parts.push(formatDuration(metrics.durationMs));
		parts.push(`${formatNumber(metrics.requests)} req`, `${formatNumber(metrics.tokens)} tok`);
		return parts.join(theme.sep.dot);
	}

	#agentPickerProps(): PickerBody {
		const selected = this.#rows[this.#selectedRow];
		const readOnly = selected?.kind === "advisor" ? "Read-only advisor transcript" : undefined;
		const actions: TspPickerAction[] = [
			{
				id: "open",
				label: "Open transcript",
				keys: ["enter"],
				primary: true,
				disabled: selected ? undefined : true,
			},
			{
				id: "revive",
				label: "Revive",
				keys: ["r"],
				disabled: readOnly ?? (selected?.status === "parked" ? undefined : "Only parked agents can be revived"),
			},
			{ id: "kill", label: "Kill", keys: ["x"], danger: true, disabled: readOnly ?? (selected ? undefined : true) },
			{ id: "view", label: "By parent", keys: ["t"], on: this.#viewMode === "tree" },
			{ id: "filter", label: "Filter", keys: ["/"] },
			CLOSE_ACTION,
		];
		return {
			noun: "agents",
			layout: this.#viewMode === "tree" ? "tree" : "rows",
			preview: "side",
			...pickerQuery(this.#agentFilterEditing || this.#agentFilter.getValue() ? this.#agentFilter : null),
			placeholder: "Filter agents…",
			columns: AGENT_COLUMNS,
			items: this.#rows.map(ref => this.#pickerAgentItem(ref)),
			selected: selected?.id ?? null,
			total: this.#registry.list().length - (this.#registry.get(MAIN_AGENT_ID) ? 1 : 0),
			state: this.#rows.length === 0 && this.#loadingPersistedSubagents ? "loading" : "ready",
			empty: "No agents in this session. Finished, parked and killed subagents stay with the session that created them.",
			actions,
			focus: "list",
		};
	}

	#pickerAgentItem(ref: TRecord): TspPickerItem {
		const observed = this.#observableFor(ref.id);
		const metrics = this.#metricsFor(ref, observed);
		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		const badges: { text: string; tone?: "warning" | "muted"; title?: string }[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#getRoleInfo) {
			const info = this.#getRoleInfo(modelRole);
			badges.push({ text: sanitizeDisplaySingleLine(info.tag ?? info.name ?? modelRole), title: "Model role" });
		}
		if (ref.kind === "advisor") badges.push({ text: "read-only", tone: "warning" });
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) badges.push({ text: `${unread} unread`, tone: "warning" });
		if (this.#viewMode === "roster" && ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
			badges.push({ text: `↳ ${sanitizeDisplaySingleLine(ref.parentId)}`, tone: "muted", title: "Spawned by" });
		}
		const model = modelChip(ref, observed);
		const item: TspPickerItem = {
			id: ref.id,
			label: sanitizeDisplaySingleLine(ref.id),
			mono: true,
			dot: statusDot(ref.status),
			detail: task ? taskSummary(task) : undefined,
			chips: model
				? [{ text: model.fallback ? `fallback → ${model.text}` : model.text, dot: model.dot }]
				: undefined,
			badges: badges.length > 0 ? badges.slice(0, 3) : undefined,
		};
		if (this.#viewMode === "tree") {
			const depth = this.#treeDepthById.get(ref.id) ?? 0;
			return { ...item, depth, open: this.#childrenByParent.has(ref.id) ? true : undefined };
		}
		if (!metrics) return item;
		const facts: Record<string, string | number> = {
			cost: formatCost(metrics.cost),
			// A running agent's active time ticks terminal-side; a settled one is frozen text.
			time:
				ref.status === "running" && metrics.durationMs > 0
					? metrics.durationMs
					: formatDuration(metrics.durationMs),
			req: metrics.requests,
			tools: metrics.tools,
			tok: metrics.tokens,
		};
		let title: string | undefined;
		if (metrics.contextTokens !== undefined && metrics.contextWindow) {
			facts.ctx = Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextWindow));
			title = `Context ${formatNumber(metrics.contextTokens)} / ${formatNumber(metrics.contextWindow)}`;
		}
		return { ...item, facts, title };
	}

	/** Selected agent's preview: title with status, facts, context meter, recent activity. */
	#describePreview(ref: TRecord | undefined, meter: boolean): NativeChild[] {
		this.#recentByKey.clear();
		if (!ref) return [];
		const observed = this.#observableFor(ref.id);
		const metrics = this.#metricsFor(ref, observed);
		const out: NativeChild[] = [
			node(
				"row",
				{ role: "omp.hub.title", gap: "sm", align: "center" },
				[
					text(sanitizeDisplaySingleLine(ref.displayName || ref.id), {
						role: "omp.picker.title",
						truncate: "end",
					}),
					node("badge", { text: ref.status, tone: statusDot(ref.status) }),
				],
				"title",
			),
		];
		if (this.#notice) {
			out.push(node("text", { text: this.#notice, tone: "error", wrap: "word" }, undefined, "notice"));
		}
		const facts = this.#detailFacts(ref, observed, metrics);
		const chip = modelChip(ref, observed);
		if (chip) {
			const model: TspSpan[] = [];
			if (chip.fallback) model.push(span("fallback → ", "warning"));
			model.push(span(chip.text, "mono"));
			if (chip.level && chip.dot) model.push(span(theme.sep.dot, "dim"), span(chip.level, chip.dot));
			const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
			if (modelRole && this.#getRoleInfo) {
				model.push(span(theme.sep.dot, "dim"), roleBadgeSpan(modelRole, this.#getRoleInfo(modelRole)));
			}
			facts.splice(facts[0]?.k === "Task" ? 1 : 0, 0, { k: "Model", v: model });
		}
		out.push(node("kv", { items: facts, layout: "grid", role: "omp.hub.kv" }, undefined, "facts"));
		if (metrics?.contextTokens !== undefined && metrics.contextWindow) {
			const ratio = Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextWindow));
			const label = `${formatNumber(metrics.contextTokens)} / ${formatNumber(metrics.contextWindow)} · ${Math.round(ratio * 100)}%`;
			out.push(
				meter
					? node(
							"meter",
							{
								value: ratio,
								style: "bar",
								size: "md",
								label,
								tone: getContextUsageTone(getContextUsageLevel(ratio * 100, metrics.contextWindow)),
							},
							undefined,
							"context",
						)
					: node("progress", { value: ratio, label }, undefined, "context"),
			);
		}
		const recent = this.#activity.recent(ref.id, NATIVE_RECENT_ACTIVITY);
		const rows: NativeChild[] = recent.map(activity => {
			const key = stableKey(activity.id);
			this.#recentByKey.set(key, activity);
			const name = activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title;
			return node(
				"row",
				{
					role: "omp.hub.activity.row",
					gap: "sm",
					align: "baseline",
					actions: { click: "transcript" },
					title: "Open in transcript",
				},
				[
					text([span(activityClock(activity.timestamp), "mono dim")]),
					text([activityGlyphSpan(activity)]),
					text([span(sanitizeDisplaySingleLine(name), "mono muted")]),
					text(sanitizeDisplaySingleLine(activity.summary), { truncate: "end", grow: 1 }),
				],
				key,
			);
		});
		if (rows.length === 0) rows.push(text([span("No response or tool activity yet", "dim")]));
		out.push(node("section", { head: "Recent activity", role: "omp.hub.activity" }, rows, "recentActivity"));
		return out;
	}

	#activityPickerProps(): PickerBody {
		const agent = this.#rows[this.#selectedRow]?.id;
		const scope =
			this.#activityScope === "all"
				? "All agents"
				: this.#activityScope === "agent"
					? (agent ?? "Selected agent")
					: `${agent ?? "Selected"} subtree`;
		const selected = this.#activityRows[this.#selectedActivityRow];
		return {
			noun: "events",
			layout: "rows",
			preview: "none",
			...pickerQuery(this.#activitySearchEditing || this.#activitySearch.getValue() ? this.#activitySearch : null),
			placeholder: "Search activity…",
			scopes: ACTIVITY_FILTER_SCOPES,
			scope: this.#activityFilter,
			columns: ACTIVITY_COLUMNS,
			items: this.#activityRows.map(activity => this.#pickerActivityItem(activity)),
			selected: selected?.id ?? null,
			empty: "No agent activity recorded yet",
			actions: [
				{
					id: "open",
					label: "Open transcript",
					keys: ["enter"],
					primary: true,
					disabled: selected ? undefined : true,
				},
				{ id: "follow", label: "Follow", keys: ["space"], on: this.#activityFollow },
				{ id: "agents", label: sanitizeDisplaySingleLine(scope), keys: ["s"] },
				{ id: "filter", label: "Search", keys: ["/"] },
				CLOSE_ACTION,
			],
			focus: "list",
		};
	}

	#pickerActivityItem(activity: AgentActivityRow): TspPickerItem {
		const title = activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title;
		const tone = activity.status === "error" ? "error" : activity.status === "aborted" ? "warning" : undefined;
		return {
			id: activity.id,
			label: sanitizeDisplaySingleLine(title),
			mono: activity.kind === "tool" || undefined,
			detail: sanitizeDisplaySingleLine(activity.summary),
			icon: ACTIVITY_KIND_ICON[activity.kind],
			dot: activity.status === "pending" ? "pending" : undefined,
			tone,
			facts: {
				agent: [span(sanitizeDisplaySingleLine(activity.agentId), "mono")],
				at: activityClock(activity.timestamp),
			},
			title: formatLocalDateTimeWithOffset(new Date(activity.timestamp)),
		};
	}

	#describeAgents(nativeTree: boolean): NativeChild[] {
		const head: NativeChild[] = [
			text([span("Roster", "strong")]),
			node("tabs", { items: VIEW_TABS, active: this.#viewMode }, undefined, "view"),
		];
		const counts: TspSpan[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = this.#statusCounts[status];
			if (count === 0) continue;
			if (counts.length > 0) counts.push(span(theme.sep.dot, "dim"));
			counts.push(statusGlyphSpan(status), span(` ${count} ${status}`, statusTone(status)));
		}
		if (counts.length > 0) head.push(text(counts));

		const children: NativeChild[] = [
			node("row", { gap: "sm", wrap: true, align: "center" }, head, "head"),
			node("text", { spans: this.#usageSpans(), wrap: "word" }, undefined, "usage"),
		];
		if (this.#agentFilterEditing) {
			children.push(
				node(
					"input",
					{
						text: this.#agentFilter.getValue(),
						cursor: this.#agentFilter.getCursor(),
						prompt: [span("/", "muted")],
					},
					undefined,
					"filter",
				),
			);
		} else if (this.#agentFilter.getValue()) {
			children.push(
				node("text", { spans: [span(`/${this.#agentFilter.getValue()}`, "accent")] }, undefined, "filter"),
			);
		}
		children.push(
			node(
				"row",
				{ gap: "md", wrap: true, align: "start", grow: 1 },
				[this.#describeRoster(nativeTree), this.#describeDetail(this.#rows[this.#selectedRow])],
				"body",
			),
		);
		if (this.#notice) {
			children.push(
				node("text", { spans: [span(this.#notice, "error")], wrap: "word", tone: "error" }, undefined, "notice"),
			);
		}
		children.push(hintsRow(AGENT_HINTS[this.#viewMode]));
		return children;
	}

	#usageSpans(): TspSpan[] {
		const metrics = this.#aggregate;
		const dot = theme.sep.dot;
		if (metrics.reportedAgents === 0) return [span(`Usage —${dot}0/${this.#rows.length} measured`, "dim")];
		const activeTime = formatMetricDuration(metrics);
		return [
			span(formatCost(metrics.cost), "statusLineCost"),
			span(
				[
					"",
					activeTime ? `${activeTime} agent time` : "agent time —",
					`${formatNumber(metrics.requests)} req`,
					`${formatNumber(metrics.tools)} tools`,
					`${formatNumber(metrics.tokens)} tok`,
					`${metrics.activeDurationAgents}/${metrics.reportedAgents} timed`,
					`${metrics.reportedAgents}/${this.#rows.length} measured`,
				].join(dot),
				"dim",
			),
		];
	}

	#describeRoster(nativeTree: boolean): NativeNode {
		const layout = { grow: 3, min: { w: `${ROSTER_MIN_WIDTH}ch` } } as const;
		if (this.#rows.length === 0) {
			if (this.#loadingPersistedSubagents) {
				return node(
					"spinner",
					{ ...layout, label: [span("Loading saved agents…", "accent")] },
					undefined,
					"loading",
				);
			}
			return node(
				"col",
				layout,
				[
					text([span(`${theme.status.shadowed} `, "muted"), span("No agents in this session", "strong")]),
					text(
						[span("Finished, parked, and killed subagents remain with the session that created them.", "dim")],
						{ wrap: "word" },
					),
					text([span("Resume that session with omp-dev --continue, or spawn a task here.", "dim")], {
						wrap: "word",
					}),
				],
				"empty",
			);
		}
		if (this.#viewMode === "tree" && nativeTree) {
			return node("tree", { ...layout, nodes: this.#agentTreeNodes() }, undefined, "agents");
		}
		// Without native trees the parent view degrades to the parent-first list, naming each parent.
		const showParent = this.#viewMode === "roster" || !nativeTree;
		return node(
			"list",
			{ ...layout, selected: this.#rows[this.#selectedRow]?.id ?? null, virtual: true },
			this.#rows.map((ref, index) => this.#describeAgentItem(ref, index === this.#selectedRow, showParent)),
			"agents",
		);
	}

	#agentLabel(ref: TRecord, selected: boolean, showParent: boolean): TspSpan[] {
		const label = [
			statusGlyphSpan(ref.status),
			span(" "),
			span(sanitizeDisplaySingleLine(ref.id), selected ? "accent strong" : "strong"),
		];
		if (showParent && ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
			label.push(span(`  ↳ ${sanitizeDisplaySingleLine(ref.parentId)}`, "dim"));
		}
		if (ref.kind === "advisor") label.push(span("  read-only", "warning"));
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) label.push(span(`  ⧉ ${unread}`, "warning"));
		return label;
	}

	#modelSpans(ref: TRecord, observed: ObservableSession | undefined): TspSpan[] | undefined {
		const spans: TspSpan[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#getRoleInfo) spans.push(roleBadgeSpan(modelRole, this.#getRoleInfo(modelRole)));
		const model = modelBadgeSpans(ref, observed);
		if (model) {
			if (spans.length > 0) spans.push(span(theme.sep.dot, "dim"));
			spans.push(...model);
		}
		return spans.length > 0 ? spans : undefined;
	}

	#describeAgentItem(ref: TRecord, selected: boolean, showParent: boolean): NativeNode {
		const observed = this.#observableFor(ref.id);
		const metrics = this.#metricsFor(ref, observed);
		const age = formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)));
		const detail = [
			span(metrics ? `${metricsText(metrics)}${theme.sep.dot}${age}` : `usage${theme.sep.dot}${age}`, "dim"),
		];
		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		if (task) detail.push(span(theme.sep.dot, "dim"), span(sanitizeDisplaySingleLine(task), "muted"));
		return node(
			"item",
			{ label: this.#agentLabel(ref, selected, showParent), detail, value: this.#modelSpans(ref, observed) },
			undefined,
			ref.id,
		);
	}

	/** The parent projection as a disclosure tree; node ids are agent ids (the `item` of select events). */
	#agentTreeNodes(): AgentTreeEntry[] {
		const roots: AgentTreeEntry[] = [];
		const byId = new Map<string, AgentTreeEntry>();
		for (let index = 0; index < this.#rows.length; index++) {
			const ref = this.#rows[index]!;
			const observed = this.#observableFor(ref.id);
			const label = this.#agentLabel(ref, index === this.#selectedRow, false);
			const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
			if (task) label.push(span(theme.sep.dot, "dim"), span(sanitizeDisplaySingleLine(task), "muted"));
			const model = this.#modelSpans(ref, observed);
			if (model) label.push(span(theme.sep.dot, "dim"), ...model);
			const entry: AgentTreeEntry = { id: ref.id, label, open: true };
			byId.set(ref.id, entry);
			const parentId = (this.#treeDepthById.get(ref.id) ?? 0) > 0 ? this.#treeParentById.get(ref.id) : undefined;
			const parent = parentId === undefined ? undefined : byId.get(parentId);
			if (!parent) roots.push(entry);
			else if (parent.children) parent.children.push(entry);
			else parent.children = [entry];
		}
		return roots;
	}

	#describeDetail(ref: TRecord | undefined): NativeNode {
		const layout = {
			grow: 2,
			min: { w: `${DETAIL_MIN_WIDTH}ch` },
			gap: "sm",
			role: "omp.overlay.agentHub.detail",
		} as const;
		if (!ref) return node("col", layout, [text([span("Select an agent to inspect", "dim")])], "detail");
		const observed = this.#observableFor(ref.id);
		const metrics = this.#metricsFor(ref, observed);

		const out: NativeChild[] = [
			text([
				statusGlyphSpan(ref.status),
				span(" "),
				span(sanitizeDisplaySingleLine(ref.displayName || ref.id), "strong"),
			]),
		];
		if (ref.displayName && ref.displayName !== ref.id)
			out.push(text([span(sanitizeDisplaySingleLine(ref.id), "dim")]));
		const state: NativeChild[] = [
			ref.status === "running"
				? node("spinner", { label: [span("running", "accent")] })
				: text([span(ref.status, statusTone(ref.status))]),
		];
		const duration = metrics ? formatMetricDuration(metrics) : undefined;
		if (duration) state.push(text([span(duration, "dim")]));
		state.push(
			text([span("last active", "dim")]),
			node("elapsed", { age: Math.max(0, Date.now() - ref.lastActivity), format: "short" }),
			text([span("ago", "dim")]),
		);
		out.push(node("row", { gap: "sm", wrap: true, align: "baseline" }, state, "state"));
		const model = this.#modelSpans(ref, observed);
		if (model) out.push(node("text", { spans: model }, undefined, "model"));
		out.push(node("kv", { items: this.#detailFacts(ref, observed, metrics), layout: "grid" }, undefined, "facts"));
		if (metrics?.contextTokens !== undefined && metrics.contextWindow) {
			const ratio = Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextWindow));
			out.push(
				node(
					"progress",
					{
						value: ratio,
						label: `${formatNumber(metrics.contextTokens)}/${formatNumber(metrics.contextWindow)} ${Math.round(ratio * 100)}%`,
					},
					undefined,
					"context",
				),
			);
		}
		const recent = this.#activity.recent(ref.id, NATIVE_RECENT_ACTIVITY);
		out.push(
			node(
				"section",
				{ head: [span("Recent activity", "accent strong")] },
				[
					node(
						"list",
						{ empty: [span("No response or tool activity yet", "muted")] },
						recent.map(activity => this.#describeActivityItem(activity)),
						"recent",
					),
				],
				"recentActivity",
			),
		);
		return node("col", layout, out, "detail");
	}

	/** Inspector facts shared by the fallback detail pane and the picker preview. */
	#detailFacts(
		ref: TRecord,
		observed: ObservableSession | undefined,
		metrics: AgentMetrics | undefined,
	): Array<{ k: string; v: TspSpan[] | string }> {
		const progress = observed?.progress;
		const children = this.#childrenByParent.get(ref.id) ?? [];
		const dot = theme.sep.dot;
		const facts: Array<{ k: string; v: TspSpan[] | string }> = [];
		const task = observed?.description ?? progress?.task ?? ref.activity;
		if (task) facts.push({ k: "Task", v: taskSummary(task) });
		const current = progress?.currentTool
			? `${progress.currentTool}${progress.currentToolArgs ? `${dot}${progress.currentToolArgs}` : ""}`
			: (progress?.lastIntent ?? ref.activity);
		if (current) {
			const value = [span(sanitizeDisplaySingleLine(current))];
			if (progress?.retryState) {
				value.push(
					span(`${dot}retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`, "warning"),
				);
			}
			facts.push({ k: "Current", v: value });
		}
		facts.push({ k: "Usage", v: metrics ? metricsText(metrics) : [span("usage —", "dim")] });
		facts.push({
			k: "Lineage",
			v: `Spawned by ${sanitizeDisplaySingleLine(ref.parentId ?? MAIN_AGENT_ID)}${children.length > 0 ? `${dot}${children.length} ${children.length === 1 ? "child" : "children"}` : ""}`,
		});
		if (children.length > 0) {
			const named = children.slice(0, NATIVE_CHILD_IDS).map(child => sanitizeDisplaySingleLine(child.id));
			const more = children.length - named.length;
			facts.push({ k: "Children", v: [span(`${named.join(", ")}${more > 0 ? `, … +${more}` : ""}`, "dim")] });
		}
		facts.push({ k: "Registered", v: [span(formatLocalDateTimeWithOffset(new Date(ref.createdAt)), "dim")] });
		facts.push({
			k: "Changes",
			v: [
				span(
					ref.kind === "advisor" || ref.history?.readOnly
						? "Read-only · 0 LoC"
						: "Shared workspace · per-agent LoC not attributable",
					"dim",
				),
			],
		});
		const artifacts = ref.history;
		if (artifacts?.outputPath) {
			facts.push({
				k: "Output",
				v: [span(shortenPath(artifacts.outputPath), "path", { href: `file://${artifacts.outputPath}` })],
			});
		}
		if (artifacts?.patchPath) facts.push({ k: "Patch", v: [span(shortenPath(artifacts.patchPath), "path")] });
		for (const nestedPath of artifacts?.nestedPatchPaths ?? []) {
			facts.push({ k: "Nested patch", v: [span(shortenPath(nestedPath), "path")] });
		}
		if (artifacts?.branchName) facts.push({ k: "Worktree branch", v: [span(artifacts.branchName, "code")] });
		return facts;
	}

	#describeActivityItem(activity: AgentActivityRow): NativeNode {
		const ref = this.#registry.get(activity.agentId);
		const observed = this.#observedById.get(activity.agentId);
		const role = observed?.progress?.modelRole ?? ref?.history?.modelRole;
		const label = [activityGlyphSpan(activity), span(" ")];
		if (role && this.#getRoleInfo) label.push(roleBadgeSpan(role, this.#getRoleInfo(role)), span(" "));
		const title = activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title;
		label.push(
			span(sanitizeDisplaySingleLine(activity.agentId), "strong"),
			span(" "),
			span(sanitizeDisplaySingleLine(title), activity.kind === "response" ? "success" : "muted"),
		);
		return node(
			"item",
			{
				label,
				detail: sanitizeDisplaySingleLine(activity.summary),
				value: [span(activityClock(activity.timestamp), "dim")],
			},
			undefined,
			activity.id,
		);
	}

	#describeActivity(): NativeChild[] {
		const selectedAgent = this.#rows[this.#selectedRow]?.id;
		const scope =
			this.#activityScope === "all"
				? "all agents"
				: this.#activityScope === "agent"
					? (selectedAgent ?? "selected agent")
					: `${selectedAgent ?? "selected"} subtree`;
		const dot = theme.sep.dot;
		const status: NativeChild[] = [
			text([
				span(
					`${sanitizeDisplaySingleLine(scope)}${dot}${this.#activityFilter}${dot}${this.#activityFollow ? "following" : "paused"}`,
					"dim",
				),
			]),
			this.#activitySearchEditing
				? node(
						"input",
						{
							text: this.#activitySearch.getValue(),
							cursor: this.#activitySearch.getCursor(),
							prompt: [span("search: ", "muted")],
						},
						undefined,
						"search",
					)
				: text([
						span(
							this.#activitySearch.getValue() ? `search: ${this.#activitySearch.getValue()}` : "search: —",
							"dim",
						),
					]),
		];
		const selected = this.#activityRows[this.#selectedActivityRow]?.id ?? null;
		return [
			node("row", { gap: "md", wrap: true, align: "baseline" }, status, "status"),
			node(
				"list",
				{
					selected,
					filter: this.#activitySearch.getValue() || undefined,
					virtual: true,
					grow: 1,
					empty: [
						span(
							this.#activitySearch.getValue() ? "No matching activity" : "No agent activity recorded yet",
							"muted",
						),
					],
				},
				this.#activityRows.map(activity => this.#describeActivityItem(activity)),
				"activity",
			),
			hintsRow(ACTIVITY_HINTS),
		];
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
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);
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
		const query = this.#agentFilter.getValue().trim();
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
		// The 2,000-row activity query only feeds the Activity tab; switching to it refreshes.
		if (this.#section === "activity") this.#refreshActivityRows();
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
				if (this.#section === "activity") this.#refreshActivityRows();
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
			search: this.#activitySearch.getValue(),
			limit: 2_000,
		});
		if (this.#activityFilter === "errors") rows = rows.filter(row => row.status === "error");
		this.#activityRows = rows;
		if (rows.length === 0) this.#selectedActivityRow = 0;
		else if (this.#activityFollow) this.#selectedActivityRow = rows.length - 1;
		else this.#selectedActivityRow = Math.min(this.#selectedActivityRow, rows.length - 1);
	}

	#metricsFor(ref: TRecord, observed: ObservableSession | undefined): AgentMetrics | undefined {
		return hubRowMetrics(ref, observed, this.#sessionMetrics);
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
			? theme.fg("accent", `search: ${filterText(this.#activitySearch)}`)
			: this.#activitySearch.getValue()
				? `search: ${this.#activitySearch.getValue()}`
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
			body.push(
				theme.fg(
					"muted",
					this.#activitySearch.getValue() ? "No matching activity" : "No agent activity recorded yet",
				),
			);
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
					`1:agents  ${formatKeyHints(["j", "k"])}:select  ${formatKeyHint("enter")}:transcript  ${formatKeyHint("space")}:follow  ${formatKeyHint("f")}:filter  ${formatKeyHint("s")}:scope  /:search  ${formatKeyHint("escape")}:close`,
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
		const filter = this.#agentFilterEditing
			? `/${filterText(this.#agentFilter)}  ·  `
			: this.#agentFilter.getValue()
				? `/${this.#agentFilter.getValue()}  ·  `
				: "";
		if (showingNarrowDetails) {
			return theme.fg(
				"dim",
				`${filter}1:agents  2:activity  ${formatKeyHint("tab")}:roster  ${formatKeyHints(["pageUp", "pageDown"])}:scroll  ${formatKeyHint("enter")}:open  ${formatKeyHint("t")}:${nextView}  ${formatKeyHint("escape")}:roster`,
			);
		}
		if (availableWidth < 96) {
			return theme.fg(
				"dim",
				`${filter}${formatKeyHints(["j", "k"])}:select  ${formatKeyHint("enter")}:open  ${formatKeyHint("t")}:${nextView}  ${formatKeyHint("tab")}:details  ${formatKeyHints(["r", "x"])}:manage  ${formatKeyHint("escape")}:close`,
			);
		}
		return theme.fg(
			"dim",
			`${filter}1:agents  2:activity  ${formatKeyHints(["j", "k"])}/wheel:select  ${formatKeyHints(["pageUp", "pageDown"])}:details  ${formatKeyHint("enter")}/click:open  ${formatKeyHint("t")}:${nextView}  ${formatKeyHint("r")}:revive  ${formatKeyHint("x")}:kill  ${formatKeyHint("escape")}:close`,
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
			fallbackStatsSession: hubFallbackStatsSession,
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
		} else {
			const before = this.#activitySearch.getValue();
			if (!this.#activitySearch.handleInput(keyData)) return;
			if (this.#activitySearch.getValue() === before) {
				this.#requestRender();
				return;
			}
		}
		this.#refreshActivityRows();
		this.#requestRender();
	}

	#handleActivityInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#activitySearch.getValue()) {
				this.#activitySearch.setValue("");
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
			this.#toggleActivityFollow();
			return;
		}
		if (keyData === "f") {
			this.#setActivityFilter(
				ACTIVITY_FILTERS[(ACTIVITY_FILTERS.indexOf(this.#activityFilter) + 1) % ACTIVITY_FILTERS.length]!,
			);
			return;
		}
		if (keyData === "s") {
			this.#cycleActivityScope();
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

	/** Space on the activity log: follow the newest row, or hold the selection. */
	#toggleActivityFollow(): void {
		this.#activityFollow = !this.#activityFollow;
		if (this.#activityFollow && this.#activityRows.length > 0) {
			this.#selectedActivityRow = this.#activityRows.length - 1;
		}
		this.#requestRender();
	}

	/** `f` cycles through these; the picker's filter scopes set one directly. */
	#setActivityFilter(filter: ActivityFilter): void {
		this.#activityFilter = filter;
		this.#refreshActivityRows();
		this.#requestRender();
	}

	/** `s`: all agents → the selected agent → its subtree. */
	#cycleActivityScope(): void {
		const scopes: ActivityScope[] = ["all", "agent", "subtree"];
		this.#activityScope = scopes[(scopes.indexOf(this.#activityScope) + 1) % scopes.length]!;
		this.#refreshActivityRows();
		this.#requestRender();
	}

	/** `t`: flat roster ⇄ grouped by parent. */
	#toggleViewMode(): void {
		this.#hoveredRow = null;
		this.#viewMode = this.#viewMode === "roster" ? "tree" : "roster";
		this.#refreshRows();
		this.#requestRender();
	}

	#handleTableInput(keyData: string): void {
		if (this.#agentFilterEditing) {
			if (matchesKey(keyData, "escape") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
				this.#agentFilterEditing = false;
				if (matchesKey(keyData, "escape")) this.#agentFilter.setValue("");
			} else {
				const before = this.#agentFilter.getValue();
				if (!this.#agentFilter.handleInput(keyData)) return;
				if (this.#agentFilter.getValue() === before) {
					this.#requestRender();
					return;
				}
			}
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "escape")) {
			if (this.#agentFilter.getValue()) {
				this.#agentFilter.setValue("");
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
			this.#toggleViewMode();
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
