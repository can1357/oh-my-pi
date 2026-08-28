import { describe, expect, it } from "bun:test";

import {
	assessMinimality,
	assessSolutionSet,
	catalogFromCapabilities,
	catalogFromGraphNodes,
	type ExistingCapability,
	MINIMALITY_GATE_NAME,
	MINIMALITY_LADDER,
	type SolutionIntent,
	tokenize,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/solution-minimality";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

function intent(overrides: Partial<SolutionIntent> = {}): SolutionIntent {
	return { id: "i1", summary: "retry queue for failed webhook deliveries", ...overrides };
}

function capability(overrides: Partial<ExistingCapability> = {}): ExistingCapability {
	return { id: "c1", label: "WebhookRetryQueue", ...overrides };
}

describe("tokenize", () => {
	it("splits camelCase and drops stopwords and short tokens", () => {
		expect(tokenize("createRetryQueueFor the webhook")).toEqual(["retry", "queue", "webhook"]);
	});

	it("returns empty for empty input", () => {
		expect(tokenize("")).toEqual([]);
	});
});

describe("assessMinimality", () => {
	it("defaults to new with an empty catalog and asserts nothing", () => {
		const result = assessMinimality(intent(), { now: NOW });
		expect(result.rung).toBe("new");
		expect(result.redundant).toBe(false);
		expect(result.failedOpen).toBe(false);
		expect(result.matches).toEqual([]);
		expect(result.gate).toBe(MINIMALITY_GATE_NAME);
		expect(result.assessedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("recommends reuse when an equivalent capability covers the intent", () => {
		const catalog = catalogFromCapabilities([
			capability({ keywords: ["retry", "queue", "webhook", "failed", "deliveries"], pointer: "src/queue.ts" }),
		]);
		const result = assessMinimality(intent({ kind: "feature" }), { catalog, now: NOW });
		expect(result.rung).toBe("reuse");
		expect(result.redundant).toBe(true);
		expect(result.bestMatch?.capability.id).toBe("c1");
		expect(result.rationale).toContain("src/queue.ts");
	});

	it("recommends extend for partial overlap between thresholds", () => {
		const catalog = catalogFromCapabilities([capability({ label: "JobRunner", keywords: ["retry", "queue"] })]);
		const result = assessMinimality(intent(), { catalog, now: NOW });
		expect(result.rung).toBe("extend");
		expect(result.redundant).toBe(false);
	});

	it("does not flag fixes as redundant even on a reuse match", () => {
		const catalog = catalogFromCapabilities([
			capability({ keywords: ["retry", "queue", "webhook", "failed", "deliveries"] }),
		]);
		const result = assessMinimality(intent({ kind: "fix" }), { catalog, now: NOW });
		expect(result.rung).toBe("reuse");
		expect(result.redundant).toBe(false);
	});

	it("fails open to new when the catalog throws", () => {
		const catalog = {
			lookup: () => {
				throw new Error("boom");
			},
		};
		const result = assessMinimality(intent(), { catalog, now: NOW });
		expect(result.rung).toBe("new");
		expect(result.failedOpen).toBe(true);
		expect(result.confidence).toBe(0);
	});

	it("ranks matches strongest-first with stable id tie-breaking", () => {
		const catalog = catalogFromCapabilities([
			capability({ id: "b", label: "JobRunner", keywords: ["retry", "queue"] }),
			capability({ id: "a", label: "TaskRunner", keywords: ["retry", "queue"] }),
			capability({ id: "z", label: "HookRunner", keywords: ["retry", "queue", "webhook"] }),
		]);
		const result = assessMinimality(intent(), { catalog, now: NOW });
		expect(result.matches.map(m => m.capability.id)).toEqual(["z", "a", "b"]);
	});

	it("caps retained matches at maxMatches", () => {
		const catalog = catalogFromCapabilities(["a", "b", "c"].map(id => capability({ id, keywords: ["retry"] })));
		const result = assessMinimality(intent(), { catalog, maxMatches: 2, now: NOW });
		expect(result.matches).toHaveLength(2);
	});

	it("counts intent tokens for telemetry", () => {
		const result = assessMinimality(intent(), { now: NOW });
		expect(result.intentTokens).toBeGreaterThan(0);
	});
});

describe("assessSolutionSet", () => {
	it("summarizes rung counts across a batch", () => {
		const catalog = catalogFromCapabilities([
			capability({ keywords: ["retry", "queue", "webhook", "failed", "deliveries"] }),
		]);
		const report = assessSolutionSet(
			[intent({ id: "i1", kind: "feature" }), intent({ id: "i2", summary: "totally unrelated parser" })],
			{ catalog, now: NOW },
		);
		expect(report.summary.total).toBe(2);
		expect(report.summary.reuse).toBe(1);
		expect(report.summary.new).toBe(1);
		expect(report.summary.redundant).toBe(1);
		expect(report.failedOpen).toBe(false);
	});

	it("returns an empty summary for no intents", () => {
		const report = assessSolutionSet([], { now: NOW });
		expect(report.summary).toEqual({ total: 0, reuse: 0, extend: 0, new: 0, redundant: 0 });
	});
});

describe("catalogFromGraphNodes", () => {
	it("builds resolvable pointers and skips unlabeled nodes", () => {
		const catalog = catalogFromGraphNodes([
			{ id: "n1", label: "RetryQueue", source_file: "src/queue.ts", keywords: ["retry", "queue"] },
			{ id: "n2" },
		]);
		const found = catalog.lookup(intent());
		expect(found).toHaveLength(1);
		expect(found[0]?.pointer).toBe("graphify://src/queue.ts#n1");
	});

	it("falls back to a symbol pointer without a file", () => {
		const catalog = catalogFromGraphNodes([{ label: "RetryQueue", keywords: ["retry"] }]);
		expect(catalog.lookup(intent())[0]?.pointer).toBe("graphify://symbol/RetryQueue");
	});
});

describe("MINIMALITY_LADDER", () => {
	it("orders rungs least-invasive first", () => {
		expect(MINIMALITY_LADDER).toEqual(["reuse", "extend", "new"]);
	});
});
