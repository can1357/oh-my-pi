import { describe, expect, it } from "bun:test";
import { visibleWidth } from "../src/index";
import type { NativeChild, NativeNode } from "../src/native/node";
import { getThemeByName } from "../src/theme";
import {
	githubToolRenderer,
	renderJobsSection,
	type GhRunJobSnapshot,
	type GhRunWatchRunDetails,
	type GhRunWatchViewDetails,
} from "../src/tools/github";
import type { RenderResultOptions } from "../src/tools/renderer";

const args = { op: "run_watch" };

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const found: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) found.push(child, ...nodes(child.c));
	}
	return found;
}

function watch(mode: "run" | "commit"): GhRunWatchViewDetails {
	const run: GhRunWatchRunDetails = {
		id: 77,
		workflowName: "CI",
		status: "in_progress",
		jobs: [
			{
				id: 321,
				name: "Build job",
				status: "in_progress",
				durationSeconds: 14,
				steps: [
					{ number: 3, name: "Prepare", status: "completed", conclusion: "success", durationSeconds: 1 },
					{
						number: 9,
						name: `Compile\twith \u001b]52;c;clipboardpayload\u0007 controls ${"界".repeat(30)}`,
						status: "in_progress",
						durationSeconds: 8,
					},
					{ number: 17, name: "Upload", status: "queued" },
				],
			},
			{
				id: 322,
				name: "Unit tests",
				status: "completed",
				conclusion: "failure",
				steps: [
					{ number: 2, name: "Run tests", status: "in_progress", conclusion: "cancelled", durationSeconds: 3 },
					{ number: 5, name: "Upload artifacts", status: "queued" },
				],
			},
		],
	};
	return mode === "run"
		? { mode, state: "watching", repo: "owner/repo", run }
		: { mode, state: "watching", repo: "owner/repo", headSha: "abcdef123456", runs: [run] };
}

function resultFor(watchData: GhRunWatchViewDetails) {
	return { content: [], details: { watch: watchData }, isError: false };
}

function options(expanded: boolean): RenderResultOptions {
	return { expanded, isPartial: false };
}

describe("GitHub run-watch renderer", () => {
	it("keeps collapsed progress compact and expands ordered, sanitized steps within the viewport", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		const runWatch = watch("run");
		const collapsedRows = githubToolRenderer
			.renderResult(resultFor(runWatch), options(false), theme, args)
			.render(42);
		const collapsed = Bun.stripANSI(collapsedRows.join("\n"));
		const collapsedRaw = collapsedRows.join("\n");

		expect(collapsed).toContain("2/3 #9 Compile");
		expect(collapsed).toContain("Ctrl+O");
		expect(collapsed).toContain("#2 Run tests · cancelled");
		expect(collapsed).not.toContain("#5 Upload artifacts");
		expect(collapsedRaw).not.toContain("clipboardpayload");
		expect(collapsed).not.toContain("\t");
		for (const row of collapsedRows.filter(row => /↳|#9|#2 Run tests/.test(Bun.stripANSI(row)))) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(42);
		}

		const expandedRows = githubToolRenderer.renderResult(resultFor(runWatch), options(true), theme, args).render(80);
		const expanded = Bun.stripANSI(expandedRows.join("\n"));
		const prepare = expanded.indexOf("#3 Prepare");
		const compile = expanded.indexOf("#9 Compile");
		const upload = expanded.indexOf("#17 Upload");
		expect(prepare).toBeGreaterThanOrEqual(0);
		expect(compile).toBeGreaterThan(prepare);
		expect(upload).toBeGreaterThan(compile);
		expect(expanded).toContain("in progress");
		expect(expanded).toContain("8s");
		expect(expanded).toContain("success");
		expect(expanded).toContain("queued");
		expect(expandedRows.join("\n")).not.toContain("clipboardpayload");
		for (const row of expandedRows.filter(row => /#(?:3|9|17|2|5) /.test(Bun.stripANSI(row)))) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(80);
		}
	});

	it("keeps semantic step identities across polls, follows outer expansion, and preserves legacy no-step views", () => {
		const firstWatch = watch("commit");
		const firstResult = resultFor(firstWatch);
		const firstView = githubToolRenderer.describeResult(firstResult, options(false), args);
		if (!firstView) throw new Error("expected a native watch view");
		const firstNodes = nodes(firstView.body);
		const firstJob = firstNodes.find(node => node.key === "job:321");
		expect(firstJob?.p).toMatchObject({ collapsible: true, collapsed: true });
		const firstSteps = firstNodes.filter(node => node.key?.startsWith("step:"));
		expect(firstSteps.map(node => node.key)).toEqual(["step:3", "step:9", "step:17", "step:2", "step:5"]);
		expect(firstSteps.find(node => node.key === "step:2")?.p).toMatchObject({ tone: "error" });
		const failedJob = firstNodes.find(node => node.key === "job:322");
		expect(failedJob?.p).toMatchObject({
			head: expect.arrayContaining([expect.objectContaining({ t: "#2 Run tests · cancelled · 1/2", s: "error" })]),
		});

		const updatedWatch = watch("commit");
		updatedWatch.pollCount = 2;
		updatedWatch.runs?.[0]?.jobs[0]?.steps?.splice(1, 1, {
			number: 9,
			name: "Compile",
			status: "completed",
			conclusion: "success",
			durationSeconds: 10,
		});
		const updatedResult = resultFor(updatedWatch);
		const updatedView = githubToolRenderer.describeResult(updatedResult, options(false), args);
		if (!updatedView) throw new Error("expected an updated native watch view");
		const updatedNodes = nodes(updatedView.body);
		expect(updatedNodes.filter(node => node.key?.startsWith("step:")).map(node => node.key)).toEqual(
			firstSteps.map(node => node.key),
		);
		const expandedView = githubToolRenderer.describeResult(updatedResult, options(true), args);
		if (!expandedView) throw new Error("expected an expanded native watch view");
		expect(nodes(expandedView.body).find(node => node.key === "job:321")?.p).toMatchObject({
			collapsible: true,
			collapsed: false,
		});

		const legacy: GhRunWatchViewDetails = {
			mode: "run",
			state: "completed",
			repo: "owner/repo",
			run: { id: 88, jobs: [{ id: 9, name: "Old saved job", conclusion: "success" }] },
		};
		const legacyView = githubToolRenderer.describeResult(resultFor(legacy), options(false), args);
		if (!legacyView) throw new Error("expected a legacy native view");
		const legacyNodes = nodes(legacyView.body);
		expect(
			legacyNodes.some(node => node.k === "list" && node.c?.some(child => "k" in child && child.key === "9")),
		).toBe(true);
		expect(legacyNodes.some(node => node.key?.startsWith("step:") || node.key?.startsWith("job:"))).toBe(false);

		// The model-facing text names only the step a failed job broke on; per-step rows stay in the UI.
		const markdownJobs: GhRunJobSnapshot[] = [
			{
				id: 5,
				name: "Checks",
				conclusion: "failure",
				steps: [
					{ number: 1, name: "Set up job", status: "completed", conclusion: "success" },
					{ number: 4, name: "Run checks\nwith controls", status: "completed", conclusion: "failure" },
					{ number: 5, name: "Upload", status: "completed", conclusion: "skipped" },
				],
			},
			{
				id: 6,
				name: "Lint",
				conclusion: "success",
				steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }],
			},
		];
		expect(renderJobsSection(markdownJobs)).toEqual([
			"## Jobs (2)",
			"",
			"- [failure] Checks",
			"  Failed step: #4 Run checks with controls",
			"- [success] Lint",
		]);
	});
});
