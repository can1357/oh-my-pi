import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { OpenTab } from "../app";
import {
	buildProjects,
	filterProjects,
	findOpenTab,
	loadSessions,
	mergeOpenChats,
	type ProjectNode,
	type SessionNode,
} from "../projects/discover";
import { exportSession, renameSession } from "../rpc/sessionOps";
import { isTauri } from "../rpc/transport";
import { getSnapshot, subscribe, type TabState } from "../shell/activity";
import { bridgeFor, liveTabs, sessionProcess } from "../shell/bridges";
import { writeClipboard } from "../shell/clipboard";
import { coalesce } from "../shell/coalesce";
import { useContextMenu } from "../shell/contextMenu";
import { projectMenuItems, sessionMenuItems } from "./sessionMenu";

export function Sidebar({
	activeSessionPath,
	activeSessionId,
	tabs,
	activeTabId,
	onOpenSession,
	onActivateTab,
	onNewChatHere,
	onNewSession,
	onCloseTab,
}: {
	activeSessionPath?: string;
	/*
	 * The active tab's session, once it has one. A chat started here is never
	 * given a `sessionPath` — that field boots `useBridge` — so its id is the only
	 * thing that can mark its row as the one you are looking at.
	 */
	activeSessionId?: string;
	/*
	 * The chats open in this window. The sidebar was always described as the tab
	 * list, and could not be one without them: omp writes no session file until
	 * there is conversation, so a chat you just started was on nobody's disk.
	 */
	tabs: readonly OpenTab[];
	activeTabId: string;
	onOpenSession(session: SessionNode): void;
	onActivateTab(tabId: string): void;
	/** "New chat here", from a project's own row. */
	onNewChatHere(cwd: string): void;
	/** The picker, for the empty space that belongs to no project. */
	onNewSession(): void;
	/** Forget a tab whose session no longer exists. */
	onCloseTab(tabId: string): void;
}) {
	const [sessions, setSessions] = useState<SessionNode[]>([]);
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const states = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	/*
	 * Reading once at mount made this a photograph of launch.
	 *
	 * A session does not exist on disk until it has been written, and omp does not
	 * name it until there is something worth naming — so a chat you had just
	 * started was never in this list, and nothing ever put it there. Restarting
	 * the app was the only way to see your own session, and only if you happened
	 * to restart after the title landed.
	 *
	 * Coalesced with a trailing repeat rather than a plain in-flight skip: a
	 * refresh that starts before the session file is written must not be the last
	 * one to run, or the list settles on the state it was called about.
	 */
	/*
	 * Which tabs Rust has a process for. Only the menu's labels read this — the
	 * actions that could do damage re-ask at the moment they act, because a stale
	 * "no process" is what sends a rename down the throwaway path and puts two
	 * agents on one session file.
	 */
	const [live, setLive] = useState<ReadonlySet<string>>(new Set());

	const refresh = useMemo(
		() =>
			coalesce(async () => {
				if (!isTauri()) return;
				try {
					setSessions(await loadSessions());
					setLive(await liveTabs());
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}),
		[],
	);

	useEffect(refresh, [refresh]);

	/*
	 * A turn ending is the moment a session gains its first messages and its
	 * title, so it is the one event that reliably changes this list. Counting the
	 * working tabs is enough to see it: the count falling means one just stopped.
	 */
	const working = [...states.values()].filter(state => state === "working").length;
	const wasWorking = useRef(working);
	useEffect(() => {
		const dropped = working < wasWorking.current;
		wasWorking.current = working;
		if (dropped) refresh();
	}, [working, refresh]);

	// Sessions are also created in a terminal, and omp renames them as they grow.
	// Coming back to the window is the cheapest honest moment to re-read.
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const projects = useMemo(() => {
		const listed = filterProjects(buildProjects(sessions), query);
		const needle = query.trim().toLowerCase();
		// The chats are filtered here rather than inside the merge, so `filterProjects`
		// keeps owning what "matches" means for a session.
		const matching = needle
			? tabs.filter(
					tab => tab.title.toLowerCase().includes(needle) || (tab.cwd ?? "").toLowerCase().includes(needle),
				)
			: tabs;
		return mergeOpenChats(listed, matching);
	}, [sessions, query, tabs]);

	/*
	 * A session's live state is stored under the id of the tab showing it, which
	 * is only the session id when it was opened from this list. A chat started
	 * here keeps its `new:N:/path`, so going through the tab is the only lookup
	 * that works for both.
	 */
	const stateOf = useMemo(() => {
		return (session: SessionNode): TabState => {
			const tab = findOpenTab(tabs, session);
			return states.get(tab?.tabId ?? session.id) ?? "idle";
		};
	}, [states, tabs]);

	/*
	 * One place failures land. Every menu action is fire-and-forget from the
	 * menu's point of view, and a silent `.catch(() => {})` is how this app has
	 * hidden defects before — the banner already exists, so it gets used.
	 */
	const report = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : String(cause));
	}, []);

	const { open: openMenu } = useContextMenu();
	/** Rename and delete both need a question answered before they act. */
	const [prompt, setPrompt] = useState<{ kind: "rename" | "delete"; session: SessionNode } | null>(null);

	const sessionMenu = useCallback(
		(event: ReactMouseEvent, session: SessionNode) => {
			const tab = findOpenTab(tabs, session);
			const bridge = bridgeFor(tab?.tabId);
			const project = session.projectRoot || session.cwd || "";

			// The pool's answer, not the bridge's: a background tab's bridge sits at
			// `idle` while its sidecar is very much alive.
			const hasProcess = tab !== undefined && live.has(tab.tabId);

			openMenu(
				event,
				sessionMenuItems(
					{ live: hasProcess, attached: bridge !== undefined, hasProject: Boolean(project) },
					{
						open: () => onOpenSession(session),
						rename: () => setPrompt({ kind: "rename", session }),
						exportHtml: () => void exportTranscript(session, tab?.tabId).catch(report),
						reveal: () => void revealFolder(project).catch(report),
						copySessionPath: () => void writeClipboard(session.path).catch(report),
						copyProjectPath: () => void writeClipboard(project).catch(report),
						stop: () => void stopSession(tab?.tabId).catch(report),
						remove: () => setPrompt({ kind: "delete", session }),
					},
				),
			);
		},
		[openMenu, onOpenSession, tabs, report, live],
	);

	const projectMenu = useCallback(
		(event: ReactMouseEvent, root: string) => {
			openMenu(
				event,
				projectMenuItems({
					newChat: () => onNewChatHere(root),
					reveal: () => void revealFolder(root).catch(report),
					copyPath: () => void writeClipboard(root).catch(report),
					collapseAll: () => setCollapsed(new Set(projects.map(entry => entry.root))),
				}),
			);
		},
		[openMenu, onNewChatHere, projects, report],
	);

	const chatState = useMemo(
		() =>
			(tabId: string): TabState =>
				states.get(tabId) ?? "idle",
		[states],
	);

	// A search should reveal what it matched, not hide it behind a collapsed row.
	const effectiveCollapsed = query.trim() ? new Set<string>() : collapsed;

	return (
		<aside className="omp-sidebar">
			{/* The header moved to the title bar, so the filter is the column's top. */}
			<div className="omp-sidebar__filter">
				<input
					className="omp-filter"
					type="search"
					placeholder="Filter sessions…"
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
			</div>

			{/*
			 * The empty space below the last project. A row or a header claims the
			 * event first and marks it, so this only fires where nothing else did.
			 */}
			<div
				className="omp-sidebar__scroll"
				onContextMenu={event => {
					if (event.defaultPrevented) return;
					openMenu(event, [
						{ kind: "action", id: "new", label: "New session…", hint: "⌘T", run: onNewSession },
						{ kind: "separator", id: "sep" },
						{
							kind: "action",
							id: "collapse",
							label: "Collapse all projects",
							disabled: projects.length ? undefined : "No projects listed",
							run: () => setCollapsed(new Set(projects.map(entry => entry.root))),
						},
					]);
				}}
			>
				{error ? <div className="omp-banner omp-banner--error">{error}</div> : null}

				{projects.length === 0 ? (
					<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
						{sessions.length === 0 ? "No sessions yet." : "Nothing matches."}
					</div>
				) : null}

				{projects.map(project => (
					<ProjectRow
						key={project.root}
						project={project}
						collapsed={effectiveCollapsed.has(project.root)}
						activeSessionPath={activeSessionPath}
						activeSessionId={activeSessionId}
						activeTabId={activeTabId}
						stateOf={stateOf}
						chatState={chatState}
						onActivateTab={onActivateTab}
						onToggle={() =>
							setCollapsed(current => {
								const next = new Set(current);
								if (!next.delete(project.root)) next.add(project.root);
								return next;
							})
						}
						onOpenSession={onOpenSession}
						onSessionMenu={sessionMenu}
						onProjectMenu={projectMenu}
					/>
				))}
			</div>

			{prompt?.kind === "rename" ? (
				<RenamePrompt
					session={prompt.session}
					onClose={() => setPrompt(null)}
					onDone={() => {
						setPrompt(null);
						refresh();
					}}
					onError={report}
					tabs={tabs}
				/>
			) : null}

			{prompt?.kind === "delete" ? (
				<DeletePrompt
					session={prompt.session}
					onCloseTab={onCloseTab}
					onClose={() => setPrompt(null)}
					onDone={() => {
						setPrompt(null);
						refresh();
					}}
					onError={report}
					tabs={tabs}
				/>
			) : null}
		</aside>
	);
}

