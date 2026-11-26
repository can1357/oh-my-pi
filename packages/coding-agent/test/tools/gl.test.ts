import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GitlabTool } from "@oh-my-pi/pi-coding-agent/tools/gl";
import { parseCanonicalGitlabProject } from "@oh-my-pi/pi-coding-agent/tools/gl-common";
import { mrLocalBranchName } from "@oh-my-pi/pi-coding-agent/tools/gl-mr-checkout";
import { toGitlabIsoDateBound } from "@oh-my-pi/pi-coding-agent/tools/gl-search";
import { resetDefaultGitlabProjectMemoForTests } from "@oh-my-pi/pi-coding-agent/tools/glab-mr";
import { getCached, putCached, resetForTests as resetGithubCache } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { gitlab } from "@oh-my-pi/pi-coding-agent/utils/gitlab";
import type { GlToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/gitlab";
import { removeWithRetries, spillFileName } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
	"GITLAB_HOST",
	"GITLAB_URI",
	"GITLAB_URL",
	"GL_HOST",
	"GLAB_CONFIG_DIR",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"XDG_CONFIG_HOME",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let tempDir: string;
let artifactsDir: string;

function createSession(
	cwd: string = tempDir,
	settings: Settings = Settings.isolated({ "gitlab.enabled": true }),
	withArtifacts: boolean = true,
): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => (withArtifacts ? artifactsDir : null),
		allocateOutputArtifact: withArtifacts
			? async () => {
					const artifactId = String(nextArtifactId++);
					return {
						id: artifactId,
						path: path.join(artifactsDir, spillFileName(artifactId)),
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
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

function spyGitlabJson(handler: (cwd: string, args: string[]) => Promise<unknown>) {
	return vi.spyOn(gitlab, "json").mockImplementation((cwd, args) => handler(cwd, args) as Promise<never>);
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gl-tool-test-"));
	artifactsDir = path.join(tempDir, "artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	process.env.GITLAB_TOKEN = "test-token";
	process.env.GITLAB_HOST = "gitlab.example.com";
	process.env.GLAB_CONFIG_DIR = tempDir;
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_TERMINAL_PROMPT = "0";
	process.env.GIT_ASKPASS = "true";
	resetGithubCache();
	resetDefaultGitlabProjectMemoForTests();
});

afterEach(async () => {
	resetGithubCache();
	resetDefaultGitlabProjectMemoForTests();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

describe("GitlabTool approval matrix & host trust", () => {
	it("classifies read-only vs mutating ops accurately", () => {
		const tool = new GitlabTool(createSession());
		const readOps = [
			"repo_view",
			"file_read",
			"issue_view",
			"mr_discussions",
			"search_mrs",
			"search_issues",
			"search_code",
			"search_commits",
			"search_projects",
			"pipeline_list",
			"pipeline_view",
			"pipeline_watch",
			"job_log",
		] as const;
		const execOps = [
			"mr_create",
			"mr_update",
			"mr_checkout",
			"mr_push",
			"mr_note",
			"mr_discussion_resolve",
			"job_retry",
			"ci_lint",
		] as const;

		for (const op of readOps) {
			expect(tool.approval({ op })).toBe("read");
		}
		for (const op of execOps) {
			expect(tool.approval({ op })).toBe("exec");
		}
	});

	it("blocks untrusted host when GITLAB_TOKEN is set across read, search, note, and pipeline ops", async () => {
		const jsonSpy = vi.spyOn(gitlab, "json").mockRejectedValue(new Error("no cwd repo"));
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue("");
		const tool = new GitlabTool(createSession());

		await expect(
			tool.execute("c1", { op: "file_read", repo: "untrusted.example/g/p", path: "README.md" }),
		).rejects.toThrow(/Refusing to send GitLab token environment variables to untrusted\.example/);

		await expect(tool.execute("c2", { op: "search_mrs", repo: "untrusted.example/g/p" })).rejects.toThrow(
			/Refusing to send GitLab token environment variables to untrusted\.example/,
		);

		await expect(
			tool.execute("c3", { op: "mr_note", repo: "untrusted.example/g/p", mr: "5", body: "hi" }),
		).rejects.toThrow(/Refusing to send GitLab token environment variables to untrusted\.example/);

		await expect(
			tool.execute("c4", { op: "pipeline_view", repo: "untrusted.example/g/p", pipeline: "10" }),
		).rejects.toThrow(/Refusing to send GitLab token environment variables to untrusted\.example/);

		// Only the cwd probe for defaultGitlabHost ran; no API calls hit untrusted.example.
		expect(textSpy).not.toHaveBeenCalled();
		for (const call of jsonSpy.mock.calls) {
			expect(call[1]).toEqual(["repo", "view", "-F", "json"]);
		}
	});
});

describe("GitlabTool file_read", () => {
	it("decodes UTF-8 files, detects binary files, falls back to directory tree on 404, and rejects leading /", async () => {
		const tool = new GitlabTool(createSession());
		await expect(
			tool.execute("f0", { op: "file_read", repo: "gitlab.example.com/acme/api", path: "/etc/passwd" }),
		).rejects.toThrow(/repository-relative/);

		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint.endsWith("/repository/files/README.md")) {
				return {
					file_name: "README.md",
					encoding: "base64",
					content: Buffer.from("Hello GitLab\n", "utf8").toString("base64"),
					ref: "main",
				};
			}
			if (endpoint.endsWith("/repository/files/blob.bin")) {
				return {
					file_name: "blob.bin",
					encoding: "base64",
					content: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString("base64"),
					ref: "main",
				};
			}
			if (endpoint.endsWith("/repository/files/src")) {
				throw new ToolError("404 File Not Found");
			}
			if (endpoint.endsWith("/repository/tree")) {
				return [
					{ name: "index.ts", type: "blob", path: "src/index.ts" },
					{ name: "utils", type: "tree", path: "src/utils" },
				];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const readme = await tool.execute("f1", {
			op: "file_read",
			repo: "gitlab.example.com/acme/api",
			path: "README.md",
		});
		expect(textOf(readme)).toBe("Hello GitLab\n");

		const binary = await tool.execute("f2", {
			op: "file_read",
			repo: "gitlab.example.com/acme/api",
			path: "blob.bin",
		});
		expect(textOf(binary)).toContain("Cannot read binary file 'blob.bin'");

		const dir = await tool.execute("f3", {
			op: "file_read",
			repo: "gitlab.example.com/acme/api",
			path: "src",
		});
		expect(textOf(dir)).toContain("# Directory src/ in gitlab.example.com/acme/api");
		expect(textOf(dir)).toContain("- [file] index.ts");
		expect(textOf(dir)).toContain("- [dir] utils/");

		// Dotted 2-segment group/project without host must use GITLAB_HOST, not gitlab.com.
		const dottedCalls: string[][] = [];
		spyGitlabJson(async (_cwd, args) => {
			dottedCalls.push(args);
			return {
				file_name: "README.md",
				encoding: "base64",
				content: Buffer.from("ok", "utf8").toString("base64"),
				ref: "HEAD",
			};
		});
		await tool.execute("f4", { op: "file_read", repo: "team.infra/api", path: "README.md" });
		expect(dottedCalls[0]).toContain("gitlab.example.com");
		expect(dottedCalls[0]).toContain("ref=HEAD");
	});
});
describe("GitlabTool mr_create & mr_update", () => {
	it("mr_create always passes --push=false --yes, writes multiline body via --description-file and cleans temp dir, and rejects fill+title", async () => {
		const tool = new GitlabTool(createSession());
		await expect(tool.execute("c0", { op: "mr_create", fill: true, title: "Conflict" })).rejects.toThrow(
			/mutually exclusive/,
		);

		let capturedArgs: string[] = [];
		let capturedBodyFilePath: string | undefined;
		let capturedBodyText: string | undefined;
		vi.spyOn(gitlab, "text").mockImplementation(async (_cwd, args) => {
			capturedArgs = [...args];
			const idx = args.indexOf("--description-file");
			if (idx >= 0) {
				capturedBodyFilePath = args[idx + 1];
				capturedBodyText = await Bun.file(capturedBodyFilePath!).text();
			}
			return "https://gitlab.example.com/acme/api/-/merge_requests/19\n";
		});
		vi.spyOn(gitlab, "json").mockResolvedValue({
			iid: 19,
			title: "Add feature",
			state: "opened",
			source_branch: "feat",
			target_branch: "main",
			web_url: "https://gitlab.example.com/acme/api/-/merge_requests/19",
		});

		const result = await tool.execute("c1", {
			op: "mr_create",
			repo: "gitlab.example.com/acme/api",
			title: "Add feature",
			body: "Line 1\n\nLine 2",
			sourceBranch: "feat",
			targetBranch: "main",
			draft: true,
			removeSourceBranch: true,
			squash: false,
			reviewer: ["bob"],
		});

		expect(capturedArgs).toContain("--push=false");
		expect(capturedArgs).toContain("--yes");
		expect(capturedArgs).toContain("--draft");
		expect(capturedArgs).toContain("--remove-source-branch=true");
		expect(capturedArgs).toContain("--squash-before-merge=false");
		expect(capturedBodyText).toBe("Line 1\n\nLine 2");
		expect(await fs.exists(path.dirname(capturedBodyFilePath!))).toBe(false);
		expect(textOf(result)).toContain("!19");
	});

	it("mr_update uses --draft/--ready and --description-file, explicit PUT for merge options, and invalidates MR cache", async () => {
		const tool = new GitlabTool(createSession());
		putCached({
			repo: "gitlab.example.com/acme/api",
			kind: "mr",
			number: 19,
			includeComments: true,
			payload: { state: "opened", mr: { iid: 19 } },
			rendered: "stale mr",
		});
		expect(getCached("gitlab.example.com/acme/api", "mr", 19, true)).not.toBeNull();

		let cliArgs: string[] = [];
		let putPayload: unknown;
		vi.spyOn(gitlab, "text").mockImplementation(async (_cwd, args) => {
			cliArgs = [...args];
			return "";
		});
		spyGitlabJson(async (_cwd, args) => {
			const inputIdx = args.indexOf("--input");
			if (inputIdx >= 0) {
				putPayload = await Bun.file(args[inputIdx + 1]!).json();
			}
			return {
				iid: 19,
				title: "Updated title",
				state: "opened",
				draft: false,
				remove_source_branch: true,
				squash: true,
				web_url: "https://gitlab.example.com/acme/api/-/merge_requests/19",
			};
		});

		const result = await tool.execute("u1", {
			op: "mr_update",
			repo: "gitlab.example.com/acme/api",
			mr: "19",
			draft: false,
			body: "Updated body",
			removeSourceBranch: true,
			squash: true,
		});

		expect(cliArgs).toContain("--ready");
		expect(cliArgs).toContain("--description-file");
		expect(putPayload).toEqual({ remove_source_branch: true, squash: true });
		expect(getCached("gitlab.example.com/acme/api", "mr", 19, true)).toBeNull();
		expect(textOf(result)).toContain("Updated Merge Request !19");
	});
});

describe("GitlabTool discussions & notes", () => {
	const discussions = [
		{
			id: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
			notes: [
				{
					id: 1,
					type: "DiffNote",
					body: "Fix edge case",
					author: { username: "bob" },
					system: false,
					resolvable: true,
					resolved: false,
					position: { new_path: "src/main.ts", new_line: 12 },
				},
			],
		},
		{
			id: "bbbb1111cccc2222dddd3333eeee4444ffff5555",
			notes: [
				{
					id: 2,
					type: "DiscussionNote",
					body: "Looks great",
					author: { username: "carol" },
					system: false,
					resolvable: true,
					resolved: true,
				},
			],
		},
		{
			id: "cccc1111dddd2222eeee3333ffff4444aaaa5555",
			notes: [{ id: 3, body: "merged commit", author: { username: "bot" }, system: true }],
		},
	];

	it("mr_discussions hides system notes by default and filters state, noteType, and path", async () => {
		vi.spyOn(gitlab, "json").mockResolvedValue(discussions);
		const tool = new GitlabTool(createSession());

		const allVisible = await tool.execute("d1", {
			op: "mr_discussions",
			repo: "gitlab.example.com/acme/api",
			mr: "7",
		});
		expect(textOf(allVisible)).toContain("1 unresolved, 1 resolved (2 shown)");
		expect(textOf(allVisible)).not.toContain("merged commit");

		const unresolvedDiff = await tool.execute("d2", {
			op: "mr_discussions",
			repo: "gitlab.example.com/acme/api",
			mr: "7",
			state: "unresolved",
			noteType: "diff",
			path: "src/main.ts",
		});
		expect(textOf(unresolvedDiff)).toContain("(1 shown)");
		expect(textOf(unresolvedDiff)).toContain("Fix edge case");
		expect(textOf(unresolvedDiff)).not.toContain("Looks great");
	});

	it("mr_note validates conflicting flags, expands >=8-char prefix, posts diff comments with diff_refs, and invalidates cache", async () => {
		const tool = new GitlabTool(createSession());
		await expect(
			tool.execute("n0", {
				op: "mr_note",
				repo: "gitlab.example.com/acme/api",
				mr: "7",
				body: "bad",
				discussionId: "aaaa1111",
				path: "a.ts",
			}),
		).rejects.toThrow(/cannot be combined/);
		await expect(
			tool.execute("n0b", {
				op: "mr_note",
				repo: "gitlab.example.com/acme/api",
				mr: "7",
				body: "secret",
				discussionId: "aaaa1111",
				internal: true,
			}),
		).rejects.toThrow(/cannot be combined/);
		await expect(
			tool.execute("n1", {
				op: "mr_note",
				repo: "gitlab.example.com/acme/api",
				mr: "7",
				body: "bad",
				line: 10,
			}),
		).rejects.toThrow(/path is required/);

		putCached({
			repo: "gitlab.example.com/acme/api",
			kind: "mr",
			number: 7,
			includeComments: true,
			payload: { state: "opened", mr: { iid: 7 } },
			rendered: "cached",
		});

		const postedPayloads: Array<{ endpoint: string; body: unknown }> = [];
		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			const inputIdx = args.indexOf("--input");
			if (inputIdx >= 0) {
				const json = await Bun.file(args[inputIdx + 1]!).json();
				postedPayloads.push({ endpoint, body: json });
				return { id: 99, notes: [{ id: 101 }] };
			}
			if (endpoint.endsWith("/discussions")) return discussions;
			if (endpoint.endsWith("/merge_requests/7")) {
				return {
					iid: 7,
					diff_refs: { base_sha: "b1", start_sha: "s1", head_sha: "h1" },
				};
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const reply = await tool.execute("n2", {
			op: "mr_note",
			repo: "gitlab.example.com/acme/api",
			mr: "7",
			discussionId: "aaaa1111",
			body: "Done!",
		});
		expect(postedPayloads[0]).toEqual({
			endpoint: "projects/acme%2Fapi/merge_requests/7/discussions/aaaa1111bbbb2222cccc3333dddd4444eeee5555/notes",
			body: { body: "Done!" },
		});
		expect(textOf(reply)).toContain("Replied to discussion");
		expect(getCached("gitlab.example.com/acme/api", "mr", 7, true)).toBeNull();

		const diffNote = await tool.execute("n3", {
			op: "mr_note",
			repo: "gitlab.example.com/acme/api",
			mr: "7",
			path: "src/main.ts",
			line: 15,
			body: "Nit here",
		});
		expect(postedPayloads[1]).toEqual({
			endpoint: "projects/acme%2Fapi/merge_requests/7/discussions",
			body: {
				body: "Nit here",
				position: {
					position_type: "text",
					base_sha: "b1",
					start_sha: "s1",
					head_sha: "h1",
					old_path: "src/main.ts",
					new_path: "src/main.ts",
					new_line: 15,
				},
			},
		});
		expect(textOf(diffNote)).toContain("Posted diff comment");
	});

	it("mr_discussion_resolve rejects ambiguous prefix and updates resolved state", async () => {
		const ambiguous = [
			{ id: "abcd123400000000000000000000000000000001", notes: [] },
			{ id: "abcd123400000000000000000000000000000002", notes: [] },
		];
		vi.spyOn(gitlab, "json").mockResolvedValue(ambiguous);
		const tool = new GitlabTool(createSession());

		await expect(
			tool.execute("r1", {
				op: "mr_discussion_resolve",
				repo: "gitlab.example.com/acme/api",
				mr: "7",
				discussionId: "abcd1234",
			}),
		).rejects.toThrow(/Ambiguous discussionId prefix/);
	});
});

describe("GitlabTool mr_checkout & mr_push", () => {
	it("creates an isolated worktree for fork MRs and rejects mr_push on non-checkout branches", async () => {
		const bareOrigin = path.join(tempDir, "origin.git");
		const bareFork = path.join(tempDir, "fork.git");
		const workRepo = path.join(tempDir, "work");
		runGit(tempDir, ["init", "--bare", bareOrigin]);
		runGit(tempDir, ["init", "--bare", bareFork]);
		runGit(tempDir, ["clone", bareOrigin, workRepo]);
		await Bun.write(path.join(workRepo, "README.md"), "init\n");
		runGit(workRepo, ["add", "."]);
		runGit(workRepo, ["commit", "-m", "initial"]);
		runGit(workRepo, ["branch", "-M", "main"]);
		runGit(workRepo, ["push", "-u", "origin", "main"]);

		const forkWork = path.join(tempDir, "fork-work");
		runGit(tempDir, ["clone", bareOrigin, forkWork]);
		runGit(forkWork, ["checkout", "-b", "feat/fork-mr"]);
		await Bun.write(path.join(forkWork, "feature.txt"), "fork change\n");
		runGit(forkWork, ["add", "."]);
		runGit(forkWork, ["commit", "-m", "fork commit"]);
		const forkSha = runGit(forkWork, ["rev-parse", "HEAD"]);
		runGit(forkWork, ["remote", "add", "fork", bareFork]);
		runGit(forkWork, ["push", "fork", "feat/fork-mr"]);

		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fapi/merge_requests/12") {
				return {
					iid: 12,
					title: "Fork MR",
					source_branch: "feat/fork-mr",
					target_branch: "main",
					sha: forkSha,
					source_project_id: 202,
					target_project_id: 101,
					allow_collaboration: true,
					web_url: "https://gitlab.example.com/acme/api/-/merge_requests/12",
				};
			}
			if (endpoint === "projects/202") {
				return {
					id: 202,
					path_with_namespace: "contrib/api",
					http_url_to_repo: bareFork,
					ssh_url_to_repo: bareFork,
				};
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const tool = new GitlabTool(createSession(workRepo));
		const checkout = await tool.execute("mc1", {
			op: "mr_checkout",
			repo: "gitlab.example.com/acme/api",
			mr: "12",
		});
		const details = checkout.details as GlToolDetails;
		expect(details.branch).toBe(mrLocalBranchName("gitlab.example.com/acme/api", 12));
		expect(details.worktreePath).toBeTruthy();
		expect(details.remote).toBe("fork-contrib");
		expect(await Bun.file(path.join(details.worktreePath!, "feature.txt")).text()).toBe("fork change\n");

		await expect(tool.execute("mp0", { op: "mr_push", ref: "main" })).rejects.toThrow(
			/has no MR push metadata; check it out via op: mr_checkout first/,
		);
	});
});

describe("GitlabTool CI pipelines & jobs", () => {
	it("prefers current branch open MR head pipeline over branch push pipeline", async () => {
		const repoDir = path.join(tempDir, "ci-repo");
		runGit(tempDir, ["init", repoDir]);
		await Bun.write(path.join(repoDir, "a.txt"), "a\n");
		runGit(repoDir, ["add", "."]);
		runGit(repoDir, ["commit", "-m", "init"]);
		runGit(repoDir, ["checkout", "-b", "feat/ci"]);

		spyGitlabJson(async (_cwd, args) => {
			if (args[0] === "repo" && args[1] === "view") {
				return { web_url: "https://gitlab.example.com/acme/api" };
			}
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fapi/merge_requests") {
				return [{ iid: 8, source_branch: "feat/ci", head_pipeline: { id: 505 } }];
			}
			if (endpoint === "projects/acme%2Fapi/pipelines/505") {
				return { id: 505, status: "success", ref: "refs/merge-requests/8/head", sha: "deadbeef1234" };
			}
			if (endpoint === "projects/acme%2Fapi/pipelines/505/jobs") {
				return [{ id: 901, name: "test", stage: "test", status: "success", duration: 12 }];
			}
			if (endpoint === "projects/acme%2Fapi/pipelines/505/bridges") {
				return [];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const tool = new GitlabTool(createSession(repoDir));
		const view = await tool.execute("pv1", { op: "pipeline_view" });
		expect((view.details as GlToolDetails).pipelineId).toBe(505);
		expect(textOf(view)).toContain("# Pipeline #505 [success]");
	});

	it("pipeline_watch ignores allow_failure jobs, fast-fails on real failure with grace refetch, strips GitLab ANSI sections, and saves artifact", async () => {
		mockSchedulerWaitWithClock();
		let poll = 0;
		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fapi/pipelines/700") {
				return {
					id: 700,
					status: "running",
					ref: "main",
					sha: "abcdef123456",
					web_url: "https://gitlab.example.com/acme/api/-/pipelines/700",
				};
			}
			if (endpoint === "projects/acme%2Fapi/pipelines/700/jobs") {
				poll += 1;
				if (poll === 1) {
					return [
						{ id: 1, name: "lint", stage: "lint", status: "failed", allow_failure: true },
						{ id: 2, name: "unit", stage: "test", status: "running", allow_failure: false },
					];
				}
				return [
					{ id: 1, name: "lint", stage: "lint", status: "failed", allow_failure: true },
					{
						id: 2,
						name: "unit",
						stage: "test",
						status: "failed",
						allow_failure: false,
						failure_reason: "script_failure",
					},
				];
			}
			if (endpoint === "projects/acme%2Fapi/pipelines/700/bridges") {
				return [];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});
		vi.spyOn(gitlab, "text").mockResolvedValue(
			"\u001b[0Ksection_start:1700000000:step_script\r\u001b[0K\u001b[32;1mRunning tests\u001b[0;m\nline1\nAssertionError: boom\n\u001b[0Ksection_end:1700000001:step_script\r\u001b[0K\n",
		);

		const updates: Array<GlToolDetails | undefined> = [];
		const tool = new GitlabTool(createSession());
		const result = await tool.execute(
			"pw1",
			{ op: "pipeline_watch", repo: "gitlab.example.com/acme/api", pipeline: "700", tail: 2 },
			undefined,
			update => {
				updates.push(update.details);
			},
		);

		const details = result.details as GlToolDetails;
		expect(details.failedJobs).toEqual(["unit"]);
		expect(details.artifactId).toBeDefined();
		expect(updates.length).toBeGreaterThanOrEqual(2);
		const body = textOf(result);
		expect(body).not.toContain("section_start");
		expect(body).not.toContain("\u001b[");
		expect(body).toContain("AssertionError: boom");
		expect(body).toContain("local://");
	});

	it("job_log lists available job names when requested job name does not exist in pipeline", async () => {
		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fapi/pipelines/700/jobs") {
				return [
					{ id: 10, name: "build", stage: "build" },
					{ id: 11, name: "test", stage: "test" },
				];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const tool = new GitlabTool(createSession());
		await expect(
			tool.execute("jl1", {
				op: "job_log",
				repo: "gitlab.example.com/acme/api",
				pipeline: "700",
				job: "deploy",
			}),
		).rejects.toThrow(/Available jobs: build, test/);
	});

	it("rejects conflicting repo vs resource URL, preserves single-label hosts, and rejects ambiguous source_branch MRs", async () => {
		const tool = new GitlabTool(createSession());
		await expect(
			tool.execute("cf1", {
				op: "mr_note",
				repo: "gitlab.example.com/acme/other",
				mr: "https://gitlab.example.com/acme/api/-/merge_requests/7",
				body: "hi",
			}),
		).rejects.toThrow(/Conflicting GitLab project targets/);

		expect(parseCanonicalGitlabProject("gitlab/acme/api")).toEqual({
			host: "gitlab",
			path: "acme/api",
			full: "gitlab/acme/api",
		});

		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			if (endpoint === "projects/acme%2Fapi/merge_requests") {
				return [
					{ iid: 10, state: "opened" },
					{ iid: 12, state: "opened" },
				];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});
		await expect(
			tool.execute("amb1", { op: "mr_update", repo: "gitlab.example.com/acme/api", mr: "main", title: "x" }),
		).rejects.toThrow(/Ambiguous merge request branch/);
	});

	it("resolves renamed file old_path/new_path from MR diffs in mr_note", async () => {
		const posted: unknown[] = [];
		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			const inputIdx = args.indexOf("--input");
			if (inputIdx >= 0) {
				posted.push(await Bun.file(args[inputIdx + 1]!).json());
				return { id: "d1", notes: [{ id: 55 }] };
			}
			if (endpoint === "projects/acme%2Fapi/merge_requests/7") {
				return { iid: 7, diff_refs: { base_sha: "b1", start_sha: "s1", head_sha: "h1" } };
			}
			if (endpoint === "projects/acme%2Fapi/merge_requests/7/diffs") {
				return [{ old_path: "src/old.ts", new_path: "src/new.ts" }];
			}
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const tool = new GitlabTool(createSession());
		await tool.execute("rn1", {
			op: "mr_note",
			repo: "gitlab.example.com/acme/api",
			mr: "7",
			path: "src/new.ts",
			line: 5,
			body: "renamed nit",
		});
		expect(posted[0]).toEqual({
			body: "renamed nit",
			position: {
				position_type: "text",
				base_sha: "b1",
				start_sha: "s1",
				head_sha: "h1",
				old_path: "src/old.ts",
				new_path: "src/new.ts",
				new_line: 5,
			},
		});
	});

	it("carries fork pipeline project_id, adopts auto-retried jobs during grace refetch, and surfaces bridge failures & truncated traces", async () => {
		mockSchedulerWaitWithClock();
		let poll = 0;
		const queriedEndpoints: string[] = [];
		spyGitlabJson(async (_cwd, args) => {
			const endpoint = args.find(arg => arg.startsWith("projects/")) ?? "";
			queriedEndpoints.push(endpoint);
			if (endpoint === "projects/acme%2Fapi/merge_requests/15") {
				return {
					iid: 15,
					source_branch: "fork-branch",
					source_project_id: 999,
					head_pipeline: { id: 888, project_id: 999 },
				};
			}
			if (endpoint === "projects/999/pipelines/888") {
				return { id: 888, status: poll >= 2 ? "success" : "running", ref: "fork-branch", sha: "1234567890ab" };
			}
			if (endpoint === "projects/999/pipelines/888/jobs") {
				poll += 1;
				if (poll === 1) return [{ id: 1, name: "test", stage: "test", status: "failed", allow_failure: false }];
				return [{ id: 2, name: "test", stage: "test", status: "success", allow_failure: false }];
			}
			if (endpoint === "projects/999/pipelines/888/bridges") return [];
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});

		const tool = new GitlabTool(createSession());
		const retried = await tool.execute("pw-retry", {
			op: "pipeline_watch",
			repo: "gitlab.example.com/acme/api",
			mr: "15",
		});
		expect((retried.details as GlToolDetails).status).toBe("success");
		expect((retried.details as GlToolDetails).failedJobs).toBeUndefined();
		expect(queriedEndpoints).toContain("projects/999/pipelines/888");

		spyGitlabJson(async () => ({ id: 44, name: "build", status: "failed" }));
		vi.spyOn(gitlab, "text").mockResolvedValue("line1\nline2\n[glab subprocess output truncated after 8 MiB]\n");
		const logRes = await tool.execute("jl-trunc", {
			op: "job_log",
			repo: "gitlab.example.com/acme/api",
			job: "44",
		});
		expect(textOf(logRes)).toContain("trace truncated after 8 MiB");
		expect(textOf(logRes)).toContain("Partial job log");
		const tailOne = await tool.execute("jl-tail1", {
			op: "job_log",
			repo: "gitlab.example.com/acme/api",
			job: "44",
			tail: 1,
		});
		expect(textOf(tailOne)).toContain("line2");
		await expect(
			tool.execute("jl-frac", {
				op: "job_log",
				repo: "gitlab.example.com/acme/api",
				job: "44",
				tail: 0.5,
			}),
		).rejects.toThrow(/tail must be a positive number/);
	});

	it("preserves relative date timestamps, passes assignee_username[], rejects multi-reviewer, and includes project_id in search_commits", async () => {
		const now = new Date("2026-06-15T18:30:00Z");
		expect(toGitlabIsoDateBound("12h", "start", now)).toBe("2026-06-15T06:30:00.000Z");
		expect(toGitlabIsoDateBound("2026-06-15", "end", now)).toBe("2026-06-15T23:59:59.999Z");
		expect(() => toGitlabIsoDateBound("2026-99-99", "start", now)).toThrow(/Invalid calendar date/);
		const tool = new GitlabTool(createSession());
		await expect(
			tool.execute("sr1", {
				op: "search_mrs",
				repo: "gitlab.example.com/acme/api",
				reviewer: ["alice", "bob"],
			}),
		).rejects.toThrow(/at most one reviewer/);

		let lastArgs: string[] = [];
		spyGitlabJson(async (_cwd, args) => {
			lastArgs = args;
			return [{ id: "abc123456789", title: "commit", project_id: 42 }];
		});
		await tool.execute("sa1", {
			op: "search_mrs",
			repo: "gitlab.example.com/acme/api",
			assignee: ["alice", "bob"],
		});
		expect(lastArgs).toContain("assignee_username[]=alice");
		expect(lastArgs).toContain("assignee_username[]=bob");

		const commits = await tool.execute("sc1", {
			op: "search_commits",
			group: "gitlab.example.com/acme",
			query: "fix",
		});
		expect(textOf(commits)).toContain("Project ID: 42");
	});
});
