/**
 * Turns `omp sessions --json` into the sidebar's two-level tree.
 *
 * The grouping already exists on disk — `~/.omp/agent/sessions/` has one bucket
 * per working directory — but the bucket name is the path slugified with `-`,
 * which is ambiguous for any folder that contains a hyphen. `SessionInfo.cwd`
 * carries the real absolute path, and the CLI resolves `projectRoot` through
 * git's common-dir so a session started in a linked worktree groups under its
 * parent repo instead of appearing as a separate project.
 */

import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo } from "../rpc/protocol";

export interface SessionNode extends SessionInfo {
	projectName: string;
}

export interface WorktreeGroup {
	root: string;
	name: string;
	sessions: SessionNode[];
}

export interface ProjectNode {
	root: string;
	name: string;
	/** Sessions in the primary checkout. */
	sessions: SessionNode[];
	/** Sessions in linked worktrees, nested under this project. */
	worktrees: WorktreeGroup[];
	/** Everything under this project, for the header count. */
	total: number;
	/** Most recent activity anywhere in the project, for ordering. */
	modified: string;
	/** Chats open in this window that have no row of their own yet. */
	openChats?: OpenChat[];
}

/** Sessions whose `cwd` was never recorded (old sessions write an empty string). */
export const UNGROUPED = "(no project)";

export async function loadSessions(): Promise<SessionNode[]> {
	const raw = await invoke<string>("omp_cli", { args: ["sessions", "--json"] });
	const parsed = JSON.parse(raw) as SessionNode[];
	return Array.isArray(parsed) ? parsed.filter(isWorthListing) : [];
}

/**
 * Whether a session was ever a conversation.
 *
 * omp declines to name a session whose messages carry no real signal —
 * `isLowSignalTitleInput` in the agent — and an empty name reaches us as an
 * absent `title`. So "has a name" is the agent's own judgement about whether
 * anything happened here, not a heuristic invented in the UI.
 *
 * The alternative signals are worse. A `messageCount` threshold is an arbitrary
 * line that hides a short but real session, and filtering by `cwd` hides real
 * work done in a temporary directory.
 *
 * Deferred, not abandoned: a session that opens with "hola" is named as soon as
 * a message with substance follows, and appears then. Filtering here rather than
 * in `omp sessions --json` keeps that command honest for its other callers —
 * this is a decision about one sidebar.
 */
export function isWorthListing(session: SessionNode): boolean {
	return Boolean(session.title?.trim());
}

export function buildProjects(sessions: readonly SessionNode[]): ProjectNode[] {
	const byRoot = new Map<string, ProjectNode>();

	for (const session of sessions) {
		const root = session.projectRoot || UNGROUPED;
		let project = byRoot.get(root);
		if (!project) {
			project = {
				root,
				name: session.projectName || basename(root),
				sessions: [],
				worktrees: [],
				total: 0,
				modified: session.modified,
			};
			byRoot.set(root, project);
		}

		if (session.isWorktree && session.cwd && session.cwd !== root) {
			let worktree = project.worktrees.find(w => w.root === session.cwd);
			if (!worktree) {
				worktree = { root: session.cwd, name: basename(session.cwd), sessions: [] };
				project.worktrees.push(worktree);
			}
			worktree.sessions.push(session);
		} else {
			project.sessions.push(session);
		}

		project.total += 1;
		if (session.modified > project.modified) project.modified = session.modified;
	}

	const projects = [...byRoot.values()];
	for (const project of projects) {
		project.sessions.sort(byModifiedDesc);
		project.worktrees.sort((a, b) => a.name.localeCompare(b.name));
		for (const worktree of project.worktrees) worktree.sessions.sort(byModifiedDesc);
	}

	// Most recently touched project first; the ungrouped bucket always last.
	return projects.sort((a, b) => {
		if (a.root === UNGROUPED) return 1;
		if (b.root === UNGROUPED) return -1;
		return b.modified.localeCompare(a.modified);
	});
}

/** A working directory a new session can be started in. */
export interface ProjectChoice {
	/** The directory the sidecar is spawned in. */
	cwd: string;
	name: string;
	kind: "project" | "worktree";
	/** The parent project's name, for a worktree. */
	parent?: string;
	/** Sessions already recorded here. */
	sessions: number;
}

/**
 * Flatten the sidebar's tree into the directories a session can start in.
 *
 * Worktrees earn their own entry: they are separate working directories, which
 * is exactly what is being chosen. The ungrouped bucket does not — its `root` is
 * the `(no project)` label, not a path, and spawning a sidecar there would
 * create a folder by that name.
 */
export function projectChoices(projects: readonly ProjectNode[]): ProjectChoice[] {
	const choices: ProjectChoice[] = [];
	for (const project of projects) {
		if (project.root === UNGROUPED) continue;
		choices.push({
			cwd: project.root,
			name: project.name,
			kind: "project",
			sessions: project.sessions.length,
		});
		for (const worktree of project.worktrees) {
			choices.push({
				cwd: worktree.root,
				name: worktree.name,
				kind: "worktree",
				parent: project.name,
				sessions: worktree.sessions.length,
			});
		}
	}
	return choices;
}

/**
 * A tab, as this module needs to see one.
 *
 * Structural on purpose: `OpenTab` lives in `app.tsx`, which imports from here,
 * and depending on it back would close a cycle for the sake of five fields.
 */
export interface OpenChat {
	tabId: string;
	title: string;
	sessionId?: string;
	sessionPath?: string;
	cwd?: string;
}

