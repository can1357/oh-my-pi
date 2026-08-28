import { SESSION_DETACHED } from "../rpc/sessionOps";
import type { MenuItem } from "../shell/contextMenu";

/**
 * What a right click offers on a session row, and why each entry is or is not
 * available.
 *
 * A builder rather than JSX so the shape can be tested: this package has no DOM
 * environment, and the interesting part here is not the drawing but the rules —
 * which entries a cold session loses, and what each disabled one says about
 * itself.
 */
export interface SessionMenuState {
	/** The session has a process right now. */
	live: boolean;
	/**
	 * ...and this window is holding its handle. Leaving the session route unmounts
	 * every view while the pool keeps the sidecars, so a live session can be one
	 * nothing here is able to speak to.
	 */
	attached: boolean;
	/** Its project directory is known, so Finder and the path make sense. */
	hasProject: boolean;
}

export interface SessionMenuActions {
	open(): void;
	rename(): void;
	exportHtml(): void;
	reveal(): void;
	copySessionPath(): void;
	copyProjectPath(): void;
	stop(): void;
	remove(): void;
}

export function sessionMenuItems(state: SessionMenuState, actions: SessionMenuActions): MenuItem[] {
	// An old session recorded no cwd; without one there is no folder to reveal
	// and no project path to copy.
	const noProject = state.hasProject ? undefined : "This session recorded no project folder";
	// Live somewhere this window cannot reach — you are on Settings, so no session
	// view is mounted. Both of these would otherwise fall through to a throwaway
	// child that opens the jsonl a running agent is appending to.
	const detached = state.live && !state.attached ? SESSION_DETACHED : undefined;

	return [
		{ kind: "action", id: "open", label: "Open", run: actions.open },
		{ kind: "action", id: "rename", label: "Rename…", disabled: detached, run: actions.rename },
		{ kind: "action", id: "export", label: "Export to HTML…", disabled: detached, run: actions.exportHtml },
		{ kind: "separator", id: "sep-1" },
		{
			kind: "action",
			id: "reveal",
			label: "Reveal folder in Finder",
			disabled: noProject,
			run: actions.reveal,
		},
		{ kind: "action", id: "copy-session", label: "Copy session path", run: actions.copySessionPath },
		{
			kind: "action",
			id: "copy-project",
			label: "Copy project path",
			disabled: noProject,
			run: actions.copyProjectPath,
		},
		{ kind: "separator", id: "sep-2" },
		{
			kind: "action",
			id: "stop",
			label: "Stop the process",
			// Named, not hidden: "why is this greyed out" has an answer, and a menu
			// whose entries come and go is harder to learn than one that explains.
			disabled: state.live ? undefined : "This session has no process running",
			run: actions.stop,
		},
		{ kind: "action", id: "delete", label: "Delete session…", danger: true, run: actions.remove },
	];
}

export interface ProjectMenuActions {
	newChat(): void;
	reveal(): void;
	copyPath(): void;
	collapseAll(): void;
}

export function projectMenuItems(actions: ProjectMenuActions): MenuItem[] {
	return [
		{ kind: "action", id: "new", label: "New chat here", run: actions.newChat },
		{ kind: "separator", id: "sep" },
		{ kind: "action", id: "reveal", label: "Reveal folder in Finder", run: actions.reveal },
		{ kind: "action", id: "copy", label: "Copy project path", run: actions.copyPath },
		{ kind: "separator", id: "sep-2" },
		{ kind: "action", id: "collapse", label: "Collapse all projects", run: actions.collapseAll },
	];
}
