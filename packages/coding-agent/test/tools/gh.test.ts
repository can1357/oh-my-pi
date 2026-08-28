import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	buildSearchDateQualifier,
	GithubTool,
	getOrFetchPrDiff,
	parsePrUnifiedDiff,
	parseSearchDateBound,
	resolveDefaultRepoMemoized,
} from "@oh-my-pi/pi-coding-agent/tools/gh";
import { parseIssueUrl, parsePullRequestUrl } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $which, getAgentDir, hashPath, removeWithRetries, setAgentDir, WhichCachePolicy } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Isolate every `git` invocation in this file from the developer's host
// configuration. The fixture spawns dozens of git subprocesses against tiny
// throwaway repos; any leak from `~/.gitconfig` or system config (LFS filters,
// commit signing, hook paths, credential helpers, custom default branches)
// turns "git add" / "git commit" / "git push" into prompts or hard failures
// that are unrelated to what we're testing.
//
// Set these on `process.env` so they apply to both the local `runGit` helper
// AND the impl's `git.ts::runCommand`, which spreads `process.env` into every
// spawn. `/dev/null` is the documented way to tell git "use no config from
// this scope". `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=true` guarantee git
// never blocks on stdin waiting for credentials or a GPG passphrase.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
// `XDG_CONFIG_HOME`, if set, lets git re-discover a global config under
// `$XDG_CONFIG_HOME/git/config` even after we pin `GIT_CONFIG_GLOBAL`. Clear
// it so the override is absolute.
delete process.env.XDG_CONFIG_HOME;

function createSession(
	cwd: string = "/tmp/test",
	settings: Settings = Settings.isolated({ "github.enabled": true }),
	artifactsDir?: string,
): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => artifactsDir ?? null,
		allocateOutputArtifact: artifactsDir
			? async toolType => {
					const artifactId = String(nextArtifactId++);
					return {
						id: artifactId,
						path: path.join(artifactsDir, `${artifactId}-${toolType}.md`),
					};
				}
			: undefined,
		getSessionSpawns: () => null,
		settings,
	};
}

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
		const detail = stderr || stdout || `exit code ${result.exitCode}`;
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}

	return new TextDecoder().decode(result.stdout).trim();
}

interface PrFixture {
	baseDir: string;
	repoRoot: string;
	originBare: string;
	forkBare: string;
	headRefName: string;
	headRefOid: string;
	otherRefName: string;
	otherRefOid: string;
}

// Building the fixture is the dominant setup cost in this file. Build one
// immutable template in `beforeAll`, using bare clones instead of repeatedly
// pushing each branch, then materialize independent per-test copies via `fs.cp`.
// Each copy is an independent repo tree, so mutating tests cannot contaminate
// one another.
let prFixtureTemplate: PrFixture | null = null;

async function buildPrFixtureTemplate(): Promise<PrFixture> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-template-"));
	const repoRoot = path.join(baseDir, "repo");
	const originBare = path.join(baseDir, "origin.git");
	const forkBare = path.join(baseDir, "fork.git");
	const headRefName = "feature/contributor-fix";

	await fs.mkdir(repoRoot, { recursive: true });
	runGit(baseDir, ["init", "-b", "main", repoRoot]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "base commit"]);

	runGit(repoRoot, ["checkout", "-b", headRefName]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\nfeature\n");
	runGit(repoRoot, ["commit", "-am", "feature commit"]);
	const headRefOid = (await fs.readFile(path.join(repoRoot, ".git", "refs", "heads", headRefName), "utf8")).trim();

	const otherRefName = "feature/another";
	runGit(repoRoot, ["checkout", "-b", otherRefName, "main"]);
	await fs.writeFile(path.join(repoRoot, "OTHER.md"), "other\n");
	runGit(repoRoot, ["add", "OTHER.md"]);
	runGit(repoRoot, ["commit", "-m", "another commit"]);
	const otherRefOid = (await fs.readFile(path.join(repoRoot, ".git", "refs", "heads", otherRefName), "utf8")).trim();
	runGit(repoRoot, ["checkout", "main"]);

	// Local bare clones copy every prepared branch in one process each. The old
	// setup initialized both remotes and then paid a separate push for main and
	// every feature branch.
	runGit(baseDir, ["clone", "--bare", repoRoot, originBare]);
	runGit(baseDir, ["clone", "--bare", repoRoot, forkBare]);
	runGit(repoRoot, ["remote", "add", "origin", originBare]);
	runGit(repoRoot, ["remote", "add", "forksrc", forkBare]);
	runGit(repoRoot, ["fetch", "origin"]);

	return { baseDir, repoRoot, originBare, forkBare, headRefName, headRefOid, otherRefName, otherRefOid };
}

async function createPrFixture(): Promise<PrFixture> {
	const template = prFixtureTemplate;
	if (!template) throw new Error("PR fixture template was not built (missing beforeAll)");

	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-"));
	const repoRoot = path.join(baseDir, "repo");
	const originBare = path.join(baseDir, "origin.git");
	const forkBare = path.join(baseDir, "fork.git");

	await fs.cp(template.baseDir, baseDir, { recursive: true });
	// Remote URLs in the copied repo still point at the template's absolute
	// `origin.git`/`fork.git`. Repoint them at this copy so pushes/fetches stay
	// isolated and `remote get-url` assertions match the returned paths.
	runGit(repoRoot, ["remote", "set-url", "origin", originBare]);
	runGit(repoRoot, ["remote", "set-url", "forksrc", forkBare]);

	return {
		baseDir,
		repoRoot,
		originBare,
		forkBare,
		headRefName: template.headRefName,
		headRefOid: template.headRefOid,
		otherRefName: template.otherRefName,
		otherRefOid: template.otherRefOid,
	};
}

/**
 * Stub `os.homedir()` AND rebuild the cached `dirs` resolver in pi-utils so
 * `getWorktreesDir()` resolves under an isolated temp home instead of the
 * user's real `~/.omp/wt`. Returns the temp home and a cleanup hook.
 */
interface TempHome {
	home: string;
	cleanup: () => Promise<void>;
}

async function setupTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-home-"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	// Clear XDG_*_HOME so the rebuilt resolver routes `dirs.rootSubdir("wt", "data")`
	// through the spied homedir instead of `$XDG_DATA_HOME/omp/wt` (CI sets these).
	const xdgKeys = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const xdgPrevious: Partial<Record<(typeof xdgKeys)[number], string | undefined>> = {};
	for (const key of xdgKeys) {
		xdgPrevious[key] = process.env[key];
		delete process.env[key];
	}
	// `dirs.configRoot` is computed at constructor time from `os.homedir()`, so
	// we must rebuild the resolver after the spy + env scrub are in place.
	// `setAgentDir` recreates it; we point it at the temp home's default agent dir.
	const originalAgentDir = getAgentDir();
	setAgentDir(path.join(home, ".omp", "agent"));
	return {
		home,
		cleanup: async () => {
			setAgentDir(originalAgentDir);
			for (const key of xdgKeys) {
				const previous = xdgPrevious[key];
				if (previous === undefined) delete process.env[key];
				else process.env[key] = previous;
			}
			await removeWithRetries(home);
		},
	};
}

/**
 * Compute the auto-derived worktree path for a given primary repo root and
 * local branch name, mirroring the encoding used by `pr_checkout`. Resolves
 * symlinks (matches the production `fs.realpath` step) so assertions match
 * the value rendered into the tool result.
 */
async function expectedWorktreePath(home: string, primaryRoot: string, localBranch: string): Promise<string> {
	const prNumber = localBranch.replace(/^pr-/, "");
	const segment = `${prNumber}-${hashPath(primaryRoot)}`;
	return fs.realpath(path.join(home, ".omp", "wt", segment));
}

describe("parsePrUnifiedDiff", () => {
	it("parses quoted diff headers instead of falling back to unknown paths", () => {
		const diff = [
			'diff --git "a/src/file with spaces.ts" "b/src/file with spaces.ts"',
			"index 0000000..1111111 100644",
			'--- "a/src/file with spaces.ts"',
			'+++ "b/src/file with spaces.ts"',
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");

		const parsed = parsePrUnifiedDiff(diff);

		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]).toMatchObject({
			path: "src/file with spaces.ts",
			additions: 1,
			deletions: 1,
			changeType: "modified",
		});
		expect(parsed.files[0]?.oldPath).toBeUndefined();
	});

	it("counts hunk lines whose content starts with file-header markers", () => {
		const diff = [
			"diff --git a/src/headings.md b/src/headings.md",
			"index 0000000..1111111 100644",
			"--- a/src/headings.md",
			"+++ b/src/headings.md",
			"@@ -1 +1 @@",
			"---- removed heading marker",
			"++++ added heading marker",
		].join("\n");

		const parsed = parsePrUnifiedDiff(diff);

		expect(parsed.files[0]).toMatchObject({
			path: "src/headings.md",
			additions: 1,
			deletions: 1,
			changeType: "modified",
		});
	});
});

