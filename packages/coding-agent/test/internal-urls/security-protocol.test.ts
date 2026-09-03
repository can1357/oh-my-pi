import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter, SecurityProtocolHandler } from "../../src/internal-urls";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { importCodexSecurityBundle, importSarifFile, SecurityStore } from "../../src/security";

const FIXTURE_ROOT = path.join(import.meta.dir, "..", "fixtures", "security");
let temporaryRoot = "";
let repositoryRoot = "";
let store: SecurityStore;

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-protocol-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
	store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
	await store.putBundle(
		await importCodexSecurityBundle(path.join(FIXTURE_ROOT, "codex-security-completed"), {
			repositoryRoot,
			createScanId: () => "secscan_codexfixture",
		}),
	);
	await store.putBundle(
		await importSarifFile(path.join(FIXTURE_ROOT, "generic-results.sarif"), {
			repositoryRoot,
			createScanId: () => "secscan_sariffixture",
		}),
	);
	InternalUrlRouter.resetForTests();
	InternalUrlRouter.instance().register(
		new SecurityProtocolHandler(
			async () => store,
			() => true,
		),
	);
});

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("security://", () => {
	test("both producers render through every stable URI level", async () => {
		const router = InternalUrlRouter.instance();
		const expectations: Record<string, { contentType: "application/json" | "text/markdown"; marker: string }> = {
			"": { contentType: "text/markdown", marker: "# Security" },
			"/manifest": { contentType: "application/json", marker: `"id"` },
			"/findings": { contentType: "text/markdown", marker: "# Findings for" },
			"/coverage": { contentType: "application/json", marker: `"mode"` },
			"/report": { contentType: "text/markdown", marker: "#" },
			"/sarif": { contentType: "application/json", marker: `"version"` },
			"/provenance": { contentType: "application/json", marker: `"producer"` },
		};
		for (const scanId of ["secscan_codexfixture", "secscan_sariffixture"]) {
			for (const [suffix, expectation] of Object.entries(expectations)) {
				const resource = await router.resolve(`security://scans/${scanId}${suffix}`, { cwd: repositoryRoot });
				expect(resource.immutable).toBeTrue();
				expect(resource.contentType).toBe(expectation.contentType);
				const marker =
					suffix === "/report"
						? scanId === "secscan_codexfixture"
							? "# Codex Security"
							: "# Imported SARIF"
						: expectation.marker;
				expect(resource.content).toContain(marker);
			}
		}
	});

	test("finding detail renders and strips terminal control sequences", async () => {
		const bundle = await store.getBundle("secscan_sariffixture");
		const finding = bundle?.findings[0];
		expect(finding).toBeDefined();
		if (!finding) return;
		finding.title = "unsafe\u001b[31m title";
		await store.putBundle(bundle);
		const resource = await InternalUrlRouter.instance().resolve(
			`security://scans/secscan_sariffixture/findings/${finding.id}`,
			{ cwd: repositoryRoot },
		);
		expect(resource.content).not.toContain("\u001b");
	});

	test("write is rejected as read-only", async () => {
		await expect(
			InternalUrlRouter.instance().write("security://scans/secscan_codexfixture", "mutate", { cwd: repositoryRoot }),
		).rejects.toThrow("read-only");
	});

	test("completion includes scan resources", async () => {
		const completions = await InternalUrlRouter.instance().complete("security", "", { cwd: repositoryRoot });
		expect(completions?.some(item => item.value === "scans/secscan_codexfixture/findings")).toBeTrue();
		expect(completions?.some(item => item.value === "scans/secscan_sariffixture/findings")).toBeTrue();
	});

	test("session settings override the process-global feature gate", async () => {
		const enabledForSession = new SecurityProtocolHandler(
			async () => store,
			() => false,
		);
		const resource = await enabledForSession.resolve(parseInternalUrl("security://scans"), {
			cwd: repositoryRoot,
			settings: { get: () => true },
		});
		expect(resource.content).toContain("Security scans");

		const disabledForSession = new SecurityProtocolHandler(
			async () => store,
			() => true,
		);
		await expect(
			disabledForSession.resolve(parseInternalUrl("security://scans"), {
				cwd: repositoryRoot,
				settings: { get: () => false },
			}),
		).rejects.toThrow("disabled");
		expect(
			await disabledForSession.complete("", {
				cwd: repositoryRoot,
				settings: { get: () => false },
			}),
		).toEqual([]);
	});

	test("public resources recursively redact private account and token metadata", async () => {
		const bundle = await store.getBundle("secscan_codexfixture");
		if (!bundle) throw new Error("expected fixture bundle");
		bundle.scan.provenance.metadata = {
			operationId: "secop_public",
			nested: {
				accountId: "workspace-secret",
				token: "access-secret",
				children: [{ email: "person@example.invalid", safe: "visible" }],
			},
		};
		await store.putBundle(bundle);
		const resource = await InternalUrlRouter.instance().resolve("security://scans/secscan_codexfixture/provenance", {
			cwd: repositoryRoot,
		});
		expect(resource.content).toContain("secop_public");
		expect(resource.content).toContain("visible");
		expect(resource.content).not.toContain("workspace-secret");
		expect(resource.content).not.toContain("access-secret");
		expect(resource.content).not.toContain("person@example.invalid");
	});

	test("rejects surplus path segments instead of aliasing a canonical resource", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("security://scans/secscan_codexfixture/manifest/extra", {
				cwd: repositoryRoot,
			}),
		).rejects.toThrow("Unknown security resource");
		const bundle = await store.getBundle("secscan_sariffixture");
		const findingId = bundle?.findings[0]?.id;
		expect(findingId).toBeDefined();
		if (!findingId) return;
		await expect(
			InternalUrlRouter.instance().resolve(`security://scans/secscan_sariffixture/findings/${findingId}/extra`, {
				cwd: repositoryRoot,
			}),
		).rejects.toThrow("Unknown security resource");
	});

	test("completion filters candidates by the requested path fragment", async () => {
		const completions = await InternalUrlRouter.instance().complete("security", "sariffixture/coverage", {
			cwd: repositoryRoot,
		});
		expect(completions?.map(item => item.value)).toEqual(["scans/secscan_sariffixture/coverage"]);
	});

	test("large untrusted reports are bounded", async () => {
		const bundle = await store.getBundle("secscan_codexfixture");
		expect(bundle).not.toBeNull();
		if (!bundle) return;
		bundle.report = `${"line\n".repeat(10_000)}\u001b[31mTAIL`;
		await store.putBundle(bundle);
		const resource = await InternalUrlRouter.instance().resolve("security://scans/secscan_codexfixture/report", {
			cwd: repositoryRoot,
		});
		expect(Buffer.byteLength(resource.content)).toBeLessThanOrEqual(50 * 1024);
		expect(resource.content).not.toContain("\u001b");
		expect(resource.notes?.join(" ")).toContain("truncated");
	});
});
