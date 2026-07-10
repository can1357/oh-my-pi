import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(advisorActive: boolean, fastModeEnabled = false): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isFastModeEnabled: () => fastModeEnabled,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line model segment advisor badge", () => {
	it("appends a success-colored ++ badge when the advisor is active", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(rendered.content).toContain("Test Model");
		// The badge carries the success color, kept distinct from the statusLineModel
		// name color (which several themes alias to `accent`).
		expect(rendered.content).toContain(theme.fg("success", "++"));
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain("++");
	});
});

describe("status line model segment fast-mode indicator", () => {
	it("shows a bright bolt immediately after the model name when fast mode is on", () => {
		const rendered = renderSegment("model", createModelContext(false, true));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("warning", ` ${theme.icon.fast}`),
		);
	});

	it("shows a muted bolt immediately after the model name when fast mode is off", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("muted", ` ${theme.icon.fast}`),
		);
	});
});