/** Rename, through the live process when there is one and a throwaway when not. */
function RenamePrompt({
	session,
	tabs,
	onClose,
	onDone,
	onError,
}: {
	session: SessionNode;
	tabs: readonly OpenTab[];
	onClose(): void;
	onDone(): void;
	onError(cause: unknown): void;
}) {
	const [name, setName] = useState(session.title ?? "");
	const [busy, setBusy] = useState(false);

	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		const tab = findOpenTab(tabs, session);
		// Asked at the moment of acting, and asked of Rust. A bridge exists for any
		// mounted view and sits at `idle` for background tabs, so trusting it here
		// is what would send this rename into a second process on a live jsonl.
		sessionProcess(tab?.tabId)
			.then(process =>
				renameSession(
					{ process, cwd: session.cwd || session.projectRoot || "", sessionPath: session.path },
					trimmed,
				),
			)
			.then(onDone)
			.catch(cause => {
				onError(cause);
				onClose();
			});
	};

	return (
		<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label="Rename session">
			<div className="omp-modal">
				<h2 className="omp-modal__title">Rename session</h2>
				<div className="omp-modal__message">
					<input
						className="omp-input"
						autoFocus
						value={name}
						disabled={busy}
						onChange={event => setName(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault();
								submit();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								onClose();
							}
						}}
					/>
				</div>
				<div className="omp-modal__actions">
					<button type="button" data-component="button" data-variant="ghost" data-size="normal" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						data-component="button"
						data-variant="primary"
						data-size="normal"
						disabled={busy || !name.trim()}
						onClick={submit}
					>
						{busy ? "Renaming…" : "Rename"}
					</button>
				</div>
			</div>
		</div>
	);
}

