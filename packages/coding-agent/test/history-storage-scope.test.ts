import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { historyScopeRing } from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import { HistoryStorage, type HistoryScope } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initGitFixture } from "./helpers/git";

interface Fixtures {
	repoA: string;
	repoASub: string;
	repoAWorktree: string;
	repoB: string;
}

let tempDir: TempDir | null = null;

/** Repo A (plus a nested directory and an out-of-tree linked worktree) and an unrelated repo B. */
async function createFixtures(root: string): Promise<Fixtures> {
	const repoA = path.join(root, "repo-a");
	const repoB = path.join(root, "repo-b");
	const repoASub = path.join(repoA, "src", "deep");
	const repoAWorktree = path.join(root, "repo-a-wt");
	await fs.mkdir(repoASub, { recursive: true });
	await fs.mkdir(repoB, { recursive: true });
	await initGitFixture(repoA);
	await vcs.requireGit(repoA).commitCreate("init", { allowEmpty: true });
	await initGitFixture(repoB);
	await vcs.requireGit(repoA).worktreeAdd(repoAWorktree, "HEAD", { detach: true, clone: false });
	return { repoA, repoASub, repoAWorktree, repoB };
}

async function seed(storage: HistoryStorage, fixtures: Fixtures, ghost: string): Promise<void> {
	const writes = [
		storage.add("alpha deploy pipeline", fixtures.repoA, "s1"),
		storage.add("beta run tests", fixtures.repoASub, "s1"),
		storage.add("gamma deploy worktree", fixtures.repoAWorktree, "s2"),
		storage.add("delta other project", fixtures.repoB, "s2"),
		storage.add("epsilon ploy infix", fixtures.repoA, "s1"),
		storage.add("zeta anonymous", fixtures.repoA),
		storage.add("eta no cwd", undefined, "s1"),
		storage.add("theta ghost cwd", ghost, "s1"),
	];
	await Promise.all(writes);
}

function promptsOf(storage: HistoryStorage, scope?: HistoryScope): string[] {
	return storage.getRecent(100, scope).map(entry => entry.prompt);
}

beforeEach(() => {
	HistoryStorage.close();
	tempDir = TempDir.createSync("@omp-history-scope-");
});

