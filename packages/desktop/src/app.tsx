import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { ContextMenu } from "./components/ContextMenu";
import { ProjectPicker } from "./components/ProjectPicker";
import { ResizeHandle } from "./components/ResizeHandle";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { adoptSessionIn, findOpenTab, type SessionNode } from "./projects/discover";
import { forgetSession } from "./rpc/boot";
import { anyTabBusy, busyTabs, forgetTab, markViewed } from "./shell/activity";
import type { MenuItem } from "./shell/contextMenu";
import { newChatId } from "./shell/ids";
import { onNotificationActivate } from "./shell/notifications";
import { useCloseGuard } from "./shell/useCloseGuard";
import { useGlobalContextMenu } from "./shell/useGlobalContextMenu";
import { usePanelWidths } from "./shell/usePanelWidths";

export interface OpenTab {
	/*
	 * Stable for the tab's whole life. Rust indexes the sidecar by this and
	 * `useBridge` keys its client on it, so renaming it mid-flight would kill and
	 * respawn the process — which is why a chat that learns its session identity
	 * gains `sessionId` beside this rather than becoming it.
	 */
	tabId: string;
	title: string;
	/** Session file to replay via `switch_session`; absent for a fresh session. */
	sessionPath?: string;
	/**
	 * omp's own id for this session. Known up front for a session opened from the
	 * list; learned from `get_state` for a chat started here, which until then has
	 * no identity anything else can recognise it by.
	 */
	sessionId?: string;
	/** Working directory for the sidecar. Fixed at spawn — see the Rust relay. */
	cwd?: string;
}

export interface ShellContext {
	/**
	 * Every session opened this run. Nothing closes them: the sidebar is the
	 * session list, and Rust reclaims background processes on its own once more
	 * than `MAX_LIVE_SESSIONS` are live.
	 */
	tabs: readonly OpenTab[];
	activeTabId: string;
	panelOpen: boolean;
	/** Reveal the side panel. The plan strip uses it to point at the Plan tab. */
	openPanel(): void;
	/**
	 * A chat started here reporting which session it turned out to be. Idempotent,
	 * and called on every state frame, so it must stay a no-op once settled.
	 *
	 * Identity only — deliberately **not** `sessionPath`. That field is an
	 * instruction ("replay this file"), and `useBridge` boots on it: filling it in
	 * on a live tab re-runs the boot sequence, whose last step is `switch_session`
	 * — which aborts the session. Adopting would have killed the turn that was
	 * running.
	 */
	adoptSession(tabId: string, sessionId: string): void;
}

const SCRATCH: OpenTab = { tabId: "scratch", title: "New session" };

