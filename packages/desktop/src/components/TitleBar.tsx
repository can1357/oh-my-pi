import { Link } from "react-router";
import { AddProjectButton } from "./AddProjectButton";
import { FolderIcon, PanelLeftIcon, PanelRightIcon, SlidersIcon, SquarePenIcon } from "./Icons";

/**
 * The window's title bar, and the only owner of the overlay title-bar area.
 *
 * The window is `titleBarStyle: "Overlay"` with `hiddenTitle: true`, so macOS
 * draws its traffic lights over whatever is at the top-left and draws nothing
 * else. Before this component, every column cleared them on its own: five rules
 * reserving the same space with four different values, which drifted apart and
 * had to be re-agreed every time a control moved.
 *
 * One row across the whole window replaces all of it — it owns the clearance,
 * it owns the drag region, and it holds the controls that used to appear and
 * disappear as panels opened.
 *
 * `data-tauri-drag-region` is what makes the drag half of that true. The CSS
 * that used to claim it, `-webkit-app-region: drag`, is a Chromium property:
 * WKWebView does not implement it, so the window could not be moved by its own
 * title bar at all. Tauri instead injects a `mousedown` handler that walks the
 * composed path looking for this attribute.
 *
 * `"deep"` rather than the bare attribute because the bare form drags only when
 * the marked element *is* the event target — pressing the title text, the
 * project name or the folder icon would land on a child and do nothing. The
 * buttons need no counterpart marking: that same handler treats a `BUTTON` or
 * `A` without the attribute as a drag blocker, so every control here stays a
 * control. Double-click-to-maximize comes from the handler too.
 *
 * The attribute is only half of it: the handler ends in
 * `invoke("plugin:window|start_dragging")`, and Tauri ships that command
 * disabled, so `src-tauri/capabilities/default.json` has to grant
 * `core:window:allow-start-dragging` or the call is denied and this row goes
 * back to doing nothing.
 */
export function TitleBar({
	sidebarOpen,
	panelOpen,
	project,
	title,
	onToggleSidebar,
	onTogglePanel,
	onNewSession,
	onAddProject,
}: {
	sidebarOpen: boolean;
	panelOpen: boolean;
	/** Folder the active session runs in; absent for a scratch session. */
	project?: string;
	title: string;
	onToggleSidebar(): void;
	onTogglePanel(): void;
	onNewSession(): void;
	onAddProject(cwd: string): void;
}) {
	return (
		<header className="omp-titlebar" data-tauri-drag-region="deep">
			{/*
			 * The window's name, shown rather than merely configured: the window is
			 * `hiddenTitle`, so macOS paints no title of its own and the one in
			 * tauri.conf.json only ever surfaces in the app switcher.
			 */}
			<span className="omp-titlebar__brand">OMP</span>

			<div className="omp-titlebar__group">
				{/*
				 * One button per panel, reflecting state with `aria-pressed`, rather
				 * than a hide control inside the panel plus a reveal control that
				 * floats over the chat once it is gone. Two controls for one boolean
				 * is what made the reveal button hard to place: it had nowhere to
				 * live that was not on top of something else.
				 */}
				<button
					className="omp-titlebar__button"
					type="button"
					aria-pressed={sidebarOpen}
					title="Sessions (⌘B)"
					aria-label={sidebarOpen ? "Hide sessions" : "Show sessions"}
					onClick={onToggleSidebar}
				>
					<PanelLeftIcon />
				</button>
				<button
					className="omp-titlebar__button"
					type="button"
					title="New session… (⌘T)"
					aria-label="New session"
					onClick={onNewSession}
				>
					<SquarePenIcon />
				</button>
				<AddProjectButton onPick={onAddProject} />
			</div>

			{/*
			 * Where you are. With the sidebar hidden there was previously nothing in
			 * the window that said which session was on screen.
			 */}
			<div className="omp-titlebar__context" title={project ? `${project} › ${title}` : title}>
				{project ? (
					<>
						<FolderIcon />
						<span className="omp-titlebar__project">{project}</span>
						<span className="omp-titlebar__sep" aria-hidden="true">
							›
						</span>
					</>
				) : null}
				<span className="omp-titlebar__title">{title}</span>
			</div>

			<div className="omp-titlebar__group">
				<Link className="omp-titlebar__button" to="/manage" title="Settings, plugins and MCP">
					<SlidersIcon />
				</Link>
				<button
					className="omp-titlebar__button"
					type="button"
					aria-pressed={panelOpen}
					title="Side panel (⌘⌥B)"
					aria-label={panelOpen ? "Hide side panel" : "Show side panel"}
					onClick={onTogglePanel}
				>
					<PanelRightIcon />
				</button>
			</div>
		</header>
	);
}
