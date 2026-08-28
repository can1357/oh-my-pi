/**
 * Tests for memory-fabric scoping: deterministic hierarchical IDs, scope
 * filters, and record matching.
 */

import { describe, expect, it } from "bun:test";
import {
	buildScopingContext,
	createScopeFilter,
	describeScope,
	generateAgentId,
	generateBranchId,
	generateProjectId,
	generateScopedSessionId,
	generateTaskId,
	generateWorktreeId,
	matchesScope,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/scoping";

describe("scoping id generators", () => {
	it("derives deterministic project ids and normalizes path separators and trailing slashes", () => {
		const a = generateProjectId("/home/user/repo");
		expect(a).toBe(generateProjectId("/home/user/repo"));
		expect(a).toBe(generateProjectId("/home/user/repo/"));
		expect(a).toBe(generateProjectId("\\home\\user\\repo"));
		expect(a).toMatch(/^proj_[0-9a-f]{16}$/);
		expect(a).not.toBe(generateProjectId("/home/user/other"));
	});

	it("derives worktree ids with a 12-hex suffix", () => {
		const id = generateWorktreeId("/home/user/repo/.worktrees/wt1");
		expect(id).toMatch(/^wt_[0-9a-f]{12}$/);
		expect(id).toBe(generateWorktreeId("/home/user/repo/.worktrees/wt1/"));
	});

	it("gives distinct branch ids to branches that sanitize identically", () => {
		const slash = generateBranchId("feat/a-b");
		const underscore = generateBranchId("feat_a-b");
		expect(slash).not.toBe(underscore);
		expect(slash).toMatch(/^br_[0-9a-f]{8}_feat_a-b$/);
	});

	it("truncates the readable branch segment to 20 characters", () => {
		const id = generateBranchId("feature/very-long-branch-name-that-keeps-going");
		const readable = id.split("_").slice(2).join("_");
		expect(readable.length).toBeLessThanOrEqual(20);
	});

	it("namespaces task ids under a parent task", () => {
		const root = generateTaskId("build");
		const child = generateTaskId("build", "task_abc");
		expect(root).toMatch(/^task_[0-9a-f]{12}$/);
		expect(child).not.toBe(root);
		expect(generateTaskId("build", "task_abc")).toBe(child);
	});

	it("distinguishes agent ids by type", () => {
		expect(generateAgentId("worker")).toBe(generateAgentId("worker", "main"));
		expect(generateAgentId("worker", "sub")).not.toBe(generateAgentId("worker", "main"));
		expect(generateAgentId("worker")).toMatch(/^agent_[0-9a-f]{10}$/);
	});

	it("generates unique session ids with a time-ordered prefix", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const id = generateScopedSessionId();
			expect(id).toMatch(/^sess_[0-9a-z]+_[0-9a-f]{12}$/);
			seen.add(id);
		}
		expect(seen.size).toBe(200);
	});
});

describe("buildScopingContext", () => {
	it("fills defaults and omits optional ids that were not requested", () => {
		const context = buildScopingContext({ cwd: "/repo", branchName: "main" });
		expect(context.worktreeId).toBe("main");
		expect(context.projectId).toBe(generateProjectId("/repo"));
		expect(context.branchId).toBe(generateBranchId("main"));
		expect("taskId" in context).toBe(false);
		expect("agentId" in context).toBe(false);
		expect(context.sessionId.startsWith("sess_")).toBe(true);
	});

	it("honors explicit worktree, task, agent, and session inputs", () => {
		const context = buildScopingContext({
			cwd: "/repo",
			worktreePath: "/repo/.worktrees/wt1",
			branchName: "feat/x",
			taskName: "port",
			agentName: "guardian",
			agentType: "sub",
			sessionId: "sess_fixed",
		});
		expect(context.worktreeId).toBe(generateWorktreeId("/repo/.worktrees/wt1"));
		expect(context.taskId).toBe(generateTaskId("port"));
		expect(context.agentId).toBe(generateAgentId("guardian", "sub"));
		expect(context.sessionId).toBe("sess_fixed");
	});
});

describe("createScopeFilter", () => {
	it("throws instead of building a cross-project filter", () => {
		expect(() => createScopeFilter({})).toThrow(/projectId/);
	});

	it("copies only the fields that are present", () => {
		const filter = createScopeFilter({ projectId: "proj_1", branchId: "br_1" });
		expect(filter).toEqual({ projectId: "proj_1", branchId: "br_1" });
		expect("worktreeId" in filter).toBe(false);
	});
});

describe("matchesScope", () => {
	const record = {
		projectId: "proj_1",
		worktreeId: "wt_1",
		branchId: "br_1",
		taskId: "task_1",
		agentId: "agent_1",
		sessionId: "sess_1",
	};

	it("requires an exact project match", () => {
		expect(matchesScope(record, { projectId: "proj_1" })).toBe(true);
		expect(matchesScope(record, { projectId: "proj_2" })).toBe(false);
	});

	it("treats unset filter fields as wildcards and set fields as exact", () => {
		expect(matchesScope(record, { projectId: "proj_1", branchId: "br_1" })).toBe(true);
		expect(matchesScope(record, { projectId: "proj_1", branchId: "br_2" })).toBe(false);
		expect(matchesScope(record, { projectId: "proj_1", sessionId: "sess_2" })).toBe(false);
	});

	it("does not match a record missing a field the filter requires", () => {
		const bare = { projectId: "proj_1" };
		expect(matchesScope(bare, { projectId: "proj_1" })).toBe(true);
		expect(matchesScope(bare, { projectId: "proj_1", worktreeId: "wt_1" })).toBe(false);
	});
});

describe("describeScope", () => {
	it("renders only present fields in stable order", () => {
		expect(describeScope({ projectId: "proj_1", branchId: "br_1" })).toBe("project=proj_1, branch=br_1");
		expect(describeScope({})).toBe("");
	});
});
