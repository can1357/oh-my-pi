import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(advisorActive: boolean): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running", yielded: false }] : [],
			}),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line stream segment", () => {
	it("renders the live viewer badge only while attached", () => {
		const ctx = createModelContext(false);
		ctx.stream = { viewers: 7 };
		expect(renderSegment("stream", ctx)).toEqual({
			content: theme.fg("thinkingHigh", "● LIVE 7"),
			visible: true,
		});
		ctx.stream = null;
		expect(renderSegment("stream", ctx)).toEqual({ content: "", visible: false });
	});
});

describe("status line model segment advisor badge", () => {
	it("appends a success-colored advisor symbol when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).toContain(theme.fg("success", ` ${theme.icon.advisor}`));
	});

	it("colors the badge by the worst roster status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("warning", ` ${theme.icon.advisor}`));
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "error", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("error", ` ${theme.icon.advisor}`));
	});
	it("closes the eye once every advisor has yielded its review", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [{ name: "default", status: "running", yielded: true }],
		});
		const rendered = renderSegment("model", ctx).content;
		expect(rendered).toContain(theme.fg("success", ` ${theme.icon.advisorClosed}`));
		// ASCII mode resolves both icons to `(adv)`, so absence is only provable
		// when the two tokens differ.
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisor);
		}
	});

	it("keeps the eye open while any advisor may still comment", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: true },
				{ name: "b", status: "running", yielded: false },
			],
		});
		const rendered = renderSegment("model", ctx).content;
		expect(rendered).toContain(theme.fg("success", ` ${theme.icon.advisor}`));
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisorClosed);
		}
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain(theme.icon.advisor);
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(rendered.content)).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(rendered.content)).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(rendered.content)).not.toContain(theme.sep.dot);
	});
});

describe("status line model segment retry fallback", () => {
	let dot: string;
	let modelPrefix: string;
	beforeAll(() => {
		dot = theme.sep.dot;
		modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
	});

	const opus = { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", thinking: true };
	const glm = { id: "glm-5", name: "GLM-5", provider: "zai", thinking: true };
	const glmServing = {
		selector: "zai/glm-5:medium",
		modelIdentity: "zai/glm-5",
		thinkingLevel: ThinkingLevel.Medium,
		isFallback: true,
	};

	function createFallbackContext(
		servingModel?: SegmentContext["session"]["servingModel"],
		model: object = opus,
		thinkingLevel: ThinkingLevel = ThinkingLevel.High,
	): SegmentContext {
		const base = createModelContext(false);
		return {
			...base,
			session: {
				...base.session,
				state: { model, thinkingLevel },
				servingModel,
			} as unknown as SegmentContext["session"],
		};
	}

	it("shows the serving fallback model, its level, and a warning marker", () => {
		const ctx = createFallbackContext(glmServing, glm, ThinkingLevel.Medium);
		const rendered = renderSegment("model", ctx).content;
		expect(Bun.stripANSI(rendered)).toBe(`${modelPrefix}glm-5${dot}${theme.thinking.medium}${dot}fallback`);
		expect(rendered).toContain(theme.fg("warning", `${dot}fallback`));
		const view = describeSegment("model", ctx);
		expect(view?.spans.map(s => s.t).join("")).toBe(`glm-5 · medium${dot}fallback`);
		expect(view?.spans.at(-1)).toEqual({ t: `${dot}fallback`, s: "warning" });
		expect(view?.tone).toBe("warning");
	});

	it("derives the fallback id from the selector when no identity was recorded", () => {
		const ctx = createFallbackContext(
			{ selector: "openrouter/z-ai/glm-4.7:high", isFallback: true },
			{ id: "z-ai/glm-4.7", name: "GLM 4.7", provider: "openrouter", thinking: true },
		);
		expect(describeSegment("model", ctx)?.spans[0]?.t).toBe("z-ai/glm-4.7");
	});

	it("shows the model the user switched to while the fallback attribution names another model", () => {
		const ctx = createFallbackContext(glmServing, opus, ThinkingLevel.High);
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toBe(
			`${modelPrefix}Opus 4.5${dot}${theme.thinking.high}`,
		);
		const view = describeSegment("model", ctx);
		expect(view?.spans.map(s => s.t).join("")).toBe("Opus 4.5 · high");
		expect(view?.tone).toBeUndefined();
	});

	it("shows a thinking level changed on the fallback before it serves again", () => {
		const ctx = createFallbackContext(glmServing, glm, ThinkingLevel.High);
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toBe(
			`${modelPrefix}glm-5${dot}${theme.thinking.high}${dot}fallback`,
		);
		expect(
			describeSegment("model", ctx)
				?.spans.map(s => s.t)
				.join(""),
		).toBe(`glm-5 · high${dot}fallback`);
	});

	it("keeps the requested model while the configured model serves", () => {
		const ctx = createFallbackContext({
			selector: "anthropic/claude-opus-4-5:high",
			modelIdentity: "anthropic/claude-opus-4-5",
			isFallback: false,
		});
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toBe(
			`${modelPrefix}Opus 4.5${dot}${theme.thinking.high}`,
		);
		expect(describeSegment("model", ctx)?.tone).toBeUndefined();
	});

	it("renders the requested model when the session reports no serving model", () => {
		const ctx = createFallbackContext();
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toBe(
			`${modelPrefix}Opus 4.5${dot}${theme.thinking.high}`,
		);
		expect(
			describeSegment("model", ctx)
				?.spans.map(s => s.t)
				.join(""),
		).toBe("Opus 4.5 · high");
	});
});