describe("getOrFetchPrDiff diff-too-large fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function http406(): Error {
		return new Error(
			"could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)",
		);
	}

	it("reassembles a unified diff from the per-file API when gh pr diff returns HTTP 406", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(http406());
		const jsonSpy = vi
			.spyOn(git.github, "json")
			.mockResolvedValueOnce({ changed_files: 2 } as never)
			.mockResolvedValueOnce([
				{
					filename: "src/big.ts",
					status: "modified",
					additions: 2,
					deletions: 1,
					patch: "@@ -1,2 +1,3 @@\n-old\n+new one\n+new two",
				},
				{
					filename: "src/added.ts",
					status: "added",
					additions: 1,
					deletions: 0,
					patch: "@@ -0,0 +1 @@\n+brand new",
				},
			] as unknown as never);

		const result = await getOrFetchPrDiff({
			cwd: "/tmp/test",
			repo: "owner/repo",
			number: 79,
			cacheAuthKey: null,
		});

		expect(result.payload.files.map(f => f.path)).toEqual(["src/big.ts", "src/added.ts"]);
		expect(result.payload.files[0]).toMatchObject({ additions: 2, deletions: 1, changeType: "modified" });
		expect(result.payload.files[1]).toMatchObject({ additions: 1, deletions: 0, changeType: "added" });
		// The reassembled diff parses through parsePrUnifiedDiff identically.
		expect(result.payload.unified).toContain("diff --git a/src/big.ts b/src/big.ts");
		expect(result.payload.unified).toContain("new file mode");
		// The metadata lookup precedes the files endpoint.
		expect(jsonSpy.mock.calls[1]?.[1]).toContain("/repos/owner/repo/pulls/79/files");
	});

	it("keeps files with omitted patches visible instead of dropping them", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(http406());
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({ changed_files: 1 } as never)
			.mockResolvedValueOnce([
				{ filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
			] as unknown as never);

		const result = await getOrFetchPrDiff({
			cwd: "/tmp/test",
			repo: "owner/repo",
			number: 80,
			cacheAuthKey: null,
		});

		expect(result.payload.files.map(f => f.path)).toEqual(["assets/logo.png"]);
		expect(result.payload.unified).toContain("patch unavailable");
	});

	it("preserves paths containing a diff-header delimiter", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(http406());
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({ changed_files: 1 } as never)
			.mockResolvedValueOnce([
				{
					filename: "dir b/file.ts",
					status: "modified",
					additions: 1,
					deletions: 1,
					patch: "@@ -1 +1 @@\n-old\n+new",
				},
			] as unknown as never);

		const result = await getOrFetchPrDiff({
			cwd: "/tmp/test",
			repo: "owner/repo",
			number: 83,
			cacheAuthKey: null,
		});

		expect(result.payload.files[0]).toMatchObject({ path: "dir b/file.ts", additions: 1, deletions: 1 });
		expect(result.payload.unified).toContain('diff --git "a/dir b/file.ts" "b/dir b/file.ts"');
	});

	it("rejects instead of silently reviewing a PR beyond the files API cap", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(http406());
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValueOnce({ changed_files: 3001 } as never);

		await expect(
			getOrFetchPrDiff({ cwd: "/tmp/test", repo: "owner/repo", number: 82, cacheAuthKey: null }),
		).rejects.toThrow("exceeding GitHub's 3000-file limit");
		expect(jsonSpy.mock.calls).toHaveLength(1);
		expect(jsonSpy.mock.calls[0]?.[1]).toContain("/repos/owner/repo/pulls/82");
	});

	it("propagates non-406 errors without hitting the files endpoint", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("authentication required"));
		const jsonSpy = vi.spyOn(git.github, "json");

		await expect(
			getOrFetchPrDiff({ cwd: "/tmp/test", repo: "owner/repo", number: 81, cacheAuthKey: null }),
		).rejects.toThrow("authentication required");
		expect(jsonSpy).not.toHaveBeenCalled();
	});
});

