/**
 * RLM Evidence Addressing experiment — deterministic gates.
 * Mechanism tests (planted needles) are labeled as such.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { RlmProtocolHandler } from "../src/internal-urls/rlm-protocol";
import {
	mergeRanges,
	parseGrantRanges,
	QUERY_SLICE,
	resetRlmStoresForTest,
	rlmQuery,
	RlmStore,
	selectGrantsFromSearch,
	workerContextContains,
} from "../src/rlm";

afterEach(() => {
	resetRlmStoresForTest();
	InternalUrlRouter.resetForTests();
});

const TAIL_NEEDLE = "CAUSAL_TAIL_EVIDENCE_9f3a";
const MID_NEEDLE = "CROSS_REGION_FACT_A_7b";
const MID_NEEDLE_B = "CROSS_REGION_FACT_B_7b";

function largeLogWithTailNeedle(prefixBytes = 20_000): string {
	return `${"x".repeat(prefixBytes)}\nERROR root_cause=${TAIL_NEEDLE} detail=disk_full\n${"y".repeat(2_000)}`;
}

function crossRegionCorpus(): string {
	return `${"a".repeat(15_000)}${MID_NEEDLE}${"b".repeat(15_000)}${MID_NEEDLE_B}${"c".repeat(5_000)}`;
}

describe("mechanism: grant selection from search", () => {
	test("selectGrantsFromSearch finds tail needle beyond first 8KiB", () => {
		const store = new RlmStore();
		const body = largeLogWithTailNeedle(20_000);
		const rec = store.put(body, "log");
		const handle = `rlm://h/${rec.id}`;
		const selected = selectGrantsFromSearch(store, handle, "root_cause=", {
			maxMatches: 2,
			contextChars: 200,
			maxTotalBytes: 4096,
		});
		expect(selected.empty).toBe(false);
		expect(selected.grants.length).toBeGreaterThan(0);
		const g = selected.grants[0]!;
		const slice = body.slice(g.start ?? 0, g.end ?? 0);
		expect(slice.includes(TAIL_NEEDLE)).toBe(true);
		expect(g.start! > QUERY_SLICE || (g.end ?? 0) > QUERY_SLICE).toBe(true);
		expect(selected.grantedBytes).toBeLessThanOrEqual(4096);
	});

	test("mergeRanges collapses overlaps", () => {
		expect(mergeRanges([
			{ start: 0, end: 100 },
			{ start: 80, end: 150 },
			{ start: 200, end: 250 },
		])).toEqual([
			{ start: 0, end: 150 },
			{ start: 200, end: 250 },
		]);
	});

	test("parseGrantRanges parses start:end list", () => {
		expect(parseGrantRanges("rlm://h/1", "10:20, 30:40")).toEqual([
			{ handle: "rlm://h/1", start: 10, end: 20 },
			{ handle: "rlm://h/1", start: 30, end: 40 },
		]);
	});

	test("hard total byte cap truncates", () => {
		const store = new RlmStore();
		const body = `${"N1_MARKER"}${"p".repeat(5000)}${"N2_MARKER"}${"q".repeat(5000)}`;
		const rec = store.put(body);
		const selected = selectGrantsFromSearch(store, rec.id, ["N1_MARKER", "N2_MARKER"], {
			maxMatches: 4,
			contextChars: 2000,
			maxTotalBytes: 1500,
		});
		expect(selected.truncated).toBe(true);
		expect(selected.grantedBytes).toBeLessThanOrEqual(1500);
	});
});

describe("mechanism: fixed grant vs search-driven query", () => {
	test("fixed default grant MISSES tail needle; search-driven finds it", async () => {
		const store = new RlmStore({ maxCalls: 8, maxTotalTokens: 100_000 });
		const body = largeLogWithTailNeedle(20_000);
		const rec = store.put(body);
		const handle = `rlm://h/${rec.id}`;

		let fixedPrompt = "";
		const fixed = await rlmQuery(store, handle, "What is root_cause?", async prompt => {
			fixedPrompt = prompt;
			return { text: "unknown", tokens: 10 };
		});
		expect(fixed.failOpen).toBeFalsy();
		expect(fixedPrompt.includes(TAIL_NEEDLE)).toBe(false);
		expect(workerContextContains(fixed.context!, TAIL_NEEDLE)).toBe(false);

		let searchPrompt = "";
		const searched = await rlmQuery(store, {
			handle,
			question: "What is root_cause?",
			patterns: "root_cause=",
			selectPolicy: { contextChars: 300, maxTotalBytes: 4096 },
			complete: async prompt => {
				searchPrompt = prompt;
				const m = /root_cause=([A-Za-z0-9_]+)/.exec(prompt);
				return { text: m?.[1] ?? "miss", tokens: 12 };
			},
		});
		expect(searched.failOpen).toBeFalsy();
		expect(searchPrompt.includes(TAIL_NEEDLE)).toBe(true);
		expect(searched.text).toBe(TAIL_NEEDLE);
		expect(searched.selection?.empty).toBe(false);
	});

	test("search-driven query abstains when pattern absent", async () => {
		const store = new RlmStore({ maxCalls: 4 });
		const rec = store.put("hello world only");
		const result = await rlmQuery(store, {
			handle: rec.id,
			question: "secret code?",
			patterns: "ABSENT_NEEDLE_ZZZ",
			complete: async () => ({ text: "should-not-run", tokens: 1 }),
		});
		expect(result.failOpen).toBe(true);
		expect(result.text.toLowerCase()).toContain("abstain");
		expect(result.selection?.empty).toBe(true);
		// No worker call reserved when empty selection.
		expect(store.budget.calls).toBe(0);
	});

	test("cross-region two patterns produce multi-grant view", async () => {
		const store = new RlmStore({ maxCalls: 4 });
		const body = crossRegionCorpus();
		const rec = store.put(body);
		const result = await rlmQuery(store, {
			handle: rec.id,
			question: "both facts?",
			patterns: [MID_NEEDLE, MID_NEEDLE_B],
			selectPolicy: { maxMatches: 4, contextChars: 100, maxTotalBytes: 8192 },
			complete: async (_p, opts) => {
				const msgs = opts?.workerMessages ?? [];
				const blob = msgs.map(m => m.content).join("\n");
				expect(blob.includes(MID_NEEDLE)).toBe(true);
				expect(blob.includes(MID_NEEDLE_B)).toBe(true);
				return { text: "both", tokens: 8 };
			},
		});
		expect(result.failOpen).toBeFalsy();
		expect((result.selection?.grants.length ?? 0) >= 1).toBe(true);
	});
});

describe("rlm:// protocol authority", () => {
	test("resolves only against caller store; unknown handle stays unknown", async () => {
		InternalUrlRouter.resetForTests();
		const router = InternalUrlRouter.instance();
		expect(router.canHandle("rlm://h/1")).toBe(true);

		const owner = new RlmStore();
		const rec = owner.put("secret-owner-body-UNIQUE");

		const ok = await router.resolve(`rlm://h/${rec.id}`, {
			getRlmStore: () => owner,
		});
		expect(ok.content.includes("secret-owner-body-UNIQUE")).toBe(true);
		expect(ok.immutable).toBe(true);

		// Empty peer store: same id string is still unknown (no cross-store bleed).
		const peerEmpty = new RlmStore();
		await expect(
			router.resolve(`rlm://h/${rec.id}`, { getRlmStore: () => peerEmpty }),
		).rejects.toThrow(/unknown rlm handle/);

		// Peer with its own id=1 gets peer bytes only — never owner's secret.
		const peer = new RlmStore();
		peer.put("peer-other-body");
		const peerRes = await router.resolve("rlm://h/1", { getRlmStore: () => peer });
		expect(peerRes.content).toBe("peer-other-body");
		expect(peerRes.content.includes("secret-owner-body-UNIQUE")).toBe(false);

		await expect(
			router.resolve("rlm://h/999", { getRlmStore: () => owner }),
		).rejects.toThrow(/unknown rlm handle/);

		await expect(router.resolve("rlm://h/1", {})).rejects.toThrow(/requires the calling session/);
	});

	test("handler is registered as RlmProtocolHandler", () => {
		const h = InternalUrlRouter.instance().getHandler("rlm");
		expect(h).toBeInstanceOf(RlmProtocolHandler);
	});
});


describe("personal-use metrics", () => {
	test("status exposes spill/reintro/query counters", async () => {
		const store = new RlmStore({ maxCalls: 4 });
		const body = largeLogWithTailNeedle(12_000);
		store.put(body);
		await rlmQuery(store, {
			handle: "1",
			question: "cause?",
			patterns: "root_cause=",
			complete: async () => ({ text: TAIL_NEEDLE, tokens: 5 }),
		});
		const s = store.status();
		expect(s).toContain("spills=1");
		expect(s).toContain("bytes_spilled=");
		expect(s).toContain("queries=1");
		expect(s).toContain("searches=");
		expect(store.metrics.bytesReintroduced).toBeGreaterThan(0);
		expect(store.metrics.queries).toBe(1);
	});
});
