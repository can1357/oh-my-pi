import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GithubTool } from "../../src/tools/gh";
import {
	formatLocalStackView,
	formatStackList,
	formatStackMap,
	GH_STACK_MISSING,
	normalizeRestStack,
	resetGhStackAvailabilityForTests,
} from "../../src/tools/gh-stack";
import { github } from "../../src/utils/github";

function createSession(cwd: string = "/tmp/stack-test"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "github.enabled": true }),
	};
}

const restStack = {
	number: 7,
	url: "https://github.com/owner/example/stack/7",
	open: true,
	base: { ref: "main" },
	pull_requests: [
		{
			number: 10,
			state: "open",
			draft: false,
			merged_at: null,
			head: { ref: "auth-layer", sha: "aaa" },
		},
		{
			number: 11,
			state: "open",
			draft: true,
			merged_at: null,
			head: { ref: "api-routes", sha: "bbb" },
		},
		{
			number: 12,
			state: "closed",
			draft: false,
			merged_at: "2026-08-01T00:00:00Z",
			head: { ref: "frontend", sha: "ccc" },
		},
	],
};

afterEach(() => {
	resetGhStackAvailabilityForTests();
	vi.restoreAllMocks();
});

describe("normalizeRestStack", () => {
	it("drops payloads that are not a stack object", () => {
		expect(normalizeRestStack(null)).toBeUndefined();
		expect(normalizeRestStack([])).toBeUndefined();
		expect(normalizeRestStack({ title: "PR #77" })).toBeUndefined();
	});

	it("projects REST stack fields into the view model", () => {
		const stack = normalizeRestStack(restStack);
		expect(stack?.number).toBe(7);
		expect(stack?.base).toBe("main");
		expect(stack?.pullRequests.map(pr => pr.number)).toEqual([10, 11, 12]);
		expect(stack?.pullRequests[1]?.draft).toBe(true);
		expect(stack?.pullRequests[2]?.mergedAt).toBe("2026-08-01T00:00:00Z");
	});
});

describe("formatStackMap", () => {
	it("numbers layers from the trunk and marks the current PR", () => {
		const stack = normalizeRestStack(restStack);
		expect(stack).toBeDefined();
		const text = formatStackMap(stack!, "owner/example", 11).join("\n");
		expect(text).toContain("## Stack #7 (base: main, 3 PRs)");
		expect(text).toContain("1. pr://owner/example/10  auth-layer  open  ← bottom");
		expect(text).toContain("2. pr://owner/example/11  api-routes  draft  ← this");
		expect(text).toContain("3. pr://owner/example/12  frontend  merged  ← top");
	});
});

describe("formatStackList", () => {
	it("renders an empty-repo contract", () => {
		expect(formatStackList("owner/example", [])).toContain("No stacks.");
	});

	it("links each stack through stack://", () => {
		const stack = normalizeRestStack(restStack);
		const text = formatStackList("owner/example", [stack!]);
		expect(text).toContain("stack://owner/example/7");
		expect(text).toContain("auth-layer → frontend");
	});
});

describe("formatLocalStackView", () => {
	it("renders gh stack view --json bottom to top", () => {
		const text = formatLocalStackView(
			{
				trunk: "main",
				currentBranch: "api-routes",
				branches: [
					{ name: "auth-layer", isCurrent: false, pr: { number: 10, state: "OPEN" } },
					{ name: "api-routes", isCurrent: true, pr: { number: 11, state: "OPEN" } },
				],
			},
			"owner/example",
		);
		expect(text).toContain("# Local stack (trunk: main)");
		expect(text).toContain("1. auth-layer  pr://owner/example/10 OPEN  ← bottom");
		expect(text).toContain("2. api-routes  pr://owner/example/11 OPEN  (current)  ← top");
	});
});

describe("github stack op", () => {
	it("refuses stack init without a branch name instead of prompting", async () => {
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const tool = new GithubTool(createSession());
		await expect(tool.execute("stack-init", { op: "stack", command: "init" })).rejects.toThrow(
			/stack init requires at least one branch name/,
		);
	});

	it("passes --json to gh stack view", async () => {
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		vi.spyOn(github, "text").mockRejectedValue(new Error("no repo"));
		const jsonSpy = vi.spyOn(github, "json").mockResolvedValue({
			trunk: "main",
			currentBranch: "auth-layer",
			branches: [{ name: "auth-layer", isCurrent: true }],
		});
		const tool = new GithubTool(createSession());
		const result = await tool.execute("stack-view", { op: "stack", command: "view" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# Local stack (trunk: main)");
		expect(jsonSpy).toHaveBeenCalledWith("/tmp/stack-test", ["stack", "view", "--json"], undefined);
	});

	it("always submits with --auto", async () => {
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const textSpy = vi.spyOn(github, "text").mockResolvedValue("created https://github.com/owner/example/pull/10");
		const tool = new GithubTool(createSession());
		await tool.execute("stack-submit", { op: "stack", command: "submit" });
		expect(textSpy).toHaveBeenCalledWith("/tmp/stack-test", ["stack", "submit", "--auto"], undefined);
	});

	it("always merges with --yes", async () => {
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		const textSpy = vi.spyOn(github, "text").mockResolvedValue("merged");
		const tool = new GithubTool(createSession());
		await tool.execute("stack-merge", { op: "stack", command: "merge", stack: "7", mergeMethod: "squash" });
		expect(textSpy).toHaveBeenCalledWith("/tmp/stack-test", ["stack", "merge", "--yes", "--squash", "7"], undefined);
	});

	it("surfaces a missing gh-stack extension as an install hint", async () => {
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "unknown command" });
		const tool = new GithubTool(createSession());
		await expect(tool.execute("stack-push", { op: "stack", command: "push" })).rejects.toThrow(GH_STACK_MISSING);
	});

	it("treats stack view as a read and other stack commands as exec", () => {
		const tool = new GithubTool(createSession());
		expect(tool.approval({ op: "stack", command: "view" })).toBe("read");
		expect(tool.approval({ op: "stack", command: "submit" })).toBe("exec");
		expect(tool.approval({ op: "stack" })).toBe("exec");
	});
});