/**
 * The tab already showing this session, if there is one.
 *
 * Three ways to match, because a tab acquires its identity at three different
 * moments: `sessionId` once its bridge reports state, `sessionPath` when it was
 * opened from the list, and `tabId` for the older shape where opening a session
 * named the tab after it.
 */
export function findOpenTab<T extends OpenChat>(tabs: readonly T[], session: SessionNode): T | undefined {
	return tabs.find(
		tab =>
			(tab.sessionId !== undefined && tab.sessionId === session.id) ||
			(tab.sessionPath !== undefined && tab.sessionPath === session.path) ||
			tab.tabId === session.id,
	);
}

/**
 * Record which session a tab turned out to be, changing nothing else.
 *
 * Two invariants, both load-bearing:
 *
 * - **`sessionId` only.** `sessionPath` is an instruction, not identity —
 *   `useBridge` boots on it and the last step of booting is `switch_session`,
 *   which aborts the session. Writing it here would kill the running turn.
 * - **Same array when nothing changed.** This is called on every state frame; a
 *   fresh array each time would re-render every tab forever.
 */
export function adoptSessionIn<T extends OpenChat>(tabs: readonly T[], tabId: string, sessionId: string): readonly T[] {
	const tab = tabs.find(entry => entry.tabId === tabId);
	if (!tab || tab.sessionId === sessionId) return tabs;
	return tabs.map(entry => (entry.tabId === tabId ? { ...entry, sessionId } : entry));
}

/**
 * Put the chats you have open into the tree, so the sidebar is the list of them
 * it claims to be.
 *
 * omp writes no session file until there is conversation, and does not name one
 * until there is something worth naming — so a chat you just started is on
 * nobody's disk, and with no tab bar there was no control in the window that
 * returned to it.
 *
 * The test is **"has no row yet"**, not "is not on disk", and the difference is
 * the whole reason this is a function. Between omp writing the session and
 * titling it there is a window where the file exists but `isWorthListing` hides
 * it; the naive test would make the chat appear, vanish and come back.
 *
 * A chat with no `cwd` is left out: that is the launch tab, which belongs to no
 * project and is empty until it is a session like any other.
 */
export function mergeOpenChats(projects: readonly ProjectNode[], chats: readonly OpenChat[]): ProjectNode[] {
	const shown = new Set<string>();
	for (const project of projects) {
		for (const session of project.sessions) shown.add(session.id);
		for (const worktree of project.worktrees) for (const session of worktree.sessions) shown.add(session.id);
	}

	const pending = chats.filter(chat => chat.cwd && !(chat.sessionId && shown.has(chat.sessionId)));
	if (pending.length === 0) return projects.map(project => ({ ...project, openChats: [] }));

	const byRoot = new Map<string, OpenChat[]>();
	const unplaced: OpenChat[] = [];
	for (const chat of pending) {
		const cwd = chat.cwd as string;
		const host = projects.find(
			project => project.root === cwd || project.worktrees.some(worktree => worktree.root === cwd),
		);
		if (host) byRoot.set(host.root, [...(byRoot.get(host.root) ?? []), chat]);
		else unplaced.push(chat);
	}

	const placed = projects.map(project => {
		const openChats = byRoot.get(project.root) ?? [];
		return { ...project, openChats, total: project.total + openChats.length };
	});

	// A folder omp has never run in has no group to join, so it gets one — first,
	// because you created it more recently than anything on disk.
	const fresh = new Map<string, ProjectNode>();
	for (const chat of unplaced) {
		const cwd = chat.cwd as string;
		const group = fresh.get(cwd) ?? {
			root: cwd,
			name: basename(cwd),
			sessions: [],
			worktrees: [],
			total: 0,
			modified: "",
			openChats: [],
		};
		group.openChats = [...(group.openChats ?? []), chat];
		group.total += 1;
		fresh.set(cwd, group);
	}

	return [...fresh.values(), ...placed];
}

/**
 * Incremental filter over what is already loaded — title, project and folder.
 *
 * Deliberately not full-text: `SessionInfo` does expose `allMessagesText`, but
 * obtaining it requires the full-content directory scan that `getRecentSessions`
 * avoids on purpose, described in its own comments as multi-hundred-ms with
 * thousands of sessions.
 */
export function filterProjects(projects: readonly ProjectNode[], query: string): ProjectNode[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...projects];

	const matches = (session: SessionNode, projectName: string): boolean =>
		(session.title ?? "").toLowerCase().includes(needle) ||
		session.firstMessage.toLowerCase().includes(needle) ||
		projectName.toLowerCase().includes(needle) ||
		session.cwd.toLowerCase().includes(needle);

	const result: ProjectNode[] = [];
	for (const project of projects) {
		const sessions = project.sessions.filter(s => matches(s, project.name));
		const worktrees = project.worktrees
			.map(w => ({ ...w, sessions: w.sessions.filter(s => matches(s, project.name)) }))
			.filter(w => w.sessions.length > 0);

		if (sessions.length || worktrees.length) {
			result.push({
				...project,
				sessions,
				worktrees,
				total: sessions.length + worktrees.reduce((n, w) => n + w.sessions.length, 0),
			});
		}
	}
	return result;
}

function byModifiedDesc(a: SessionNode, b: SessionNode): number {
	return b.modified.localeCompare(a.modified);
}

function basename(p: string): string {
	if (!p || p === UNGROUPED) return UNGROUPED;
	const parts = p.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}
