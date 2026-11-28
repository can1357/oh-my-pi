import * as os from "node:os";
import { describe, expect, it } from "bun:test";
import type { GithubTerm } from "../../../src/ui/tools/github";
import { gitlabPresenter, gitlabTitle } from "../../../src/ui/tools/gitlab";

const idleState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: true };

describe("gitlabPresenter", () => {
	it("formats operation titles and extracts numeric IDs from pipeline/MR URLs in call subjects", () => {
		expect(gitlabTitle("mr_discussions")).toBe("GitLab MR Discussions");
		expect(gitlabTitle("ci_lint")).toBe("GitLab CI Lint");
		expect(gitlabTitle(undefined)).toBe("GitLab");

		const pipelineCall = gitlabPresenter.call!(
			{
				op: "pipeline_watch",
				pipeline: "https://gitlab.example.com/acme/api/-/pipelines/5570177",
			},
			idleState,
		)!;
		expect((pipelineCall.term as GithubTerm).subject).toBe("#5570177");
		expect((pipelineCall.term as GithubTerm).icon).toBe("tool.gl");
		expect((pipelineCall.term as GithubTerm).waitText).toBe("waiting for pipeline data...");

		const mrCall = gitlabPresenter.call!(
			{
				op: "pipeline_watch",
				mr: "https://gitlab.example.com/acme/api/-/merge_requests/42",
			},
			idleState,
		)!;
		expect((mrCall.term as GithubTerm).subject).toBe("!42");
	});

	it("sanitizes tabs and control characters in pipeline_watch failed logs and marks allowFailure jobs", () => {
		const view = gitlabPresenter.result!(
			{
				content: [],
				isError: false,
				details: {
					watch: {
						state: "completed",
						repo: "gitlab.example.com/acme/api",
						pipelineId: 700,
						status: "failed",
						ref: "feat/ci",
						headSha: "abcdef1234567890",
						jobs: [
							{ id: 1, name: "lint", stage: "lint", status: "failed", allowFailure: true, durationSeconds: 4 },
							{ id: 2, name: "unit", stage: "test", status: "failed", allowFailure: false, durationSeconds: 18 },
						],
						failedLogs: [
							{
								pipelineId: 700,
								jobId: 2,
								jobName: "unit",
								stage: "test",
								status: "failed",
								available: true,
								tail: "line 1\twith tab\u0007bell\nAssertionError:\tfailed",
							},
						],
					},
				},
			},
			idleState,
			{ op: "pipeline_watch" },
		)!;

		const term = view.term as GithubTerm;
		expect(term.icon).toBe("tool.gl");
		expect(term.runs?.[0]?.jobs[0]?.name).toContain("(allowed to fail)");
		expect(term.runs?.[0]?.jobs[0]?.state).toBe("pending");
		expect(term.runs?.[0]?.jobs[1]?.state).toBe("failure");
		const tailJoined = term.failedLogs?.[0]?.tail?.join("\n") ?? "";
		expect(tailJoined).not.toContain("\t");
		expect(tailJoined).not.toContain("\u0007");
		expect(tailJoined).toContain("AssertionError:");
	});

	it("handles markdown, empty, and error results with tool.gl icon", () => {
		const ok = gitlabPresenter.result!(
			{ content: [{ type: "text", text: "col1\tcol2" }], isError: false },
			idleState,
			{ op: "file_read", repo: "gitlab.example.com/acme/api", path: "README.md" },
		)!;
		expect((ok.term as GithubTerm).icon).toBe("tool.gl");
		expect((ok.term as GithubTerm).lines?.[0]).not.toContain("\t");

		const empty = gitlabPresenter.result!({ content: [], isError: false }, idleState, { op: "repo_view" })!;
		expect(empty.tone).toBe("warning");
		expect((empty.term as GithubTerm).empty).toBe("no output");

		const err = gitlabPresenter.result!(
			{ content: [{ type: "text", text: "403 Forbidden" }], isError: true },
			idleState,
			{ op: "repo_view" },
		)!;
		expect(err.tone).toBe("error");
		expect((err.term as GithubTerm).error).toBe("403 Forbidden");
	});

	it("shortens home-directory paths in errors and renders terminal outcome for 0-job completed watch", () => {
		const homePath = `${os.homedir()}/repo/.gitlab-ci.yml`;
		const err = gitlabPresenter.result!(
			{ content: [{ type: "text", text: `missing file: ${homePath}\u0007` }], isError: true },
			idleState,
			{ op: "ci_lint" },
		)!;
		const errTerm = err.term as GithubTerm;
		expect(errTerm.error).toContain("~/repo/.gitlab-ci.yml");
		expect(errTerm.error).not.toContain(os.homedir());
		expect(errTerm.error).not.toContain("\u0007");

		const noPipeline = gitlabPresenter.result!(
			{
				content: [{ type: "text", text: "No pipelines found for gitlab.example.com/acme/api after 90s." }],
				isError: false,
				details: {
					watch: {
						state: "completed",
						repo: "gitlab.example.com/acme/api",
						jobs: [],
					},
				},
			},
			idleState,
			{ op: "pipeline_watch" },
		)!;
		const noPipelineTerm = noPipeline.term as GithubTerm;
		expect(noPipelineTerm.runs).toBeUndefined();
		expect(noPipelineTerm.lines?.[0]).toContain("No pipelines found");
	});
});
