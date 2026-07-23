import { describe, expect, it } from "bun:test";
import type { LinearProject } from "../src/linear";
import {
	hasRepoKeyToken,
	normalizeRepoKey,
	type ProjectRegistry,
	REPO_KEY_PREFIX,
	type ResolverDeps,
	resolveProject,
} from "../src/project-resolver";

function makeProject(overrides: Partial<LinearProject> = {}): LinearProject {
	return {
		id: "proj-1",
		name: "oh-my-pk",
		description: `${REPO_KEY_PREFIX} kingkillery/oh-my-pk`,
		archivedAt: null,
		...overrides,
	};
}

/**
 * Fake deps recording every side effect: blocked outcomes must leave both
 * the registry and the workspace untouched.
 */
function makeDeps(opts: {
	registry?: ProjectRegistry | null;
	fetched?: LinearProject | null;
	projects?: LinearProject[];
}) {
	const writes: ProjectRegistry[] = [];
	const created: Array<{ name: string; description: string; teamId: string }> = [];
	const deps: ResolverDeps = {
		readRegistry: async () => opts.registry ?? null,
		writeRegistry: async registry => {
			writes.push(structuredClone(registry));
		},
		fetchProject: async () => opts.fetched ?? null,
		listAllProjects: async () => opts.projects ?? [],
		createProject: async input => {
			created.push(input);
			return makeProject({ id: "proj-created", name: input.name, description: input.description });
		},
		now: () => new Date("2026-07-23T00:00:00Z"),
	};
	return { deps, writes, created };
}

describe("normalizeRepoKey", () => {
	it("maps ssh, https, and scp-style remotes to one lowercase key", () => {
		const expected = "kingkillery/oh-my-pk";
		expect(normalizeRepoKey("git@github.com:KingKillery/Oh-My-PK.git")).toBe(expected);
		expect(normalizeRepoKey("https://github.com/kingkillery/oh-my-pk.git")).toBe(expected);
		expect(normalizeRepoKey("https://github.com/kingkillery/oh-my-pk/")).toBe(expected);
		expect(normalizeRepoKey("ssh://git@github.com/kingkillery/oh-my-pk")).toBe(expected);
	});

	it("rejects remotes that do not resolve to owner/repo", () => {
		expect(normalizeRepoKey("not a url")).toBeNull();
		expect(normalizeRepoKey("https://github.com/only-owner")).toBeNull();
		expect(normalizeRepoKey("https://github.com/a/b/c")).toBeNull();
	});
});

describe("hasRepoKeyToken", () => {
	it("matches the token line exactly and ignores key prefixes", () => {
		expect(hasRepoKeyToken("intro\nrepo-key: owner/repo\noutro", "owner/repo")).toBe(true);
		expect(hasRepoKeyToken("  repo-key: owner/repo  ", "owner/repo")).toBe(true);
		// The classic collision: a sibling repo whose key extends ours.
		expect(hasRepoKeyToken("repo-key: owner/repo-two", "owner/repo")).toBe(false);
		expect(hasRepoKeyToken("prose mentioning repo-key: owner/repo inline", "owner/repo")).toBe(false);
	});
});

describe("resolveProject", () => {
	const repoKey = "kingkillery/oh-my-pk";
	const entry = { projectId: "proj-1", adoptedAt: "2026-01-01T00:00:00Z" };

	it("uses a live registry mapping without touching anything", async () => {
		const { deps, writes, created } = makeDeps({
			registry: { projects: { [repoKey]: entry } },
			fetched: makeProject(),
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: true });
		expect(outcome).toEqual({ ok: true, projectId: "proj-1", outcome: "registry" });
		expect(writes).toHaveLength(0);
		expect(created).toHaveLength(0);
	});

	it("blocks on an archived registry target instead of recreating", async () => {
		const { deps, writes, created } = makeDeps({
			registry: { defaults: { teamId: "team-1" }, projects: { [repoKey]: entry } },
			fetched: makeProject({ archivedAt: "2026-06-01T00:00:00Z" }),
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: true });
		expect(outcome).toEqual({ ok: false, reason: "registry_project_archived" });
		expect(writes).toHaveLength(0);
		expect(created).toHaveLength(0);
	});

	it("blocks when the registry target no longer exists in Linear", async () => {
		const { deps, writes } = makeDeps({
			registry: { projects: { [repoKey]: entry } },
			fetched: null,
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: true });
		expect(outcome).toEqual({ ok: false, reason: "registry_project_missing" });
		expect(writes).toHaveLength(0);
	});

	it("adopts exactly one token match into the registry", async () => {
		const { deps, writes, created } = makeDeps({
			projects: [
				makeProject({ id: "proj-9", description: `${REPO_KEY_PREFIX} ${repoKey}` }),
				makeProject({ id: "other", description: `${REPO_KEY_PREFIX} someone/else` }),
			],
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: false });
		expect(outcome).toEqual({ ok: true, projectId: "proj-9", outcome: "adopted" });
		expect(writes).toHaveLength(1);
		expect(writes[0]!.projects[repoKey]!.projectId).toBe("proj-9");
		expect(created).toHaveLength(0);
	});

	it("never adopts an archived match and treats it as no match", async () => {
		const { deps, writes } = makeDeps({
			projects: [makeProject({ archivedAt: "2026-06-01T00:00:00Z" })],
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: false });
		expect(outcome).toEqual({ ok: false, reason: "creation_disabled" });
		expect(writes).toHaveLength(0);
	});

	it("blocks with candidates when several projects claim the key", async () => {
		const { deps, writes, created } = makeDeps({
			projects: [makeProject({ id: "proj-a" }), makeProject({ id: "proj-b" })],
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: true });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe("multiple_matches");
			expect(outcome.candidates?.map(c => c.id).sort()).toEqual(["proj-a", "proj-b"]);
		}
		expect(writes).toHaveLength(0);
		expect(created).toHaveLength(0);
	});

	it("refuses creation without the explicit flag, then without team config", async () => {
		const noFlag = makeDeps({ registry: { defaults: { teamId: "team-1" }, projects: {} } });
		expect(await resolveProject(noFlag.deps, { repoKey, allowCreate: false })).toEqual({
			ok: false,
			reason: "creation_disabled",
		});

		const noTeam = makeDeps({ registry: { projects: {} } });
		expect(await resolveProject(noTeam.deps, { repoKey, allowCreate: true })).toEqual({
			ok: false,
			reason: "missing_team_config",
		});
		expect(noFlag.created).toHaveLength(0);
		expect(noTeam.created).toHaveLength(0);
	});

	it("creates deliberately with the token embedded and persists the mapping", async () => {
		const { deps, writes, created } = makeDeps({
			registry: { defaults: { teamId: "team-1" }, projects: {} },
		});
		const outcome = await resolveProject(deps, { repoKey, allowCreate: true });
		expect(outcome).toEqual({ ok: true, projectId: "proj-created", outcome: "created" });
		expect(created).toHaveLength(1);
		expect(created[0]!.teamId).toBe("team-1");
		expect(created[0]!.name).toBe("oh-my-pk");
		expect(hasRepoKeyToken(created[0]!.description, repoKey)).toBe(true);
		expect(writes[0]!.projects[repoKey]!.projectId).toBe("proj-created");
	});
});
