import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ProjectMemoryStore,
	projectFingerprint,
	renderProjectMemory,
	validateMemoryCandidate,
	type MemoryCandidate,
} from "./project-memory";

let root = "";
const fp = "repo-test-fingerprint";
const candidate = (content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
	type: "TOOLING",
	content,
	source: "test evidence",
	scope: "PROJECT",
	confidence: 0.9,
	trust: "VERIFIED",
	relevance: 0.9,
	repositoryFingerprint: fp,
	verified: true,
	...overrides,
});

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("candidate filtering", () => {
	test("rejects session state", () => {
		expect(validateMemoryCandidate(candidate("editing checkout.ts", { scope: "SESSION" }))).toEqual({ accepted: false, reason: "session_scope" });
	});
	test("rejects secrets", () => {
		expect(validateMemoryCandidate(candidate("api_key=sk-1234567890123456"))).toEqual({ accepted: false, reason: "sensitive" });
	});
	test("rejects speculative observations", () => {
		expect(validateMemoryCandidate(candidate("Maybe the project uses Redis.", { trust: "OBSERVED", verified: false }))).toEqual({ accepted: false, reason: "speculative" });
	});
	test("requires trust for unverified content", () => {
		expect(validateMemoryCandidate(candidate("database is PostgreSQL", { trust: "UNVERIFIED", verified: false }))).toEqual({ accepted: false, reason: "insufficient_trust" });
	});
});

describe("store", () => {
	test("persists and reloads durable memory", async () => {
		const file = path.join(root, "project-memory.json");
		const first = new ProjectMemoryStore(file, root);
		await first.addCandidate(candidate("Tests use Vitest."));
		const second = new ProjectMemoryStore(file, root);
		expect((await second.list())).toHaveLength(1);
		expect((await second.list())[0]?.content).toBe("Tests use Vitest.");
	});

	test("deduplicates equivalent facts and promotes repeated observations", async () => {
		const store = new ProjectMemoryStore(path.join(root, "project-memory.json"), root);
		const observed = candidate("Tests use Vitest.", { trust: "OBSERVED", verified: false });
		await store.addCandidate(observed);
		const result = await store.addCandidate(observed);
		expect(result.action).toBe("deduplicated");
		expect((await store.list())[0]?.trust).toBe("VERIFIED");
		expect((await store.list())[0]?.evidenceCount).toBe(2);
	});

	test("verified contradiction invalidates the old fact", async () => {
		const store = new ProjectMemoryStore(path.join(root, "project-memory.json"), root);
		await store.addCandidate(candidate("Tests use Jest."));
		const result = await store.addCandidate(candidate("Tests use Vitest."));
		expect(result.action).toBe("invalidated");
		const items = await store.list();
		expect(items.filter(item => !item.invalidatedAt)).toHaveLength(1);
		expect(items.find(item => !item.invalidatedAt)?.content).toBe("Tests use Vitest.");
	});

	test("retrieves only trusted, relevant memory within a token budget", async () => {
		const store = new ProjectMemoryStore(path.join(root, "project-memory.json"), root);
		await store.addCandidate(candidate("Tests use Vitest."));
		await store.addCandidate(candidate("Payments use Stripe.", { type: "ARCHITECTURE" }));
		await store.addCandidate(candidate("The current task is editing checkout.ts.", { type: "WORKFLOW", trust: "UNVERIFIED", verified: false }));
		const result = await store.query("fix the Vitest authentication tests", fp, { limit: 2, budgetTokens: 80 });
		expect(result.items.map(item => item.content)).toContain("Tests use Vitest.");
		expect(result.items.map(item => item.content)).not.toContain("The current task is editing checkout.ts.");
		expect(result.telemetry.memoryContextTokens).toBeLessThanOrEqual(80);
	});

	test("bounds total entries deterministically", async () => {
		const store = new ProjectMemoryStore(path.join(root, "project-memory.json"), root, { maxItems: 3, maxItemsPerCategory: 3 });
		for (const text of ["Project uses Bun.", "Project uses pnpm.", "Project uses npm.", "Project uses yarn."]) await store.addCandidate(candidate(text));
		expect((await store.list())).toHaveLength(3);
	});

	test("corrupt storage degrades to an empty store without throwing", async () => {
		const file = path.join(root, "project-memory.json");
		await fs.writeFile(file, "not-json", "utf8");
		const store = new ProjectMemoryStore(file, root);
		expect(await store.list()).toEqual([]);
	});

	test("renders compact model-facing memory", async () => {
		const items = await (async () => {
			const store = new ProjectMemoryStore(path.join(root, "project-memory.json"), root);
			await store.addCandidate(candidate("Tests use Vitest."));
			return store.list();
		})();
		const rendered = renderProjectMemory(items);
		expect(rendered).toContain("[Project Memory]");
		expect(rendered).toContain("Tests use Vitest. [verified]");
	});

	test("fingerprint is stable for the same repository location", async () => {
		expect(await projectFingerprint(root)).toBe(await projectFingerprint(root));
	});
});
