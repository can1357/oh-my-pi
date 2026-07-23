/**
 * Deterministic repo → Linear project resolution.
 *
 * Invariant: one repository maps to exactly one Linear project. Identity is
 * the canonical repo key (`owner/repo`, normalized from the git remote URL),
 * never a human-typed project name — names drift when humans rename.
 *
 * Sources of truth, in order:
 * 1. The committed registry (`.ompk/linear.json`): every clone, worktree,
 *    and agent reads the same mapping; changes ship through review like
 *    code. A registry hit is verified against Linear — an archived or
 *    deleted target BLOCKS instead of silently recreating.
 * 2. A workspace scan for the exact `repo-key: <owner/repo>` token line in
 *    project descriptions (line-exact, so `owner/repo` never matches
 *    `owner/repo-two`). Exactly one match is adopted into the registry;
 *    two or more BLOCK for a human decision — the resolver never
 *    tie-breaks and never creates a duplicate.
 * 3. Creation, only when explicitly allowed (`allowCreate`) and a team id
 *    is configured in the registry defaults. Search-then-create is a
 *    classic TOCTOU race, so creation stays a deliberate, human-gated
 *    action (KV is never a lock; neither is a Linear query).
 */

import type { LinearProject } from "./linear";

/** Exact token line embedded in a project description to bind it to a repo. */
export const REPO_KEY_PREFIX = "repo-key:";

export interface ProjectRegistryEntry {
	projectId: string;
	adoptedAt: string;
}

export interface ProjectRegistry {
	defaults?: { teamId?: string };
	projects: Record<string, ProjectRegistryEntry>;
}

export type BlockReason =
	| "registry_project_missing"
	| "registry_project_archived"
	| "multiple_matches"
	| "creation_disabled"
	| "missing_team_config";

export type ResolutionPlan =
	| { action: "use"; projectId: string; source: "registry" | "match" }
	| { action: "create" }
	| { action: "blocked"; reason: BlockReason; candidates?: LinearProject[] };

/**
 * Normalize a git remote URL to the canonical `owner/repo` key.
 * Handles ssh (`git@host:owner/repo.git`), ssh URLs, and https forms;
 * lowercases (GitHub identities are case-insensitive). Returns `null` for
 * anything that does not resolve to exactly `owner/repo`.
 */
export function normalizeRepoKey(remoteUrl: string): string | null {
	let path = remoteUrl.trim();
	const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(path);
	if (scp) {
		path = scp[1]!;
	} else {
		try {
			path = new URL(path).pathname;
		} catch {
			return null;
		}
	}
	path = path
		.replace(/^\/+/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const segments = path.split("/");
	if (segments.length !== 2 || segments.some(s => s.length === 0)) return null;
	return `${segments[0]}/${segments[1]}`.toLowerCase();
}

/**
 * Line-exact token match: a description line must equal
 * `repo-key: <repoKey>` after trimming, so key prefixes never collide.
 */
export function hasRepoKeyToken(description: string, repoKey: string): boolean {
	const wanted = `${REPO_KEY_PREFIX} ${repoKey}`;
	return description.split("\n").some(line => line.trim() === wanted);
}

/**
 * Pure resolution decision from gathered facts. The shell executes the
 * plan; nothing here touches the network or filesystem.
 */
export function planResolution(facts: {
	registryEntry: ProjectRegistryEntry | null;
	/** Fetched project for the registry entry; ignored without an entry. */
	registryProject: LinearProject | null;
	/** Token matches from the workspace scan; ignored with an entry. */
	matches: readonly LinearProject[];
	teamId: string | null;
	allowCreate: boolean;
}): ResolutionPlan {
	if (facts.registryEntry) {
		if (!facts.registryProject) return { action: "blocked", reason: "registry_project_missing" };
		if (facts.registryProject.archivedAt) return { action: "blocked", reason: "registry_project_archived" };
		return { action: "use", projectId: facts.registryEntry.projectId, source: "registry" };
	}
	if (facts.matches.length > 1) {
		return { action: "blocked", reason: "multiple_matches", candidates: [...facts.matches] };
	}
	if (facts.matches.length === 1) {
		return { action: "use", projectId: facts.matches[0]!.id, source: "match" };
	}
	if (!facts.allowCreate) return { action: "blocked", reason: "creation_disabled" };
	if (!facts.teamId) return { action: "blocked", reason: "missing_team_config" };
	return { action: "create" };
}

export interface ResolverDeps {
	readRegistry(): Promise<ProjectRegistry | null>;
	writeRegistry(registry: ProjectRegistry): Promise<void>;
	fetchProject(projectId: string): Promise<LinearProject | null>;
	/** All workspace projects, archived included (resolver filters). */
	listAllProjects(): Promise<LinearProject[]>;
	createProject(input: { name: string; description: string; teamId: string }): Promise<LinearProject>;
	now(): Date;
}

export type ResolveOutcome =
	| { ok: true; projectId: string; outcome: "registry" | "adopted" | "created" }
	| { ok: false; reason: BlockReason; candidates?: LinearProject[] };

/**
 * Resolve the Linear project for `repoKey`, adopting or creating exactly
 * as {@link planResolution} decides. Adoption and creation persist to the
 * registry; every blocked outcome leaves registry and workspace untouched.
 */
export async function resolveProject(
	deps: ResolverDeps,
	opts: { repoKey: string; allowCreate: boolean },
): Promise<ResolveOutcome> {
	const registry: ProjectRegistry = (await deps.readRegistry()) ?? { projects: {} };
	const registryEntry = registry.projects[opts.repoKey] ?? null;
	const registryProject = registryEntry ? await deps.fetchProject(registryEntry.projectId) : null;
	// Archived projects participate in matching so a duplicate of an
	// archived-but-bound project is still visible; they are never adopted.
	const matches = registryEntry
		? []
		: (await deps.listAllProjects()).filter(p => !p.archivedAt && hasRepoKeyToken(p.description, opts.repoKey));
	const plan = planResolution({
		registryEntry,
		registryProject,
		matches,
		teamId: registry.defaults?.teamId ?? null,
		allowCreate: opts.allowCreate,
	});

	if (plan.action === "blocked") {
		return { ok: false, reason: plan.reason, ...(plan.candidates ? { candidates: plan.candidates } : {}) };
	}
	if (plan.action === "use" && plan.source === "registry") {
		return { ok: true, projectId: plan.projectId, outcome: "registry" };
	}

	let projectId: string;
	let outcome: "adopted" | "created";
	if (plan.action === "use") {
		projectId = plan.projectId;
		outcome = "adopted";
	} else {
		const slug = opts.repoKey.split("/")[1]!;
		const created = await deps.createProject({
			name: slug,
			description: `${REPO_KEY_PREFIX} ${opts.repoKey}\n\nManaged by ompk-linear-agent; do not remove the repo-key line.`,
			teamId: registry.defaults!.teamId!,
		});
		projectId = created.id;
		outcome = "created";
	}
	registry.projects[opts.repoKey] = {
		projectId,
		adoptedAt: deps.now().toISOString(),
	};
	await deps.writeRegistry(registry);
	return { ok: true, projectId, outcome };
}
