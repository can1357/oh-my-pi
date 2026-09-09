import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeBankScope, deriveBankId, ensureBankExists } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Isolate `git` invocations in this file from the host's global config —
// `~/.gitconfig` commit signing or template hooks would otherwise turn the
// worktree fixture's `git init`/`git commit`/`git worktree add` into a flaky
// dance. Mirrors the isolation in `test/tools/gh.test.ts`.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
delete process.env.XDG_CONFIG_HOME;

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 120_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

describe("computeBankScope", () => {
	describe("scoping=global", () => {
		it("returns the configured bank id verbatim", () => {
			expect(computeBankScope(baseConfig({ bankId: "team-a" }), "/work/proj")).toEqual({
				bankId: "team-a",
			});
		});

		it("falls back to the default bank name when bankId is unset", () => {
			expect(computeBankScope(baseConfig(), "/whatever")).toEqual({ bankId: "omp" });
		});

		it("applies the configured prefix", () => {
			expect(computeBankScope(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toEqual({
				bankId: "prod-team",
			});
		});

		it("does not surface tag fields", () => {
			const scope = computeBankScope(baseConfig(), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
			expect(scope.recallTagsMatch).toBeUndefined();
		});
	});

	describe("scoping=per-project", () => {
		it("appends the cwd basename to the base bank id", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj")).toEqual({
				bankId: "omp-proj",
			});
		});

		it("appends `unknown` for an empty cwd", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "")).toEqual({
				bankId: "omp-unknown",
			});
		});

		it("lowercases the project segment so one checkout maps to one bank", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "/work/General")).toEqual({
				bankId: "omp-general",
			});
		});

		it("composes prefix + bankId + project", () => {
			const scope = computeBankScope(
				baseConfig({ scoping: "per-project", bankId: "team", bankIdPrefix: "prod" }),
				"/work/cool-app",
			);
			expect(scope.bankId).toBe("prod-team-cool-app");
		});

		it("does not surface tag fields (isolation is at the bank level)", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
		});
	});

	describe("scoping=per-project-tagged", () => {
		it("keeps the base bank id and emits project tags with `any` match", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toEqual({
				bankId: "omp",
				retainTags: ["project:proj"],
				recallTags: ["project:proj"],
				recallTagsMatch: "any",
			});
		});

		it("uses the same project label for retain and recall tags", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/repo/cool-app");
			expect(scope.retainTags).toEqual(["project:cool-app"]);
			expect(scope.recallTags).toEqual(["project:cool-app"]);
		});

		it("falls back to project:unknown when cwd is empty", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "");
			expect(scope.retainTags).toEqual(["project:unknown"]);
			expect(scope.recallTags).toEqual(["project:unknown"]);
		});

		it("lowercases the project tag so casing cannot split one project in two", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/work/General");
			expect(scope.retainTags).toEqual(["project:general"]);
			expect(scope.recallTags).toEqual(["project:general"]);
		});
	});

	// Regression for #2232: linked git worktrees used to silo memory into
	// distinct `project:<basename>` tags. The fix resolves the primary
	// checkout root via `git.repo.primaryRootSync`, so every worktree of one
	// repo collapses to the same tag (and the same per-project bank id).
	describe("git worktree handling", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;
		let bareRepoRoot: string;
		let bareWorktreeA: string;
		let bareWorktreeB: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-worktree-"));
			primaryRoot = path.join(baseDir, "myrepo");
			worktreeRoot = path.join(baseDir, "myrepo-feature-x");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature-x"]);
			bareRepoRoot = path.join(baseDir, "bare-repo.git");
			bareWorktreeA = path.join(baseDir, "bare-a");
			bareWorktreeB = path.join(baseDir, "bare-b");
			runGit(baseDir, ["init", "--bare", bareRepoRoot]);
			runGit(primaryRoot, ["remote", "add", "bare", bareRepoRoot]);
			runGit(primaryRoot, ["push", "bare", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeA, "-b", "bare-a", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeB, "-b", "bare-b", "main"]);
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("emits the same project tag from the primary checkout and a linked worktree", () => {
			const fromPrimary = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot);
			const fromWorktree = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot);
			expect(fromPrimary.retainTags).toEqual(["project:myrepo"]);
			expect(fromWorktree.retainTags).toEqual(["project:myrepo"]);
			expect(fromWorktree).toEqual(fromPrimary);
		});

		it("uses the primary root basename for the per-project bank id from a worktree", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), worktreeRoot)).toEqual({
				bankId: "omp-myrepo",
			});
		});

		it("emits one shared project label across worktrees attached to a bare repository", () => {
			const fromA = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeA);
			const fromB = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeB);
			expect(fromA.retainTags).toEqual(["project:bare-repo.git"]);
			expect(fromB).toEqual(fromA);
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), bareWorktreeB)).toEqual({
				bankId: "omp-bare-repo.git",
			});
		});

		it("falls back to the cwd basename outside any repository", () => {
			// The temp parent dir is not itself a repo — it just contains one.
			// `mkdtemp` mixes case into the suffix, so fold it like the label does.
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), baseDir).retainTags).toEqual([
				`project:${path.basename(baseDir).toLowerCase()}`,
			]);
		});
	});

	// Casing is the second fragmentation source, and it survives the #2232
	// worktree fix: the label becomes a tag, Hindsight matches tags literally,
	// so `project:General` and `project:general` are two disjoint scopes over
	// one repository. Fold the case after the primary root is resolved.
	describe("project label case folding", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-case-"));
			primaryRoot = path.join(baseDir, "CasedRepo");
			worktreeRoot = path.join(baseDir, "CasedRepo-Feature");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "Feature"]);
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("folds a mixed-case checkout root to a lowercase tag", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot);
			expect(scope.retainTags).toEqual(["project:casedrepo"]);
			expect(scope.recallTags).toEqual(["project:casedrepo"]);
		});

		it("folds the label a linked worktree inherits from a mixed-case primary root", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot).retainTags).toEqual([
				"project:casedrepo",
			]);
		});
	});
});

