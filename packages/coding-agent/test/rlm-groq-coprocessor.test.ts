/**
 * Groq semantic coprocessor P0 — EvidencePacket path, firewall, deterministic gates.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	deriveContextPolicy,
	emptyEvidencePacket,
	resetRlmStoresForTest,
	rlmEvidenceQuery,
	RlmRuntime,
	tryDeterministicEvidencePacket,
	workerContextContains,
} from "../src/rlm";
import { buildEvidenceWorkerRequest } from "../src/rlm/evidence-query";
import { selectGrantsFromSearch } from "../src/rlm/select-grants";
import type { EvidencePacketV2 } from "../src/rlm/evidence-packet-v2";

afterEach(() => {
	resetRlmStoresForTest();
});

const TAIL_NEEDLE = "CAUSAL_TAIL_EVIDENCE_9f3a";

function largeLogWithTailNeedle(prefixBytes = 20_000): string {
	return `${"x".repeat(prefixBytes)}\nERROR root_cause=${TAIL_NEEDLE} detail=disk_full\n${"y".repeat(2_000)}`;
}

describe("tokenomics policy arm D", () => {
	test("deriveContextPolicy selects groq arm when workerMode=evidence-packet", () => {
		expect(
			deriveContextPolicy({
				get: (p) =>
					p === "rlm.enabled"
						? true
						: p === "rlm.workerMode"
							? "evidence-packet"
							: undefined,
			}),
		).toBe("rlm-search-grants-groq");
	});
});

describe("evidence worker firewall", () => {
	test("worker messages exclude parent secret and include granted fact", async () => {
		const SECRET = "SECRET_PARENT_X91";
		const runtime = new RlmRuntime({ maxCalls: 8 });
		const rec = runtime.store.put(`prefix root_cause=${TAIL_NEEDLE} suffix`, "granted");
		const handle = rec.id;

		let capturedMessages: readonly { role: string; content: string }[] | undefined;
		const selection = selectGrantsFromSearch(runtime.store, handle, "root_cause=");
		const grant = selection.grants[0]!;
		const result = await rlmEvidenceQuery(runtime, {
			handle,
			question: "Summarize the ERROR block for disk failure diagnosis",
			patterns: "root_cause=",
			complete: async (_prompt, opts) => {
				capturedMessages = opts?.workerMessages;
				expect(opts?.purpose).toBe("rlm-evidence-packet");
				expect(opts?.workerMessages?.some(m => m.content.includes(SECRET))).toBe(false);
				expect(opts?.workerMessages?.some(m => m.content.includes(TAIL_NEEDLE))).toBe(true);
				const cite = { handle: `rlm://h/${handle}`, start: grant.start ?? 0, end: grant.end ?? 40 };
				const packet: EvidencePacketV2 = {
					status: "sufficient",
					atoms: [
						{
							id: "root_cause",
							key: "root_cause",
							value: TAIL_NEEDLE,
							citations: [{ handle: `rlm://h/${handle}`, start: 0, end: 40 }],
						},
					],
					claims: [
						{
							fact: TAIL_NEEDLE,
							supports: ["root_cause"],
							confidence: 1,
							citations: [{ handle: `rlm://h/${handle}`, start: 0, end: 40 }],
						},
					],
					contradictions: [],
					missingEvidence: [],
				};
				return { text: JSON.stringify(packet), structured: packet, tokens: 120, inputTokens: 900, outputTokens: 120 };
			},
		});

		expect(capturedMessages?.length).toBeGreaterThan(0);
		expect(result.packet?.status).toBe("sufficient");
		expect(result.text.includes(TAIL_NEEDLE)).toBe(true);
		expect(result.text.includes(SECRET)).toBe(false);
		expect(result.context).toBeDefined();
		expect(workerContextContains(result.context!, SECRET)).toBe(false);
		expect(workerContextContains(result.context!, TAIL_NEEDLE)).toBe(true);
	});
});

describe("deterministic gates", () => {
	test("zero search hits abstain locally without worker call", async () => {
		const runtime = new RlmRuntime({ maxCalls: 8 });
		const rec = runtime.store.put(largeLogWithTailNeedle());
		let workerCalls = 0;
		const result = await rlmEvidenceQuery(runtime, {
			handle: rec.id,
			question: "find missing",
			patterns: "NO_SUCH_PATTERN_XYZ",
			complete: async () => {
				workerCalls += 1;
				return { text: "should not run" };
			},
		});
		expect(workerCalls).toBe(0);
		expect(result.workerSkipped).toBe(true);
		expect(result.packet?.status).toBe("abstain");
		expect(runtime.store.metrics.workerCallsAvoided).toBeGreaterThan(0);
	});

	test("single obvious root_cause skips worker", () => {
		const runtime = new RlmRuntime({ maxCalls: 8 });
		const rec = runtime.store.put(largeLogWithTailNeedle());
		const selection = selectGrantsFromSearch(runtime.store, rec.id, "root_cause=");
		const packet = tryDeterministicEvidencePacket(selection, "What is root_cause?");
		expect(packet?.status).toBe("sufficient");
		expect(packet?.atoms[0]?.value).toBe(TAIL_NEEDLE);
	});
});

describe("prompt caching layout", () => {
	test("static system/schema precedes task and excerpts", async () => {
		const { resolveRlmView } = await import("../src/rlm/view");
		const runtime = new RlmRuntime({ maxCalls: 8 });
		const rec = runtime.store.put("FACT_A=1");
		const selection = selectGrantsFromSearch(runtime.store, rec.id, "FACT_A");
		const resolved = resolveRlmView(runtime.store, selection.grants);
		const ctx = buildEvidenceWorkerRequest({ task: "extract fact", view: resolved });
		const system = ctx.messages.find(m => m.role === "system")?.content ?? "";
		const user = ctx.messages.find(m => m.role === "user")?.content ?? "";
		expect(system.includes("EvidencePacketV2")).toBe(true);
		expect(system.includes("Schema")).toBe(true);
		expect(user.startsWith("Task:")).toBe(true);
		expect(system.length).toBeGreaterThan(user.length / 4);
	});
});
