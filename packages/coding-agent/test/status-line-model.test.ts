import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/**
 * `fastModeActive` is what the bolt reflects (fast mode applies to the next
 * request). `fastModeEnabled` is the broader "some tier is configured" flag —
 * they diverge for a scoped tier on a non-matching provider, which is the case
 * the bolt used to get wrong, so the two are settable independently here.
 */
function createModelContext(
	advisorActive: boolean,
	fastModeActive = false,
	fastModeEnabled = fastModeActive,
): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => fastModeActive,
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
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		activeRepo: null,
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

	it("mutes the bolt when a scoped tier is configured but does not apply to this model's provider", () => {
		// e.g. `openai-only` while an Anthropic model is selected: the tier is
		// configured (enabled) but resolves to no priority for this provider, so
		// fast mode is not applied and the bolt must not read as on.
		const rendered = renderSegment("model", createModelContext(false, false, true));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("muted", ` ${theme.icon.fast}`),
		);
		expect(rendered.content).not.toContain(theme.fg("warning", ` ${theme.icon.fast}`));
	});
});