/** Delete, after stopping the process if this session still has one. */
function DeletePrompt({
	session,
	tabs,
	onClose,
	onDone,
	onError,
	onCloseTab,
}: {
	session: SessionNode;
	tabs: readonly OpenTab[];
	onClose(): void;
	onDone(): void;
	onError(cause: unknown): void;
	onCloseTab(tabId: string): void;
}) {
	const [busy, setBusy] = useState(false);

	const remove = async () => {
		setBusy(true);
		try {
			/*
			 * Order matters, and the failure of the first step matters too: a
			 * process still holding the file would keep appending to a transcript
			 * that no longer exists. This used to swallow it and unlink anyway,
			 * reporting success over an orphan.
			 */
			const tab = findOpenTab(tabs, session);
			const bridge = bridgeFor(tab?.tabId);
			/*
			 * A missing bridge is not proof of a missing process. The registry only
			 * holds bridges for a MOUNTED `SessionRoute`, while the Rust pool keeps
			 * the sidecar alive on purpose when you leave the route — so deleting
			 * from Settings or onboarding found no bridge, skipped the stop, and
			 * unlinked the jsonl out from under a running agent, whose next write
			 * went to an open handle on a file with no name. Ask the pool, which is
			 * the only thing that actually knows.
			 */
			if (bridge) await bridge.stop();
			else if (tab) await invoke("agent_kill", { tabId: tab.tabId });
			await invoke("delete_session", { path: session.path });
			// And forget the tab, or the next refresh lists it again as an unsaved
			// chat — the row you just deleted, back under another name.
			if (tab) onCloseTab(tab.tabId);
			onDone();
		} catch (cause) {
			onError(cause);
			onClose();
		}
	};

	return (
		<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label="Delete session">
			<div className="omp-modal">
				<h2 className="omp-modal__title">Delete this session?</h2>
				<p className="omp-modal__message">
					{session.title || "Untitled session"} — {session.messageCount} messages. The transcript is removed from
					disk and this cannot be undone.
				</p>
				<div className="omp-modal__actions">
					<button type="button" data-component="button" data-variant="ghost" data-size="normal" onClick={onClose}>
						Keep it
					</button>
					<button
						type="button"
						data-component="button"
						data-variant="primary"
						data-size="normal"
						disabled={busy}
						onClick={() => void remove()}
					>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</div>
			</div>
		</div>
	);
}

