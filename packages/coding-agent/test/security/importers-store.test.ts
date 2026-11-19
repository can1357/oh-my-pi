import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { importCodexSecurityBundle, importSarif, importSarifFile, SecurityStore } from "../../src/security";

const FIXTURE_ROOT = path.join(import.meta.dir, "..", "fixtures", "security");
let temporaryRoot = "";
let repositoryRoot = "";

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-store-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
});

afterEach(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("security importers and store", () => {
	test("Codex and generic SARIF producers normalize into one store", async () => {
		const store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
		const codex = await importCodexSecurityBundle(path.join(FIXTURE_ROOT, "codex-security-completed"), {
			repositoryRoot,
			createScanId: () => "secscan_codexfixture",
			createdAt: "2026-07-29T00:00:00.000Z",
		});
		const sarif = await importSarifFile(path.join(FIXTURE_ROOT, "generic-results.sarif"), {
			repositoryRoot,
			createScanId: () => "secscan_sariffixture",
			createdAt: "2026-07-29T00:01:00.000Z",
		});
		await store.putBundle(codex);
		await store.putBundle(sarif);
		const scans = await store.listScans();
		expect(scans.map(scan => scan.id).sort()).toEqual(["secscan_codexfixture", "secscan_sariffixture"]);
		expect((await store.getBundle("secscan_codexfixture"))?.findings).toHaveLength(1);
		expect((await store.getBundle("secscan_sariffixture"))?.findings).toHaveLength(2);
		expect(codex.scan.producer.kind).toBe("codex-security-bundle");
		expect(sarif.scan.producer.kind).toBe("sarif-import");
	});

	test("rejects Codex bundle locations outside the selected repository", async () => {
		const bundleRoot = path.join(temporaryRoot, "codex-outside");
		await fs.mkdir(bundleRoot);
		await Promise.all([
			Bun.write(
				path.join(bundleRoot, "scan-manifest.json"),
				JSON.stringify({
					documentType: "codex-security.scan-manifest",
					schemaVersion: "1.0",
					scan: { id: "scan-outside", producer: { name: "fixture" }, status: "completed" },
				}),
			),
			Bun.write(
				path.join(bundleRoot, "findings.json"),
				JSON.stringify({
					documentType: "codex-security.findings",
					schemaVersion: "1.0",
					scanId: "scan-outside",
					findings: [
						{
							findingId: "finding-outside",
							ruleId: "path.traversal",
							locations: [{ path: "../outside.ts", startLine: 1 }],
						},
					],
				}),
			),
			Bun.write(
				path.join(bundleRoot, "coverage.json"),
				JSON.stringify({
					documentType: "codex-security.coverage",
					schemaVersion: "1.0",
					scanId: "scan-outside",
				}),
			),
		]);
		await expect(importCodexSecurityBundle(bundleRoot, { repositoryRoot })).rejects.toThrow(
			"locations must be repository-relative",
		);
	});

	test("resolves one canonical store for a nested repository cwd", async () => {
		const nestedCwd = path.join(repositoryRoot, "packages", "app");
		await fs.mkdir(nestedCwd, { recursive: true });
		const initialized = await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet().nothrow();
		if (initialized.exitCode !== 0) throw new Error("git init failed");
		const store = await SecurityStore.openForCwd(nestedCwd, { stateRoot: path.join(temporaryRoot, "state") });
		expect(store.repositoryRoot).toBe(await fs.realpath(repositoryRoot));
	});

	test("locationless SARIF keeps distinct results while deduplicating repeats", async () => {
		const input = {
			version: "2.1.0",
			runs: [
				{
					tool: { driver: { name: "Fixture scanner" } },
					results: [
						{ ruleId: "fixture.rule", message: { text: "first result" } },
						{ ruleId: "fixture.rule", message: { text: "second result" } },
						{ ruleId: "fixture.rule", message: { text: "second result" } },
					],
				},
			],
		};
		const bundle = await importSarif(input, {
			repositoryRoot,
			createScanId: () => "secscan_locationless",
		});
		expect(bundle.findings.map(finding => finding.summary)).toEqual(["first result", "second result"]);
		expect(new Set(bundle.findings.map(finding => finding.id)).size).toBe(2);
	});

	test("serializes concurrent index updates without losing scans", async () => {
		const store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
		const bundles = await Promise.all(
			["one", "two", "three"].map((suffix, index) =>
				importSarifFile(path.join(FIXTURE_ROOT, "generic-results.sarif"), {
					repositoryRoot,
					createScanId: () => `secscan_concurrent${suffix}`,
					createdAt: `2026-07-29T00:0${index}:00.000Z`,
				}),
			),
		);
		await Promise.all(bundles.map(bundle => store.putBundle(bundle)));
		expect((await store.listScans()).map(scan => scan.id).sort()).toEqual([
			"secscan_concurrentone",
			"secscan_concurrentthree",
			"secscan_concurrenttwo",
		]);
	});

	test("store files remain outside the repository and private", async () => {
		const stateRoot = path.join(temporaryRoot, "state");
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		expect(store.projectDirectory.startsWith(repositoryRoot)).toBeFalse();
		if (process.platform !== "win32") {
			const mode = (await fs.stat(store.projectDirectory)).mode & 0o777;
			expect(mode).toBe(0o700);
		}
	});
});