describe("deriveBankId (legacy wrapper)", () => {
	it("returns the bankId field of the resolved scope", () => {
		expect(deriveBankId(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toBe("prod-team");
		expect(deriveBankId(baseConfig({ scoping: "per-project" }), "/work/proj")).toBe("omp-proj");
		expect(deriveBankId(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toBe("omp");
	});
});

describe("ensureBankExists", () => {
	let client: HindsightApi;
	let createSpy: Mock<HindsightApi["createBank"]> | undefined;

	beforeEach(() => {
		client = new HindsightApi({ baseUrl: "http://localhost:8888" });
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("calls createBank exactly once per bank id and forwards the mission body", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "remember everything", retainMission: "extract facts" });

		await ensureBankExists(client, "bank-a", config, seen);
		await ensureBankExists(client, "bank-a", config, seen);
		await ensureBankExists(client, "bank-b", config, seen);

		expect(createSpy).toHaveBeenCalledTimes(2);
		expect(createSpy).toHaveBeenCalledWith(
			"bank-a",
			expect.objectContaining({ reflectMission: "remember everything", retainMission: "extract facts" }),
		);
		expect(createSpy).toHaveBeenCalledWith("bank-b", expect.any(Object));
		expect(seen.has("bank-a")).toBe(true);
		expect(seen.has("bank-b")).toBe(true);
	});

	// Regression: mental-model auto-seed used to POST `createMentalModel` against
	// a never-created bank when `bankMission` was blank, because the old
	// `ensureBankMission` skipped creation entirely without a mission.
	it("still PUTs the bank when no mission is configured (so the bank gets created)", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();

		await ensureBankExists(client, "bank", baseConfig({ bankMission: "" }), seen);
		await ensureBankExists(client, "bank", baseConfig({ bankMission: "   " }), seen);

		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledWith(
			"bank",
			expect.objectContaining({ reflectMission: undefined, retainMission: undefined }),
		);
		expect(seen.has("bank")).toBe(true);
	});

	it("swallows API failures and does not mark the bank as initialised", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockRejectedValue(new Error("HTTP 500"));
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "do the thing" });

		await expect(ensureBankExists(client, "bank-x", config, seen)).resolves.toBeUndefined();
		expect(seen.has("bank-x")).toBe(false);
	});
});
