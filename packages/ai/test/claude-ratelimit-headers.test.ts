import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseClaudeRateLimitHeaders } from "@oh-my-pi/pi-ai/usage/claude";

const NOW = 1_780_400_000_000;
const BROKER_OAUTH_HEADERS = {
	"anthropic-ratelimit-unified-5h-utilization": "0.02",
	"anthropic-ratelimit-unified-5h-reset": "1780405800",
	"anthropic-ratelimit-unified-5h-status": "allowed",
	"anthropic-ratelimit-unified-7d-utilization": "0.3",
	"anthropic-ratelimit-unified-7d-reset": "1780531200",
	"anthropic-ratelimit-unified-7d-status": "allowed",
	"anthropic-ratelimit-unified-7d_oi-utilization": "0.55",
	"anthropic-ratelimit-unified-7d_oi-reset": "1780617600",
	"anthropic-ratelimit-unified-7d_oi-status": "allowed",
} as const;

function requireReport(report: UsageReport | null): UsageReport {
	if (!report) throw new Error("expected Claude rate-limit headers to parse");
	return report;
}

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

describe("Claude rate-limit response headers", () => {
	it("parses shared and Fable-scoped unified windows from broker-backed OAuth headers", () => {
		const report = requireReport(parseClaudeRateLimitHeaders(BROKER_OAUTH_HEADERS, NOW));

		expect(report.provider).toBe("anthropic");
		expect(report.fetchedAt).toBe(NOW);
		expect(report.metadata?.source).toBe("ratelimit-headers");
		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"]);

		const fiveHour = requireLimit(report, "anthropic:5h");
		expect(fiveHour.label).toBe("Claude 5 Hour");
		expect(fiveHour.scope.provider).toBe("anthropic");
		expect(fiveHour.scope.windowId).toBe("5h");
		expect(fiveHour.scope.shared).toBe(true);
		expect(fiveHour.window?.label).toBe("5 Hour");
		expect(fiveHour.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(fiveHour.window?.resetsAt).toBe(1780405800 * 1000);
		expect(fiveHour.amount.used).toBe(2);
		expect(fiveHour.amount.usedFraction).toBeCloseTo(0.02);

		const sevenDay = requireLimit(report, "anthropic:7d");
		expect(sevenDay.label).toBe("Claude 7 Day");
		expect(sevenDay.scope.provider).toBe("anthropic");
		expect(sevenDay.scope.windowId).toBe("7d");
		expect(sevenDay.scope.shared).toBe(true);
		expect(sevenDay.scope.tier).toBeUndefined();
		expect(sevenDay.window?.label).toBe("7 Day");
		expect(sevenDay.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(sevenDay.window?.resetsAt).toBe(1780531200 * 1000);
		expect(sevenDay.amount.used).toBe(30);
		expect(sevenDay.amount.usedFraction).toBeCloseTo(0.3);

		const fable = requireLimit(report, "anthropic:7d:fable");
		expect(fable.label).toBe("Claude 7 Day (Fable)");
		expect(fable.scope.provider).toBe("anthropic");
		expect(fable.scope.windowId).toBe("7d");
		expect(fable.scope.tier).toBe("fable");
		expect(fable.scope.shared).toBeUndefined();
		expect(fable.window?.label).toBe("7 Day");
		expect(fable.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(fable.window?.resetsAt).toBe(1780617600 * 1000);
		expect(fable.amount.used).toBeCloseTo(55);
		expect(fable.amount.limit).toBe(100);
		expect(fable.amount.remaining).toBeCloseTo(45);
		expect(fable.amount.usedFraction).toBeCloseTo(0.55);
		expect(fable.amount.remainingFraction).toBeCloseTo(0.45);
		expect(fable.amount.unit).toBe("percent");
		expect(fable.status).toBe("ok");
	});

	it("maps live-style 7d_oi headers to the Fable weekly overage bucket without model context", () => {
		const report = requireReport(parseClaudeRateLimitHeaders(BROKER_OAUTH_HEADERS, NOW));

		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"]);
		expect(requireLimit(report, "anthropic:7d:fable").amount.used).toBeCloseTo(55);
	});

	it("parses a single available unified window", () => {
		const report = requireReport(
			parseClaudeRateLimitHeaders(
				{
					"anthropic-ratelimit-unified-5h-utilization": "0.25",
					"anthropic-ratelimit-unified-5h-reset": "1780405800",
				},
				NOW,
			),
		);

		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:5h"]);
		expect(report.limits[0]?.amount.used).toBe(25);
	});

	it("returns null when no unified utilization headers are present", () => {
		expect(parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, NOW)).toBeNull();
	});

	it("omits a window that has reset metadata without utilization", () => {
		const report = requireReport(
			parseClaudeRateLimitHeaders(
				{
					"anthropic-ratelimit-unified-5h-reset": "1780405800",
					"anthropic-ratelimit-unified-7d-utilization": "0.4",
					"anthropic-ratelimit-unified-7d-reset": "1780531200",
				},
				NOW,
			),
		);

		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:7d"]);
		expect(report.limits[0]?.amount.used).toBe(40);
	});
});
