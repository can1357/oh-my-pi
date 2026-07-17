/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentRegistry — status, unread irc count,
 *   current/last task, last activity. Select with j/k, Enter focuses/opens one,
 *   `r` revives a parked agent, and Ctrl+X twice removes one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { Container, Ellipsis, matchesKey, type OverlayHandle, type TUI, visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { formatAge, getProjectDir, logger, normalizePathForComparison } from "@pk-nerdsaver-ai/pi-utils";
import { ADVISOR_TRANSCRIPT_FILENAME } from "../../advisor";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import {
	backgroundInstanceDisplayName,
	isBackgroundInstanceSession,
	type SessionStatus,
} from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { isValidThemeColor, type ThemeColor, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { AgentHubKanbanSync, type AgentHubKanbanSyncResult } from "./agent-hub-kanban-sync";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";

/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;
/** Double-tap window for Ctrl+X "remove agent" gesture. */
const REMOVE_TAP_WINDOW_MS = 2000;
/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(text).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2), Ellipsis.Omit);
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

function rosterColor(color: string | undefined): ThemeColor | undefined {
	return color && isValidThemeColor(color) ? color : undefined;
}

/**
 * One flattened tree row: an {@link AgentRef} plus its depth (folder root = 0,
 * session lane = 1, subagents = 2+) and the pre-built connector prefix that
 * renders the `├─`/`└─` branch and the `│`/space ancestor-continuation columns.
 */
interface HubRow {
	ref: HubAgentRef;
	depth: number;
	prefix: string;
}
type HubAgentKind = AgentRef["kind"] | "background" | "folder";
type HubAgentRef = Omit<AgentRef, "kind"> & {
	kind: HubAgentKind;
	/** Folder rows only: number of session lanes grouped under this folder. */
	laneCount?: number;
	/** Folder rows only: whether this folder holds the active (current) session. */
	isCurrentFolder?: boolean;
	/** Background lanes only: coarse lifecycle status derived from the session file tail. */
	sessionStatus?: SessionStatus;
	/** Background lanes only: last assistant message text, shown as the row preview. */
	preview?: string;
};

/** Outcome word + color for a session lane, Claude Code jobs-list style. */
interface HubOutcome {
	label: string;
	color: ThemeColor;
}

/**
 * Map a lane to its outcome column. Explicit markers in the last assistant
 * message (`result:` / `failed:` / `needs input:`) win; otherwise the coarse
 * {@link SessionStatus} decides. Live registry work reads as Working.
 */
function laneOutcome(ref: HubAgentRef): HubOutcome | undefined {
	if (ref.id === MAIN_AGENT_ID) {
		return ref.status === "running" ? { label: "Working", color: "accent" } : { label: "Idle", color: "success" };
	}
	if (!isBackgroundLane(ref)) return undefined;
	const preview = ref.preview ?? "";
	const marker = /(^|\n)\s*(result|failed|needs input):/i.exec(preview)?.[2]?.toLowerCase();
	if (marker === "result") return { label: "Done", color: "success" };
	if (marker === "failed") return { label: "Failed", color: "error" };
	if (marker === "needs input") return { label: "Needs input", color: "warning" };
	switch (ref.sessionStatus) {
		case "complete":
			return { label: "Done", color: "success" };
		case "error":
		case "aborted":
			return { label: "Failed", color: "error" };
		case "pending":
		case "interrupted":
			return { label: "Needs input", color: "warning" };
		default:
			return undefined;
	}
}

/**
 * One-line preview for a background lane: the text following an explicit
 * `result:`/`failed:`/`needs input:` marker when present (the outcome column
 * already conveys the marker), otherwise the last assistant message itself.
 */
function lanePreview(ref: HubAgentRef): string | undefined {
	const preview = ref.preview?.trim();
	if (!preview) return undefined;
	const marker = /(^|\n)\s*(result|failed|needs input):\s*/i.exec(preview);
	const text = marker ? preview.slice((marker.index ?? 0) + marker[0].length) : preview;
	const line = text.replace(/\s+/g, " ").trim();
	return line || undefined;
}

function isRegistryAgentRef(ref: HubAgentRef): ref is AgentRef {
	return ref.kind !== "background" && ref.kind !== "folder" && ref.id !== MAIN_AGENT_ID;
}

function isBackgroundLane(ref: HubAgentRef): boolean {
	return ref.kind === "background" && (ref.parentId ?? MAIN_AGENT_ID) === MAIN_AGENT_ID;
}

function isFolder(ref: HubAgentRef): boolean {
	return ref.kind === "folder";
}

function isLane(ref: HubAgentRef): boolean {
	return ref.id === MAIN_AGENT_ID || isBackgroundLane(ref);
}

/** Stable grouping key for a session's working directory (folder). Empty cwd → "" (unknown bucket). */
function folderKey(cwd: string | undefined): string {
	return cwd ? path.resolve(cwd) : "";
}

/** Human-facing folder label: directory basename, or "(unknown folder)" for sessions with no recorded cwd. */
function folderDisplayName(cwd: string | undefined): string {
	if (!cwd) return "(unknown folder)";
	return path.basename(path.resolve(cwd)) || cwd;
}

/**
 * One ancestor-continuation column matching a connector's width: spaces when the
 * branch was the last sibling, else the `│` vertical plus padding. Computed per
 * call so a live theme switch updates the glyphs.
 */
function treeContinuation(last: boolean): string {
	const indent = theme.tree.branch.length + 1;
	return last
		? " ".repeat(indent)
		: `${theme.tree.vertical}${" ".repeat(Math.max(1, indent - theme.tree.vertical.length))}`;
}
/** Scan a background session's artifact dir for its direct subagent transcripts (read-only, hub-local rows). */
function collectBackgroundLaneSubagents(sessionFile: string, laneId: string): HubAgentRef[] {
	if (!sessionFile.endsWith(".jsonl")) return [];
	const dir = sessionFile.slice(0, -6);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const subs: HubAgentRef[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		if (entry.name === ADVISOR_TRANSCRIPT_FILENAME) continue;
		const subId = entry.name.slice(0, -6);
		const subFile = path.join(dir, entry.name);
		let lastActivity = Date.now();
		try {
			lastActivity = fs.statSync(subFile).mtimeMs;
		} catch {}
		subs.push({
			id: `${laneId}/${subId}`,
			displayName: subId,
			kind: "background",
			parentId: laneId,
			status: "parked",
			session: null,
			sessionFile: subFile,
			createdAt: lastActivity,
			lastActivity,
			activity: "background subagent",
		});
	}
	return subs;
}

