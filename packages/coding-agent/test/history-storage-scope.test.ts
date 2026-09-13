import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { historyScopeRing } from "@oh-my-pi/pi-coding-agent/modes/history-scope";
import { HistoryStorage, type HistoryScope } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Fixtures {
	repoA: string;
	repoASub: string;
	repoAWorktree: string;
	repoB: string;
}

let tempDir: TempDir | null = null;

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}

/** Repo A (plus a nested directory and an out-of-tree linked worktree) and an unrelated repo B. */
function createFixtures(root: string): Fixtures {
	const repoA = path.join(root, "repo-a");
	const repoB = path.join(root, "repo-b");
	const repoASub = path.join(repoA, "src", "deep");
	const repoAWorktree = path.join(root, "repo-a-wt");
	fs.mkdirSync(repoASub, { recursive: true });
	fs.mkdirSync(repoB, { recursive: true });
	git(repoA, "init", "--quiet");
	git(repoA, "commit", "--allow-empty", "--quiet", "-m", "init");
	git(repoB, "init", "--quiet");
	git(repoA, "worktree", "add", "--quiet", "--detach", repoAWorktree);
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
		const fixtures = createFixtures(dir.path());
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
		// A legacy row with no session id must never surface under a session scope.
		expect(promptsOf(storage, { kind: "session", value: "s1" })).not.toContain("zeta anonymous");
	});

	it("filters reads by exact cwd and exposes prompts with no cwd only outside cwd/repo scopes", async () => {
		const dir = tempDir!;
		const fixtures = createFixtures(dir.path());
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
		const fixtures = createFixtures(dir.path());
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
		const fixtures = createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));
		const emptyRepo = path.join(dir.path(), "repo-c");
		fs.mkdirSync(emptyRepo, { recursive: true });
		git(emptyRepo, "init", "--quiet");

		expect(storage.getRecent(100, { kind: "repo", value: emptyRepo })).toEqual([]);
	});

	it("keeps a stored directory outside any repository readable and scoped to itself", async () => {
		const dir = tempDir!;
		const fixtures = createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		const ghost = path.join(dir.path(), "ghost");
		await seed(storage, fixtures, ghost);

		const repoPrompts = promptsOf(storage, { kind: "repo", value: fixtures.repoA });
		expect(repoPrompts).not.toContain("theta ghost cwd");
		expect(promptsOf(storage, { kind: "cwd", value: ghost })).toEqual(["theta ghost cwd"]);
	});

	it("applies the scope before the limit instead of after it", async () => {
		const dir = tempDir!;
		const fixtures = createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		// Six later rows belong to other scopes; the newest s1 prompt must still win.
		expect(storage.getRecent(1, { kind: "session", value: "s1" }).map(entry => entry.prompt)).toEqual([
			"theta ghost cwd",
		]);
	});

	it("scopes the full-text path", async () => {
		const dir = tempDir!;
		const fixtures = createFixtures(dir.path());
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
		const fixtures = createFixtures(dir.path());
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
		const fixtures = createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, dir.path() + "/ghost");
		const link = dir.join("repo-a-link");
		fs.symlinkSync(fixtures.repoA, link, "dir");
		// A row submitted while the symlinked spelling was current: stored `cwd` keeps it.
		await storage.add("submitted through the link", link, "s1");

		// Both spellings must see the same repository — stored rows may carry either.
		const viaPhysical = new Set(promptsOf(storage, { kind: "repo", value: fixtures.repoA }));
		const viaLink = new Set(promptsOf(storage, { kind: "repo", value: link }));
		expect(viaLink).toEqual(viaPhysical);
		expect(viaPhysical).toContain("alpha deploy pipeline");
		expect(viaPhysical).toContain("submitted through the link");
	});

	it("re-resolves repository membership after a nested repository appears", async () => {
		const dir = tempDir!;
		const outer = dir.join("outer");
		const inner = path.join(outer, "inner");
		fs.mkdirSync(inner, { recursive: true });
		git(outer, "init", "--quiet");
		const storage = HistoryStorage.open(dir.join("history.db"));
		await storage.add("before nested init", inner, "s1");

		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual(["before nested init"]);

		// A repository created while the process runs must be picked up: the cache is dropped
		// on the next write, so the rows below stop belonging to the outer repository.
		git(inner, "init", "--quiet");
		await storage.add("after nested init", inner, "s1");

		expect(new Set(promptsOf(storage, { kind: "repo", value: inner }))).toEqual(
			new Set(["after nested init", "before nested init"]),
		);
		expect(promptsOf(storage, { kind: "repo", value: outer })).toEqual([]);
	});

	it("reads with the scope the search ring hands to the panel", async () => {
		const dir = tempDir!;
		const fixtures = createFixtures(dir.path());
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
		const fixtures = createFixtures(dir.path());
		const storage = HistoryStorage.open(dir.join("history.db"));
		await seed(storage, fixtures, path.join(dir.path(), "ghost"));

		expect(promptsOf(storage)).toHaveLength(8);
		expect(promptsOf(storage, { kind: "global" })).toHaveLength(8);
		// The resume picker ranks sessions across projects, so this path must stay unscoped.
		expect(new Set(storage.matchingSessionIds("deploy"))).toEqual(new Set(["s1", "s2"]));
	});
});
