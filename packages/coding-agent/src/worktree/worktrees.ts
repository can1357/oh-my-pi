import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, logger, pathIsWithin, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { cfgIsolationBackend, ovnfsCommand } from "../task/settings";
import type { ManagedWorktree, SessionWorktree, WorktreeBackend, WorktreeLocation } from "./backend";
import { gitWorktree } from "./git";
import { ovnfsWorktree } from "./ovnfs";

/** Choose one creation backend; an unavailable ovnfs daemon is not a fallback to Git. */
export function creationBackend(settings: Settings): WorktreeBackend {
	const command = cfgIsolationBackend.get(settings) === "auto" ? ovnfsCommand(settings) : undefined;
	return command ? ovnfsWorktree($which(command) ?? command) : gitWorktree;
}

/** Dispatch operations on a known session checkout independently of current settings. */
export function worktreeBackend(worktree: SessionWorktree): WorktreeBackend {
	return worktree.ovnfs ? ovnfsWorktree(worktree.ovnfs.command) : gitWorktree;
}

async function ovnfsBackend(settings?: Settings): Promise<WorktreeBackend> {
	return ovnfsWorktree(ovnfsCommand(settings ?? (await Settings.current) ?? undefined));
}

/** List all OMP-owned entries, including the backend that tears each one down. */
export async function managedWorktrees(): Promise<ManagedWorktree[]> {
	const [git, ovnfs] = await Promise.all([gitWorktree.managed(), (await ovnfsBackend()).managed()]);
	return [...git, ...ovnfs];
}

async function ovnfsLocations(cwd: string, settings?: Settings): Promise<WorktreeLocation[]> {
	try {
		return await (await ovnfsBackend(settings)).locations(cwd);
	} catch (error) {
		logger.warn("ovnfs worktree lookup failed", { cwd, error });
		return [];
	}
}

function enclosing(cwd: string, locations: WorktreeLocation[]): WorktreeLocation | undefined {
	let found: WorktreeLocation | undefined;
	for (const location of locations) {
		if (
			!location.removed &&
			pathIsWithin(location.root, cwd) &&
			(!found || location.root.length > found.root.length)
		) {
			found = location;
		}
	}
	return found;
}

function originalRoot(cwd: string, locations: WorktreeLocation[]): string {
	const visited = new Set<string>();
	while (!visited.has(cwd)) {
		visited.add(cwd);
		const entry = enclosing(cwd, locations);
		if (!entry) break;
		cwd = entry.source;
	}
	return cwd;
}

/** Find the primary checkout behind a Git worktree or ovnfs checkout, if `cwd` is in one. */
export async function worktreeOrigin(cwd: string, settings?: Settings): Promise<string | undefined> {
	const repo = vcs.git(cwd);
	if (!repo) return undefined;
	const linked = repo.linkedWorktree();
	if (linked) return linked.primaryRoot;
	const normalized = resolveEquivalentPath(cwd);
	const locations = await ovnfsLocations(normalized, settings);
	if (!enclosing(normalized, locations)) return undefined;
	const source = originalRoot(normalized, locations);
	return vcs.git(source)?.primaryRoot() ?? source;
}

/** All checkout roots in the current repository family, even removed ovnfs roots with session history. */
export async function worktreeFamily(
	cwd: string,
	settings?: Settings,
): Promise<
	| {
			primary: string;
			prefix: string;
			locations: WorktreeLocation[];
	  }
	| undefined
> {
	const repo = vcs.git(cwd);
	if (!repo) return undefined;
	const normalized = resolveEquivalentPath(cwd);
	const ovnfs = await ovnfsLocations(normalized, settings);
	const containing = enclosing(normalized, ovnfs);
	const origin = originalRoot(containing?.source ?? normalized, ovnfs);
	const primary = vcs.git(origin)?.primaryRoot() ?? origin;
	const canonical = resolveEquivalentPath(primary);
	const prefix = containing ? path.relative(containing.root, normalized) : repo.prefixOf(cwd);
	if (prefix == null) return undefined;
	const git = await gitWorktree.locations(primary);
	const siblings = ovnfs.filter(location => {
		const source = originalRoot(location.source, ovnfs);
		return resolveEquivalentPath(vcs.git(source)?.primaryRoot() ?? source) === canonical;
	});
	return { primary, prefix, locations: [...git, ...siblings] };
}
