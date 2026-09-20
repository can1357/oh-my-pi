/**
 * Whole-session RLM accounting — partition + no double-count gates.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRlmSessionAccounting,
	exportRlmExperimentRecord,
	formatRlmAccountingSummary,
	rlmQuery,
	RlmRuntime,
	RlmStore,
	resetRlmStoresForTest,
} from "../src/rlm";
import type { SessionEntry } from "../src/session/session-entries";
import type { Usage } from "@oh-my-pi/pi-ai";

afterEach(() => {
	resetRlmStoresForTest();
});

function usage(partial: Partial<Usage> & { input: number; output: number }): Usage {
	const input = partial.input;
	const output = partial.output;
	const cacheRead = partial.cacheRead ?? 0;
	const cacheWrite = partial.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: partial.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: partial.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: partial.cost?.total ?? 0 },
	};
}

function assistantEntry(id: string, parentId: string | null, u: Usage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "test",
			model: "m",
			usage: u,
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	};
}

function modelUsageEntry(id: string, parentId: string | null, purpose: string, u: Usage): SessionEntry {
	return {
		type: "model_usage",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		purpose,
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: u,
		stopReason: "stop",
	};
}

describe("partition: no double-count", () => {
	test("root assistant + rlm model_usage + sideOther sum to sessionRaw", () => {
		const rootU = usage({ input: 100, output: 20, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } });
		const rlmU = usage({ input: 40, output: 10, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } });
		const sideU = usage({ input: 5, output: 1, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } });
		const branch: SessionEntry[] = [
			assistantEntry("a1", null, rootU),
			modelUsageEntry("m1", "a1", "rlm", rlmU),
			modelUsageEntry("m2", "a1", "auto-thinking", sideU),
		];
		const sessionRaw = {
			input: 100 + 40 + 5,
			output: 20 + 10 + 1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 120 + 50 + 6,
			cost: 0.01 + 0.002 + 0.0001,
		};
		const a = buildRlmSessionAccounting({ branch, sessionRaw, sessionId: "s1" });
		expect(a.root.input).toBe(100);
		expect(a.root.requests).toBe(1);
		expect(a.rlm.input).toBe(40);
		expect(a.rlm.source).toBe("model_usage");
		expect(a.sideOther.input).toBe(5);
		expect(a.totalAttributable.input).toBe(145);
		expect(a.totalAttributable.total).toBe(176);
		expect(a.doubleCountCheck.ok).toBe(true);
		// Must not double-add rlm into root
		expect(a.root.total + a.rlm.total + a.sideOther.total).toBe(a.totalAttributable.total);
	});

	test("ledger-only rlm is NOT added twice when sessionRaw excludes it", () => {
		const rootU = usage({ input: 80, output: 10, totalTokens: 90 });
		const branch: SessionEntry[] = [assistantEntry("a1", null, rootU)];
		const runtime = new RlmRuntime({ maxCalls: 4, maxTotalTokens: 10000 });
		// Simulate one completed trajectory without model_usage
		runtime.records.push({
			leaseId: "lease:1",
			viewId: "view:1",
			operation: "query",
			depth: 0,
			grantedBytes: 100,
			inputTokens: 30,
			outputTokens: 5,
			totalTokens: 35,
			cost: 0.001,
			startedAt: Date.now(),
			completedAt: Date.now(),
			status: "completed",
			citations: [],
		});
		runtime.store.budget.calls = 1;
		runtime.store.budget.tokens = 35;
		runtime.store.budget.cost = 0.001;

		const a = buildRlmSessionAccounting({
			branch,
			runtime,
			sessionRaw: { input: 80, output: 10, total: 90, cost: 0 },
		});
		expect(a.root.total).toBe(90);
		expect(a.rlm.total).toBe(35);
		expect(a.rlm.source).toBe("ledger");
		expect(a.totalAttributable.total).toBe(125);
		expect(a.doubleCountCheck.ok).toBe(true);
		expect(a.doubleCountCheck.detail).toContain("ledger-only");
	});

	test("when both model_usage and ledger present, tokens come from model_usage only once", () => {
		const rlmU = usage({ input: 30, output: 5, totalTokens: 35 });
		const branch: SessionEntry[] = [modelUsageEntry("m1", null, "rlm", rlmU)];
		const runtime = new RlmRuntime({ maxCalls: 4 });
		runtime.records.push({
			leaseId: "lease:1",
			viewId: "v",
			operation: "query",
			depth: 0,
			grantedBytes: 10,
			inputTokens: 30,
			outputTokens: 5,
			totalTokens: 35,
			startedAt: 0,
			completedAt: 1,
			status: "completed",
			citations: [],
		});
		const a = buildRlmSessionAccounting({ branch, runtime });
		expect(a.rlm.source).toBe("mixed");
		expect(a.rlm.total).toBe(35); // not 70
		expect(a.totalAttributable.total).toBe(35);
	});
});

describe("ops + abstain path", () => {
	test("empty search abstain: zero worker calls, workerCallsAvoided++", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4, maxTotalTokens: 10000 });
		const rec = runtime.store.put("hello only");
		const result = await rlmQuery(runtime, {
			handle: rec.id,
			question: "secret?",
			patterns: "ABSENT_ZZ",
			complete: async () => ({ text: "nope", tokens: 99, inputTokens: 50, outputTokens: 49 }),
		});
		expect(result.failOpen).toBe(true);
		expect(runtime.store.budget.calls).toBe(0);
		expect(runtime.store.metrics.workerCallsAvoided).toBe(1);
		expect(runtime.records.length).toBe(0);

		const a = buildRlmSessionAccounting({ runtime, store: runtime.store });
		expect(a.ops.workerCallsAvoided).toBe(1);
		expect(a.ops.workerCalls).toBe(0);
		expect(a.rlm.requests).toBe(0);
		expect(a.rlm.total).toBe(0);
	});

	test("search-driven query records grantsSelected and ledger I/O", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4, maxTotalTokens: 100000 });
		const body = `${"x".repeat(12_000)}root_cause=CAUSAL_TAIL_EVIDENCE_9f3a\n`;
		const rec = runtime.store.put(body);
		await rlmQuery(runtime, {
			handle: rec.id,
			question: "cause?",
			patterns: "root_cause=",
			selectPolicy: { contextChars: 100, maxTotalBytes: 2048 },
			complete: async () => ({
				text: "CAUSAL_TAIL_EVIDENCE_9f3a",
				tokens: 40,
				inputTokens: 32,
				outputTokens: 8,
				cost: 0.001,
			}),
		});
		expect(runtime.store.metrics.grantsSelected).toBeGreaterThanOrEqual(1);
		expect(runtime.store.budget.calls).toBe(1);
		const a = buildRlmSessionAccounting({ runtime });
		expect(a.rlm.input).toBe(32);
		expect(a.rlm.output).toBe(8);
		expect(a.rlm.requests).toBe(1);
		expect(a.ops.queries).toBe(1);
		expect(a.ops.grantsSelected).toBeGreaterThanOrEqual(1);
	});
});

describe("export + summary", () => {
	test("export writes JSONL and snapshot", () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-acct-"));
		try {
			const a = buildRlmSessionAccounting({
				sessionId: "exp-test-1",
				branch: [assistantEntry("a1", null, usage({ input: 10, output: 2, totalTokens: 12 }))],
			});
			const paths = exportRlmExperimentRecord(a, { dir, filename: "test.jsonl" });
			const line = readFileSync(paths.jsonlPath, "utf8").trim();
			const parsed = JSON.parse(line);
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.root.input).toBe(10);
			expect(paths.snapshotPath).toBeTruthy();
			expect(formatRlmAccountingSummary(a)).toContain("root_in=10");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("A/B/C accounting path (deterministic)", () => {
	const TAIL = "CAUSAL_TAIL_EVIDENCE_9f3a";

	async function armB(corpus: string) {
		const runtime = new RlmRuntime({ maxCalls: 8, maxTotalTokens: 1_000_000 });
		const rec = runtime.store.put(corpus);
		await rlmQuery(runtime, rec.id, "What is root_cause?", async prompt => {
			const hit = prompt.includes(TAIL);
			return {
				text: hit ? TAIL : "UNKNOWN",
				tokens: Math.ceil(prompt.length / 4) + 8,
				inputTokens: Math.ceil(prompt.length / 4),
				outputTokens: 8,
			};
		});
		return buildRlmSessionAccounting({ runtime });
	}

	async function armC(corpus: string) {
		const runtime = new RlmRuntime({ maxCalls: 8, maxTotalTokens: 1_000_000 });
		const rec = runtime.store.put(corpus);
		await rlmQuery(runtime, {
			handle: rec.id,
			question: "What is root_cause?",
			patterns: "root_cause=",
			selectPolicy: { contextChars: 400, maxTotalBytes: 8192 },
			complete: async prompt => {
				const hit = prompt.includes(TAIL);
				return {
					text: hit ? TAIL : "UNKNOWN",
					tokens: Math.ceil(prompt.length / 4) + 8,
					inputTokens: Math.ceil(prompt.length / 4),
					outputTokens: 8,
				};
			},
		});
		return buildRlmSessionAccounting({ runtime });
	}

	test("fixed vs search: B misses evidence path still charges worker; C hits with smaller grant", async () => {
		const corpus = `${"x".repeat(25_000)}\nERROR root_cause=${TAIL}\n`;
		const b = await armB(corpus);
		const c = await armC(corpus);
		expect(b.ops.workerCalls).toBe(1);
		expect(c.ops.workerCalls).toBe(1);
		expect(c.ops.grantsSelected).toBeGreaterThanOrEqual(1);
		expect(c.rlm.total).toBeLessThan(b.rlm.total);
		// absent arm
		const runtime = new RlmRuntime({ maxCalls: 4 });
		runtime.store.put("noise only");
		await rlmQuery(runtime, {
			handle: "1",
			question: "gone?",
			patterns: "NEVER",
			complete: async () => ({ text: "x", tokens: 1 }),
		});
		const absent = buildRlmSessionAccounting({ runtime });
		expect(absent.ops.workerCalls).toBe(0);
		expect(absent.ops.workerCallsAvoided).toBe(1);
		expect(absent.rlm.total).toBe(0);
	});
});
