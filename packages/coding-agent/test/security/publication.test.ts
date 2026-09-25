import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SecurityPublishParams, SecurityScanPlan } from "../../src/security";
import { createSecurityPublicationTool, SecurityStore } from "../../src/security";

let temporaryRoot = "";
let repositoryRoot = "";
let store: SecurityStore;
let plan: SecurityScanPlan;

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-publication-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
	store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
	plan = {
		documentType: "omp-security.scan-plan",
		schemaVersion: "1.0",
		id: "secplan_fixture",
		createdAt: "2026-07-29T00:00:00.000Z",
		repositoryRoot,
		target: {
			kind: "repository",
			repositoryRoot,
			displayName: "repo",
			revision: "a".repeat(40),
			includePaths: [],
			excludePaths: [],
			treeDigest: "fixture-tree",
		},
		knowledgeBases: [],
		output: { root: path.join(temporaryRoot, "output"), archiveExisting: false, existingState: "empty" },
		model: { provider: "openai-codex", modelId: "fixture" },
		account: { provider: "openai-codex", credentialId: 1, accountId: "fixture-workspace" },
		configFingerprint: "fixture-config",
		workflowFingerprint: "fixture-workflow",
		fingerprint: "fixture-plan",
	};
});

afterEach(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

type SecurityFindingInput = SecurityPublishParams["findings"][number];

function publishableFinding(
	overrides: Partial<SecurityFindingInput> & Pick<SecurityFindingInput, "rule_id" | "title" | "locations">,
): SecurityFindingInput {
	return {
		summary: "Fixture summary",
		severity: "high",
		confidence: "high",
		category: "fixture",
		...overrides,
	};
}

describe("security publication", () => {
	test("rejects absolute and traversing source locations", async () => {
		for (const invalidPath of ["../outside.ts", "/etc/passwd", "C:/Windows/System32/config"]) {
			const tool = createSecurityPublicationTool({
				plan,
				scanId: "secscan_fixture",
				store,
				startedAt: "2026-07-29T00:00:00.000Z",
			});
			await expect(
				tool.execute(
					"tool-call",
					{
						findings: [
							{
								rule_id: "fixture.rule",
								title: "Fixture finding",
								summary: "Fixture summary",
								severity: "high",
								confidence: "high",
								category: "fixture",
								locations: [{ path: invalidPath, start_line: 1 }],
							},
						],
						coverage: { completeness: "partial" },
						report: "# Fixture\n",
					},
					undefined,
					undefined,
					undefined as never,
				),
			).rejects.toThrow("repository-relative");
		}
	});

	test("creates an absent approved output directory and writes the complete bundle", async () => {
		const tool = createSecurityPublicationTool({
			plan,
			scanId: "secscan_output",
			store,
			startedAt: "2026-07-29T00:00:00.000Z",
		});
		await tool.execute(
			"publish",
			{
				findings: [],
				coverage: { completeness: "complete" },
				report: "# No findings\n",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect((await fs.stat(plan.output.root)).isDirectory()).toBeTrue();
		expect((await fs.stat(plan.output.root)).mode & 0o777).toBe(0o700);
		expect((await fs.readdir(plan.output.root)).sort()).toEqual([
			"findings.json",
			"provenance.json",
			"report.md",
			"results.sarif",
			"scan.json",
		]);
		const serializedScan = await Bun.file(path.join(plan.output.root, "scan.json")).text();
		expect(serializedScan).not.toContain("fixture-workspace");
		expect(serializedScan).not.toContain("credentialId");
		expect(JSON.parse(serializedScan)).not.toHaveProperty("plan");
	});

	test("allows only one publication while persistence is in flight", async () => {
		const putStarted = Promise.withResolvers<void>();
		const releasePut = Promise.withResolvers<void>();
		let putCalls = 0;
		const delayedStore = {
			projectKey: store.projectKey,
			putBundle: async () => {
				putCalls++;
				putStarted.resolve();
				await releasePut.promise;
			},
		} as unknown as SecurityStore;
		const tool = createSecurityPublicationTool({
			plan,
			scanId: "secscan_fixture",
			store: delayedStore,
			startedAt: "2026-07-29T00:00:00.000Z",
		});
		const params = {
			findings: [],
			coverage: { completeness: "complete" as const },
			report: "# Fixture\n",
		};
		const first = tool.execute("first", params, undefined, undefined, undefined as never);
		await putStarted.promise;
		await expect(tool.execute("second", params, undefined, undefined, undefined as never)).rejects.toThrow(
			"already been published",
		);
		expect(putCalls).toBe(1);
		releasePut.resolve();
		await first;
	});

	test("withholds findings whose cited locations cannot be resolved", async () => {
		await fs.writeFile(path.join(repositoryRoot, "real.ts"), "one\ntwo\nthree\n");
		const tool = createSecurityPublicationTool({
			plan,
			scanId: "secscan_grounding",
			store,
			startedAt: "2026-07-29T00:00:00.000Z",
		});
		const result = await tool.execute(
			"publish",
			{
				findings: [
					publishableFinding({
						rule_id: "grounded",
						title: "Cites a real location",
						locations: [{ path: "real.ts", start_line: 2 }],
					}),
					publishableFinding({
						rule_id: "ghost-file",
						title: "Cites a file that does not exist",
						locations: [{ path: "src/does-not-exist.ts", start_line: 42 }],
					}),
					publishableFinding({
						rule_id: "ghost-line",
						title: "Cites a line past end of file",
						locations: [{ path: "real.ts", start_line: 9999 }],
					}),
					publishableFinding({
						rule_id: "ghost-end-line",
						title: "Cites an end line past end of file",
						locations: [{ path: "real.ts", start_line: 1, end_line: 9999 }],
					}),
				],
				coverage: { completeness: "partial" },
				report: "# Grounding\n",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details?.findingCount).toBe(1);
		expect(result.details?.droppedFindings).toEqual([
			{
				ruleId: "ghost-file",
				title: "Cites a file that does not exist",
				path: "src/does-not-exist.ts",
				startLine: 42,
				reason: "path_absent",
			},
			{
				ruleId: "ghost-line",
				title: "Cites a line past end of file",
				path: "real.ts",
				startLine: 9999,
				reason: "line_out_of_range",
			},
			{
				ruleId: "ghost-end-line",
				title: "Cites an end line past end of file",
				path: "real.ts",
				startLine: 1,
				reason: "line_out_of_range",
			},
		]);
		const persisted = await Bun.file(path.join(plan.output.root, "findings.json")).text();
		expect(persisted).toContain("grounded");
		expect(persisted).not.toContain("does-not-exist.ts");
		expect(persisted).not.toContain("ghost-line");
		expect(persisted).not.toContain("ghost-end-line");
	});

	test("resolves cited locations against resolutionRoot when provided", async () => {
		// Simulates a ref_diff scan: the review session reads a detached worktree
		// whose tree differs from the live repository root.
		await fs.writeFile(path.join(repositoryRoot, "live-only.ts"), "one\ntwo\n");
		const worktreeRoot = path.join(temporaryRoot, "worktree");
		await fs.mkdir(worktreeRoot);
		await fs.writeFile(path.join(worktreeRoot, "worktree-only.ts"), "one\ntwo\nthree\n");
		const tool = createSecurityPublicationTool({
			plan,
			scanId: "secscan_worktree",
			store,
			startedAt: "2026-07-29T00:00:00.000Z",
			resolutionRoot: worktreeRoot,
		});
		const result = await tool.execute(
			"publish",
			{
				findings: [
					publishableFinding({
						rule_id: "worktree-grounded",
						title: "Exists only in the scanned worktree",
						locations: [{ path: "worktree-only.ts", start_line: 3 }],
					}),
					publishableFinding({
						rule_id: "live-only",
						title: "Exists only in the live tree",
						locations: [{ path: "live-only.ts", start_line: 1 }],
					}),
				],
				coverage: { completeness: "partial" },
				report: "# Worktree grounding\n",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details?.findingCount).toBe(1);
		expect(result.details?.droppedFindings).toEqual([
			{
				ruleId: "live-only",
				title: "Exists only in the live tree",
				path: "live-only.ts",
				startLine: 1,
				reason: "path_absent",
			},
		]);
		const persisted = await Bun.file(path.join(plan.output.root, "findings.json")).text();
		expect(persisted).toContain("worktree-grounded");
		expect(persisted).not.toContain("live-only.ts");
	});

	test("withholds findings whose evidence locations cannot be resolved", async () => {
		await fs.writeFile(path.join(repositoryRoot, "real.ts"), "one\ntwo\nthree\n");
		const tool = createSecurityPublicationTool({
			plan,
			scanId: "secscan_evidence",
			store,
			startedAt: "2026-07-29T00:00:00.000Z",
		});
		const result = await tool.execute(
			"publish",
			{
				findings: [
					publishableFinding({
						rule_id: "ghost-evidence",
						title: "Grounded location but ghost evidence citation",
						locations: [{ path: "real.ts", start_line: 1 }],
						evidence: [
							{
								label: "sink",
								explanation: "cites a missing file",
								location: { path: "missing-evidence.ts", start_line: 7 },
							},
						],
					}),
				],
				coverage: { completeness: "partial" },
				report: "# Evidence grounding\n",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details?.findingCount).toBe(0);
		expect(result.details?.droppedFindings).toEqual([
			{
				ruleId: "ghost-evidence",
				title: "Grounded location but ghost evidence citation",
				path: "missing-evidence.ts",
				startLine: 7,
				reason: "path_absent",
			},
		]);
	});
});