describe("github tool", () => {
	beforeAll(async () => {
		prFixtureTemplate = await buildPrFixtureTemplate();
	});

	afterAll(async () => {
		if (prFixtureTemplate) {
			await removeWithRetries(prFixtureTemplate.baseDir);
			prFixtureTemplate = null;
		}
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("formats repository metadata into readable text", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			nameWithOwner: "cli/cli",
			description: "GitHub CLI",
			url: "https://github.com/cli/cli",
			defaultBranchRef: { name: "trunk" },
			homepageUrl: "https://cli.github.com",
			forkCount: 1234,
			isArchived: false,
			isFork: false,
			primaryLanguage: { name: "Go" },
			repositoryTopics: [{ name: "cli" }, { name: "github" }],
			stargazerCount: 4567,
			updatedAt: "2026-04-01T10:00:00Z",
			viewerPermission: "WRITE",
			visibility: "PUBLIC",
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("repo-view", { op: "repo_view", repo: "cli/cli" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# cli/cli");
		expect(text).toContain("GitHub CLI");
		expect(text).toContain("Default branch: trunk");
		expect(text).toContain("Stars: 4567");
		expect(text).toContain("Topics: cli, github");
	});

	it("reads repository text through GitHub's JSON contents API", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({
			type: "file",
			encoding: "base64",
			size: 20,
			content: Buffer.from('{"version":"16.3.11"}\n').toString("base64"),
			html_url: "https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/package.json",
		});
		const tool = new GithubTool(createSession());
		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "can1357/oh-my-pi",
			branch: "main",
			path: "packages/coding-agent/package.json",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toBe('{"version":"16.3.11"}\n');
		expect(jsonSpy).toHaveBeenCalledWith(
			"/tmp/test",
			[
				"api",
				"/repos/can1357/oh-my-pi/contents/packages/coding-agent/package.json",
				"--method",
				"GET",
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				"Accept-Encoding: identity",
				"-f",
				"ref=main",
			],
			undefined,
			{ repoProvided: true, trimOutput: false },
		);
	});

	it("returns GitHub images as model image content", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			type: "file",
			encoding: "base64",
			size: Buffer.byteLength(TINY_PNG_BASE64, "base64"),
			content: TINY_PNG_BASE64,
			html_url: "https://github.com/anomalyco/opencode/blob/main/packages/web/src/assets/lander/screenshot.png",
		});
		const tool = new GithubTool(
			createSession("/tmp/test", Settings.isolated({ "github.enabled": true, "images.autoResize": false })),
		);
		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "anomalyco/opencode",
			branch: "main",
			path: "packages/web/src/assets/lander/screenshot.png",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Image file: packages/web/src/assets/lander/screenshot.png");
		expect(result.content).toContainEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("identifies files GitHub returns without inline bytes", async () => {
		const sourceUrl = "https://github.com/anomalyco/opencode/blob/main/packages/web/src/assets/lander/screenshot.png";
		vi.spyOn(git.github, "json").mockResolvedValue({
			type: "file",
			encoding: "none",
			size: 2 * 1024 * 1024,
			html_url: sourceUrl,
		});
		const tool = new GithubTool(createSession());
		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "anomalyco/opencode",
			branch: "main",
			path: "packages/web/src/assets/lander/screenshot.png",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("GitHub did not return file bytes");
		expect(text).toContain("packages/web/src/assets/lander/screenshot.png");
		expect(text).toContain(sourceUrl);
	});

	it("creates a pull request via gh and renders the resulting summary", async () => {
		const textCalls: string[][] = [];
		const textSpy = vi.spyOn(git.github, "text").mockImplementation(async (_cwd, args) => {
			textCalls.push([...args]);
			return "https://github.com/owner/repo/pull/77\n";
		});
		const jsonCalls: string[][] = [];
		const jsonSpy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			jsonCalls.push([...args]);
			return {
				number: 77,
				title: "Add gizmo",
				state: "OPEN",
				isDraft: true,
				baseRefName: "main",
				headRefName: "feature/gizmo",
				author: { login: "octocat" },
				createdAt: "2026-05-01T09:00:00Z",
				labels: [{ name: "enhancement" }],
				body: "Adds a gizmo.",
				url: "https://github.com/owner/repo/pull/77",
			} as never;
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-create", {
			op: "pr_create",
			repo: "owner/repo",
			title: "Add gizmo",
			body: "Adds a gizmo.",
			base: "main",
			head: "feature/gizmo",
			draft: true,
			reviewer: ["reviewer1"],
			label: ["enhancement"],
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		// gh pr create invocation: must pass --repo, --title, --base, --head,
		// --draft, --reviewer, --label, and route the body through --body-file
		// (not --body, to keep multi-KB bodies clear of argv-length limits).
		expect(textSpy).toHaveBeenCalledTimes(1);
		const createArgs = textCalls[0];
		expect(createArgs.slice(0, 2)).toEqual(["pr", "create"]);
		expect(createArgs).toEqual(expect.arrayContaining(["--repo", "owner/repo"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--title", "Add gizmo"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--base", "main"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--head", "feature/gizmo"]));
		expect(createArgs).toContain("--draft");
		expect(createArgs).toEqual(expect.arrayContaining(["--reviewer", "reviewer1"]));
		expect(createArgs).toEqual(expect.arrayContaining(["--label", "enhancement"]));
		const bodyFlagIndex = createArgs.indexOf("--body-file");
		expect(bodyFlagIndex).toBeGreaterThanOrEqual(0);
		const bodyFilePath = createArgs[bodyFlagIndex + 1];
		expect(bodyFilePath).toMatch(/gh-pr-body-/);
		expect(createArgs).not.toContain("--body");

		// Follow-up summary fetch must target the parsed PR number/repo.
		expect(jsonSpy).toHaveBeenCalledTimes(1);
		const viewArgs = jsonCalls[0];
		expect(viewArgs.slice(0, 3)).toEqual(["pr", "view", "77"]);
		expect(viewArgs).toEqual(expect.arrayContaining(["--repo", "owner/repo"]));

		// Output: PR number + summary rendered, URL surfaces, body block included.
		expect(text).toContain("# Created Pull Request #77: Add gizmo");
		expect(text).toContain("URL: https://github.com/owner/repo/pull/77");
		expect(text).toContain("Draft: true");
		expect(text).toContain("Base: main");
		expect(text).toContain("Head: feature/gizmo");
		expect(text).toContain("Labels: enhancement");
		expect(text).toContain("Adds a gizmo.");
	});

	it("rejects pr_create when neither title nor fill is supplied", async () => {
		const textSpy = vi.spyOn(git.github, "text");
		const jsonSpy = vi.spyOn(git.github, "json");
		const tool = new GithubTool(createSession());

		await expect(tool.execute("pr-create", { op: "pr_create", repo: "owner/repo" })).rejects.toThrow(
			"title is required unless fill is true",
		);
		expect(textSpy).not.toHaveBeenCalled();
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("formats pull request search results", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			items: [
				{
					number: 101,
					title: "Add feature",
					state: "open",
					user: { login: "dev1" },
					repository_url: "https://api.github.com/repos/owner/repo",
					labels: [{ name: "feature" }],
					created_at: "2026-04-01T08:00:00Z",
					updated_at: "2026-04-01T09:00:00Z",
					html_url: "https://github.com/owner/repo/pull/101",
					pull_request: { merged_at: null },
				},
				{
					number: 102,
					title: "Fix regression",
					state: "closed",
					user: { login: "dev2" },
					repository_url: "https://api.github.com/repos/owner/repo",
					labels: [],
					created_at: "2026-03-31T08:00:00Z",
					updated_at: "2026-03-31T09:00:00Z",
					html_url: "https://github.com/owner/repo/pull/102",
					pull_request: { merged_at: "2026-03-31T10:00:00Z" },
				},
			],
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-prs", {
			op: "search_prs",
			query: "feature",
			repo: "owner/repo",
			limit: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub pull requests search");
		expect(text).toContain("Query: feature");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("- #101 Add feature");
		expect(text).toContain("  State: open");
		expect(text).toContain("  Labels: feature");
		expect(text).toContain("- #102 Fix regression");
		// merged_at present → state surfaces as "merged" even though the API says "closed".
		expect(text).toContain("  State: merged");
	});

	it("calls /search/issues via gh api with the full query verbatim (including leading-dash terms)", async () => {
		const runGhJsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });

		const tool = new GithubTool(createSession());
		await tool.execute("search-issues", {
			op: "search_issues",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});
		await tool.execute("search-prs", {
			op: "search_prs",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});

		const issueArgs = runGhJsonSpy.mock.calls[0]?.[1];
		const prArgs = runGhJsonSpy.mock.calls[1]?.[1];

		// `gh api` carries each form field separately, so leading dashes inside `q=` are not
		// parsed as flags — replaces the historical `--` positional workaround.
		expect(issueArgs?.slice(0, 4)).toEqual(["api", "-X", "GET", "/search/issues"]);
		expect(issueArgs).toContain("q=-label:bug repo:owner/repo is:issue");
		expect(issueArgs).toContain("per_page=1");
		expect(prArgs?.slice(0, 4)).toEqual(["api", "-X", "GET", "/search/issues"]);
		expect(prArgs).toContain("q=-label:bug repo:owner/repo is:pr");
		expect(prArgs).toContain("per_page=1");
	});

	it("parseSearchDateBound: relative duration walks back from `now` and returns YYYY-MM-DD", () => {
		const now = new Date("2026-05-12T15:00:00Z");
		expect(parseSearchDateBound("3d", now)).toBe("2026-05-09");
		expect(parseSearchDateBound("2w", now)).toBe("2026-04-28");
		expect(parseSearchDateBound("12h", now)).toBe("2026-05-12");
		expect(parseSearchDateBound("1mo", now)).toBe("2026-04-12");
		expect(parseSearchDateBound("1y", now)).toBe("2025-05-12");
	});

	it("parseSearchDateBound: passes ISO dates through and normalizes ISO datetimes", () => {
		expect(parseSearchDateBound("2026-05-01")).toBe("2026-05-01");
		expect(parseSearchDateBound("2026-05-01T08:30:00Z")).toBe("2026-05-01T08:30:00Z");
		expect(parseSearchDateBound("2026-05-01T08:30:00.250Z")).toBe("2026-05-01T08:30:00Z");
	});

	it("parseSearchDateBound: rejects unparseable input", () => {
		expect(() => parseSearchDateBound("yesterday")).toThrow(/invalid date bound/);
		expect(() => parseSearchDateBound(" ")).toThrow(/must not be empty/);
	});

	it("buildSearchDateQualifier: emits >=, <=, or range depending on which bounds are set", () => {
		const now = new Date("2026-05-12T00:00:00Z");
		expect(buildSearchDateQualifier("created", "3d", undefined, now)).toBe("created:>=2026-05-09");
		expect(buildSearchDateQualifier("created", undefined, "2026-05-01", now)).toBe("created:<=2026-05-01");
		expect(buildSearchDateQualifier("committer-date", "7d", "1d", now)).toBe("committer-date:2026-05-05..2026-05-11");
		expect(buildSearchDateQualifier("created", undefined, undefined)).toBeUndefined();
	});

	it("search_issues: appends a created:>= qualifier built from `since` and tags `is:issue`", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		await tool.execute("search-issues", {
			op: "search_issues",
			query: "is:open",
			repo: "owner/repo",
			since: "2026-05-01",
			limit: 5,
		});

		const args = spy.mock.calls[0]?.[1];
		expect(args).toContain("q=is:open created:>=2026-05-01 repo:owner/repo is:issue");
	});

	it("search_prs: builds a qualifier-only query when `query` is omitted and tags `is:pr`", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		await tool.execute("search-prs", {
			op: "search_prs",
			repo: "owner/repo",
			since: "2026-05-01",
			until: "2026-05-09",
			dateField: "updated",
			limit: 5,
		});

		const args = spy.mock.calls[0]?.[1];
		expect(args).toContain("q=updated:2026-05-01..2026-05-09 repo:owner/repo is:pr");
	});

	it("search_prs: errors when neither `query` nor a date bound is provided", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		await expect(tool.execute("search-prs", { op: "search_prs", repo: "owner/repo" })).rejects.toThrow(
			/query is required/,
		);
	});

	it("search_commits: forces `committer-date` regardless of `dateField`", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		await tool.execute("search-commits", {
			op: "search_commits",
			query: "refactor",
			repo: "owner/repo",
			since: "2026-05-01",
			dateField: "updated",
			limit: 5,
		});

		const args = spy.mock.calls[0]?.[1];
		expect(args?.slice(0, 4)).toEqual(["api", "-X", "GET", "/search/commits"]);
		expect(args).toContain("q=refactor committer-date:>=2026-05-01 repo:owner/repo");
	});

	it("search_repos: maps dateField=updated to the `pushed:` qualifier", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		await tool.execute("search-repos", {
			op: "search_repos",
			query: "language:rust",
			since: "2026-05-01",
			dateField: "updated",
			limit: 1,
		});

		const args = spy.mock.calls[0]?.[1];
		expect(args?.slice(0, 4)).toEqual(["api", "-X", "GET", "/search/repositories"]);
		expect(args).toContain("q=language:rust pushed:>=2026-05-01");
	});

	it("search_code: treats validated empty date placeholders as omitted", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		const request: ToolCall = {
			type: "toolCall",
			id: "search-code-empty-dates",
			name: tool.name,
			arguments: {
				op: "search_code",
				query: "transformer_infer.py",
				repo: "ModelTC/LightX2V",
				since: "",
				until: "",
				dateField: "created",
			},
		};

		const result = await tool.execute(request.id, tool.parameters.assert(validateToolArguments(tool, request)));
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No code matches found.");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[1]).toContain("q=transformer_infer.py repo:ModelTC/LightX2V");
	});

	it("search_code: rejects validated non-empty since and until values", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession());
		const requests: ToolCall[] = [
			{
				type: "toolCall",
				id: "search-code-since",
				name: tool.name,
				arguments: { op: "search_code", query: "foo", since: "3d" },
			},
			{
				type: "toolCall",
				id: "search-code-until",
				name: tool.name,
				arguments: { op: "search_code", query: "foo", until: "2026-05-01" },
			},
		];

		for (const request of requests) {
			await expect(
				tool.execute(request.id, tool.parameters.assert(validateToolArguments(tool, request))),
			).rejects.toThrow(/search_code does not support since\/until/);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("formats code search results with paths, repo, sha, and match fragment", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({
			items: [
				{
					path: "src/lib.ts",
					repository: { full_name: "owner/repo" },
					sha: "abcdef1234567890",
					html_url: "https://github.com/owner/repo/blob/abcdef1234567890/src/lib.ts",
					text_matches: [{ fragment: "function findThing(): void {\n  ...\n}", property: "content" }],
				},
			],
		});
		const tool = new GithubTool(createSession());

		const request: ToolCall = {
			type: "toolCall",
			id: "search-code-results",
			name: tool.name,
			arguments: {
				op: "search_code",
				query: "findThing",
				repo: "owner/repo",
				limit: 1,
			},
		};
		const result = await tool.execute(request.id, tool.parameters.assert(validateToolArguments(tool, request)));
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub code search");
		expect(text).toContain("Query: findThing");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("- src/lib.ts");
		expect(text).toContain("  Repo: owner/repo");
		expect(text).toContain("  Commit: abcdef123456");
		expect(text).toContain("  Match: function findThing(): void {");

		// Code search needs the text-match accept header to populate `text_matches`.
		const args = spy.mock.calls[0]?.[1] ?? [];
		const acceptIndex = args.indexOf("Accept: application/vnd.github.text-match+json");
		expect(acceptIndex).toBeGreaterThan(-1);
		expect(args[acceptIndex - 1]).toBe("-H");
		expect(args).toContain("q=findThing repo:owner/repo");
	});

	it("formats commit search results with short sha and message subject", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			items: [
				{
					sha: "0123456789abcdef",
					author: { login: "octocat" },
					commit: {
						message: "Fix flaky test\n\nMore detail in the body.",
						author: { name: "Mona Lisa", email: "mona@example.com", date: "2026-04-01T12:00:00Z" },
					},
					repository: { full_name: "owner/repo" },
					html_url: "https://github.com/owner/repo/commit/0123456789abcdef",
				},
			],
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-commits", {
			op: "search_commits",
			query: "fix flaky",
			repo: "owner/repo",
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub commits search");
		expect(text).toContain("- 0123456789ab Fix flaky test");
		expect(text).not.toContain("More detail in the body.");
		expect(text).toContain("  Author: @octocat");
		expect(text).toContain("  Date: 2026-04-01T12:00:00Z");
	});

	it("formats repository search results and never injects the repo qualifier", async () => {
		const runGhJsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({
			items: [
				{
					full_name: "octocat/hello-world",
					description: "First line.\nSecond line should not surface.",
					language: "TypeScript",
					stargazers_count: 42,
					forks_count: 7,
					open_issues_count: 3,
					visibility: "public",
					archived: false,
					fork: false,
					updated_at: "2026-04-01T09:00:00Z",
					html_url: "https://github.com/octocat/hello-world",
				},
			],
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-repos", {
			op: "search_repos",
			query: "language:typescript stars:>100",
			repo: "ignored/value",
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub repositories search");
		expect(text).toContain("- octocat/hello-world");
		expect(text).toContain("  Description: First line.");
		expect(text).not.toContain("Second line should not surface.");
		expect(text).toContain("  Language: TypeScript");
		expect(text).toContain("  Stars: 42");

		const reposArgs = runGhJsonSpy.mock.calls[0]?.[1] ?? [];
		expect(reposArgs.slice(0, 4)).toEqual(["api", "-X", "GET", "/search/repositories"]);
		// `repo:` is ignored for repository searches even when supplied — query is forwarded as-is.
		expect(reposArgs).toContain("q=language:typescript stars:>100");
		expect(reposArgs.some(arg => typeof arg === "string" && arg.includes("repo:ignored/value"))).toBe(false);
	});

	it("search_prs: defaults `repo:` to the current checkout when `repo` is omitted", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets\n");
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession("/tmp/gh-default-prs"));
		await tool.execute("search-prs", {
			op: "search_prs",
			query: "is:open",
			limit: 1,
		});

		// `gh repo view --json url` runs against the session cwd to fetch the default
		// scope; the resolved owner/repo gets layered onto the API query.
		expect(textSpy).toHaveBeenCalled();
		const repoViewArgs = textSpy.mock.calls[0]?.[1] ?? [];
		expect(repoViewArgs.slice(0, 2)).toEqual(["repo", "view"]);
		expect(repoViewArgs).toContain("url");

		const apiArgs = jsonSpy.mock.calls[0]?.[1] ?? [];
		expect(apiArgs).toContain("q=is:open repo:acme/widgets is:pr");
	});

	it("search_issues: skips the current-repo default when the query already carries a scope qualifier", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets\n");
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession("/tmp/gh-default-skip-qualifier"));
		await tool.execute("search-issues", {
			op: "search_issues",
			query: "is:open org:torvalds",
			limit: 1,
		});

		// Explicit `org:` qualifier suppresses the auto-resolved `repo:` injection.
		expect(textSpy).not.toHaveBeenCalled();
		const apiArgs = jsonSpy.mock.calls[0]?.[1] ?? [];
		expect(apiArgs).toContain("q=is:open org:torvalds is:issue");
		expect(apiArgs.some(a => typeof a === "string" && a.startsWith("q=") && a.includes("repo:acme/widgets"))).toBe(
			false,
		);
	});

	it("search_code: falls back to global search when `gh repo view` cannot resolve the current checkout", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession("/tmp/gh-default-no-remote"));
		await tool.execute("search-code", {
			op: "search_code",
			query: "findThing",
			limit: 1,
		});

		expect(textSpy).toHaveBeenCalled();
		const apiArgs = jsonSpy.mock.calls[0]?.[1] ?? [];
		// No `repo:` should be injected — resolution failed, so the search proceeds globally.
		expect(apiArgs).toContain("q=findThing");
		expect(apiArgs.some(a => typeof a === "string" && a.startsWith("q=") && a.includes("repo:"))).toBe(false);
	});

	it("search_commits: honors an explicit `repo` override over the current-checkout default", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets\n");
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession("/tmp/gh-default-explicit-override"));
		await tool.execute("search-commits", {
			op: "search_commits",
			query: "fix",
			repo: "other/project",
			limit: 1,
		});

		// Explicit `repo` short-circuits resolution — no `gh repo view` invocation.
		expect(textSpy).not.toHaveBeenCalled();
		const apiArgs = jsonSpy.mock.calls[0]?.[1] ?? [];
		expect(apiArgs).toContain("q=fix repo:other/project");
	});

	describe("pr_checkout (single, cross-repository) and git remote handling", () => {
		// Arrange the mutable fixture + isolated $HOME once in beforeAll (excluded
		// from test-body time); the body only performs the checkout and assertions.
		let fixture: PrFixture;
		let tempHome: TempHome;
		beforeAll(async () => {
			fixture = await createPrFixture();
			tempHome = await setupTempHome();
		});
		afterAll(async () => {
			await tempHome.cleanup();
			await removeWithRetries(fixture.baseDir);
		});

		it("checks out a pull request into a worktree and configures contributor push metadata", async () => {
			const githubSpy = vi
				.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 123,
					title: "Contributor fix",
					url: "https://ghe.example.com/base/repo/pull/123",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					headRepository: { nameWithOwner: "contrib/repo" },
					headRepositoryOwner: { login: "contrib" },
					isCrossRepository: true,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					nameWithOwner: "contrib/repo",
					sshUrl: fixture.forkBare,
					url: fixture.forkBare,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: "123" });
			expect(githubSpy.mock.calls[1]?.[1]).toContain("ghe.example.com/contrib/repo");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const worktreePath = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-123");

			expect(text).toContain("Checked Out Pull Request #123");
			expect(text).toContain(`Worktree: ${worktreePath}`);
			// Contributor push metadata persisted to git config (single read).
			// `--get-regexp` echoes variable names in git's canonical lowercase.
			const cfg = runGit(fixture.repoRoot, ["config", "--get-regexp", "^branch\\.pr-123\\."]);
			expect(cfg).toContain("branch.pr-123.pushremote forksrc");
			expect(cfg).toContain(`branch.pr-123.merge refs/heads/${fixture.headRefName}`);
			expect(runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"])).toContain(`worktree ${worktreePath}`);
			expect(runGit(worktreePath, ["branch", "--show-current"])).toBe("pr-123");
		});

		// These assertions are non-mutating (a no-op add and rejected adds), so
		// reuse the checkout fixture instead of cloning another repository.
		describe("git.remote.add idempotency", () => {
			it("treats git.remote.add as a no-op when the remote already exists with the same URL", async () => {
				await git.remote.add(fixture.repoRoot, "forksrc", fixture.forkBare);
				expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
			});

			it("rejects git.remote.add when the remote already exists with a different URL", async () => {
				await expect(git.remote.add(fixture.repoRoot, "forksrc", fixture.originBare)).rejects.toThrow(
					/already exists with URL/,
				);
				// Existing URL is preserved — we never overwrote it.
				expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
			});
			it("does not depend on localized git remote-add stderr for existing remotes", async () => {
				// The shim is a bash script resolved via `which`; neither exists on Windows.
				if (process.platform === "win32") return;
				const originalPath = process.env.PATH;
				const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-git-"));
				const realGitResult = Bun.spawnSync(["which", "git"], { stdout: "pipe", stderr: "pipe" });
				expect(realGitResult.exitCode).toBe(0);
				const realGit = new TextDecoder().decode(realGitResult.stdout).trim();
				const fakeGit = path.join(fakeBin, "git");
				await fs.writeFile(
					fakeGit,
					`#!/usr/bin/env bash
while [[ "$1" == "-c" ]]; do shift 2; done
if [[ "$1" == "remote" && "$2" == "add" && "$3" == "forksrc" ]]; then
	echo "本地化错误：远程 forksrc 已经存在。" >&2
	exit 3
fi
exec ${JSON.stringify(realGit)} "$@"
`,
				);
				await fs.chmod(fakeGit, 0o755);

				try {
					process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
					await git.remote.add(fixture.repoRoot, "forksrc", fixture.forkBare);
				} finally {
					if (originalPath === undefined) {
						delete process.env.PATH;
					} else {
						process.env.PATH = originalPath;
					}
					await removeWithRetries(fakeBin);
				}
			});

			it("pins Git messages while preserving UTF-8 character locale", async () => {
				if (process.platform === "win32") return;
				const originalPath = process.env.PATH;
				const originalLocale = {
					EXPECTED_LC_CTYPE: process.env.EXPECTED_LC_CTYPE,
					LANG: process.env.LANG,
					LC_ALL: process.env.LC_ALL,
					LC_CTYPE: process.env.LC_CTYPE,
					LC_MESSAGES: process.env.LC_MESSAGES,
				};
				const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-git-locale-"));
				const realGit = $which("git");
				expect(realGit).not.toBeNull();
				if (realGit === null) return;
				const fakeGit = path.join(fakeBin, "git");
				await fs.writeFile(
					fakeGit,
					`#!/bin/sh
if [ "\${LC_MESSAGES-}" != "C" ]; then
	echo "LC_MESSAGES was \${LC_MESSAGES-<unset>}" >&2
	exit 41
fi
if [ "\${LC_CTYPE-}" != "\${EXPECTED_LC_CTYPE-}" ]; then
	echo "LC_CTYPE was \${LC_CTYPE-<unset>}, expected \${EXPECTED_LC_CTYPE-<unset>}" >&2
	exit 42
fi
if [ "\${LC_ALL+x}" = "x" ]; then
	echo "LC_ALL leaked: \${LC_ALL}" >&2
	exit 43
fi
exec ${JSON.stringify(realGit)} "$@"
`,
				);
				await fs.chmod(fakeGit, 0o755);

				try {
					process.env.PATH = fakeBin;
					process.env.EXPECTED_LC_CTYPE = "C.UTF-8";
					process.env.LC_ALL = "C.UTF-8";
					delete process.env.LANG;
					process.env.LC_CTYPE = "";
					delete process.env.LC_MESSAGES;
					await git.diff(fixture.repoRoot, { env: { LC_MESSAGES: undefined } });

					process.env.EXPECTED_LC_CTYPE = "fr_FR.UTF-8";
					process.env.LC_ALL = "fr_FR.UTF-8";
					process.env.LC_CTYPE = "C";
					process.env.LC_MESSAGES = "fr_FR.UTF-8";
					await git.diff(fixture.repoRoot, { env: { LC_MESSAGES: undefined } });

					process.env.EXPECTED_LC_CTYPE = "UTF-8-SENTINEL";
					process.env.LC_ALL = "fr_FR.UTF-8";
					process.env.LC_CTYPE = "UTF-8-SENTINEL";
					process.env.LC_MESSAGES = "fr_FR.UTF-8";
					await git.diff(fixture.repoRoot, { env: { LC_ALL: "C", LC_MESSAGES: undefined } });
				} finally {
					if (originalPath === undefined) {
						delete process.env.PATH;
					} else {
						process.env.PATH = originalPath;
					}
					for (const [key, value] of Object.entries(originalLocale)) {
						if (value === undefined) {
							delete process.env[key];
						} else {
							process.env[key] = value;
						}
					}
					await removeWithRetries(fakeBin);
				}
			});
		});
	});

	it("pins gh messages while preserving UTF-8 character locale", async () => {
		if (process.platform === "win32") return;
		const originalPath = process.env.PATH;
		const originalLocale = {
			EXPECTED_LC_CTYPE: process.env.EXPECTED_LC_CTYPE,
			LANG: process.env.LANG,
			LC_ALL: process.env.LC_ALL,
			LC_CTYPE: process.env.LC_CTYPE,
			LC_MESSAGES: process.env.LC_MESSAGES,
		};
		const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-gh-locale-"));
		const fakeGh = path.join(fakeBin, "gh");
		await fs.writeFile(
			fakeGh,
			`#!/bin/sh
if [ "\${LC_MESSAGES-}" != "C" ]; then
	echo "LC_MESSAGES was \${LC_MESSAGES-<unset>}" >&2
	exit 41
fi
if [ "\${LC_CTYPE-}" != "\${EXPECTED_LC_CTYPE-}" ]; then
	echo "LC_CTYPE was \${LC_CTYPE-<unset>}, expected \${EXPECTED_LC_CTYPE-<unset>}" >&2
	exit 42
fi
if [ "\${LC_ALL+x}" = "x" ]; then
	echo "LC_ALL leaked: \${LC_ALL}" >&2
	exit 43
fi
echo ok
`,
		);
		const realWhich = $which;
		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation((command, options) =>
				command === "gh"
					? realWhich(command, { ...options, cache: WhichCachePolicy.Bypass })
					: realWhich(command, options),
			);

		await fs.chmod(fakeGh, 0o755);

		try {
			process.env.PATH = fakeBin;
			for (const lcCtype of [undefined, ""] as const) {
				process.env.EXPECTED_LC_CTYPE = "C.UTF-8";
				process.env.LC_ALL = "C.UTF-8";
				delete process.env.LANG;
				delete process.env.LC_MESSAGES;
				if (lcCtype === undefined) {
					delete process.env.LC_CTYPE;
				} else {
					process.env.LC_CTYPE = lcCtype;
				}
				await expect(git.github.run(process.cwd(), ["--version"])).resolves.toMatchObject({ stdout: "ok" });
			}
		} finally {
			whichSpy.mockRestore();
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			for (const [key, value] of Object.entries(originalLocale)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await removeWithRetries(fakeBin);
		}
	});

	it("serializes concurrent git mutations through withRepoLock so callers don't race git's internal locks", async () => {
		// withRepoLock only needs a real `.git/config` to serialize against, so a
		// bare `git init` repo is enough — no fixture clone, remotes, or commits.
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gh-repo-lock-"));
		runGit(repoRoot, ["init", "-b", "main"]);
		try {
			// Without serialization, concurrent `git config` invocations against the
			// same `.git/config` produce "could not lock config file" failures (the
			// lock is O_EXCL with no waiter). Wrapping each write in `withRepoLock`
			// makes the queue per-repo so all writes succeed. Four concurrent writers
			// reliably contend for the O_EXCL lock — enough to prove serialization.
			const writeCount = 4;
			const writes = Array.from({ length: writeCount }, (_, idx) =>
				git.withRepoLock(repoRoot, () => git.config.set(repoRoot, `branch.race-test.key${idx}`, `value-${idx}`)),
			);
			await Promise.all(writes);
			// One read returns every key; without the lock some writes would be lost.
			const dump = runGit(repoRoot, ["config", "--get-regexp", "^branch\\.race-test\\.key"]);
			for (let idx = 0; idx < writeCount; idx += 1) {
				expect(dump).toContain(`branch.race-test.key${idx} value-${idx}`);
			}
		} finally {
			await removeWithRetries(repoRoot);
		}
	});

	describe("pr_checkout arrays and pr_push metadata", () => {
		// One mutable fixture covers disjoint branches and worktrees for both contracts.
		let fixture: PrFixture;
		let tempHome: TempHome;
		beforeAll(async () => {
			fixture = await createPrFixture();
			tempHome = await setupTempHome();
		});
		afterAll(async () => {
			await tempHome.cleanup();
			await removeWithRetries(fixture.baseDir);
		});

		it("checks out multiple pull requests in a single call when pr is an array", async () => {
			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 100,
					title: "Same-repo PR 100",
					url: "https://github.com/owner/repo/pull/100",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					number: 200,
					title: "Same-repo PR 200",
					url: "https://github.com/owner/repo/pull/200",
					baseRefName: "main",
					headRefName: fixture.otherRefName,
					headRefOid: fixture.otherRefOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: ["100", "200"] });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const wt100 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-100");
			const wt200 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-200");

			expect(text).toContain("# 2 Pull Request Worktrees");
			expect(text).toContain("Checked Out Pull Request #100");
			expect(text).toContain("Checked Out Pull Request #200");
			expect(text).toContain(`Worktree: ${wt100}`);
			expect(text).toContain(`Worktree: ${wt200}`);
			expect(runGit(wt100, ["branch", "--show-current"])).toBe("pr-100");
			expect(runGit(wt200, ["branch", "--show-current"])).toBe("pr-200");
			// Both PR URLs persisted to git config (single read instead of two).
			// `--get-regexp` echoes variable names in git's canonical lowercase.
			const prUrls = runGit(fixture.repoRoot, ["config", "--get-regexp", "^branch\\.pr-.*\\.ompprurl$"]);
			expect(prUrls).toContain("branch.pr-100.ompprurl https://github.com/owner/repo/pull/100");
			expect(prUrls).toContain("branch.pr-200.ompprurl https://github.com/owner/repo/pull/200");

			const summaries = result.details?.checkouts;
			expect(summaries?.length).toBe(2);
			expect(summaries?.map(s => s.prNumber)).toEqual([100, 200]);
			expect(summaries?.every(s => s.reused === false)).toBe(true);
		}, 30_000);

		describe("pr_push without checkout metadata", () => {
			// Arrange a branch carrying an unpushed commit (so a stray push WOULD
			// move origin) but no pr_checkout metadata.
			let originMainBefore: string;
			beforeAll(async () => {
				originMainBefore = runGit(fixture.baseDir, [
					"--git-dir",
					fixture.originBare,
					"rev-parse",
					"refs/heads/main",
				]);
				runGit(fixture.repoRoot, ["checkout", "-b", "manual-branch", "origin/main"]);
				await Bun.write(path.join(fixture.repoRoot, "README.md"), "base\nmanual\n");
				runGit(fixture.repoRoot, ["add", "README.md"]);
				runGit(fixture.repoRoot, ["commit", "-m", "manual branch commit"]);
			});

			it("rejects PR pushes from branches without checkout metadata", async () => {
				const tool = new GithubTool(createSession(fixture.repoRoot));
				await expect(tool.execute("pr-push", { op: "pr_push" })).rejects.toThrow(
					"branch manual-branch has no PR push metadata; check it out via op: pr_checkout first",
				);
				// The rejection happened before any push: origin's main is untouched.
				expect(runGit(fixture.baseDir, ["--git-dir", fixture.originBare, "rev-parse", "refs/heads/main"])).toBe(
					originMainBefore,
				);
			});
		});
	});

	it("exposes a flat op-based schema without legacy run_watch parameters", () => {
		const tool = new GithubTool(createSession());
		const wire = toolWireSchema(tool);
		const properties = wire.properties as Record<string, unknown>;
		expect(properties.op).toBeDefined();
		expect(properties.interval).toBeUndefined();
		expect(properties.grace).toBeUndefined();
	});

	it("tails failed job logs inline and saves the full failed-job logs as an artifact", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-run-watch-artifacts-"));
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				id: 77,
				name: "CI",
				display_title: "PR checks",
				status: "completed",
				conclusion: "failure",
				head_branch: "feature/bugfix",
				created_at: "2026-04-01T08:00:00Z",
				updated_at: "2026-04-01T08:06:00Z",
				html_url: "https://github.com/owner/repo/actions/runs/77",
			})
			.mockResolvedValueOnce({
				total_count: 2,
				jobs: [
					{
						id: 201,
						name: "build",
						status: "completed",
						conclusion: "success",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:02:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/201",
					},
					{
						id: 202,
						name: "test",
						status: "completed",
						conclusion: "failure",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:06:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/202",
					},
				],
			});
		vi.spyOn(git.github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta",
			stderr: "",
		});

		try {
			const tool = new GithubTool(
				createSession("/tmp/test", Settings.isolated({ "github.enabled": true }), artifactsDir),
			);
			const result = await tool.execute("run-watch", {
				op: "run_watch",
				run: "https://github.com/owner/repo/actions/runs/77",
				tail: 3,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(text).toContain("# GitHub Actions Run #77");
			// The run URL named a host, so the repo keeps it.
			expect(text).toContain("Repository: github.com/owner/repo");
			expect(text).toContain("### test [failure]");
			expect(text).toContain("delta");
			expect(text).toContain("epsilon");
			expect(text).toContain("zeta");
			expect(text).not.toContain("alpha");
			expect(text).toContain("Run failed.");
			expect(text).toContain("Full failed-job logs: artifact://0");
			expect(result.details?.artifactId).toBe("0");
			expect(result.details?.watch?.mode).toBe("run");
			expect(result.details?.watch?.state).toBe("completed");
			expect(result.details?.watch?.failedLogs?.[0]?.jobName).toBe("test");
			expect(result.details?.watch?.failedLogs?.[0]?.tail).toContain("zeta");

			const artifactText = await Bun.file(path.join(artifactsDir, "0-github.md")).text();
			expect(artifactText).toContain("# GitHub Actions Run #77");
			expect(artifactText).toContain("Full log:");
			expect(artifactText).toContain("alpha");
			expect(artifactText).toContain("beta");
			expect(artifactText).toContain("gamma");
			expect(artifactText).toContain("delta");
			expect(artifactText).toContain("epsilon");
			expect(artifactText).toContain("zeta");
		} finally {
			await removeWithRetries(artifactsDir);
		}
	});

	it("honors the explicit `repo` argument and does not fall back to the cwd repo (issue #1949)", async () => {
		// Reporter's scenario: cwd lives in repo A (`cagedbird043/cagedbird-ecosystem`),
		// caller passes `repo: cagedbird043/cxf`. Before the fix, executeRunWatch
		// passed `undefined` for the explicit repo and `resolveGitHubRepo` fell back
		// to `gh repo view` in cwd, silently watching repo A. The fix routes
		// `params.repo` through, so all `/repos/...` API calls must target cxf.
		const targetRepo = "cagedbird043/cxf";
		const runId = 42;

		const jsonSpy = vi
			.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				// `fetchRunSnapshot` → run details
				id: runId,
				name: "CI",
				display_title: "explicit-repo run",
				status: "completed",
				conclusion: "failure",
				head_branch: "main",
				created_at: "2026-06-05T10:00:00Z",
				updated_at: "2026-06-05T10:05:00Z",
				html_url: `https://github.com/${targetRepo}/actions/runs/${runId}`,
			})
			.mockResolvedValueOnce({
				// `fetchRunJobs` page 1
				total_count: 1,
				jobs: [
					{
						id: 7,
						name: "test",
						status: "completed",
						conclusion: "failure",
						started_at: "2026-06-05T10:00:00Z",
						completed_at: "2026-06-05T10:05:00Z",
						html_url: `https://github.com/${targetRepo}/actions/runs/${runId}/job/7`,
					},
				],
			});
		const runSpy = vi.spyOn(git.github, "run").mockResolvedValue({ exitCode: 0, stdout: "log line\n", stderr: "" });
		const textSpy = vi
			.spyOn(git.github, "text")
			.mockRejectedValue(new Error("gh repo view must not be consulted when `repo` is explicit"));

		const tool = new GithubTool(createSession("/tmp/run-watch-explicit-repo-cwd"));
		const result = await tool.execute("run-watch", {
			op: "run_watch",
			repo: targetRepo,
			run: String(runId),
			tail: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		// Repo precedence — every API surface stayed scoped to `cagedbird043/cxf`.
		expect(textSpy).not.toHaveBeenCalled();
		for (const call of jsonSpy.mock.calls) {
			const argv = call[1] as string[];
			const apiPath = argv.find(arg => arg.startsWith("/repos/"));
			expect(apiPath, `every json call must target ${targetRepo}, got ${argv.join(" ")}`).toContain(
				`/repos/${targetRepo}/`,
			);
		}
		const logsCall = runSpy.mock.calls.find(call =>
			(call[1] as string[]).some(arg => typeof arg === "string" && arg.includes("/actions/jobs/")),
		);
		expect(logsCall?.[1] as string[]).toContain(`/repos/${targetRepo}/actions/jobs/7/logs`);

		expect(text).toContain(`Repository: ${targetRepo}`);
		expect(text).not.toContain("cagedbird043/cagedbird-ecosystem");
		expect(result.details?.repo).toBe(targetRepo);
	});

	it("accepts case-only differences between explicit `repo` and a run URL repo (PR #1951)", async () => {
		const targetRepo = "cagedbird043/cxf";
		const runUrlRepo = "CagedBird043/CXF";
		const runId = 123;
		const jsonSpy = vi
			.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				id: runId,
				name: "CI",
				display_title: "case-only run URL repo match",
				status: "completed",
				conclusion: "success",
				head_branch: "main",
				created_at: "2026-06-05T10:00:00Z",
				updated_at: "2026-06-05T10:05:00Z",
				html_url: `https://github.com/${runUrlRepo}/actions/runs/${runId}`,
			})
			.mockResolvedValueOnce({ total_count: 0, jobs: [] });
		const textSpy = vi
			.spyOn(git.github, "text")
			.mockRejectedValue(new Error("gh repo view must not be consulted when `repo` is explicit"));

		const tool = new GithubTool(createSession("/tmp/run-watch-run-url-casing"));
		const result = await tool.execute("run-watch", {
			op: "run_watch",
			repo: targetRepo,
			run: `https://github.com/${runUrlRepo}/actions/runs/${runId}`,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(textSpy).not.toHaveBeenCalled();
		for (const call of jsonSpy.mock.calls) {
			const argv = call[1];
			const apiPath = argv.find(arg => arg.startsWith("/repos/"));
			expect(apiPath).toContain(`/repos/${targetRepo}/`);
		}
		expect(text).toContain(`Repository: ${targetRepo}`);
		expect(result.details?.repo).toBe(targetRepo);
	});

	it("fails fast when explicit `repo` differs from the cwd repo and no `branch`/`run` selector is given (issue #1949)", async () => {
		// Without a selector, the legacy code grabbed the cwd's HEAD SHA and
		// queried it against the explicit repo — yielding an unrelated commit
		// that surfaced as `Waiting for workflow runs for this commit`. The fix
		// refuses to silently rebind: callers must scope explicitly.
		const targetRepo = "cagedbird043/cxf";
		const cwdRepo = "cagedbird043/cagedbird-ecosystem";
		// Unique cwd per test — `resolveDefaultRepoMemoized` caches by absolute
		// path for the lifetime of the process.
		const cwd = `/tmp/run-watch-explicit-repo-mismatch-${Date.now()}`;
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(`https://github.com/${cwdRepo}`);
		const jsonSpy = vi.spyOn(git.github, "json");

		const tool = new GithubTool(createSession(cwd));
		await expect(tool.execute("run-watch", { op: "run_watch", repo: targetRepo })).rejects.toThrow(
			`Cannot infer the watched commit for ${targetRepo}: current checkout is ${cwdRepo}. Pass \`branch\` or \`run\` to scope the watch.`,
		);
		expect(textSpy).toHaveBeenCalled();
		// No API requests fired — we bailed before issuing any /repos/... call.
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("revalidates cwd repo without using the process-lifetime default repo cache before trusting HEAD (PR #1951)", async () => {
		const targetRepo = "cagedbird043/cxf";
		const replacedCwdRepo = "cagedbird043/cagedbird-ecosystem";
		const cwd = `/tmp/run-watch-stale-cwd-repo-cache-${Date.now()}`;
		const textSpy = vi
			.spyOn(git.github, "text")
			.mockResolvedValueOnce(`https://github.com/${targetRepo}`)
			.mockResolvedValueOnce(`https://github.com/${replacedCwdRepo}`);
		const jsonSpy = vi.spyOn(git.github, "json");

		// Populate `resolveDefaultRepoMemoized` for this exact cwd, simulating a
		// long-lived process that resolved the path before its checkout/remote
		// was replaced.
		await expect(resolveDefaultRepoMemoized(cwd)).resolves.toBe(targetRepo);

		const tool = new GithubTool(createSession(cwd));
		await expect(tool.execute("run-watch", { op: "run_watch", repo: targetRepo })).rejects.toThrow(
			`Cannot infer the watched commit for ${targetRepo}: current checkout is ${replacedCwdRepo}. Pass \`branch\` or \`run\` to scope the watch.`,
		);
		expect(textSpy).toHaveBeenCalledTimes(2);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("fails fast when explicit `repo` is given and cwd has no GitHub repository context (issue #1949)", async () => {
		const targetRepo = "cagedbird043/cxf";
		const cwd = `/tmp/run-watch-explicit-repo-no-git-${Date.now()}`;
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const jsonSpy = vi.spyOn(git.github, "json");

		const tool = new GithubTool(createSession(cwd));
		await expect(tool.execute("run-watch", { op: "run_watch", repo: targetRepo })).rejects.toThrow(
			`Cannot infer the watched commit for ${targetRepo}: current checkout is not a GitHub repository. Pass \`branch\` or \`run\` to scope the watch.`,
		);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("treats explicit `repo` and the cwd repo as matching when only casing differs (PR #1951)", async () => {
		// `gh repo view --json url` returns the canonical GitHub casing.
		// A caller who types `cagedbird043/cxf` while the canonical form is
		// `CagedBird043/cxf` MUST be treated as the same repo — GitHub repository
		// paths are case-insensitive — and run_watch must NOT force them to pass
		// a redundant `branch`/`run` selector.
		const canonicalRepo = "CagedBird043/CXF";
		const userRepo = "cagedbird043/cxf";
		const cwd = `/tmp/run-watch-explicit-repo-casing-${Date.now()}`;
		vi.spyOn(git.github, "text").mockResolvedValue(`https://github.com/${canonicalRepo}`);
		// Past the case-insensitive guard, run_watch keeps using the caller's
		// `repo` (downstream `/repos/...` paths are case-insensitive on GitHub).
		// Stub the cwd's git HEAD/branch lookups so the watch proceeds to its
		// first poll, then trip an abort to terminate the loop deterministically.
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		vi.spyOn(git.head, "sha").mockResolvedValue("c215f3a91217c215f3a91217c215f3a91217c215");
		const abort = new AbortController();
		const jsonSpy = vi.spyOn(git.github, "json").mockImplementation((async () => {
			abort.abort();
			return { workflow_runs: [] };
		}) as unknown as typeof git.github.json);

		const tool = new GithubTool(createSession(cwd));
		// We don't care about the outcome — just that the casing guard let us
		// reach the polling loop instead of throwing the mismatch ToolError.
		await tool.execute("run-watch", { op: "run_watch", repo: userRepo }, abort.signal).catch(() => {});

		expect(jsonSpy).toHaveBeenCalled();
		const firstCall = jsonSpy.mock.calls[0]?.[1] as string[];
		expect(firstCall.some(arg => arg === `/repos/${userRepo}/actions/runs`)).toBe(true);
	});
});

describe("github tool on a GitHub Enterprise host", () => {
	const ENTERPRISE_URL = "https://ghe.example.com/acme/widgets";
	const ENTERPRISE_REPO = "ghe.example.com/acme/widgets";

	// A host-less repo belongs to whatever `GH_HOST` names, so these tests pin
	// it themselves instead of inheriting the developer's value. Restored per
	// test to keep later files unaffected.
	let savedGhHost: string | undefined;
	beforeEach(() => {
		savedGhHost = process.env.GH_HOST;
		delete process.env.GH_HOST;
	});

	afterEach(() => {
		if (savedGhHost === undefined) {
			delete process.env.GH_HOST;
		} else {
			process.env.GH_HOST = savedGhHost;
		}
		vi.restoreAllMocks();
	});

	it("resolves the current checkout to a host-qualified repo", async () => {
		// `gh` resolves a host-less `--repo` against GH_HOST (github.com by
		// default), so dropping the host here sends every lookup for an
		// enterprise checkout to github.com.
		vi.spyOn(git.github, "text").mockResolvedValue(`${ENTERPRISE_URL}\n`);
		await expect(resolveDefaultRepoMemoized(`/tmp/gh-enterprise-resolve-${Date.now()}`)).resolves.toBe(
			ENTERPRISE_REPO,
		);
	});

	it("keeps github.com on the checkout's identity when GH_HOST names another host", async () => {
		process.env.GH_HOST = "ghe.example.com";
		// Stripping the host here would hand `gh` a bare ref and send a
		// github.com checkout's lookups to the enterprise instance.
		vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets\n");
		await expect(resolveDefaultRepoMemoized(`/tmp/gh-default-host-retained-${Date.now()}`)).resolves.toBe(
			"github.com/acme/widgets",
		);
	});

	it("file_read links a bare repo to the host its request went to", async () => {
		process.env.GH_HOST = "ghe.example.com";
		vi.spyOn(git.github, "json").mockResolvedValue({
			type: "file",
			encoding: "none",
			size: 2 * 1024 * 1024,
		} as never);
		const tool = new GithubTool(createSession("/tmp/gh-default-host-file-read"));

		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "acme/widgets",
			path: "docs/readme.md",
		});

		// The request carried no --hostname, so it hit GH_HOST; the fallback link
		// must name the same instance rather than github.com.
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("https://ghe.example.com/acme/widgets/blob/HEAD/docs/readme.md");
	});

	it("file_read passes the host as a flag and keeps it out of the API path", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({
			type: "file",
			encoding: "none",
			size: 2 * 1024 * 1024,
		} as never);
		const tool = new GithubTool(createSession("/tmp/gh-enterprise-file-read"));

		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: ENTERPRISE_REPO,
			path: "docs/readme.md",
		});

		const args = (jsonSpy.mock.calls[0]?.[1] ?? []) as string[];
		// `gh api` endpoints are host-relative: an embedded host would 404.
		expect(args).toContain("/repos/acme/widgets/contents/docs/readme.md");
		expect(args[args.indexOf("--hostname") + 1]).toBe("ghe.example.com");
		// Without an html_url from the API the fallback link must still point at
		// the enterprise instance, not github.com.
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("https://ghe.example.com/acme/widgets/blob/HEAD/docs/readme.md");
	});

	it("search scopes the query to a bare slug and the request to the host", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(`${ENTERPRISE_URL}\n`);
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({ items: [] });
		const tool = new GithubTool(createSession("/tmp/gh-enterprise-search"));

		await tool.execute("search-prs", { op: "search_prs", query: "is:open", limit: 1 });

		const args = (jsonSpy.mock.calls[0]?.[1] ?? []) as string[];
		// GitHub rejects `repo:host/owner/name`; the host belongs in --hostname.
		expect(args).toContain("q=is:open repo:acme/widgets is:pr");
		expect(args[args.indexOf("--hostname") + 1]).toBe("ghe.example.com");
	});

	it("run_watch keeps the host out of the run URL's repo path", async () => {
		const abort = new AbortController();
		const jsonSpy = vi.spyOn(git.github, "json").mockImplementation((async () => {
			abort.abort();
			return { id: 12, status: "queued" };
		}) as unknown as typeof git.github.json);
		const tool = new GithubTool(createSession("/tmp/gh-enterprise-run-watch"));

		await tool
			.execute(
				"run-watch",
				{ op: "run_watch", run: "https://ghe.example.com/acme/widgets/actions/runs/12" },
				abort.signal,
			)
			.catch(() => {});

		const args = (jsonSpy.mock.calls[0]?.[1] ?? []) as string[];
		expect(args).toContain("/repos/acme/widgets/actions/runs/12");
		expect(args[args.indexOf("--hostname") + 1]).toBe("ghe.example.com");
	});

	it("run_watch refuses to infer a commit for a bare repo that resolves elsewhere", async () => {
		// The bare `repo` goes to github.com (no GH_HOST), so the enterprise
		// checkout's HEAD says nothing about the runs being watched.
		vi.spyOn(git.github, "text").mockResolvedValue(`${ENTERPRISE_URL}\n`);
		const jsonSpy = vi.spyOn(git.github, "json");
		const tool = new GithubTool(createSession(`/tmp/gh-enterprise-mismatch-${Date.now()}`));

		await expect(tool.execute("run-watch", { op: "run_watch", repo: "acme/widgets" })).rejects.toThrow(
			"current checkout is ghe.example.com/acme/widgets",
		);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("run_watch accepts a bare repo when GH_HOST names the checkout's host", async () => {
		process.env.GH_HOST = "ghe.example.com";
		vi.spyOn(git.github, "text").mockResolvedValue(`${ENTERPRISE_URL}\n`);
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		vi.spyOn(git.head, "sha").mockResolvedValue("c215f3a91217c215f3a91217c215f3a91217c215");
		const abort = new AbortController();
		const jsonSpy = vi.spyOn(git.github, "json").mockImplementation((async () => {
			abort.abort();
			return { workflow_runs: [] };
		}) as unknown as typeof git.github.json);
		const tool = new GithubTool(createSession(`/tmp/gh-enterprise-ghhost-${Date.now()}`));

		await tool.execute("run-watch", { op: "run_watch", repo: "acme/widgets" }, abort.signal).catch(() => {});

		// Guard passed: the watch reached its first poll, and the caller's bare
		// repo is left host-less so `gh` applies the same GH_HOST.
		const args = (jsonSpy.mock.calls[0]?.[1] ?? []) as string[];
		expect(args).toContain("/repos/acme/widgets/actions/runs");
		expect(args).not.toContain("--hostname");
	});
});

describe("GitHub URL parsing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the host a full URL names so the request cannot drift to another instance", () => {
		expect(parsePullRequestUrl("https://ghe.example.com/acme/widgets/pull/7")).toEqual({
			repo: "ghe.example.com/acme/widgets",
			prNumber: 7,
		});
		// A host-less repo is resolved by `gh` against GH_HOST, so an explicit
		// github.com must survive parsing too.
		expect(parseIssueUrl("https://github.com/acme/widgets/issues/7")).toEqual({
			repo: "github.com/acme/widgets",
			issueNumber: 7,
		});
	});

	it("leaves the session checkout's github.com identity bare", () => {
		vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets\n");
		return expect(resolveDefaultRepoMemoized(`/tmp/gh-canonical-identity-${Date.now()}`)).resolves.toBe(
			"acme/widgets",
		);
	});
});