function ProjectRow({
	project,
	collapsed,
	activeSessionPath,
	activeSessionId,
	activeTabId,
	stateOf,
	chatState,
	onToggle,
	onOpenSession,
	onActivateTab,
	onSessionMenu,
	onProjectMenu,
}: {
	project: ProjectNode;
	collapsed: boolean;
	activeSessionPath?: string;
	activeSessionId?: string;
	activeTabId: string;
	stateOf(session: SessionNode): TabState;
	chatState(tabId: string): TabState;
	onToggle(): void;
	onOpenSession(session: SessionNode): void;
	onActivateTab(tabId: string): void;
	onSessionMenu(event: ReactMouseEvent, session: SessionNode): void;
	onProjectMenu(event: ReactMouseEvent, root: string): void;
}) {
	return (
		<div className="omp-project">
			<button
				className="omp-project__head"
				type="button"
				onClick={onToggle}
				onContextMenu={event => onProjectMenu(event, project.root)}
				title={project.root}
			>
				<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
				<span className="omp-project__name">{project.name}</span>
				<span className="omp-project__count">{project.total}</span>
			</button>

			{collapsed ? null : (
				<>
					{/*
					 * Chats first: they are the ones you started this run, and the
					 * newest thing in the group by definition.
					 */}
					{(project.openChats ?? []).map(chat => (
						<button
							className="omp-session omp-session--unsaved"
							key={chat.tabId}
							type="button"
							aria-current={chat.tabId === activeTabId}
							title={`${chat.title}\nNot saved yet — omp writes a session once there is conversation`}
							onClick={() => onActivateTab(chat.tabId)}
						>
							<span
								className={`omp-dot omp-dot--${chatState(chat.tabId)}`}
								aria-label={STATE_LABEL[chatState(chat.tabId)]}
							/>
							<span className="omp-session__title">{chat.title}</span>
							<span className="omp-session__age">new</span>
						</button>
					))}

					{project.sessions.map(session => (
						<SessionRow
							key={session.path}
							session={session}
							active={
								session.path === activeSessionPath ||
								(activeSessionId !== undefined && session.id === activeSessionId)
							}
							state={stateOf(session)}
							onOpen={onOpenSession}
							onMenu={onSessionMenu}
						/>
					))}

					{project.worktrees.map(worktree => (
						<div key={worktree.root}>
							{/* A sub-heading, not a row you can open — it was styled as a session,
							    which promised a click it never honoured. */}
							<div className="omp-worktree" title={worktree.root}>
								<span aria-hidden="true">↳</span>
								<span className="omp-worktree__name">{worktree.name}</span>
							</div>
							{worktree.sessions.map(session => (
								<SessionRow
									key={session.path}
									session={session}
									active={
										session.path === activeSessionPath ||
										(activeSessionId !== undefined && session.id === activeSessionId)
									}
									worktree
									state={stateOf(session)}
									onOpen={onOpenSession}
									onMenu={onSessionMenu}
								/>
							))}
						</div>
					))}
				</>
			)}
		</div>
	);
}