export function App() {
	const navigate = useNavigate();
	/*
	 * Only the session route renders a side panel. The grid reserved its column
	 * regardless, so Settings and onboarding sat next to an empty 420px track with
	 * a resize handle floating over it, dragging a panel that was not there.
	 */
	const { pathname } = useLocation();
	const [tabs, setTabs] = useState<OpenTab[]>([SCRATCH]);
	const [activeTabId, setActiveTabId] = useState(SCRATCH.tabId);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [panelOpen, setPanelOpen] = useState(true);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [closePrompt, setClosePrompt] = useState<((confirmed: boolean) => void) | null>(null);
	const widths = usePanelWidths({ sidebarOpen, panelOpen });

	/*
	 * Only the session route renders a side panel. The grid reserved its column
	 * regardless, so Settings and onboarding sat beside an empty 420px track with
	 * a resize handle floating over it, dragging a panel that was not there.
	 */
	const panelVisible = panelOpen && (pathname === "/" || pathname.startsWith("/session"));

	const activeTab = tabs.find(tab => tab.tabId === activeTabId) ?? tabs[0];

	const activate = useCallback(
		(tabId: string) => {
			setActiveTabId(tabId);
			markViewed(tabId); // clears the unread "finished" mark
			// The sidebar is visible from every route, so activating a tab has to
			// bring the session view back the way `openTab` does. Without this,
			// clicking a chat while Settings was open changed which tab was active
			// and left you looking at Settings.
			void navigate("/");
		},
		[navigate],
	);

	const openTab = useCallback(
		(tab: OpenTab) => {
			// One entry per session id: re-opening a session re-attaches to its live
			// process rather than spawning a second one, and opening a new session
			// never closes the one you were in.
			setTabs(current => (current.some(t => t.tabId === tab.tabId) ? current : [...current, tab]));
			// `activate` navigates; opening and re-activating take the same road.
			activate(tab.tabId);
		},
		[activate],
	);

	/*
	 * Opening a session you already have open brings it to the front.
	 *
	 * `openTab` deduplicates on `tabId`, and its comment claimed this — true only
	 * for a session opened from the list, where `tabId === session.id`. A chat
	 * started here is `new:N:/path`, so clicking its row once it appeared in the
	 * sidebar appended a second tab, spawned a second sidecar (the pool keys on
	 * `tabId`) and pointed it at the jsonl the first one was live on: two agents
	 * appending to the same session file.
	 */
	const openSession = useCallback(
		(session: SessionNode) => {
			const open = findOpenTab(tabs, session);
			if (open) {
				activate(open.tabId);
				void navigate("/");
				return;
			}
			openTab({
				tabId: session.id,
				sessionPath: session.path,
				sessionId: session.id,
				cwd: session.cwd || undefined,
				title: session.title || session.firstMessage.slice(0, 40) || session.id.slice(0, 8),
			});
		},
		[activate, navigate, openTab, tabs],
	);

	/*
	 * Called on every state frame, so it settles rather than churning: a write
	 * that changed nothing would re-render every tab and, worse, hand `tabs` a new
	 * identity on each frame.
	 */
	/*
	 * Forget a tab entirely. The only caller is deleting its session: the tab
	 * would otherwise stay open with no file behind it, and the next sidebar
	 * refresh would list it again as an unsaved chat — the row you just deleted,
	 * back under a different name.
	 */
	const closeTab = useCallback((tabId: string) => {
		setTabs(current => current.filter(tab => tab.tabId !== tabId));
		setActiveTabId(current => (current === tabId ? SCRATCH.tabId : current));
		forgetTab(tabId);
		// The jsonl behind this tab is being unlinked, and a project's tab id is
		// `dir:<cwd>` — it comes back when that folder is opened again. Left here,
		// the dead path would be the next process's `switch_session` target, which
		// does not fail on a missing file: it recreates it.
		forgetSession(tabId);
	}, []);

	const adoptSession = useCallback((tabId: string, sessionId: string) => {
		setTabs(current => adoptSessionIn(current, tabId, sessionId) as OpenTab[]);
	}, []);

	/*
	 * Opening a project and starting a chat are different questions, so they key
	 * their tabs differently. A project is identified by its directory — adding
	 * the same folder twice re-activates the tab you already have, rather than
	 * stacking duplicates and duplicate sidecars. A chat is not: two chats in one
	 * repository is the normal case, so each gets an id of its own.
	 */
	const openProject = useCallback(
		(cwd: string) => openTab({ tabId: `dir:${cwd}`, cwd, title: baseName(cwd) }),
		[openTab],
	);

	const [pickingProject, setPickingProject] = useState(false);

	/*
	 * Always ask where, but ask in the app's own vocabulary. A session's
	 * directory is fixed at spawn and decides what the agent can reach, what
	 * Changes diffs and what Files lists — too much to infer. It used to fall
	 * through to `$HOME`, which is not a project: the side panels came up empty
	 * and the agent's workspace was the whole home folder.
	 *
	 * Cancelling creates nothing, which is why this cannot be folded into
	 * `openTab`.
	 */
	const startSession = useCallback(
		(cwd: string) => openTab({ tabId: newChatId(), cwd, title: baseName(cwd) }),
		[openTab],
	);

	const actions: PaletteAction[] = useMemo(
		() => [
			{ id: "new", label: "New session…", hint: "⌘T", run: () => setPickingProject(true) },
			{ id: "settings", label: "Settings", hint: "⌘,", run: () => void navigate("/manage") },
			{ id: "providers", label: "Connect a provider", run: () => void navigate("/onboarding") },
			{ id: "probe", label: "Protocol probe", run: () => void navigate("/probe") },
			{
				id: "sidebar",
				label: sidebarOpen ? "Hide sessions" : "Show sessions",
				hint: "⌘B",
				run: () => setSidebarOpen(open => !open),
			},
			{
				id: "panel",
				label: panelOpen ? "Hide side panel" : "Show side panel",
				hint: "⌘⌥B",
				run: () => setPanelOpen(open => !open),
			},
		],
		[navigate, panelOpen, sidebarOpen],
	);

	// Desktop conventions rather than omp's terminal keybindings: those are built
	// for a TTY and collide with what a native app is expected to do.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey;
			if (!mod) return;
			const key = event.key.toLowerCase();

			if (key === "b") {
				event.preventDefault();
				if (event.altKey) setPanelOpen(open => !open);
				else setSidebarOpen(open => !open);
			} else if (key === "k") {
				event.preventDefault();
				setPaletteOpen(open => !open);
			} else if (key === "t" || key === "n") {
				event.preventDefault();
				setPickingProject(true);
			} else if (key === ",") {
				event.preventDefault();
				void navigate("/manage");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate]);

	/*
	 * What a right click means where nothing more specific claims it. The native
	 * menu is suppressed everywhere, so this is what stands between an empty
	 * corner of the window and nothing happening at all.
	 */
	const shellItems = useCallback(
		(): MenuItem[] => [
			{ kind: "action", id: "new", label: "New session…", hint: "⌘T", run: () => setPickingProject(true) },
			{ kind: "action", id: "palette", label: "Command palette", hint: "⌘K", run: () => setPaletteOpen(true) },
			{ kind: "separator", id: "sep" },
			{
				kind: "action",
				id: "sidebar",
				label: sidebarOpen ? "Hide sessions" : "Show sessions",
				hint: "⌘B",
				run: () => setSidebarOpen(open => !open),
			},
			{
				kind: "action",
				id: "panel",
				label: panelOpen ? "Hide side panel" : "Show side panel",
				hint: "⌘⌥B",
				run: () => setPanelOpen(open => !open),
			},
			{ kind: "separator", id: "sep2" },
			{ kind: "action", id: "settings", label: "Settings", hint: "⌘,", run: () => void navigate("/manage") },
		],
		[navigate, panelOpen, sidebarOpen],
	);

	useGlobalContextMenu(shellItems);

	/*
	 * A notification announces a session that is not on screen, so clicking it has
	 * to land you there. Registered here because `activate` is the shell's, and
	 * once for the app rather than once per session view — every open tab renders,
	 * so a per-view listener would be N of them answering the same click.
	 */
	useEffect(() => {
		// No cleanup: the listener is the app's, not this render's, and it replaces
		// its handler rather than stacking one per pass.
		onNotificationActivate(activate);
	}, [activate]);

	// Closing mid-turn loses only the turn in flight — the transcript is already
	// on disk — but that turn can be a lot of work.
	useCloseGuard(
		anyTabBusy,
		useCallback(() => {
			// `withResolvers` because the resolver outlives this call: the dialog
			// answers it from a click, later. AGENTS.md asks for it over `new
			// Promise` everywhere, and this is the shape it is asking for.
			const { promise, resolve } = Promise.withResolvers<boolean>();
			setClosePrompt(() => resolve);
			return promise;
		}, []),
	);

	const context: ShellContext = {
		tabs,
		activeTabId: activeTab?.tabId ?? SCRATCH.tabId,
		panelOpen,
		openPanel: () => setPanelOpen(true),
		adoptSession,
	};

	return (
		<div
			className="omp-shell"
			data-panel={panelVisible}
			data-sidebar={sidebarOpen}
			/*
			 * The grid reads its side columns from these, so a drag is one custom
			 * property away from the layout instead of a re-render of the tracks.
			 */
			style={{ "--omp-sidebar-w": `${widths.sidebar}px`, "--omp-panel-w": `${widths.panel}px` } as CSSProperties}
		>
			<TitleBar
				sidebarOpen={sidebarOpen}
				panelOpen={panelOpen}
				project={activeTab?.cwd ? baseName(activeTab.cwd) : undefined}
				title={activeTab?.title ?? SCRATCH.title}
				onToggleSidebar={() => setSidebarOpen(open => !open)}
				onTogglePanel={() => setPanelOpen(open => !open)}
				onNewSession={() => setPickingProject(true)}
				onAddProject={openProject}
			/>

			{/*
			 * The columns. The title bar is a row above them, so the grid that used
			 * to live on `.omp-shell` moved down here unchanged — same tracks, same
			 * four sidebar/panel combinations, just no longer sharing a box with the
			 * area macOS draws its traffic lights over.
			 */}
			<div className="omp-shell__body">
				{sidebarOpen ? (
					<Sidebar
						activeSessionPath={activeTab?.sessionPath}
						activeSessionId={activeTab?.sessionId}
						tabs={tabs}
						activeTabId={activeTab?.tabId ?? SCRATCH.tabId}
						onOpenSession={openSession}
						onActivateTab={activate}
						onNewChatHere={startSession}
						onNewSession={() => setPickingProject(true)}
						onCloseTab={closeTab}
					/>
				) : null}

				<Outlet context={context} />

				{/*
				 * Floating over the column boundary rather than sitting in the grid as
				 * a track of its own: a real track would have to be added and removed
				 * with each panel, and every one of the four column declarations would
				 * have to agree about it.
				 */}
				{sidebarOpen ? (
					<ResizeHandle
						side="left"
						width={widths.sidebar}
						label="Resize the session list"
						onResize={widths.setSidebar}
						onReset={widths.resetSidebar}
					/>
				) : null}

				{panelVisible ? (
					<ResizeHandle
						side="right"
						width={widths.panel}
						label="Resize the side panel"
						onResize={widths.setPanel}
						onReset={widths.resetPanel}
					/>
				) : null}
			</div>

			<ContextMenu />

			<CommandPalette actions={actions} open={paletteOpen} onClose={() => setPaletteOpen(false)} />

			<ProjectPicker open={pickingProject} onClose={() => setPickingProject(false)} onChoose={startSession} />

			{closePrompt ? (
				<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label="Quit omp Desktop">
					<div className="omp-modal">
						<h2 className="omp-modal__title">An agent is still working</h2>
						<p className="omp-modal__message">
							{busyTabs().length === 1
								? "One session is mid-turn."
								: `${busyTabs().length} sessions are mid-turn.`}{" "}
							Transcripts are saved continuously, so only the turn in flight is lost.
						</p>
						<div className="omp-modal__actions">
							<button
								type="button"
								data-component="button"
								data-variant="ghost"
								data-size="normal"
								onClick={() => {
									closePrompt(false);
									setClosePrompt(null);
								}}
							>
								Keep working
							</button>
							<button
								type="button"
								data-component="button"
								data-variant="primary"
								data-size="normal"
								onClick={() => {
									closePrompt(true);
									setClosePrompt(null);
								}}
							>
								Quit anyway
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function baseName(directory: string): string {
	const parts = directory.split(/[/\\]/).filter(Boolean);
	return parts.at(-1) ?? directory;
}
