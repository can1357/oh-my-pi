import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

interface CostCtxOptions {
	cost?: number;
	advisorCost?: number;
	unreportedSubagentCost?: number;
	onAdvisorSubscriptionProbe: () => void;
}

function costCtx(options: CostCtxOptions): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: options.cost ?? 0,
			tokensPerSecond: null,
		},
		unreportedSubagentCost: options.unreportedSubagentCost ?? 0,
		session: {
			state: { model: undefined },
			getAdvisorCost: () => options.advisorCost ?? 0,
			isAdvisorUsingSubscription: () => {
				options.onAdvisorSubscriptionProbe();
				return false;
			},
			modelRegistry: { isUsingOAuth: () => false },
		},
	} as unknown as SegmentContext;
}

describe("cost status-line segment", () => {
	// Regression for #10129: the advisor-subscription probe walks the full model
	// catalog (getAvailable() → hasAuth per provider → credential-file reads) when
	// no advisors are active. The status line re-renders at the animation cadence
	// while the agent works, so calling it every frame — for a value used only
	// when advisor spend exists — pinned 20-30% CPU on WSL.
	it("does not probe advisor subscription state when there is no advisor cost", () => {
		let probes = 0;
		const ctx = costCtx({ cost: 0.5, advisorCost: 0, onAdvisorSubscriptionProbe: () => probes++ });

		const rendered = renderSegment("cost", ctx);

		expect(probes).toBe(0);
		expect(stripVTControlCharacters(rendered.content)).toContain("$0.50");
	});

	it("still probes advisor subscription state exactly once when advisor cost is present", () => {
		let probes = 0;
		const ctx = costCtx({ cost: 0, advisorCost: 0.25, onAdvisorSubscriptionProbe: () => probes++ });

		const rendered = renderSegment("cost", ctx);

		expect(probes).toBe(1);
		expect(stripVTControlCharacters(rendered.content)).toContain("0.25");
	});

	it("renders unreported subagent cost as an additional labelled amount", () => {
		const ctx = costCtx({
			cost: 0.5,
			advisorCost: 0.25,
			unreportedSubagentCost: 0.4,
			onAdvisorSubscriptionProbe: () => {},
		});

		const rendered = stripVTControlCharacters(renderSegment("cost", ctx).content);

		expect(rendered).toContain("$0.50 + $0.40 (agents)");
		expect(rendered).toContain("$0.25");
		expect(rendered.indexOf("(agents)")).toBeLessThan(rendered.indexOf("$0.25"));
	});
});
