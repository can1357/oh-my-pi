/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Agent Hub (ctrl+s / `/agents`): every subagent of the session as a
 * data-first `picker` with two tabs.
 *
 * - Agents: the roster, flat (newest spawn batches first, then by status and
 *   recency; a row keeps its place once seen) or grouped by parent (`t`),
 *   filtered by status scope and a fuzzy filter (`/`). The selected agent's
 *   preview lists its facts and recent activity. Enter focuses the agent (or
 *   opens its transcript), `r` revives a parked or killed agent, `x` kills.
 * - Activity: the merged activity log of every agent (or the selected agent,
 *   or its subtree: `s`), filtered by kind (`f`) and searched (`/`); it
 *   follows the newest row until the selection moves (space resumes).
 *
 * The terminal draws its own boxed look (`term.look = "omp.hub"`,
 * `src/ui/styles/pickers/agent-hub.ts`): a roster beside the inspector on a
 * wide terminal, the roster alone (Tab swaps in the inspector) on a narrow
 * one, and the activity table.
 */
import {
	type Accessor,
	computed,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	signal,
	type UiEvent,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import type {
	TspKvProps,
	TspPickerColumn,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import { sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import {
	type AgentActivityKind,
	type AgentActivityQuery,
	type AgentActivityRow,
	activityRowsFromProgress,
} from "../../../modes/view-model/overlays/agent-activity";
import {
	type AgentMetrics,
	type AggregateMetrics,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "../../../modes/view-model/overlays/agent-hub-projection";
import { formatCost } from "../../../modes/view-model/overlays/agent-hub-renderer";
import {
	type AgentHubRegistry,
	type AgentRecordLike,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "../../../registry/agent-hub-types";
import type { ObservableSession } from "../../../task/session-observer-registry";
import { fuzzyMatch } from "../../../utils/fuzzy";
import { shortenPath } from "../../../utils/render-utils";
import { clearHubHover, hubPaintedSplit } from "../../styles/pickers/agent-hub";
import type {
	HubActivityLine,
	HubActivityView,
	HubAgentsView,
	HubDetail,
	HubEntries,
	HubEntry,
	HubLookTerm,
} from "../../styles/pickers/agent-hub";
import { contextLevel, contextTone } from "../../status/format";
import {
	ACTIVITY_KIND_ICON,
	type AgentRoleDisplay,
	type AgentTree,
	activityClock,
	activityGlyph,
	activitySummary,
	activityTitle,
	agentCurrent,
	agentTask,
	compareFrozenRanks,
	type FrozenRank,
	formatMetricDuration,
	hubModel,
	localDateTime,
	metricsText,
	NATIVE_CHILD_IDS,
	projectAgentTree,
	recentActivityLine,
	roleBadge,
	STATUS_DOT,
	span,
	taskSummary,
	treeSegments,
} from "./agent-hub-model";
import { stableKey } from "./format";
import { confirmKbd } from "../../keys/hints";
import { closeAction } from "./select-sheet";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

export type AgentHubSection = "agents" | "activity";
type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";
type ViewMode = "roster" | "tree";
type StatusScope = "all" | "running" | "done" | "parked";

/** The observer registry: live progress of running subagents. */
export interface AgentHubObservers {
	getSessions(): readonly ObservableSession[];
	getSession(id: string): ObservableSession | undefined;
	onChange(listener: () => void): () => void;
}

/** Merged activity of every agent, local or from the collab host. */
export interface AgentActivitySource {
	setLive(agentId: string, rows: readonly AgentActivityRow[]): void;
	sync(agentId: string, sessionFile: string | null | undefined): Promise<void>;
	query(query: AgentActivityQuery): AgentActivityRow[];
	recent(agentId: string, limit: number): AgentActivityRow[];
}

/** Reviving and releasing agents. */
export interface AgentLifecycleLike<T extends AgentRecordLike = AgentRecordLike> {
	ensureLive(id: string): Promise<unknown>;
	release(id: string, expected: T, options: { tombstone: true }): Promise<boolean>;
}

/** Collab guest: actions run on the host. */
export interface AgentHubRemote {
	kill(id: string): void;
	revive(id: string): void;
}

export interface AgentHubProps<T extends AgentRecordLike = AgentRecordLike> {
	readonly registry: AgentHubRegistry<T>;
	readonly observers: AgentHubObservers;
	readonly activity: AgentActivitySource;
	readonly irc: { unreadCount(id: string): number };
	readonly lifecycle: () => AgentLifecycleLike<T>;
	readonly getRoleInfo?: (role: string) => AgentRoleDisplay;
	/** Register the session's saved subagents; `shouldContinue` turns false once the hub closes. */
	readonly loadPersisted: (shouldContinue: () => boolean) => Promise<void>;
	/** The main session file: a `.jsonl` one has saved subagents to scan (shown as loading meanwhile). */
	readonly sessionFile?: string | null;
	/** Whether a registry entry belongs to the open session's tree (default: all do). */
	readonly inSession?: (ref: AgentRecordLike) => boolean;
	/** Key ids that close the hub from inside (its own toggle keys). */
	readonly hubKeys: readonly string[];
	readonly initialSection?: AgentHubSection;
	/** Whether the hub feeds observer progress into the live activity rows (default true). */
	readonly manageActivityLive?: boolean;
	/** Terminal rows the hub may fill. */
	readonly rows: Accessor<number>;
	/** Focus the main view on an agent's live session (reviving it); absent: Enter opens its transcript. */
	readonly focusAgent?: (id: string) => Promise<void>;
	/** Open an agent's transcript (at an entry). */
	readonly openTranscript?: (id: string, entryId?: string) => void;
	readonly remote?: AgentHubRemote;
	readonly onDone: () => void;
	/** Wall clock (ms); default `Date.now`. */
	readonly now?: () => number;
}

/** The hub's imperative surface for its host. */
export interface AgentHubHandle {
	/** Show a section (a slash command deep-linking into the open hub). */
	showSection(section: AgentHubSection): void;
	/** Let one `←` close the hub (the editor's `←←` that opened it consumed the first tap). */
	armCloseTap(): void;
	/** Resolves once saved subagents are registered. */
	readonly persistedReady: Promise<void>;
}

const STATUS_SCOPES: readonly { id: StatusScope; label: string; icon: string; status?: AgentStatus }[] = [
	{ id: "all", label: "All", icon: "list" },
	{ id: "running", label: "Running", icon: "play", status: "running" },
	{ id: "done", label: "Done", icon: "check", status: "idle" },
	{ id: "parked", label: "Parked", icon: "pause", status: "parked" },
];
const PICKER_TABS = [
	{ id: "agents", label: "Agents" },
	{ id: "activity", label: "Activity" },
];
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
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "errors", "responses", "tools"];
const ACTIVITY_FILTER_SCOPES: readonly TspPickerScope[] = [
	{ id: "all", label: "All", icon: "list", group: "Show" },
	{ id: "errors", label: "Errors", icon: "x-circle", group: "Show" },
	{ id: "responses", label: "Responses", icon: "message", group: "Show" },
	{ id: "tools", label: "Tools", icon: "wrench", group: "Show" },
];
const ACTIVITY_SCOPES: readonly ActivityScope[] = ["all", "agent", "subtree"];
const EMPTY_AGENTS =
	"No agents in this session. Finished, parked and killed subagents stay with the session that created them.";
const SEP = " · ";

/** Recent-activity entries the preview lists for the selected agent. */
const NATIVE_RECENT_ACTIVITY = 20;
/** Activity rows a query reads. */
const ACTIVITY_LIMIT = 2_000;
/** Registry and observer changes coalesce into one refresh. */
const DATA_CHANGE_DELAY_MS = 100;
/** Ages and fallback usage refresh on this cadence. */
const AGE_TICK_MS = 5_000;
/** Two `←` within this window close the hub. */
const LEFT_TAP_WINDOW_MS = 500;

/** A one-line text field (the roster filter, the activity search). */
interface LineInput {
	text: string;
	cursor: number;
	editing: boolean;
}

/** Edit `input` with `key`; false when the key is not an edit. */
function editLine(input: LineInput, key: KeyEvent): boolean {
	const { text, cursor } = input;
	switch (key.id) {
		case "backspace":
			if (cursor > 0) {
				input.text = text.slice(0, cursor - 1) + text.slice(cursor);
				input.cursor = cursor - 1;
			}
			return true;
		case "delete":
			input.text = text.slice(0, cursor) + text.slice(cursor + 1);
			return true;
		case "left":
			input.cursor = Math.max(0, cursor - 1);
			return true;
		case "right":
			input.cursor = Math.min(text.length, cursor + 1);
			return true;
		case "home":
			input.cursor = 0;
			return true;
		case "end":
			input.cursor = text.length;
			return true;
	}
	if (key.text && !/[\x00-\x1f\x7f]/.test(key.text)) {
		input.text = text.slice(0, cursor) + key.text + text.slice(cursor);
		input.cursor = cursor + key.text.length;
		return true;
	}
	return false;
}

/** The picker's `query`/`cursor` for a field: null while closed and empty. */
function pickerQuery(input: LineInput): Pick<TspPickerProps, "query" | "cursor"> {
	return input.editing || input.text ? { query: input.text, cursor: input.cursor } : { query: null };
}

/** The Agent Hub. `ref` receives its imperative handle. */
export function AgentHub<T extends AgentRecordLike>(
	props: AgentHubProps<T> & { ref?: (hub: AgentHubHandle) => void },
): JSXNode {
	const now = props.now ?? Date.now;
	const registry = props.registry;
	/** Bumped on every visible change: the tree and the look recompute from the state below. */
	const revision = signal(0);
	/** Bumped by every change but a selection move: the picker's agent items rebuild only then. */
	let rosterEpoch = 0;
	const touch = (): void => {
		rosterEpoch++;
		revision.set(revision() + 1);
	};
	/** A selection move: the look and the preview follow; the agent items stand. */
	const touchSelection = (): void => revision.set(revision() + 1);
	/** The picker node, for the terminal's pointer state. */
	let sheet: UiNode | undefined;
	/** The selection moved some other way than the pointer: the hovered row no longer stands out. */
	const unhover = (): void => {
		if (sheet) clearHubHover(sheet);
	};
	/** The inspector shows beside the roster (Tab has nothing to swap). */
	const split = (): boolean => sheet !== undefined && hubPaintedSplit(sheet);

	let disposed = false;
	let section: AgentHubSection = props.initialSection ?? "agents";
	let loading = !props.remote && Boolean(props.sessionFile?.endsWith(".jsonl"));
	let viewMode: ViewMode = "roster";
	let statusScope: StatusScope = "all";
	const filter: LineInput = { text: "", cursor: 0, editing: false };
	const search: LineInput = { text: "", cursor: 0, editing: false };
	let activityFilter: ActivityFilter = "all";
	let activityScope: ActivityScope = "all";
	let follow = true;
	let notice: string | undefined;
	let narrowDetails = false;
	let lastLeftTap = 0;

	let rows: T[] = [];
	let selectedRow = 0;
	let sessionCount = 0;
	let tree: AgentTree<T> = projectAgentTree<T>([], () => false);
	let treeMaxDepth = 0;
	const childrenByParent = new Map<string, T[]>();
	let statusCounts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
	let observedById = new Map<string, ObservableSession>();
	let aggregate: AggregateMetrics = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: 0,
		durationKind: "active",
		reportedAgents: 0,
		activeDurationAgents: 0,
	};
	let fallbackLive = false;
	const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	const frozenRank = new Map<T, FrozenRank>();
	const seenIds = new Set<string>();
	let opened = false;
	let spawnBatches = 0;
	let activityRows: AgentActivityRow[] = [];
	let selectedActivity = 0;
	let syncGeneration = 0;
	const syncStamps = new Map<string, string>();

	const observed = (id: string): ObservableSession | undefined =>
		observedById.get(id) ?? props.observers.getSession(id);
	const metricsFor = (ref: T, session: ObservableSession | undefined): AgentMetrics | undefined =>
		hubRowMetrics(ref, session, sessionMetrics);
	const sessionRefs = (): T[] =>
		registry.list().filter(ref => ref.id !== MAIN_AGENT_ID && (props.inSession?.(ref) ?? true));

	/** A parked or killed agent without a session and an unseen id, met while the saved-agent scan runs, is one it found. */
	const foundOnDisk = (ref: T): boolean =>
		loading && ref.session === null && (ref.status === "parked" || ref.status === "aborted") && !seenIds.has(ref.id);

	const refreshAggregate = (refreshFallback: boolean): void => {
		const result = aggregateMetrics({
			rows,
			observedById,
			metricsFor,
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback,
		});
		aggregate = result.metrics;
		fallbackLive = result.hasFallbackLiveSessions;
	};

	const activityAgentIds = (): ReadonlySet<string> | undefined => {
		if (activityScope === "all") return undefined;
		const selected = rows[selectedRow]?.id;
		if (!selected) return new Set();
		const ids = new Set([selected]);
		if (activityScope === "agent") return ids;
		const queue = [selected];
		for (let index = 0; index < queue.length; index++) {
			for (const child of childrenByParent.get(queue[index]!) ?? []) {
				if (ids.has(child.id)) continue;
				ids.add(child.id);
				queue.push(child.id);
			}
		}
		return ids;
	};

	const refreshActivityRows = (): void => {
		const kinds: ReadonlySet<AgentActivityKind> | undefined =
			activityFilter === "responses"
				? new Set(["response"])
				: activityFilter === "tools"
					? new Set(["tool"])
					: undefined;
		let found = props.activity.query({
			agentIds: activityAgentIds(),
			kinds,
			search: search.text,
			limit: ACTIVITY_LIMIT,
		});
		if (activityFilter === "errors") found = found.filter(row => row.status === "error");
		activityRows = found;
		if (found.length === 0) selectedActivity = 0;
		else if (follow) selectedActivity = found.length - 1;
		else selectedActivity = Math.min(selectedActivity, found.length - 1);
	};

	const syncActivity = (refs: readonly T[]): void => {
		if (props.manageActivityLive ?? true) {
			for (const ref of refs) {
				const progress = observedById.get(ref.id)?.progress;
				props.activity.setLive(
					ref.id,
					progress ? activityRowsFromProgress(progress, observedById.get(ref.id)!.lastUpdate) : [],
				);
			}
		}
		const generation = ++syncGeneration;
		const pending: Promise<void>[] = [];
		for (const ref of refs) {
			if (!props.remote && !ref.sessionFile) continue;
			const stamp = `${ref.sessionFile ?? ""}:${ref.lastActivity}`;
			if (syncStamps.get(ref.id) === stamp) continue;
			syncStamps.set(ref.id, stamp);
			pending.push(props.activity.sync(ref.id, ref.sessionFile));
		}
		if (pending.length === 0) return;
		void Promise.all(pending)
			.then(() => {
				if (disposed || generation !== syncGeneration) return;
				if (section === "activity") refreshActivityRows();
				touch();
			})
			.catch(() => {});
	};

	/** Re-read the registry: rank new generations, filter, scope and project the roster, keep the selection. */
	const refreshRows = (): void => {
		const selectedId = rows[selectedRow]?.id;
		const refs = sessionRefs();
		sessionCount = refs.length;
		observedById = new Map(props.observers.getSessions().map(session => [session.id, session]));
		const live = new Set(refs);
		for (const ref of frozenRank.keys()) if (!live.has(ref)) frozenRank.delete(ref);
		let spawnBatch: number | undefined;
		for (const ref of refs) {
			if (frozenRank.has(ref)) continue;
			frozenRank.set(ref, {
				id: ref.id,
				status: ref.status,
				lastActivity: ref.lastActivity,
				batch: opened && !foundOnDisk(ref) ? (spawnBatch ??= --spawnBatches) : 0,
			});
			seenIds.add(ref.id);
		}
		opened = true;
		refs.sort((a, b) => compareFrozenRanks(frozenRank.get(a)!, frozenRank.get(b)!));
		const query = filter.text.trim();
		const matched = query
			? refs.filter(ref => fuzzyMatch(query, `${ref.id} ${ref.displayName ?? ""}`).matches)
			: refs;
		const status = STATUS_SCOPES.find(scope => scope.id === statusScope)?.status;
		const scoped = status ? matched.filter(ref => ref.status === status) : matched;
		if (viewMode === "tree") {
			tree = projectAgentTree(scoped, ref => frozenRank.get(ref)!.batch < 0);
			rows = tree.rows;
			treeMaxDepth = Math.max(0, ...tree.depthById.values());
		} else {
			tree = projectAgentTree<T>([], () => false);
			rows = scoped;
			treeMaxDepth = 0;
		}
		const kept = selectedId ? rows.findIndex(ref => ref.id === selectedId) : -1;
		selectedRow = kept >= 0 ? kept : Math.min(selectedRow, Math.max(0, rows.length - 1));
		childrenByParent.clear();
		for (const ref of matched) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const siblings = childrenByParent.get(parent);
			if (siblings) siblings.push(ref);
			else childrenByParent.set(parent, [ref]);
		}
		statusCounts = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of matched) statusCounts[ref.status]++;
		refreshAggregate(false);
		syncActivity(matched);
		if (section === "activity") refreshActivityRows();
	};

	// ─── Data changes ───────────────────────────────────────────────────────

	let changeTimer: NodeJS.Timeout | undefined;
	const scheduleChange = (): void => {
		if (changeTimer) return;
		changeTimer = setTimeout(() => {
			changeTimer = undefined;
			if (disposed) return;
			refreshRows();
			touch();
		}, DATA_CHANGE_DELAY_MS);
		changeTimer.unref?.();
	};
	const unsubscribers = [registry.onChange(scheduleChange), props.observers.onChange(scheduleChange)];
	const ageTimer = setInterval(() => {
		if (fallbackLive) refreshAggregate(true);
		touch();
	}, AGE_TICK_MS);
	ageTimer.unref?.();
	onCleanup(() => {
		disposed = true;
		for (const unsubscribe of unsubscribers) unsubscribe();
		clearInterval(ageTimer);
		clearTimeout(changeTimer);
	});

	const persistedReady = props.remote
		? Promise.resolve()
		: props
				.loadPersisted(() => !disposed)
				.catch(() => {})
				.finally(() => {
					if (disposed) return;
					// Rank what the scan found before its end turns later arrivals into spawns.
					refreshRows();
					loading = false;
					touch();
				});
	refreshRows();

	// ─── Actions ────────────────────────────────────────────────────────────

	const switchSection = (next: AgentHubSection): void => {
		if (section === next) return;
		section = next;
		narrowDetails = false;
		unhover();
		if (next === "activity") refreshActivityRows();
		touch();
	};

	const openChat = (id: string, entryId?: string): void => {
		if (disposed || !registry.get(id) || !props.openTranscript) return;
		notice = undefined;
		props.openTranscript(id, entryId);
		touch();
	};

	const activate = (ref: T): void => {
		notice = undefined;
		const focusAgent = props.focusAgent;
		// An advisor is a read-only transcript with nothing to revive.
		if (ref.kind === "advisor" || props.remote || !focusAgent) {
			openChat(ref.id);
			touch();
			return;
		}
		void focusAgent(ref.id).then(
			() => props.onDone(),
			(error: unknown) => {
				notice = error instanceof Error ? error.message : String(error);
				touch();
			},
		);
		touch();
	};

	const revive = (): void => {
		const ref = rows[selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") notice = `"${ref.id}" is a read-only advisor transcript — nothing to revive.`;
		else if (ref.status !== "parked" && ref.status !== "aborted")
			notice = `Agent "${ref.id}" is ${ref.status} — only parked or killed agents can be revived.`;
		else {
			notice = undefined;
			if (props.remote) props.remote.revive(ref.id);
			else
				props
					.lifecycle()
					.ensureLive(ref.id)
					.catch((error: unknown) => {
						notice = error instanceof Error ? error.message : String(error);
						touch();
					});
		}
		touch();
	};

	const kill = (): void => {
		const ref = rows[selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			notice = `"${ref.id}" is a read-only advisor transcript — cannot be killed.`;
			touch();
			return;
		}
		notice = undefined;
		touch();
		if (props.remote) {
			props.remote.kill(ref.id);
			refreshRows();
			touch();
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) await ref.session.abort({ reason: "Interrupted by user" });
				await props.lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (error) {
				notice = error instanceof Error ? error.message : String(error);
			}
			if (disposed) return;
			refreshRows();
			touch();
		})();
	};

	const toggleView = (): void => {
		unhover();
		viewMode = viewMode === "roster" ? "tree" : "roster";
		refreshRows();
		touch();
	};

	const setActivityFilter = (next: ActivityFilter): void => {
		activityFilter = next;
		refreshActivityRows();
		touch();
	};

	const cycleActivityScope = (): void => {
		activityScope = ACTIVITY_SCOPES[(ACTIVITY_SCOPES.indexOf(activityScope) + 1) % ACTIVITY_SCOPES.length]!;
		refreshActivityRows();
		touch();
	};

	const toggleFollow = (): void => {
		follow = !follow;
		if (follow && activityRows.length > 0) selectedActivity = activityRows.length - 1;
		touch();
	};

	const moveActivity = (delta: number): void => {
		if (activityRows.length > 0) {
			follow = false;
			selectedActivity = Math.max(0, Math.min(selectedActivity + delta, activityRows.length - 1));
		}
		touch();
	};

	const moveRow = (delta: number): void => {
		if (rows.length > 0) selectedRow = Math.max(0, Math.min(selectedRow + delta, rows.length - 1));
		touchSelection();
	};

	// ─── Keys ───────────────────────────────────────────────────────────────

	const onFilterKey = (key: KeyEvent): boolean => {
		if (key.id === "escape" || key.id === "enter") {
			filter.editing = false;
			if (key.id === "escape") {
				filter.text = "";
				filter.cursor = 0;
			}
		} else {
			const before = filter.text;
			if (!editLine(filter, key)) return true;
			if (filter.text === before) {
				touch();
				return true;
			}
		}
		refreshRows();
		touch();
		return true;
	};

	const onSearchKey = (key: KeyEvent): boolean => {
		if (key.id === "escape" || key.id === "enter") search.editing = false;
		else {
			const before = search.text;
			if (!editLine(search, key)) return true;
			if (search.text === before) {
				touch();
				return true;
			}
		}
		refreshActivityRows();
		touch();
		return true;
	};

	const onActivityKey = (key: KeyEvent): boolean => {
		if (matchesSelectCancel(key)) {
			if (search.text) {
				search.text = "";
				search.cursor = 0;
				refreshActivityRows();
				touch();
			} else props.onDone();
			return true;
		}
		switch (selectKeyId(key)) {
			case "left":
				switchSection("agents");
				return true;
			case "/":
				search.editing = true;
				touch();
				return true;
			case "space":
				toggleFollow();
				return true;
			case "f":
				setActivityFilter(
					ACTIVITY_FILTERS[(ACTIVITY_FILTERS.indexOf(activityFilter) + 1) % ACTIVITY_FILTERS.length]!,
				);
				return true;
			case "s":
				cycleActivityScope();
				return true;
			case "j":
			case "down":
				moveActivity(1);
				return true;
			case "k":
			case "up":
				moveActivity(-1);
				return true;
			case "enter": {
				const row = activityRows[selectedActivity];
				if (row) openChat(row.agentId, row.entryId);
				return true;
			}
		}
		return true;
	};

	const onAgentsKey = (key: KeyEvent): boolean => {
		if (filter.editing) return onFilterKey(key);
		if (matchesSelectCancel(key)) {
			if (filter.text) {
				filter.text = "";
				filter.cursor = 0;
				refreshRows();
			} else if (narrowDetails && !split()) narrowDetails = false;
			else props.onDone();
			touch();
			return true;
		}
		switch (selectKeyId(key)) {
			case "/":
				filter.editing = true;
				touch();
				return true;
			case "tab":
				if (split()) break;
				if (rows.length > 0) narrowDetails = !narrowDetails;
				touch();
				return true;
			case "pageUp":
			case "pageDown":
				// The inspector's scroll is the terminal's (the look's widget).
				return false;
			case "t":
				toggleView();
				return true;
			case "left": {
				if (narrowDetails && !split()) {
					narrowDetails = false;
					touch();
					return true;
				}
				const at = now();
				if (at - lastLeftTap < LEFT_TAP_WINDOW_MS) {
					lastLeftTap = 0;
					props.onDone();
				} else lastLeftTap = at;
				return true;
			}
		}
		unhover();
		switch (selectKeyId(key)) {
			case "j":
			case "down":
				moveRow(1);
				return true;
			case "k":
			case "up":
				moveRow(-1);
				return true;
			case "enter": {
				const ref = rows[selectedRow];
				if (ref) activate(ref);
				return true;
			}
			case "r":
				revive();
				return true;
			case "x":
				kill();
				return true;
		}
		return true;
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (props.hubKeys.includes(key.id)) {
			props.onDone();
			return true;
		}
		if (section === "activity" && search.editing) return onSearchKey(key);
		if (key.id === "1") {
			switchSection("agents");
			return true;
		}
		if (key.id === "2") {
			switchSection("activity");
			return true;
		}
		return section === "activity" ? onActivityKey(key) : onAgentsKey(key);
	};

	// ─── Pointer and native events ──────────────────────────────────────────

	const pick = (item: string, activateIt: boolean): void => {
		if (section === "activity") {
			const index = activityRows.findIndex(row => row.id === item);
			const row = activityRows[index];
			if (!row) return;
			if (activateIt) {
				openChat(row.agentId, row.entryId);
				return;
			}
			follow = false;
			selectedActivity = index;
			touch();
			return;
		}
		const index = rows.findIndex(ref => ref.id === item);
		const ref = rows[index];
		if (!ref) return;
		if (!activateIt) unhover();
		selectedRow = index;
		touchSelection();
		if (activateIt) activate(ref);
	};

	const onAction = (act: string, event: Extract<UiEvent, { type: "action" }>): void => {
		if (act === "transcript") {
			// A preview activity row (its key names the row).
			const row = recentByKey.get(event.key.slice(event.key.lastIndexOf("/") + 1));
			if (row) openChat(row.agentId, row.entryId);
			return;
		}
		const activity = section === "activity";
		switch (act) {
			case "tab":
				if (event.value === "agents" || event.value === "activity") switchSection(event.value);
				return;
			case "scope":
				if (activity && ACTIVITY_FILTERS.includes(event.value as ActivityFilter))
					setActivityFilter(event.value as ActivityFilter);
				else if (!activity && STATUS_SCOPES.some(scope => scope.id === event.value)) {
					statusScope = event.value as StatusScope;
					refreshRows();
					touch();
				}
				return;
			case "close":
				props.onDone();
				return;
			case "clear": {
				const input = activity ? search : filter;
				input.text = "";
				input.cursor = 0;
				if (activity) refreshActivityRows();
				else refreshRows();
				touch();
				return;
			}
			case "filter":
				if (activity) search.editing = true;
				else filter.editing = true;
				touch();
				return;
			case "open":
				if (activity) {
					const row = activityRows[selectedActivity];
					if (row) openChat(row.agentId, row.entryId);
				} else {
					const ref = rows[selectedRow];
					if (ref) activate(ref);
				}
				return;
		}
		if (activity) {
			if (act === "follow") toggleFollow();
			else if (act === "agents") cycleActivityScope();
			return;
		}
		if (act === "revive") revive();
		else if (act === "kill") kill();
		else if (act === "view") toggleView();
	};

	props.ref?.({
		showSection: switchSection,
		armCloseTap: () => {
			lastLeftTap = now();
		},
		persistedReady,
	});

	// ─── Native tree ────────────────────────────────────────────────────────

	/** Preview activity rows by node key, for their pointer actions. */
	const recentByKey = new Map<string, AgentActivityRow>();

	const agentItem = (ref: T, at: number): TspPickerItem => {
		const session = observed(ref.id);
		const metrics = metricsFor(ref, session);
		const task = agentTask(ref, session);
		const badges: NonNullable<TspPickerItem["badges"]>[number][] = [];
		const role = session?.progress?.modelRole ?? ref.history?.modelRole;
		if (role && props.getRoleInfo)
			badges.push({ text: roleBadge(role, props.getRoleInfo(role)).text, title: "Model role" });
		if (ref.kind === "advisor") badges.push({ text: "read-only", tone: "warning" });
		const unread = props.irc.unreadCount(ref.id);
		if (unread > 0) badges.push({ text: `${unread} unread`, tone: "warning" });
		if (viewMode === "roster" && ref.parentId && ref.parentId !== MAIN_AGENT_ID)
			badges.push({ text: `↳ ${sanitizeDisplaySingleLine(ref.parentId)}`, tone: "muted", title: "Spawned by" });
		const model = hubModel(ref, session);
		let item: TspPickerItem = {
			id: ref.id,
			label: sanitizeDisplaySingleLine(ref.id),
			mono: true,
			dot: STATUS_DOT[ref.status],
			detail: task ? taskSummary(task) : undefined,
			chips: model
				? [{ text: model.fallback ? `fallback → ${model.text}` : model.text, dot: model.levelColor }]
				: undefined,
			badges: badges.length > 0 ? badges.slice(0, 3) : undefined,
		};
		if (viewMode === "tree")
			item = {
				...item,
				depth: tree.depthById.get(ref.id) ?? 0,
				open: childrenByParent.has(ref.id) ? true : undefined,
			};
		if (!metrics) return item;
		// A running agent's active time ticks terminal-side from its age at send.
		const progressAt = session?.progress ? session.progressAt : undefined;
		const clocked = ref.status === "running" && (metrics.durationMs > 0 || progressAt !== undefined);
		const facts: Record<string, string | number> = {
			cost: formatCost(metrics.cost),
			time: clocked
				? metrics.durationMs + (progressAt === undefined ? 0 : Math.max(0, at - progressAt))
				: (formatMetricDuration(metrics)?.replace(/ \w+$/, "") ?? "0ms"),
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
	};

	/** The roster's picker items, kept across selection moves (a 10k roster rebuilds them only when it changes). */
	let agentItems: { rows: readonly T[]; epoch: number; items: TspPickerItem[] } | undefined;
	const rosterItems = (at: number): TspPickerItem[] => {
		if (agentItems?.rows !== rows || agentItems.epoch !== rosterEpoch)
			agentItems = { rows, epoch: rosterEpoch, items: rows.map(ref => agentItem(ref, at)) };
		return agentItems.items;
	};

	const detailFacts = (ref: T, session: ObservableSession | undefined, metrics: AgentMetrics | undefined) => {
		const progress = session?.progress;
		const children = childrenByParent.get(ref.id) ?? [];
		const facts: { k: string; v: TspSpan[] | string }[] = [];
		const task = agentTask(ref, session);
		if (task) facts.push({ k: "Task", v: taskSummary(task) });
		const current = agentCurrent(ref, session, SEP);
		if (current) {
			const value = [span(sanitizeDisplaySingleLine(current))];
			if (progress?.retryState)
				value.push(
					span(`${SEP}retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`, "warning"),
				);
			facts.push({ k: "Current", v: value });
		}
		facts.push({ k: "Usage", v: metrics ? metricsText(metrics, SEP) : [span("usage —", "dim")] });
		facts.push({
			k: "Lineage",
			v: `Spawned by ${sanitizeDisplaySingleLine(ref.parentId ?? MAIN_AGENT_ID)}${children.length > 0 ? `${SEP}${children.length} ${children.length === 1 ? "child" : "children"}` : ""}`,
		});
		if (children.length > 0) {
			const named = children.slice(0, NATIVE_CHILD_IDS).map(child => sanitizeDisplaySingleLine(child.id));
			const more = children.length - named.length;
			facts.push({ k: "Children", v: [span(`${named.join(", ")}${more > 0 ? `, … +${more}` : ""}`, "dim")] });
		}
		facts.push({ k: "Registered", v: [span(localDateTime(ref.createdAt), "dim")] });
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
		if (artifacts?.outputPath)
			facts.push({
				k: "Output",
				v: [{ t: shortenPath(artifacts.outputPath), s: "path", href: `file://${artifacts.outputPath}` }],
			});
		if (artifacts?.patchPath) facts.push({ k: "Patch", v: [span(shortenPath(artifacts.patchPath), "path")] });
		for (const nested of artifacts?.nestedPatchPaths ?? [])
			facts.push({ k: "Nested patch", v: [span(shortenPath(nested), "path")] });
		if (artifacts?.branchName) facts.push({ k: "Worktree branch", v: [span(artifacts.branchName, "code")] });
		return facts;
	};

	const preview = (ref: T | undefined): JSXNode[] => {
		recentByKey.clear();
		if (!ref) return [];
		const session = observed(ref.id);
		const metrics = metricsFor(ref, session);
		const facts = detailFacts(ref, session, metrics);
		const model = hubModel(ref, session);
		if (model) {
			const value: TspSpan[] = [];
			if (model.fallback) value.push(span("fallback → ", "warning"));
			value.push(span(model.text, "mono"));
			if (model.level && model.levelColor) value.push(span(SEP, "dim"), span(model.level, model.levelColor));
			const role = session?.progress?.modelRole ?? ref.history?.modelRole;
			if (role && props.getRoleInfo) {
				const badge = roleBadge(role, props.getRoleInfo(role));
				value.push(span(SEP, "dim"), span(badge.text, badge.color));
			}
			facts.splice(facts[0]?.k === "Task" ? 1 : 0, 0, { k: "Model", v: value });
		}
		const out: JSXNode[] = [
			<row key="title" role="omp.hub.title" gap="sm" align="center">
				<text role="omp.picker.title" text={sanitizeDisplaySingleLine(ref.displayName || ref.id)} truncate="end" />
				<badge text={ref.status} tone={STATUS_DOT[ref.status]} />
			</row>,
		];
		if (notice) out.push(<text key="notice" text={notice} tone="error" wrap="word" />);
		out.push(<kv key="facts" items={facts as TspKvProps["items"]} layout="grid" role="omp.hub.kv" />);
		if (metrics?.contextTokens !== undefined && metrics.contextWindow) {
			const ratio = Math.max(0, Math.min(1, metrics.contextTokens / metrics.contextWindow));
			out.push(
				<meter
					key="context"
					value={ratio}
					style="bar"
					size="md"
					label={`${formatNumber(metrics.contextTokens)} / ${formatNumber(metrics.contextWindow)} · ${Math.round(ratio * 100)}%`}
					tone={contextTone(contextLevel(ratio * 100, metrics.contextWindow))}
				/>,
			);
		}
		const recent = props.activity.recent(ref.id, NATIVE_RECENT_ACTIVITY).map(row => {
			const key = stableKey(row.id);
			recentByKey.set(key, row);
			const glyph = activityGlyph(row);
			return (
				<row
					key={key}
					role="omp.hub.activity.row"
					gap="sm"
					align="baseline"
					actions={{ click: "transcript" }}
					title="Open in transcript"
				>
					<text spans={[span(activityClock(row.timestamp), "mono dim")]} />
					<text
						spans={glyph ? [span(glyph.text ?? currentTheme().symbols.symbol(glyph.symbol!), glyph.color)] : []}
					/>
					<text spans={[span(sanitizeDisplaySingleLine(activityTitle(row)), "mono muted")]} />
					<text text={sanitizeDisplaySingleLine(activitySummary(row))} truncate="end" grow={1} />
				</row>
			);
		});
		out.push(
			<section key="recentActivity" head="Recent activity" role="omp.hub.activity">
				{recent.length > 0 ? recent : <text spans={[span("No response or tool activity yet", "dim")]} />}
			</section>,
		);
		return out;
	};

	const activityItem = (row: AgentActivityRow): TspPickerItem => ({
		id: row.id,
		label: sanitizeDisplaySingleLine(activityTitle(row)),
		mono: row.kind === "tool" || undefined,
		detail: sanitizeDisplaySingleLine(activitySummary(row)),
		icon: ACTIVITY_KIND_ICON[row.kind],
		dot: row.status === "pending" ? "pending" : undefined,
		tone: row.status === "error" ? "error" : row.status === "aborted" ? "warning" : undefined,
		facts: { agent: [span(sanitizeDisplaySingleLine(row.agentId), "mono")], at: activityClock(row.timestamp) },
		title: localDateTime(row.timestamp),
	});

	const activityScopeLabel = (capitalized: boolean): string => {
		const agent = rows[selectedRow]?.id;
		if (activityScope === "all") return capitalized ? "All agents" : "all agents";
		if (activityScope === "agent") return agent ?? (capitalized ? "Selected agent" : "selected agent");
		return `${agent ?? (capitalized ? "Selected" : "selected")} subtree`;
	};

	const pickerProps = computed((): TspPickerProps => {
		revision();
		const at = untrack(now);
		const head: TspPickerProps = {
			title: "Agents",
			subtitle:
				aggregate.reportedAgents === 0
					? "No usage reported yet"
					: [
							formatCost(aggregate.cost),
							...(aggregate.durationMs > 0 ? [formatMetricDuration(aggregate)!.replace(/ \w+$/, "")] : []),
							`${formatNumber(aggregate.requests)} req`,
							`${formatNumber(aggregate.tokens)} tok`,
						].join(SEP),
			icon: "users",
			size: "lg",
			tabs: PICKER_TABS,
			tab: section,
		};
		if (section === "activity") {
			const selected = activityRows[selectedActivity];
			return {
				...head,
				noun: "events",
				layout: "rows",
				preview: "none",
				...pickerQuery(search),
				placeholder: "Search activity…",
				scopes: ACTIVITY_FILTER_SCOPES,
				scope: activityFilter,
				columns: ACTIVITY_COLUMNS,
				items: activityRows.map(activityItem),
				selected: selected?.id ?? null,
				empty: "No agent activity recorded yet",
				actions: [
					{
						id: "open",
						label: "Open transcript",
						keys: confirmKbd(),
						primary: true,
						disabled: selected ? undefined : true,
					},
					{ id: "follow", label: "Follow", keys: ["space"], on: follow },
					{ id: "agents", label: sanitizeDisplaySingleLine(activityScopeLabel(true)), keys: ["s"] },
					{ id: "filter", label: "Search", keys: ["/"] },
					closeAction(),
				],
				focus: "list",
			};
		}
		const selected = rows[selectedRow];
		const readOnly = selected?.kind === "advisor" ? "Read-only advisor transcript" : undefined;
		const refs = sessionRefs();
		return {
			...head,
			noun: "agents",
			layout: viewMode === "tree" ? "tree" : "rows",
			preview: "side",
			...pickerQuery(filter),
			placeholder: "Filter agents…",
			scopes: STATUS_SCOPES.map(scope => ({
				id: scope.id,
				label: scope.label,
				icon: scope.icon,
				count: scope.status ? refs.filter(ref => ref.status === scope.status).length : refs.length,
			})),
			scope: statusScope,
			columns: AGENT_COLUMNS,
			items: rosterItems(at),
			selected: selected?.id ?? null,
			total: sessionCount,
			state: rows.length === 0 && loading ? "loading" : "ready",
			empty: EMPTY_AGENTS,
			actions: [
				{
					id: "open",
					label: "Open transcript",
					keys: confirmKbd(),
					primary: true,
					disabled: selected ? undefined : true,
				},
				{
					id: "revive",
					label: "Revive",
					keys: ["r"],
					disabled:
						readOnly ??
						(selected?.status === "parked" || selected?.status === "aborted"
							? undefined
							: "Only parked or killed agents can be revived"),
				},
				{
					id: "kill",
					label: "Kill",
					keys: ["x"],
					danger: true,
					disabled: readOnly ?? (selected ? undefined : true),
				},
				{ id: "view", label: "By parent", keys: ["t"], on: viewMode === "tree" },
				{ id: "filter", label: "Filter", keys: ["/"] },
				closeAction(),
			],
			focus: "list",
		};
	});

	// ─── Terminal look ──────────────────────────────────────────────────────

	const entryOf = (ref: T, at: number): HubEntry => {
		const session = observed(ref.id);
		const role = session?.progress?.modelRole ?? ref.history?.modelRole;
		const task = agentTask(ref, session);
		return {
			id: ref.id,
			status: ref.status,
			parent: viewMode === "roster" && ref.parentId && ref.parentId !== MAIN_AGENT_ID ? ref.parentId : undefined,
			readOnly: ref.kind === "advisor",
			unread: props.irc.unreadCount(ref.id),
			role: role && props.getRoleInfo ? roleBadge(role, props.getRoleInfo(role)) : undefined,
			model: hubModel(ref, session),
			task,
			age: formatAge(Math.max(1, Math.round((at - ref.lastActivity) / 1000))),
			metrics: metricsFor(ref, session),
			branch: treeSegments(ref, tree, false),
			continuation: treeSegments(ref, tree, true),
			hasChildren: childrenByParent.has(ref.id),
		};
	};

	/** `list`'s entries built on first read: a 10k roster costs only the rows the look windows. */
	const lazyEntries = (list: readonly T[], at: number): HubEntries => {
		const built = new Map<number, HubEntry>();
		return {
			length: list.length,
			at: index => {
				let entry = built.get(index);
				if (!entry) {
					entry = untrack(() => entryOf(list[index]!, at));
					built.set(index, entry);
				}
				return entry;
			},
		};
	};

	const detailOf = (ref: T, at: number): HubDetail => {
		const session = observed(ref.id);
		const progress = session?.progress;
		const metrics = metricsFor(ref, session);
		const role = progress?.modelRole ?? ref.history?.modelRole;
		const artifacts = ref.history;
		return {
			id: ref.id,
			name: ref.displayName,
			status: ref.status,
			duration: metrics ? formatMetricDuration(metrics) : undefined,
			active: formatAge(Math.max(1, Math.round((at - ref.lastActivity) / 1000))),
			role: role && props.getRoleInfo ? roleBadge(role, props.getRoleInfo(role)) : undefined,
			model: hubModel(ref, session),
			task: agentTask(ref, session),
			current: agentCurrent(ref, session, SEP),
			retry: progress?.retryState
				? `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`
				: undefined,
			metrics,
			parent: ref.parentId ?? MAIN_AGENT_ID,
			children: (childrenByParent.get(ref.id) ?? []).map(child => child.id),
			registered: localDateTime(ref.createdAt),
			readOnly: ref.kind === "advisor" || ref.history?.readOnly === true,
			artifacts: [
				...(artifacts?.outputPath ? [`Output ${shortenPath(artifacts.outputPath)}`] : []),
				...(artifacts?.patchPath ? [`Patch ${shortenPath(artifacts.patchPath)}`] : []),
				...(artifacts?.nestedPatchPaths ?? []).map(nested => `Nested patch ${shortenPath(nested)}`),
				...(artifacts?.branchName ? [`Worktree branch ${artifacts.branchName}`] : []),
			],
			recent: props.activity.recent(ref.id, Math.max(1, props.rows())).map(recentActivityLine),
		};
	};

	const activityLine = (row: AgentActivityRow): HubActivityLine => {
		const ref = registry.get(row.agentId);
		const role = observedById.get(row.agentId)?.progress?.modelRole ?? ref?.history?.modelRole;
		return {
			...recentActivityLine(row),
			id: row.id,
			agent: row.agentId,
			role: role && props.getRoleInfo ? roleBadge(role, props.getRoleInfo(role)) : undefined,
			response: row.kind === "response",
		};
	};

	const term = computed((): HubLookTerm => {
		revision();
		const at = untrack(now);
		const height = props.rows();
		if (section === "activity") {
			const view: HubActivityView = {
				scope: activityScopeLabel(false),
				filter: activityFilter,
				follow,
				search: { ...search },
				rows: activityRows.map(activityLine),
				selected: selectedActivity,
			};
			return { look: "omp.hub", role: "omp.hub", hub: { section: "activity", height, activity: view } };
		}
		const selected = rows[selectedRow];
		const view: HubAgentsView = {
			viewMode,
			counts: statusCounts,
			aggregate,
			notice,
			loading,
			filter: { ...filter },
			entries: lazyEntries(rows, at),
			selected: selectedRow,
			treeMaxDepth,
			narrowDetails,
			detail: selected ? detailOf(selected, at) : undefined,
		};
		return { look: "omp.hub", role: "omp.hub", hub: { section: "agents", height, agents: view } };
	});

	return (
		<picker
			title="Agents"
			subtitle={() => pickerProps().subtitle}
			icon="users"
			size="lg"
			tabs={PICKER_TABS}
			tab={() => pickerProps().tab}
			noun={() => pickerProps().noun}
			layout={() => pickerProps().layout}
			preview={() => pickerProps().preview}
			query={() => pickerProps().query}
			cursor={() => pickerProps().cursor}
			placeholder={() => pickerProps().placeholder}
			scopes={() => pickerProps().scopes}
			scope={() => pickerProps().scope}
			columns={() => pickerProps().columns}
			items={() => pickerProps().items}
			selected={() => pickerProps().selected}
			total={() => pickerProps().total}
			state={() => pickerProps().state}
			empty={() => pickerProps().empty}
			actions={() => pickerProps().actions}
			focus="list"
			term={term}
			ref={node => {
				sheet = node;
			}}
			onKey={onKey}
			onAction={onAction}
			onSelect={item => pick(item, false)}
			onActivate={item => pick(item, true)}
		>
			{() => {
				revision();
				return section === "agents" ? preview(rows[selectedRow]) : [];
			}}
		</picker>
	);
}