afterEach(async () => {
	HistoryStorage.close();
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage scope filtering", () => {
	it("filters recent reads by session, keeping prompts without a session id out", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		expect(promptsOf(storage, { kind: "session", value: "s1" })).toEqual([
			"theta ghost cwd",
			"eta no cwd",
			"epsilon ploy infix",
			"beta run tests",
			"alpha deploy pipeline",
		]);
		expect(promptsOf(storage, { kind: "session", value: "s2" })).toEqual([
			"delta other project",
			"gamma deploy worktree",
		]);
	});

	it("filters reads by exact cwd and exposes prompts with no cwd only outside cwd/repo scopes", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		expect(promptsOf(storage, { kind: "cwd", value: fixtures.repoA })).toEqual([
			"zeta anonymous",
			"epsilon ploy infix",
			"alpha deploy pipeline",
		]);
		expect(promptsOf(storage, { kind: "cwd", value: fixtures.repoASub })).toEqual(["beta run tests"]);
		expect(promptsOf(storage, { kind: "cwd", value: fixtures.repoB })).toEqual(["delta other project"]);
	});

	it("shares one repository scope across its root, subdirectories and out-of-tree worktrees", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		// The worktree lives outside repo-a, so only primary-root resolution can group it.
		expect(new Set(promptsOf(storage, { kind: "repo", value: fixtures.repoA }))).toEqual(
			new Set([
				"alpha deploy pipeline",
				"beta run tests",
				"gamma deploy worktree",
				"epsilon ploy infix",
				"zeta anonymous",
			]),
		);
		expect(promptsOf(storage, { kind: "repo", value: fixtures.repoB })).toEqual(["delta other project"]);
	});

	it("returns nothing — not the whole history — for a repository scope with no matching directory", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));
		const emptyRepo = path.join(dir.path(), "repo-c");
		await fs.mkdir(emptyRepo, { recursive: true });
		await initGitFixture(emptyRepo);

		expect(storage.getRecent(100, { kind: "repo", value: emptyRepo })).toEqual([]);
	});

	it("reads nothing for a scope kind it does not recognize, never the whole history", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		// A kind outside the union reaches storage only from a caller that bypassed the resolver;
		// answering it with the full table would leak every project.
		const unknown = { kind: "nonsense" } as unknown as HistoryScope;
		expect(storage.getRecent(100, unknown)).toEqual([]);
		expect(storage.search("deploy", 100, unknown)).toEqual([]);
	});

	it("keeps a stored directory outside any repository readable and scoped to itself", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		const ghost = path.join(dir.path(), "ghost");
		await seed(storage, fixtures, ghost);

		const repoPrompts = promptsOf(storage, { kind: "repo", value: fixtures.repoA });
		expect(repoPrompts).not.toContain("theta ghost cwd");
		expect(promptsOf(storage, { kind: "cwd", value: ghost })).toEqual(["theta ghost cwd"]);
	});

	it("applies the scope before the limit instead of after it", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));
		// The newest row overall belongs to another session, so scoping after the limit
		// would return nothing while scoping before it returns the newest s1 prompt.
		await storage.add("iota newest but s2", fixtures.repoB, "s2");

		expect(storage.getRecent(1).map(entry => entry.prompt)).toEqual(["iota newest but s2"]);
		expect(storage.getRecent(1, { kind: "session", value: "s1" }).map(entry => entry.prompt)).toEqual([
			"theta ghost cwd",
		]);
	});

	it("scopes the full-text path", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		expect(storage.search("deploy", 100, { kind: "session", value: "s1" }).map(e => e.prompt)).toEqual([
			"alpha deploy pipeline",
		]);
		expect(
			new Set(storage.search("deploy", 100, { kind: "repo", value: fixtures.repoA }).map(e => e.prompt)),
		).toEqual(new Set(["alpha deploy pipeline", "gamma deploy worktree"]));
	});

	it("scopes the substring fallback path", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		// "silon" is an infix of "epsilon": FTS cannot reach it, only the LIKE fallback can.
		expect(storage.search("silon", 100, { kind: "session", value: "s1" }).map(e => e.prompt)).toEqual([
			"epsilon ploy infix",
		]);
		expect(storage.search("silon", 100, { kind: "session", value: "s2" })).toEqual([]);
		expect(storage.search("silon", 100, { kind: "cwd", value: fixtures.repoA }).map(e => e.prompt)).toEqual([
			"epsilon ploy infix",
		]);
	});

	it("matches a repository reached through a symlink to its physical spelling", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));
		const link = dir.join("repo-a-link");
		await fs.symlink(fixtures.repoA, link, "dir");
		// A row submitted while the symlinked spelling was current: stored `cwd` keeps it.
		await storage.add("submitted through the link", link, "s1");

		// Both spellings must see the same repository and the same directory — stored rows may
		// carry either, and a plain string comparison would split them in two.
		for (const [kind, value] of [
			["repo", fixtures.repoA],
			["repo", link],
			["cwd", fixtures.repoA],
			["cwd", link],
		] as const) {
			const prompts = promptsOf(storage, { kind, value });
			expect(prompts).toContain("alpha deploy pipeline");
			expect(prompts).toContain("submitted through the link");
		}
		// `cwd` stays exact: it must not widen to the repository the way `repo` does.
		expect(promptsOf(storage, { kind: "cwd", value: link })).not.toContain("beta run tests");
	});

	it("removes old directory membership when a local resubmission moves or clears its last row", async () => {
		const dir = tempDir!;
		const a: HistoryScope = { kind: "cwd", value: dir.join("a") };
		const b: HistoryScope = { kind: "cwd", value: dir.join("b") };
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("moving prompt", a.value, "first");
		const keyA = storage.getDirectoryScopeKey("cwd", a.value);
		await storage.add("moving prompt", b.value, "second");
		expect(storage.getDirectoryScopeKey("cwd", a.value)).not.toBe(keyA);
		expect(promptsOf(storage, a)).toEqual([]);
		expect(promptsOf(storage, b)).toEqual(["moving prompt"]);
		await storage.add("moving prompt", undefined, "third");
		expect(storage.getDirectoryScopeKey("cwd", b.value)).toBe("[]");
		expect(promptsOf(storage, b)).toEqual([]);
		expect(storage.getRecent(1)[0]).toMatchObject({ prompt: "moving prompt", sessionId: "third", useCount: 3 });
	});

	it("refreshes foreign moves and deletions and never reuses a cache after table removal", async () => {
		const dir = tempDir!;
		const a: HistoryScope = { kind: "cwd", value: dir.join("a") };
		const b: HistoryScope = { kind: "cwd", value: dir.join("b") };
		const dbPath = dir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("foreign prompt", a.value, "first");
		storage.getDirectoryScopeKey("cwd", a.value);
		const other = new Database(dbPath);
		try {
			other.run("UPDATE history SET cwd = ? WHERE prompt = ?", [b.value!, "foreign prompt"]);
			expect(promptsOf(storage, a)).toEqual([]);
			expect(promptsOf(storage, b)).toEqual(["foreign prompt"]);
			other.run("DELETE FROM history WHERE prompt = ?", ["foreign prompt"]);
			expect(storage.getDirectoryScopeKey("cwd", b.value)).toBe("[]");
			expect(promptsOf(storage, b)).toEqual([]);
			other.run("DROP TABLE history");
			expect(() => storage.getDirectoryScopeKey("cwd", a.value)).toThrow();
			expect(() => storage.getDirectoryScopeKey("cwd", a.value)).toThrow();
		} finally {
			other.close();
		}
	});

	it("re-resolves repository membership after a nested repository appears", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		await fs.mkdir(inner, { recursive: true });
		await initGitFixture(outer);
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("before nested init", inner, "s1");

		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual(["before nested init"]);

		// Repository topology is resolved again on every read, independently of database writes.
		await initGitFixture(inner);
		await storage.add("after nested init", inner, "s1");

		expect(new Set(promptsOf(storage, { kind: "repo", value: inner }))).toEqual(
			new Set(["after nested init", "before nested init"]),
		);
		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual([]);
	});

	it("re-resolves repository membership for a repository created after the last write", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		await fs.mkdir(inner, { recursive: true });
		await initGitFixture(outer);
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("avant", inner, "s1");

		// Warm every fact this process could hold for `inner` and for the outer repository.
		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual(["avant"]);
		expect(promptsOf(storage, { kind: "repo", value: inner })).toEqual([]);
		expect(promptsOf(storage, { kind: "cwd", value: inner })).toEqual(["avant"]);

		// A repository appears under the outer one and nothing is written afterwards — not by
		// this process, and no other connection commits either. Prompts submitted from `inner`
		// belong to `inner` now; serving them under `outer` would hand one project another
		// project's prompts.
		await initGitFixture(inner);

		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual([]);
		expect(promptsOf(storage, { kind: "repo", value: inner })).toEqual(["avant"]);
		expect(storage.search("avant", 100, { kind: "repo", value: outer })).toEqual([]);
		expect(storage.search("avant", 100, { kind: "repo", value: inner }).map(e => e.prompt)).toEqual(["avant"]);
	});

	it("does not pin a stored directory to a symlink that was retargeted", async () => {
		const dir = tempDir!;
		const one = dir.join("one");
		const two = dir.join("two");
		await fs.mkdir(one, { recursive: true });
		await fs.mkdir(two, { recursive: true });
		const link = dir.join("link");
		await fs.symlink(one, link, "dir");
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("via_link", link, "s1");
		expect(promptsOf(storage, { kind: "cwd", value: one })).toEqual(["via_link"]);

		// The link now names another project: the row filed under the old spelling must follow
		// the directory, not the string that was stored.
		await fs.unlink(link);
		await fs.symlink(two, link, "dir");

		expect(promptsOf(storage, { kind: "cwd", value: one })).toEqual([]);
		expect(promptsOf(storage, { kind: "cwd", value: two })).toEqual(["via_link"]);
	});

	it("sees a row committed by another connection without a local write", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("alpha local", fixtures.repoA, "s1");
		// Warm the raw-directory cache through repository and exact-directory reads.
		expect(promptsOf(storage, { kind: "repo", value: fixtures.repoA })).toEqual(["alpha local"]);
		expect(promptsOf(storage, { kind: "cwd", value: fixtures.repoA })).toEqual(["alpha local"]);

		// Another OMP process commits rows under a directory this process never saw, and under a
		// symlinked spelling of the known one. No local write follows.
		const link = dir.join("repo-a-link");
		await fs.symlink(fixtures.repoA, link, "dir");
		const external = new Database(dir.join("history.db"));
		const insert = external.prepare(
			"INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, strftime('%s','now'), ?, ?)",
		);
		insert.run("beta external subdir", fixtures.repoASub, "s2");
		insert.run("gamma external link", link, "s2");
		external.close();

		expect(new Set(promptsOf(storage, { kind: "repo", value: fixtures.repoA }))).toEqual(
			new Set(["gamma external link", "beta external subdir", "alpha local"]),
		);
		expect(new Set(promptsOf(storage, { kind: "cwd", value: fixtures.repoA }))).toEqual(
			new Set(["gamma external link", "alpha local"]),
		);
	});

	it("re-resolves repository roots after another connection commits", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		await fs.mkdir(inner, { recursive: true });
		await initGitFixture(outer);
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("alpha inner", inner, "s1");
		// Warm the raw-directory cache while inner still belongs to outer.
		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual(["alpha inner"]);

		// Another process makes `inner` its own repository and commits a row, with no local write.
		await initGitFixture(inner);
		const external = new Database(dir.join("history.db"));
		external
			.prepare("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, strftime('%s','now'), ?, ?)")
			.run("beta inner", inner, "s2");
		external.close();

		// The live root resolution must reflect that inner left outer.
		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual([]);
		expect(new Set(promptsOf(storage, { kind: "repo", value: inner }))).toEqual(
			new Set(["beta inner", "alpha inner"]),
		);
	});

	it("reads with the scope the search ring hands to the panel", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		// The ring is the only path Ctrl+R uses: its entries must carry the subject, so the
		// head scope must read real rows rather than an empty set.
		const ring = historyScopeRing("cwd", { sessionId: "s1", cwd: fixtures.repoASub });
		expect(ring[0]).toEqual({ kind: "cwd", value: fixtures.repoASub });
		expect(storage.getRecent(100, ring[0])?.map(entry => entry.prompt)).toEqual(["beta run tests"]);
	});

	it("treats an omitted scope as global and keeps matchingSessionIds cross-project", async () => {
		const dir = tempDir!;
		const fixtures = await createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		expect(promptsOf(storage)).toHaveLength(8);
		expect(promptsOf(storage, { kind: "global" })).toHaveLength(8);
		// The resume picker ranks sessions across projects, so this path must stay unscoped.
		expect(new Set(storage.matchingSessionIds("deploy"))).toEqual(new Set(["s1", "s2"]));
	});
});
