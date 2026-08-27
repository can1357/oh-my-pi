/**
 * Project scoping for replication: which projects sync, and how a
 * machine-specific path becomes a machine-independent wire identity.
 *
 * ## Why this exists
 *
 * Session directories are named from the cwd
 * (`session-paths.ts:getDefaultSessionDirName` encodes the home-relative path,
 * so `~/projects/foo` becomes `-projects-foo`), and `history.cwd` holds an
 * absolute local path. Both are meaningless on another machine that keeps the
 * same project at `~/dev/foo`. Everything crossing the replication boundary is
 * therefore translated into `<projectId>` + a path relative to the project
 * root, and translated back on arrival.
 *
 * ## Fail closed
 *
 * A cwd that resolves to no registered project is **not replicated**. Sharing
 * is opt-in per project via `omp project enable`; an unregistered directory
 * never leaves the machine. Every lookup here is synchronous because the
 * `ReplicatedDomain.changedSince` contract is synchronous — git remotes are
 * consulted only by the registration CLI, never on a sync path.
 */

import * as path from "node:path";
import { logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { loadProjects, type ProjectEntry } from "../config/projects-config";

/** Separator between project id and in-project path on the wire. */
const WIRE_SEP = "\u0000";

/** How long a resolved registry snapshot is reused before re-reading disk. */
const SNAPSHOT_TTL_MS = 5_000;

/** A registered project with its path pre-canonicalized for prefix matching. */
export interface ScopedProject {
	id: string;
	/** Absolute path as written in projects.yml. */
	localPath: string;
	/** `resolveEquivalentPath(localPath)` — symlinks resolved, for comparisons. */
	canonicalPath: string;
	sync: boolean;
}

/** A cwd resolved against the registry. */
export interface ResolvedProject {
	project: ScopedProject;
	/** POSIX path from the project root to the cwd; `""` at the root itself. */
	rel: string;
}

interface Snapshot {
	at: number;
	projects: ScopedProject[];
}

let snapshot: Snapshot | undefined;

/** Drop the cached registry snapshot; call after mutating projects.yml. */
export function invalidateProjectScope(): void {
	snapshot = undefined;
}

/**
 * Registered projects, newest-read-wins with a short TTL.
 *
 * The TTL keeps a long-lived TUI honest about `omp project enable` running in
 * another terminal without re-reading YAML on every replicated row.
 */
export function listScopedProjects(): ScopedProject[] {
	const now = Date.now();
	if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.projects;

	const projects: ScopedProject[] = [];
	for (const entry of loadProjects()) {
		const resolved = toScoped(entry);
		if (resolved) projects.push(resolved);
	}
	// Longest path first so a nested project wins over its parent.
	projects.sort((a, b) => b.canonicalPath.length - a.canonicalPath.length);
	snapshot = { at: now, projects };
	return projects;
}

function toScoped(entry: ProjectEntry): ScopedProject | undefined {
	if (!path.isAbsolute(entry.path)) {
		logger.warn("projects.yml entry ignored: path is not absolute", { id: entry.id, path: entry.path });
		return undefined;
	}
	const localPath = path.resolve(entry.path);
	return {
		id: entry.id,
		localPath,
		canonicalPath: resolveEquivalentPath(localPath),
		sync: entry.sync,
	};
}

/** Projects with replication enabled. */
export function listSyncedProjects(): ScopedProject[] {
	return listScopedProjects().filter(p => p.sync);
}

/**
 * Resolve a cwd to its registered project, or undefined when unregistered.
 *
 * Matches the project whose path is the cwd or an ancestor of it, preferring the
 * deepest match. Comparison happens on canonicalized paths so a symlinked
 * checkout resolves like its target — the same normalization
 * `getDefaultSessionDirName` applies when naming the session dir.
 */
export function resolveProject(cwd: string): ResolvedProject | undefined {
	const canonicalCwd = resolveEquivalentPath(path.resolve(cwd));
	for (const project of listScopedProjects()) {
		const rel = path.relative(project.canonicalPath, canonicalCwd);
		if (rel === "") return { project, rel: "" };
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			return { project, rel: rel.split(path.sep).join("/") };
		}
	}
	return undefined;
}

/** Registered project for `id`, or undefined when this machine has no mapping. */
export function projectById(id: string): ScopedProject | undefined {
	return listScopedProjects().find(p => p.id === id);
}

/**
 * Translate an absolute local path into its wire form, or undefined when the
 * path belongs to no synced project (and therefore must not be replicated).
 */
export function toWirePath(absolutePath: string): string | undefined {
	const resolved = resolveProject(absolutePath);
	if (!resolved?.project.sync) return undefined;
	return encodeWireKey(resolved.project.id, resolved.rel);
}

/**
 * Translate a wire path back to an absolute local path, or undefined when this
 * machine has no mapping for that project (or has it disabled).
 */
export function fromWirePath(wirePath: string): string | undefined {
	const decoded = decodeWireKey(wirePath);
	if (!decoded) return undefined;
	const project = projectById(decoded.id);
	if (!project?.sync) return undefined;
	return decoded.rel ? path.join(project.localPath, ...decoded.rel.split("/")) : project.localPath;
}

/** Compose a wire key from a project id and an in-project POSIX path. */
export function encodeWireKey(projectId: string, rel: string): string {
	return `${projectId}${WIRE_SEP}${rel}`;
}

/**
 * Split a wire key. Returns undefined for a key without the separator — an
 * un-namespaced key is either corruption or a pre-scoping peer, and silently
 * treating it as a bare path would write remote data into an unmapped location.
 */
export function decodeWireKey(key: string): { id: string; rel: string } | undefined {
	const idx = key.indexOf(WIRE_SEP);
	if (idx <= 0) return undefined;
	return { id: key.slice(0, idx), rel: key.slice(idx + WIRE_SEP.length) };
}

/**
 * Object-storage path segment for a project.
 *
 * Project ids contain `/` and `:` (`git:github.com/owner/repo`), which would
 * explode into unintended key hierarchy. Mirrors
 * `session-paths.ts:encodeHashedSessionDirName`: a readable slug for humans
 * browsing the bucket plus a digest so distinct ids can never collide.
 */
export function projectObjectSlug(projectId: string): string {
	const readable = projectId
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-60);
	const digest = Bun.SHA256.hash(projectId, "hex").slice(0, 16);
	return `${readable || "project"}-${digest}`;
}
