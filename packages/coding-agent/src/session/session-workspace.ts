import * as os from "node:os";
import * as path from "node:path";

/**
 * Filesystem workspace of a session: one current/default directory plus a
 * non-empty ordered list of workspace directories.
 *
 * `cwd` remains the default directory for relative-path resolution and
 * backward compatibility. `directories` always contains `cwd` first, followed
 * by any additional directories in their supplied order (deduplicated).
 * Directory order is stable but carries no semantic hierarchy.
 *
 * Workspace directories come from the platform (ACP/editor), CLI, or config —
 * never from filesystem walk-up discovery.
 */
export interface SessionWorkspace {
	/** Current/default directory for compatibility and relative path resolution. */
	cwd: string;
	/** Non-empty ordered list of absolute normalized directories; `cwd` is always first. */
	directories: string[];
}

/** Expand a leading `~`/`~/` and resolve to an absolute path (relative input resolves against `base`). */
export function normalizeWorkspaceDirectory(directory: string, base?: string): string {
	let expanded = directory;
	if (expanded === "~") {
		expanded = os.homedir();
	} else if (expanded.startsWith("~/") || expanded.startsWith(`~${path.sep}`)) {
		expanded = path.join(os.homedir(), expanded.slice(2));
	}
	return base ? path.resolve(base, expanded) : path.resolve(expanded);
}

/**
 * Build a normalized {@link SessionWorkspace} from a cwd and optional
 * additional directories. Additional entries are normalized (relative entries
 * resolve against the normalized cwd), deduplicated, and appended after `cwd`
 * preserving their supplied order.
 */
export function normalizeSessionWorkspace(args: { cwd: string; directories?: string[] }): SessionWorkspace {
	const cwd = normalizeWorkspaceDirectory(args.cwd);
	const directories = [cwd];
	for (const directory of args.directories ?? []) {
		const normalized = normalizeWorkspaceDirectory(directory, cwd);
		if (!directories.includes(normalized)) directories.push(normalized);
	}
	return { cwd, directories };
}

/** The workspace directories beyond `cwd`, in order (ACP `additionalDirectories` shape). */
export function additionalWorkspaceDirectories(workspace: SessionWorkspace): string[] {
	return workspace.directories.filter(directory => directory !== workspace.cwd);
}

/**
 * Reconcile the live workspace roots against a new settings-owned list.
 *
 * Startup copies `workspace.additionalDirectories` out of settings into
 * `SessionManager`, which owns the roots from then on, so a live re-read has to
 * reconcile two populations that are mixed together in one list: roots this
 * setting granted, and roots that came from the session header (resume/fork) or
 * `/add-dir`. Only the first population may be revoked.
 *
 * Unioning the live list with the new value is what makes the removal case
 * unreachable — the live list already contains every previously granted root,
 * so `[A]` to `[]` keeps `A` and `[A]` to `[B]` yields `[A, B]`. Passing the
 * previously granted set instead makes a root's origin decidable: a live root
 * is dropped only when it was granted by the old value and is absent from the
 * new one.
 *
 * Returns the next root list and the set that owns it, for the caller to carry
 * into the following reconcile.
 */
export function reconcileSettingsWorkspaceRoots(args: {
	cwd: string;
	/** Roots currently live on the session, settings-owned or not. */
	live: readonly string[];
	/** Roots the previous settings value granted (normalized). */
	previouslyOwned: ReadonlySet<string>;
	/** The new settings value, unnormalized. */
	configured: readonly string[];
}): { roots: string[]; owned: Set<string> } {
	const configuredRoots = additionalWorkspaceDirectories(
		normalizeSessionWorkspace({ cwd: args.cwd, directories: [...args.configured] }),
	);
	// A root the setting names is settings-owned only when the setting is where
	// it came from. One already live on an INDEPENDENT grant — the session
	// header, or `/add-dir` — keeps that grant when the setting happens to name
	// the same path: claiming it would let a later removal from the setting
	// revoke a directory the operator named separately and never withdrew.
	// A root granted by the previous value is ours already, so naming it again
	// is a renewal, not an independent grant.
	const independentlyLive = new Set(args.live.filter(dir => !args.previouslyOwned.has(dir)));
	const owned = new Set(configuredRoots.filter(dir => !independentlyLive.has(dir)));
	const retained = args.live.filter(dir => !args.previouslyOwned.has(dir) || owned.has(dir));
	return { roots: [...new Set([...retained, ...configuredRoots])], owned };
}
