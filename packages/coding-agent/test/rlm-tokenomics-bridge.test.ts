/**
 * OMP → Tokenomics bridge: no double-count, context economics, gold only with verifier.
 */
import { describe, expect, test } from "bun:test";
import { summarizeTrace, type TokenomicsEvent } from "@agent-tokenomics/core";
import {
	createTokenomicsBridge,
	deriveContextPolicy,
	OmpTokenomicsBridge,
} from "../src/rlm/tokenomics-bridge.ts";

function usage(input: number, output: number, extras?: Partial<{ cacheRead: number; total: number; cost: number }>) {
	return {
		input,
		output,
		cacheRead: extras?.cacheRead ?? 0,
		cacheWrite: 0,
		totalTokens: extras?.total ?? input + output + (extras?.cacheRead ?? 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: extras?.cost ?? 0 },
	};
}

describe("OmpTokenomicsBridge", () => {
	test("deriveContextPolicy native vs rlm-search-grants", () => {
		expect(deriveContextPolicy({ get: () => undefined })).toBe("native");
		expect(
			deriveContextPolicy({
				get: (p) => (p === "rlm.enabled" ? true : p === "context.engine" ? "rlm" : undefined),
			}),
		).toBe("rlm-search-grants");
	});

	test("stable session trace_id", () => {
		const a = createTokenomicsBridge({ sessionId: "sess-1", memoryOnly: true, contextPolicy: "native" });
		const b = createTokenomicsBridge({ sessionId: "sess-1", memoryOnly: true, contextPolicy: "native" });
		expect(a.traceId).toBe(b.traceId);
		expect(a.traceId).toHaveLength(32);
	});

	test("root + worker incremental; aggregate not double-counted", async () => {
		const bridge = new OmpTokenomicsBridge({
			sessionId: "trace-abc",
			memoryOnly: true,
			contextPolicy: "rlm-search-grants",
		});

		await bridge.emitModelCall({
			role: "root",
			provider: "openai",
			model: "gpt-test",
			usage: usage(1000, 200, { cost: 0.01 }),
		});
		await bridge.emitModelCall({
			role: "rlm_worker",
			provider: "openai",
			model: "gpt-test",
			usage: usage(300, 50, { cost: 0.002 }),
		});
		// session aggregate that already includes both — must not inflate totals
		await bridge.emitSessionAggregate({
			input: 1300,
			output: 250,
			totalTokens: 1550,
			cost: 0.012,
		});

		const summary = bridge.summary()!;
		expect(summary.root_tokens).toBe(1200);
		expect(summary.worker_tokens).toBe(350);
		expect(summary.total_tokens).toBe(1550);
		expect(summary.aggregate_reported_tokens).toBe(1550);
		expect(summary.reconciliation_delta).toBe(0);
		expect(summary.cost_usd).toBeCloseTo(0.012);
		// aggregate event present but not in incremental sum
		expect(bridge.events.filter((e) => e.usage?.attribution === "aggregate")).toHaveLength(1);
		expect(bridge.events.filter((e) => (e.usage?.attribution ?? "incremental") === "incremental")).toHaveLength(2);
	});

	test("context snapshot carries spill/grant/avoided counters", async () => {
		const bridge = new OmpTokenomicsBridge({
			sessionId: "ctx-1",
			memoryOnly: true,
			contextPolicy: "rlm-search-grants",
		});
		await bridge.emitContextSnapshot({
			spills: 2,
			bytesSpilled: 50_000,
			bytesReintroduced: 1800,
			searches: 3,
			queries: 1,
			grantsSelected: 2,
			workerCallsAvoided: 1,
			grantedBytes: 1800,
		});
		const ctx = bridge.events.find((e) => e.kind === "context");
		expect(ctx?.context?.policy).toBe("rlm-search-grants");
		expect(ctx?.context?.spilled_bytes).toBe(50_000);
		expect(ctx?.context?.granted_bytes).toBe(1800);
		expect(ctx?.context?.worker_calls_avoided).toBe(1);
		expect(ctx?.context?.retrieval_calls).toBe(3);
	});

	test("absent-evidence path: avoided worker, zero rlm model usage", async () => {
		const bridge = new OmpTokenomicsBridge({
			sessionId: "absent-1",
			memoryOnly: true,
			contextPolicy: "rlm-search-grants",
		});
		await bridge.emitModelCall({
			role: "root",
			usage: usage(800, 40),
		});
		// no worker call — only context with avoided
		await bridge.emitContextSnapshot({
			searches: 1,
			queries: 1,
			workerCallsAvoided: 1,
			workerCalls: 0,
			spills: 1,
			bytesSpilled: 20_000,
			grantedBytes: 0,
		});
		const s = bridge.summary()!;
		expect(s.worker_tokens).toBe(0);
		expect(s.root_tokens).toBe(840);
		expect(s.total_tokens).toBe(840);
		expect(bridge.events.some((e) => e.role === "rlm_worker" && e.kind === "llm")).toBe(false);
		expect(bridge.events.find((e) => e.kind === "context")?.context?.worker_calls_avoided).toBe(1);
	});

	test("gold outcome only with verification_source; turn_end is execution", async () => {
		const bridge = new OmpTokenomicsBridge({
			sessionId: "out-1",
			memoryOnly: true,
			contextPolicy: "native",
		});
		await bridge.emitModelCall({ role: "root", usage: usage(10, 5) });
		await bridge.emitOutcome({ executionCompleted: true });
		let s = bridge.summary()!;
		expect(s.outcome_tier).toBe("execution");
		expect(s.verified).toBe(false);

		await bridge.emitOutcome({ evidenceQuality: "SUPPORTED" });
		s = bridge.summary()!;
		expect(s.outcome_tier).toBe("gold");
		expect(s.verified).toBe(true);
	});

	test("deterministic full trace fixture", async () => {
		const bridge = new OmpTokenomicsBridge({
			sessionId: "fixture-full",
			memoryOnly: true,
			contextPolicy: "rlm-search-grants",
			experimentId: "rlm-abc",
			taskSnapshotId: "task-frozen-1",
		});

		// 1 root
		await bridge.emitModelCall({
			role: "root",
			provider: "test",
			model: "m",
			usage: usage(2000, 100, { cost: 0.02 }),
		});
		// 2 context spill/search/grant
		await bridge.emitContextSnapshot({
			spills: 1,
			bytesSpilled: 40_000,
			searches: 1,
			grantsSelected: 1,
			bytesReintroduced: 900,
			grantedBytes: 900,
			queries: 1,
			workerCalls: 1,
		});
		// 3 worker
		await bridge.emitModelCall({
			role: "rlm_worker",
			provider: "test",
			model: "m",
			usage: usage(400, 80, { cost: 0.004 }),
		});
		// 4 aggregate
		await bridge.emitSessionAggregate({
			input: 2400,
			output: 180,
			totalTokens: 2580,
			cost: 0.024,
		});
		// 5 verified
		await bridge.emitOutcome({ evidenceQuality: "SUPPORTED" });

		const events = [...bridge.events] as TokenomicsEvent[];
		const summary = summarizeTrace(events);

		expect(summary.total_tokens).toBe(2000 + 100 + 400 + 80);
		expect(summary.root_tokens).toBe(2100);
		expect(summary.worker_tokens).toBe(480);
		expect(summary.aggregate_reported_tokens).toBe(2580);
		expect(summary.reconciliation_delta).toBe(2580 - summary.total_tokens);
		expect(summary.outcome_tier).toBe("gold");
		expect(summary.verified).toBe(true);

		const ctx = events.find((e) => e.kind === "context")!;
		expect(ctx.context?.spilled_bytes).toBe(40_000);
		expect(ctx.context?.granted_bytes).toBe(900);

		// experiment metadata on events
		expect(events.every((e) => e.experiment?.arm_id === "C")).toBe(true);
		expect(events.every((e) => e.experiment?.treatment_hash)).toBe(true);
		expect(events.every((e) => e.trace_id === bridge.traceId)).toBe(true);

		const line = bridge.formatStatusLine();
		expect(line).toContain("root=2100");
		expect(line).toContain("rlm=480");
		expect(line).toContain("tier=gold");
	});

	test("OMP_TOKENOMICS=0 disables", () => {
		const prev = process.env.OMP_TOKENOMICS;
		process.env.OMP_TOKENOMICS = "0";
		try {
			const b = createTokenomicsBridge({ sessionId: "off", memoryOnly: true });
			expect(b.enabled).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.OMP_TOKENOMICS;
			else process.env.OMP_TOKENOMICS = prev;
		}
	});
});
