import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SecurityScanPlan } from "../../src/security";
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
});