function SessionRow({
	session,
	active,
	worktree,
	state,
	onOpen,
	onMenu,
}: {
	session: SessionNode;
	active: boolean;
	worktree?: boolean;
	/** Live state of the session, not the status recorded on disk. */
	state: TabState;
	onOpen(session: SessionNode): void;
	onMenu(event: ReactMouseEvent, session: SessionNode): void;
}) {
	const label = session.title || session.firstMessage.slice(0, 60) || session.id.slice(0, 8);
	const age = shortAge(session.modified);
	return (
		<button
			className={`omp-session${worktree ? " omp-session--worktree" : ""}`}
			type="button"
			aria-current={active}
			title={`${label}\n${session.messageCount} messages · ${STATE_LABEL[state]}`}
			onClick={() => onOpen(session)}
			onContextMenu={event => onMenu(event, session)}
		>
			<span className={`omp-dot omp-dot--${state}`} aria-label={STATE_LABEL[state]} />
			<span className="omp-session__title">{label}</span>
			{/*
			 * Titles repeat — three sessions called "hola" is normal — and nothing on
			 * the row told them apart. This is the cheapest thing that does, and it
			 * fills the dead space on the right instead of taking room from the title.
			 */}
			{age ? <span className="omp-session__age">{age}</span> : null}
		</button>
	);
}

/** Coarse on purpose: a disambiguator, not a clock. */
export function shortAge(modified: string): string {
	const then = Date.parse(modified);
	if (!Number.isFinite(then)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.round(days / 7);
	if (weeks < 5) return `${weeks}w`;
	return `${Math.round(days / 30)}mo`;
}

const STATE_LABEL: Record<TabState, string> = {
	working: "working",
	attention: "needs your attention",
	done: "finished",
	idle: "idle",
};

/** Open a directory in Finder. A folder is opened, not revealed inside itself. */
async function revealFolder(directory: string): Promise<void> {
	if (!directory) return;
	await openPath(directory);
}

/**
 * Stop the process, whether or not this window is holding its handle.
 *
 * The entry is enabled from the pool's answer but used to act on the registry's,
 * and the registry is empty on every route but the session one — so from Settings
 * this was `undefined?.stop()`: an entry the menu had just enabled that did
 * nothing at all while the sidecar kept running. `agent_kill` is the pool's own
 * door, the one `DeletePrompt` already goes through, and Rust answers it with
 * `Ok(())` when there is nothing to kill.
 */
async function stopSession(tabId: string | undefined): Promise<void> {
	if (!tabId) return;
	const process = await sessionProcess(tabId);
	// A mounted bridge is preferred for one reason: it also fails everything it
	// had in flight, which a bare kill leaves hanging until each request times out.
	if (process.kind === "mounted") return process.bridge.stop();
	await invoke("agent_kill", { tabId });
}

/**
 * Ask where, export there, then show it.
 *
 * The save dialog runs first so the file lands where you meant; `export_html`
 * takes the path and answers with what it actually wrote, which is what gets
 * opened — never the path we asked for.
 */
async function exportTranscript(session: SessionNode, tabId: string | undefined): Promise<void> {
	const suggested = `${(session.title || "session").replace(/[^\w.-]+/g, "-").slice(0, 60)}.html`;
	const target = await save({
		title: "Export transcript",
		defaultPath: suggested,
		filters: [{ name: "HTML", extensions: ["html"] }],
	});
	if (!target) return;

	// Resolved here, not when the menu was drawn: between the two, whether this
	// session has a process can change, and getting it wrong sends the export to
	// a second process on a live jsonl.
	const written = await exportSession(
		{
			process: await sessionProcess(tabId),
			cwd: session.cwd || session.projectRoot || "",
			sessionPath: session.path,
		},
		target,
	);
	await openPath(written);
}