/** Glyph + status word, colored per theme status conventions. */
function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} working`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		case "aborted":
			return theme.fg("error", `${theme.status.aborted} failed`);
	}
}

function registerPersistedSubagents(registry: AgentRegistry, sessionFile: string | null | undefined): void {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const root = sessionFile.slice(0, -6);
	registerPersistedSubagentsFromDir(registry, root, undefined);
}

function registerPersistedSubagentsFromDir(registry: AgentRegistry, dir: string, parentId: string | undefined): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (entry.name === ADVISOR_TRANSCRIPT_FILENAME) {
			const owner = parentId ?? MAIN_AGENT_ID;
			const advisorId = `${owner}/advisor`;
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				registry.register({
					id: advisorId,
					displayName: "advisor",
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (!registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		registerPersistedSubagentsFromDir(registry, path.join(dir, id), id);
	}
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = unavailable. */
	readTranscript(id: string, fromByte: number): Promise<{ text: string; newSize: number } | null>;
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Session directory for persisted background-agent discovery. */
	sessionDir?: string;
	/** Resume a persisted background-agent session selected from the hub. */
	resumeSession?: (sessionPath: string) => Promise<void>;
	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
	/** Kanban board synchronizer. Pass null to disable Kanban sync mode in tests/collab guests. */
	kanbanSync?: AgentHubKanbanSync | null;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#remote: AgentHubRemote | undefined;
	#sessionDir: string | undefined;
	#currentSessionFile: string | null;
	#resumeSession: ((sessionPath: string) => Promise<void>) | undefined;
	#backgroundRefs: HubAgentRef[] = [];
	#backgroundSessionPaths = new Map<string, string>();
	#backgroundLoadGeneration = 0;
	/** Resolves when the constructor's initial background-session disk scan has landed. */
	#backgroundsLoaded: Promise<void> = Promise.resolve();
	#expandedLanes = new Set<string>([MAIN_AGENT_ID]);
	#collapsedFolders = new Set<string>();
	#backgroundSubagents = new Map<string, HubAgentRef[]>();

	// Table state
	/** Selectable subagent rows in Main→children tree order (Main itself is the non-selectable root header). */
	#rows: HubRow[] = [];
	#selectedRow = 0;
	#notice: string | undefined;
	/** First-seen order per agent id; freezes sibling order while the hub is open. */
	#rowOrder: Map<string, number> | undefined;
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;
	/** Agent-specific Ctrl+X confirmation state. */
	#pendingRemove: { id: string; at: number } | undefined;
	/** Rename input mode: agent id being renamed. */
	#renameInput: { id: string; buffer: string } | undefined;
	/** Filter input mode: active filter query. */
	#filterInput: string | undefined;
	/** Kanban sync sub-mode: selected rows can be pushed into a pk-kanban board. */
	#kanbanSyncMode = false;
	#kanbanSync: AgentHubKanbanSync | undefined;
	#kanbanSyncStatusByAgent = new Map<string, string>();
	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;
		this.#sessionDir = deps.sessionDir;
		this.#currentSessionFile = deps.sessionFile ?? null;
		this.#resumeSession = deps.resumeSession;
		this.#kanbanSync =
			deps.kanbanSync === null ? undefined : (deps.kanbanSync ?? new AgentHubKanbanSync({ projectPath: this.#cwd }));

		this.#unsubscribers.push(this.#registry.onChange(() => this.#onDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#onDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		if (!this.#remote) {
			registerPersistedSubagents(this.#registry, deps.sessionFile);
			// Never rejects: #loadBackgroundInstances catches internally.
			this.#backgroundsLoaded = this.#loadBackgroundInstances();
		}
		this.#refreshRows();
	}

	/**
	 * Whether the hub has nothing worth opening: only the folder + current-session
	 * scaffold, no subagents and no background sessions. The double-← gesture reads
	 * this to stay inert when there is nothing to open.
	 */
	get isEmpty(): boolean {
		return this.#rows.every(row => isFolder(row.ref) || row.ref.id === MAIN_AGENT_ID);
	}

	/**
	 * Resolves once the initial background-session disk scan has populated the
	 * rows. `isEmpty` is only authoritative after this settles — the double-←
	 * gesture awaits it so background-only sessions still open the hub.
	 */
	backgroundsLoaded(): Promise<void> {
		return this.#backgroundsLoaded;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		return this.#renderTable(width).map(line => clampHubLine(line, width));
	}

	handleInput(keyData: string): void {
		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		this.#handleTableInput(keyData);
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	async #loadBackgroundInstances(): Promise<void> {
		const generation = ++this.#backgroundLoadGeneration;
		try {
			let sessions = await SessionManager.list(this.#cwd, this.#sessionDir);
			sessions = sessions.filter(isBackgroundInstanceSession);
			if (sessions.length === 0) {
				sessions = (await SessionManager.listAll()).filter(isBackgroundInstanceSession);
			}
			if (generation !== this.#backgroundLoadGeneration) return;
			const refs: HubAgentRef[] = [];
			const sessionPaths = new Map<string, string>();
			const subagentsByLane = new Map<string, HubAgentRef[]>();
			const currentFile = this.#currentSessionFile
				? normalizePathForComparison(this.#currentSessionFile)
				: undefined;
			const registrySessionPaths = new Set(
				this.#registry
					.list()
					.flatMap(ref =>
						ref.status !== "aborted" && ref.sessionFile !== null
							? [normalizePathForComparison(ref.sessionFile)]
							: [],
					),
			);
			for (const session of sessions) {
				if (
					(currentFile && normalizePathForComparison(session.path) === currentFile) ||
					registrySessionPaths.has(normalizePathForComparison(session.path))
				)
					continue;
				const id = `background:${session.id}`;
				const name = backgroundInstanceDisplayName(session);
				const createdAt = session.created.getTime();
				const lastActivity = session.modified.getTime();
				const resolvedLastActivity = Number.isFinite(lastActivity) ? lastActivity : Date.now();
				refs.push({
					id,
					displayName: name,
					kind: "background",
					parentId: MAIN_AGENT_ID,
					status: "parked",
					session: null,
					sessionFile: session.path,
					createdAt: Number.isFinite(createdAt) ? createdAt : resolvedLastActivity,
					lastActivity: resolvedLastActivity,
					activity: session.backgroundInstance?.model
						? `background session · ${session.backgroundInstance.model}`
						: "background session",
					cwd: session.cwd,
					sessionStatus: session.status,
					preview: session.lastAssistantText,
				});
				sessionPaths.set(id, session.path);
				subagentsByLane.set(id, collectBackgroundLaneSubagents(session.path, id));
			}
			this.#backgroundRefs = refs;
			this.#backgroundSessionPaths = sessionPaths;
			this.#backgroundSubagents = subagentsByLane;
			this.#refreshRows();
			this.#requestRender();
		} catch (error) {
			logger.warn("Agent hub: failed to load background sessions", { error: String(error) });
		}
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#selectedRef()?.id;
		const rawQuery = this.#filterInput && this.#filterInput.length > 0 ? this.#filterInput.toLowerCase() : undefined;
		const matches = (ref: HubAgentRef): boolean =>
			!rawQuery ||
			ref.id.toLowerCase().includes(rawQuery) ||
			ref.displayName.toLowerCase().includes(rawQuery) ||
			(ref.activity?.toLowerCase().includes(rawQuery) ?? false);

		// Current session's subagents (the live registry tree). Background sessions
		// are handled separately as top-level lanes below — they are NOT registry agents.
		let registryRefs: HubAgentRef[] = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);
		if (rawQuery) registryRefs = registryRefs.filter(matches);

		// Freeze each agent's first-seen order so siblings keep a stable position
		// while the hub is open (agents heartbeat / bump lastActivity constantly).
		// Seed by status, then recency; new agents append at the end thereafter.
		if (!this.#rowOrder) {
			const seeded = [...registryRefs].sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(seeded.map((ref, i) => [ref.id, i]));
		} else {
			for (const ref of registryRefs) {
				if (!this.#rowOrder.has(ref.id)) this.#rowOrder.set(ref.id, this.#rowOrder.size);
			}
		}

		const rows: HubRow[] = [];

		// The current session lane is always present, even with no subagents.
		let mainRef = this.#registry.get(MAIN_AGENT_ID) as HubAgentRef | undefined;
		if (!mainRef) {
			mainRef = {
				id: MAIN_AGENT_ID,
				displayName: "current session",
				kind: "main",
				status: "running",
				session: null,
				sessionFile: null,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			};
		}

		// Every session lane (current + background instances), tagged with its folder.
		const currentFolderKey = folderKey(this.#cwd);
		interface LaneEntry {
			lane: HubAgentRef;
			folderKey: string;
			folderCwd: string;
			isCurrent: boolean;
		}
		const laneEntries: LaneEntry[] = [];
		const mainVisible = !rawQuery || matches(mainRef) || registryRefs.length > 0;
		if (mainVisible) {
			laneEntries.push({ lane: mainRef, folderKey: currentFolderKey, folderCwd: this.#cwd, isCurrent: true });
		}
		for (const lane of this.#backgroundRefs) {
			laneEntries.push({ lane, folderKey: folderKey(lane.cwd), folderCwd: lane.cwd ?? "", isCurrent: false });
		}

		// Group lanes by folder. Current folder first, then by most-recent activity.
		interface FolderGroup {
			key: string;
			cwd: string;
			lanes: LaneEntry[];
			maxActivity: number;
		}
		const folderByKey = new Map<string, FolderGroup>();
		for (const entry of laneEntries) {
			let group = folderByKey.get(entry.folderKey);
			if (!group) {
				group = { key: entry.folderKey, cwd: entry.folderCwd, lanes: [], maxActivity: 0 };
				folderByKey.set(entry.folderKey, group);
			}
			// The current session owns its folder's display cwd even if a background lane created the bucket first.
			if (entry.isCurrent && entry.folderCwd) group.cwd = entry.folderCwd;
			group.lanes.push(entry);
			group.maxActivity = Math.max(group.maxActivity, entry.lane.lastActivity);
		}
		const folderGroups = [...folderByKey.values()].sort((a, b) => {
			const aCurrent = a.key === currentFolderKey;
			const bCurrent = b.key === currentFolderKey;
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			return b.maxActivity - a.maxActivity;
		});

		// Folder → session lane → subagents. Folders default-expanded; background
		// session lanes default-collapsed (Space reveals their subagents).
		for (const group of folderGroups) {
			const groupLanes = [...group.lanes].sort((a, b) => {
				if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
				return b.lane.lastActivity - a.lane.lastActivity;
			});
			const visibleLanes = groupLanes.filter(entry => {
				if (!rawQuery) return true;
				if (entry.isCurrent) return matches(entry.lane) || registryRefs.length > 0;
				const laneSubs = this.#backgroundSubagents.get(entry.lane.id) ?? [];
				const hasMatchingSub = this.#expandedLanes.has(entry.lane.id) && laneSubs.some(matches);
				return matches(entry.lane) || hasMatchingSub;
			});
			if (rawQuery && visibleLanes.length === 0) continue;

			const folderId = `folder:${group.key}`;
			const folderRef: HubAgentRef = {
				id: folderId,
				displayName: folderDisplayName(group.cwd),
				kind: "folder",
				status: "running",
				session: null,
				sessionFile: null,
				createdAt: 0,
				lastActivity: group.maxActivity || Date.now(),
				cwd: group.cwd,
				laneCount: visibleLanes.length,
				isCurrentFolder: group.key === currentFolderKey,
			};
			rows.push({ ref: folderRef, depth: 0, prefix: "" });
			if (this.#collapsedFolders.has(folderId)) continue;

			visibleLanes.forEach((entry, laneIdx) => {
				const lane = entry.lane;
				const lastLane = laneIdx === visibleLanes.length - 1;
				rows.push({ ref: lane, depth: 1, prefix: `${lastLane ? theme.tree.last : theme.tree.branch} ` });
				if (!this.#expandedLanes.has(lane.id)) return;
				const basePrefix = treeContinuation(lastLane);
				if (entry.isCurrent) {
					rows.push(...this.#buildTree(registryRefs, basePrefix, 2));
				} else {
					const laneSubs = this.#backgroundSubagents.get(lane.id) ?? [];
					const visibleSubs = rawQuery ? laneSubs.filter(matches) : laneSubs;
					visibleSubs.forEach((sub, i) => {
						const last = i === visibleSubs.length - 1;
						rows.push({
							ref: sub,
							depth: 2,
							prefix: `${basePrefix}${last ? theme.tree.last : theme.tree.branch} `,
						});
					});
				}
			});
		}

		this.#rows = rows;
		const keptIndex = selectedId ? this.#rows.findIndex(row => row.ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	/**
	 * Flatten a session's subagent forest into tree order, rooted at Main. Every
	 * ref is parented to its `parentId` when that agent is present, else hoisted
	 * directly under the root; siblings keep the frozen {@link #rowOrder}. Each row
	 * carries a connector prefix (`├─`/`└─` for the branch, `│`/spaces for ancestor
	 * columns). `basePrefix`/`baseDepth` nest the whole forest under an outer
	 * session lane (folder → session → subagents).
	 */
	#buildTree(refs: HubAgentRef[], basePrefix = "", baseDepth = 1): HubRow[] {
		const known = new Set(refs.map(ref => ref.id));
		const childrenOf = new Map<string, HubAgentRef[]>();
		for (const ref of refs) {
			const parent =
				ref.parentId && ref.parentId !== ref.id && known.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
			const bucket = childrenOf.get(parent);
			if (bucket) bucket.push(ref);
			else childrenOf.set(parent, [ref]);
		}

		const order = this.#rowOrder;
		const bySibling = (a: HubAgentRef, b: HubAgentRef): number =>
			(order?.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order?.get(b.id) ?? Number.MAX_SAFE_INTEGER);

		const rows: HubRow[] = [];
		const visited = new Set<string>();
		const walk = (parentId: string, depth: number, ancestorPrefix: string): void => {
			const kids = childrenOf.get(parentId);
			if (!kids) return;
			kids.sort(bySibling);
			kids.forEach((ref, i) => {
				if (visited.has(ref.id)) return; // defensive: never loop on a malformed parent cycle
				visited.add(ref.id);
				const last = i === kids.length - 1;
				rows.push({ ref, depth, prefix: `${ancestorPrefix}${last ? theme.tree.last : theme.tree.branch} ` });
				walk(ref.id, depth + 1, `${ancestorPrefix}${treeContinuation(last)}`);
			});
		};
		walk(MAIN_AGENT_ID, baseDepth, basePrefix);

		// Safety net: a ref whose parent chain never reaches Main (detached/cyclic)
		// would otherwise vanish — surface it as a top-level row so it stays selectable.
		const orphans = refs.filter(ref => !visited.has(ref.id)).sort(bySibling);
		orphans.forEach((ref, i) => {
			if (visited.has(ref.id)) return;
			visited.add(ref.id);
			const last = i === orphans.length - 1;
			rows.push({ ref, depth: baseDepth, prefix: `${basePrefix}${last ? theme.tree.last : theme.tree.branch} ` });
			walk(ref.id, baseDepth + 1, `${basePrefix}${treeContinuation(last)}`);
		});
		return rows;
	}

	#selectedRef(): HubAgentRef | undefined {
		return this.#rows[this.#selectedRow]?.ref;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(s => s.id === id);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		const counts = this.#statusSummary();
		lines.push(
			` ${theme.fg("accent", this.#kanbanSyncMode ? "Agent Hub · Kanban sync" : "Agent Hub")}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`,
		);
		lines.push(...new DynamicBorder().render(width));

		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", "no agents yet — /tan and /background sessions appear here")}`);
		} else {
			// mainRef is now a regular row in rows; termHeight calculations stay the same.
			const termHeight = process.stdout.rows || 40;
			// Chrome: 2 borders + title + Main root + notice? + blank + hints + border
			const maxVisible = Math.max(3, termHeight - 8 - (this.#notice ? 1 : 0));
			let start = 0;
			if (this.#rows.length > maxVisible) {
				start = Math.min(
					Math.max(0, this.#selectedRow - Math.floor(maxVisible / 2)),
					this.#rows.length - maxVisible,
				);
			}
			const end = Math.min(start + maxVisible, this.#rows.length);
			for (let i = start; i < end; i++) {
				lines.push(this.#renderRow(this.#rows[i], i === this.#selectedRow, width));
			}
			if (end < this.#rows.length) {
				lines.push(` ${theme.fg("dim", `… ${this.#rows.length - end} more`)}`);
			}
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		if (this.#renameInput) {
			const ref = this.#registry.get(this.#renameInput.id);
			if (ref) {
				lines.push(
					` ${theme.fg("dim", "Rename:")} ${this.#renameInput.buffer}${theme.fg("accent", theme.nav.cursor)}`,
				);
			}
		}
		lines.push("");
		if (this.#renameInput) {
			lines.push(` ${theme.fg("dim", "Enter:save  Esc:cancel")}`);
		} else if (this.#filterInput !== undefined) {
			lines.push(` ${theme.fg("dim", `Filter: ${this.#filterInput}  Enter:apply  Esc:clear`)}`);
		} else if (this.#kanbanSyncMode) {
			lines.push(` ${theme.fg("dim", "j/k:select  Enter:sync  a:sync all  Esc:table  q:close")}`);
		} else {
			const selected = this.#selectedRef();
			const hints = selected ? this.#getAdaptiveHints(selected) : "j/k:select  K:kanban  q:close";
			lines.push(` ${theme.fg("dim", hints)}`);
		}
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	// renderMainHeader deleted; Main renders as a selectable depth-0 row.

	#statusSummary(): string {
		// Claude Code jobs-list style: outcome counts across session lanes first,
		// then the subagent tally.
		const outcomes = new Map<string, number>();
		let laneCount = 0;
		for (const row of this.#rows) {
			if (!isLane(row.ref)) continue;
			laneCount++;
			const outcome = laneOutcome(row.ref);
			if (outcome) outcomes.set(outcome.label, (outcomes.get(outcome.label) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [label, key] of [
			["Needs input", "awaiting input"],
			["Working", "working"],
			["Done", "completed"],
			["Failed", "failed"],
		] as const) {
			const count = outcomes.get(label);
			if (count) parts.push(`${count} ${key}`);
		}
		if (parts.length === 0 && laneCount > 0) {
			parts.push(`${laneCount} ${laneCount === 1 ? "session" : "sessions"}`);
		}
		const subagentRows = this.#rows.filter(row => !isLane(row.ref) && !isFolder(row.ref));
		if (subagentRows.length > 0) {
			parts.push(`${subagentRows.length} ${subagentRows.length === 1 ? "agent" : "agents"}`);
		}
		return parts.join(theme.sep.dot);
	}

	#getAdaptiveHints(ref: HubAgentRef): string {
		const base = "j/k:select  ";
		if (isFolder(ref)) {
			const verb = this.#collapsedFolders.has(ref.id) ? "expand" : "collapse";
			return `${base}Space:${verb}  /:filter  q:close`;
		}
		if (ref.id === MAIN_AGENT_ID) {
			const verb = this.#expandedLanes.has(ref.id) ? "collapse" : "expand";
			return `${base}Space:${verb}  Enter:focus  /:filter  q:close`;
		}
		if (ref.kind === "background") {
			if (isBackgroundLane(ref)) {
				const verb = this.#expandedLanes.has(ref.id) ? "collapse" : "expand";
				return `${base}Space:${verb}  Enter:resume  /:filter  q:close`;
			}
			return `${base}Enter:open session  /:filter  q:close`;
		}
		switch (ref.status) {
			case "running":
				return `${base}Enter:focus  c:chat  r:rename  x×2:kill  K:kanban  q:close`;
			case "parked":
				return `${base}Enter:open  c:chat  r:rename  R:revive  x×2:remove  K:kanban  q:close`;
			case "idle":
				return `${base}Enter:focus  c:chat  r:rename  R:revive  x×2:remove  K:kanban  q:close`;
			case "aborted":
				return `${base}c:chat  r:rename  x×2:remove  K:kanban  q:close`;
			default:
				return `${base}Enter:focus  c:chat  r:rename  R:revive  x×2:remove  K:kanban  q:close`;
		}
	}

	#renderRow(row: HubRow, selected: boolean, width: number): string {
		const { ref } = row;
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const color = rosterColor(ref.color);
		const lane = isLane(ref);
		const folder = isFolder(ref);
		const expanded = folder ? !this.#collapsedFolders.has(ref.id) : this.#expandedLanes.has(ref.id);
		const caret = lane || folder ? `${expanded ? "▾" : "▸"} ` : "";
		const label =
			ref.id === MAIN_AGENT_ID
				? `${caret}current session`
				: folder
					? `${caret}${ref.cwd ? shortenPath(ref.cwd) : ref.displayName}`
					: ref.kind === "background"
						? `${caret}${ref.displayName}`
						: ref.id;
		const idText = color ? theme.bold(theme.fg(color, replaceTabs(label))) : theme.bold(replaceTabs(label));
		const parts: string[] = lane || folder ? [idText] : [statusBadge(ref.status), idText];
		if (folder) {
			const count = ref.laneCount ?? 0;
			const bits: string[] = [];
			if (ref.isCurrentFolder) bits.push("current");
			bits.push(`${count} ${count === 1 ? "session" : "sessions"}`);
			parts.push(theme.fg("muted", bits.join(theme.sep.dot)));
		} else if (ref.id === MAIN_AGENT_ID) {
			const outcome = laneOutcome(ref);
			if (outcome) parts.push(theme.fg(outcome.color, outcome.label));
			const subCount = this.#registry.list().filter(r => r.id !== MAIN_AGENT_ID).length;
			if (subCount > 0) {
				parts.push(theme.fg("muted", `${subCount} ${subCount === 1 ? "agent" : "agents"}`));
			}
		} else if (ref.kind === "background") {
			if (lane) {
				const outcome = laneOutcome(ref);
				if (outcome) parts.push(theme.fg(outcome.color, outcome.label));
				const preview = lanePreview(ref);
				if (preview) parts.push(theme.fg("muted", sanitizeLine(preview, TRUNCATE_LENGTHS.TITLE)));
				const subCount = this.#backgroundSubagents.get(ref.id)?.length ?? 0;
				if (subCount > 0) {
					parts.push(theme.fg("dim", `${subCount} ${subCount === 1 ? "agent" : "agents"}`));
				}
			} else {
				parts.push(theme.fg("muted", "background subagent"));
			}
		} else {
			parts.push(theme.fg("dim", replaceTabs(ref.displayName)));
			// Parentage is conveyed by the tree connectors, so the kind stands alone.
			parts.push(theme.fg("dim", ref.kind));
		}
		// Surface the cwd only when it diverges from the parent's (CWD-aware spawns).
		const parentCwd = this.#registry.get(ref.parentId ?? MAIN_AGENT_ID)?.cwd;
		if (!folder && ref.cwd && ref.cwd !== parentCwd) {
			parts.push(theme.fg("dim", `cwd ${replaceTabs(shortenPath(ref.cwd))}`));
		}
		const observed = this.#observableFor(ref.id);
		const task = observed?.description ?? observed?.progress?.task;
		if (task) {
			parts.push(theme.fg("muted", sanitizeLine(task, TRUNCATE_LENGTHS.TITLE)));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			parts.push(theme.fg("warning", `⧉ ${unread}`));
		}
		if (isRegistryAgentRef(ref) && ref.needsAttention) {
			const reason = ref.attentionReason
				? truncateToWidth(ref.attentionReason, TRUNCATE_LENGTHS.TITLE)
				: "needs response";
			parts.push(theme.fg("warning", `⚠ ${reason}`));
		}
		if (this.#kanbanSyncMode) {
			const syncStatus = this.#kanbanSyncStatusByAgent.get(ref.id) ?? "not synced";
			const colorName: ThemeColor = syncStatus.startsWith("✓")
				? "success"
				: syncStatus.startsWith("!")
					? "error"
					: "muted";
			parts.push(theme.fg(colorName, syncStatus));
		}

		const rawLine = ` ${cursor} ${theme.fg("dim", row.prefix)}${parts.join(theme.sep.dot)}`;
		const sanitized = rawLine.replace(/[\r\n]+/g, " ");
		// clampHubLine (render()) trims every hub line to width-2; build to that
		// budget so the right-aligned age column survives the final clamp.
		const maxWidth = Math.max(1, width - 2);
		// Age renders as a right-aligned column (Claude Code jobs-list style); the
		// folder header rows skip it — their lanes carry the meaningful timestamps.
		const age = folder ? "" : formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)));
		const leftWidth = Math.max(1, maxWidth - (age ? visibleWidth(age) + 2 : 0));
		const left = truncateToWidth(sanitized, leftWidth);
		const padding = Math.max(age ? 2 : 0, maxWidth - visibleWidth(left) - visibleWidth(age));
		const line = age ? `${left}${" ".repeat(padding)}${theme.fg("dim", age)}` : left;
		// Selected row: wash the whole padded line with the selection background so
		// the highlight is visible while navigating, not just the tiny cursor glyph.
		if (selected) {
			return theme.bg("selectedBg", truncateToWidth(line, maxWidth, Ellipsis.Omit, true));
		}
		return truncateToWidth(line, maxWidth);
	}

	#handleKanbanSyncInput(keyData: string): void {
		if (keyData === "q") {
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "escape")) {
			this.#kanbanSyncMode = false;
			this.#notice = undefined;
			this.#requestRender();
			return;
		}
		if (keyData === "j" || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			this.#requestRender();
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#syncSelectedAgentToKanban();
			return;
		}
		if (keyData === "a") {
			this.#syncAllAgentsToKanban();
			return;
		}
	}

	#clearPendingRemove(): void {
		this.#pendingRemove = undefined;
	}

	#toggleLane(id: string): void {
		this.#clearPendingRemove();
		this.#notice = undefined;
		if (this.#expandedLanes.has(id)) this.#expandedLanes.delete(id);
		else this.#expandedLanes.add(id);
		this.#refreshRows();
		this.#requestRender();
	}

	#toggleFolder(id: string): void {
		this.#clearPendingRemove();
		this.#notice = undefined;
		if (this.#collapsedFolders.has(id)) this.#collapsedFolders.delete(id);
		else this.#collapsedFolders.add(id);
		this.#refreshRows();
		this.#requestRender();
	}

	#handleTableInput(keyData: string): void {
		// Filter mode takes priority when active
		if (this.#filterInput !== undefined) {
			this.#handleFilterInput(keyData);
			return;
		}
		// Rename mode takes priority when active
		if (this.#renameInput) {
			this.#handleRenameInput(keyData);
			return;
		}
		if (this.#kanbanSyncMode) {
			this.#handleKanbanSyncInput(keyData);
			return;
		}
		// q or Esc closes the hub
		if (keyData === "q") {
			this.#clearPendingRemove();
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "escape")) {
			this.#clearPendingRemove();
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#clearPendingRemove();
			this.#notice = undefined;
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		// x or ctrl+x triggers remove (double-tap confirmation)
		if (keyData === "x" || matchesKey(keyData, "ctrl+x")) {
			this.#handleRemoveTap();
			return;
		}
		if (keyData === "j" || matchesSelectDown(keyData)) {
			this.#clearPendingRemove();
			this.#notice = undefined;
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			this.#clearPendingRemove();
			this.#notice = undefined;
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const selected = this.#selectedRef();
			if (selected) this.#activateAgent(selected);
			return;
		}
		// Space expands/collapses the selected folder or session lane.
		if (keyData === " ") {
			const selected = this.#selectedRef();
			if (selected && isFolder(selected)) this.#toggleFolder(selected.id);
			else if (selected && isLane(selected)) this.#toggleLane(selected.id);
			return;
		}
		if (keyData === "c") {
			const selected = this.#selectedRef();
			if (selected?.id === MAIN_AGENT_ID) {
				this.#onDone();
			} else if (selected?.kind === "background") {
				this.#notice = `Press Enter to resume background session for "${selected.displayName}".`;
				this.#requestRender();
			} else if (selected) {
				this.openChat(selected.id);
			}
			return;
		}
		// R (shift-r) revives parked agents
		if (keyData === "R") {
			this.#reviveSelected();
			return;
		}
		// r (lowercase) starts rename mode for the selected agent
		if (keyData === "r") {
			this.#startRename();
			return;
		}
		// / starts filter mode
		if (keyData === "/") {
			this.#filterInput = "";
			this.#requestRender();
			return;
		}
		if (keyData === "K") {
			if (!this.#kanbanSync) {
				this.#notice = "Kanban sync is unavailable in this session.";
			} else {
				this.#kanbanSyncMode = true;
				this.#notice = "Kanban sync mode: Enter syncs selected, a syncs all.";
			}
			this.#requestRender();
			return;
		}
		// Clear any pending remove confirmation on other keys
		this.#clearPendingRemove();
		this.#notice = undefined;
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: HubAgentRef): void {
		this.#clearPendingRemove();
		this.#notice = undefined;
		if (isFolder(ref)) {
			this.#toggleFolder(ref.id);
			return;
		}
		if (ref.id === MAIN_AGENT_ID) {
			this.#onDone();
			return;
		}
		if (ref.kind === "background") {
			const sessionPath =
				this.#backgroundSessionPaths.get(ref.id) ??
				(ref.parentId ? this.#backgroundSessionPaths.get(ref.parentId) : undefined) ??
				ref.sessionFile;
			const resumeSession = this.#resumeSession;
			if (!sessionPath || !resumeSession) {
				this.#notice = `Background session "${ref.displayName}" cannot be resumed here.`;
				this.#requestRender();
				return;
			}
			void (async () => {
				try {
					await resumeSession(sessionPath);
					this.#onDone();
				} catch (error) {
					this.#notice = error instanceof Error ? error.message : String(error);
					this.#requestRender();
				}
			})();
			return;
		}
		const focusAgent = this.#focusAgent;
		// Advisor refs are read-only transcripts with no live/revivable session;
		// open the in-hub chat view (file-backed) instead of trying to focus one.
		if (ref.kind === "advisor" || this.#remote || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		// If the agent is parked, revive it first, then focus
		if (ref.status === "parked") {
			this.#reviveSelected();
		}
		void (async () => {
			try {
				await focusAgent(ref.id);
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#reviveSelected(): void {
		this.#clearPendingRemove();
		const ref = this.#selectedRef();
		if (!ref) return;
		if (isFolder(ref)) {
			this.#notice = "Folders group sessions — select a session or agent to revive.";
			this.#requestRender();
			return;
		}
		if (ref.id === MAIN_AGENT_ID) {
			this.#notice = "The current session is already active.";
			this.#requestRender();
			return;
		}
		if (ref.kind === "background") {
		}
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

	#startRename(): void {
		const ref = this.#selectedRef();
		if (!ref) return;
		if (isFolder(ref)) {
			this.#notice = "Folders group sessions and cannot be renamed.";
			this.#requestRender();
			return;
		}
		if (ref.id === MAIN_AGENT_ID) {
			this.#notice = "The current session can be renamed with /background <name>.";
			this.#requestRender();
			return;
		}
		if (ref.kind === "background" && !isBackgroundLane(ref)) {
			this.#notice = `"${ref.id}" is a read-only background subagent — cannot be renamed.`;
			this.#requestRender();
			return;
		}
		this.#renameInput = { id: ref.id, buffer: ref.displayName };
		this.#notice = undefined;
		this.#requestRender();
	}

	#handleRenameInput(keyData: string): void {
		if (!this.#renameInput) return;

		if (matchesKey(keyData, "escape")) {
			this.#renameInput = undefined;
			this.#requestRender();
			return;
		}

		if (matchesKey(keyData, "enter")) {
			const newName = this.#renameInput.buffer.trim();
			if (!newName) {
				this.#notice = "Rename cannot be empty.";
				this.#requestRender();
				return;
			}
			this.#commitRename(this.#renameInput.id, newName);
			return;
		}

		if (matchesKey(keyData, "backspace")) {
			if (this.#renameInput.buffer.length > 0) {
				this.#renameInput.buffer = this.#renameInput.buffer.slice(0, -1);
			}
			this.#requestRender();
			return;
		}

		// Regular character input
		if (keyData.length === 1 && keyData.charCodeAt(0) >= 32) {
			this.#renameInput.buffer += keyData;
			this.#requestRender();
		}
	}

	#commitRename(id: string, newName: string): void {
		const ref = this.#rows.find(row => row.ref.id === id)?.ref;
		if (!ref) {
			this.#renameInput = undefined;
			this.#requestRender();
			return;
		}
		if (ref.kind === "background") {
			this.#renameBackgroundSession(ref, newName);
			return;
		}
		this.#registry.setDisplayName(id, newName);
		this.#renameInput = undefined;
		this.#notice = undefined;
		this.#requestRender();
	}

	#renameBackgroundSession(ref: HubAgentRef, newName: string): void {
		if (!isBackgroundLane(ref)) {
			this.#notice = `"${ref.id}" is a read-only background subagent — cannot be renamed.`;
			this.#requestRender();
			return;
		}
		const sessionPath = this.#backgroundSessionPaths.get(ref.id) ?? ref.sessionFile;
		if (!sessionPath) {
			this.#notice = `Could not resolve path for background session "${ref.displayName}".`;
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				const sm = await SessionManager.open(sessionPath, this.#sessionDir ?? "");
				try {
					const current = sm.getBackgroundInstance();
					if (!current) {
						this.#notice = `Background session "${ref.displayName}" is no longer active.`;
					} else {
						sm.appendBackgroundInstance({ ...current, name: newName });
						await sm.flush();
						this.#backgroundRefs = this.#backgroundRefs.map(backgroundRef =>
							backgroundRef.id === ref.id
								? { ...backgroundRef, displayName: newName, lastActivity: Date.now() }
								: backgroundRef,
						);
						this.#notice = undefined;
					}
				} finally {
					// Release the transient writer (and its session guard) so later
					// maintenance ops on this session don't contend with a leaked handle.
					await sm.close();
				}
			} catch (error) {
				this.#notice = `Failed to rename session: ${error instanceof Error ? error.message : String(error)}`;
			}
			this.#renameInput = undefined;
			this.#refreshRows();
			this.#requestRender();
		})();
	}

	#handleFilterInput(keyData: string): void {
		if (this.#filterInput === undefined) return;

		if (matchesKey(keyData, "escape")) {
			this.#filterInput = undefined;
			this.#refreshRows();
			this.#requestRender();
			return;
		}

		if (matchesKey(keyData, "enter")) {
			this.#filterInput = undefined;
			this.#refreshRows();
			// Activate the selected agent (respecting adaptive hints)
			const selected = this.#selectedRef();
			if (selected) this.#activateAgent(selected);
			return;
		}

		if (matchesKey(keyData, "backspace")) {
			if (this.#filterInput.length > 0) {
				this.#filterInput = this.#filterInput.slice(0, -1);
				this.#refreshRows();
				this.#requestRender();
			}
			return;
		}

		// Regular character input
		if (keyData.length === 1 && keyData.charCodeAt(0) >= 32) {
			this.#filterInput += keyData;
			this.#refreshRows();
			this.#requestRender();
		}
	}

	#syncSelectedAgentToKanban(): void {
		const ref = this.#selectedRef();
		if (!ref) return;
		if (ref.id === MAIN_AGENT_ID) {
			this.#notice = "The current session cannot be synced to Kanban.";
			this.#requestRender();
			return;
		}
		if (isFolder(ref)) {
			this.#notice = "Folders group sessions — select an agent to sync to Kanban.";
			this.#requestRender();
			return;
		}
		if (!isRegistryAgentRef(ref)) {
			this.#notice = `Background sessions are resumed from the hub, not synced to Kanban.`;
			this.#requestRender();
			return;
		}
		if (!this.#kanbanSync) {
			this.#notice = "Kanban sync is unavailable in this session.";
			this.#requestRender();
			return;
		}
		this.#kanbanSyncStatusByAgent.set(ref.id, "syncing…");
		this.#requestRender();
		void this.#kanbanSync
			.syncAgent(ref)
			.then(result => this.#recordKanbanSyncResult(result))
			.catch((error: unknown) => {
				this.#kanbanSyncStatusByAgent.set(ref.id, `! ${error instanceof Error ? error.message : String(error)}`);
				this.#requestRender();
			});
	}

	#syncAllAgentsToKanban(): void {
		if (!this.#kanbanSync) {
			this.#notice = "Kanban sync is unavailable in this session.";
			this.#requestRender();
			return;
		}
		const agents = this.#rows.map(row => row.ref).filter(isRegistryAgentRef);
		if (agents.length === 0) {
			this.#notice = "No live or parked subagents to sync.";
			this.#requestRender();
			return;
		}
		for (const agent of agents) {
			this.#kanbanSyncStatusByAgent.set(agent.id, "syncing…");
		}
		this.#requestRender();
		void this.#kanbanSync
			.syncAgents(agents)
			.then(results => {
				for (const result of results) this.#recordKanbanSyncResult(result);
			})
			.catch((error: unknown) => {
				const message = `! ${error instanceof Error ? error.message : String(error)}`;
				for (const agent of agents) this.#kanbanSyncStatusByAgent.set(agent.id, message);
				this.#requestRender();
			});
	}

	#recordKanbanSyncResult(result: AgentHubKanbanSyncResult): void {
		const action = result.created ? "created" : result.updated ? "updated" : "synced";
		this.#kanbanSyncStatusByAgent.set(result.agentId, `✓ ${action}${result.taskId ? ` ${result.taskId}` : ""}`);
		this.#requestRender();
	}

	#handleRemoveTap(): void {
		const ref = this.#selectedRef();
		if (!ref) {
			this.#clearPendingRemove();
			return;
		}
		if (isFolder(ref)) {
			this.#clearPendingRemove();
			this.#notice = "Folders group sessions and cannot be removed.";
			this.#requestRender();
			return;
		}

		const now = Date.now();
		const pending = this.#pendingRemove;
		if (pending?.id === ref.id && now - pending.at < REMOVE_TAP_WINDOW_MS) {
			this.#clearPendingRemove();
			this.#notice = undefined;
			this.#removeAgent(ref);
		} else {
			this.#pendingRemove = { id: ref.id, at: now };
			if (ref.id === MAIN_AGENT_ID) {
				this.#notice = "The current session cannot be removed.";
				this.#clearPendingRemove();
			} else if (ref.kind === "background" && !isBackgroundLane(ref)) {
				this.#notice = `"${ref.id}" is a read-only background subagent — cannot be removed.`;
				this.#clearPendingRemove();
			} else if (ref.kind === "advisor") {
				this.#notice = `"${ref.id}" is a read-only advisor transcript — cannot be removed.`;
				this.#clearPendingRemove();
			} else {
				const label = ref.kind === "background" ? "background session" : "agent";
				this.#notice = `Press x again (or Ctrl+X) to remove ${label} "${ref.displayName ?? ref.id}"`;
			}
		}
		this.#requestRender();
	}

	#removeAgent(ref: HubAgentRef): void {
		if (ref.id === MAIN_AGENT_ID) {
			this.#notice = "The current session cannot be removed.";
			this.#requestRender();
			return;
		}
		if (ref.kind === "background") {
			if (!isBackgroundLane(ref)) {
				this.#notice = `"${ref.id}" is a read-only background subagent — cannot be removed.`;
				this.#requestRender();
				return;
			}
			const sessionPath = this.#backgroundSessionPaths.get(ref.id) ?? ref.sessionFile;
			if (!sessionPath) {
				this.#notice = `Could not resolve path for background session "${ref.displayName}".`;
				this.#requestRender();
				return;
			}
			void (async () => {
				try {
					const sm = await SessionManager.open(sessionPath, this.#sessionDir ?? "");
					try {
						sm.archiveBackgroundInstance();
						await sm.flush();
					} finally {
						// Release the transient writer (and its session guard) so later
						// maintenance ops on this session don't contend with a leaked handle.
						await sm.close();
					}
					this.#backgroundRefs = this.#backgroundRefs.filter(r => r.id !== ref.id);
					this.#notice = `Removed background session "${ref.displayName}"`;
				} catch (error) {
					this.#notice = `Failed to remove session: ${error instanceof Error ? error.message : String(error)}`;
				}
				this.#refreshRows();
				this.#requestRender();
			})();
			return;
		}

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
				await this.#lifecycle().release(ref.id);
				this.#notice = `Removed agent "${ref.id}"`;
			} catch (error) {
				logger.warn("Agent hub: remove failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
