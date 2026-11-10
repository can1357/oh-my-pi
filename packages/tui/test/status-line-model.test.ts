import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
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

describe("status line model segment served-model badge", () => {
	function servedTurn(model: string, served?: string): Record<string, unknown> {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openrouter",
			model,
			...(served ? { upstreamModel: served } : {}),
		};
	}

	function createServedContext(selectedId: string, messages: Record<string, unknown>[]): SegmentContext {
		const ctx = createModelContext(false);
		const state = ctx.session.state as unknown as { model: { id: string }; messages: unknown[] };
		state.model.id = selectedId;
		state.messages = messages;
		return ctx;
	}

	it("names the served model when the host provably served different weights", () => {
		const rendered = renderSegment(
			"model",
			createServedContext("claude-opus-4-6", [servedTurn("claude-opus-4-6", "claude-opus-4-7")]),
		);
		expect(rendered.content).toContain(theme.fg("warning", `${theme.sep.dot}claude-opus-4-7`));
	});

	it("stays silent for an echo of the same model, including snapshots and prefixes", () => {
		const same = renderSegment(
			"model",
			createServedContext("claude-opus-4-6", [servedTurn("claude-opus-4-6", "claude-opus-4-6")]),
		);
		expect(same.content).not.toContain(theme.sep.dot);
		const canonical = renderSegment(
			"model",
			createServedContext("anthropic/claude-haiku-4.5", [
				servedTurn("anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001"),
			]),
		);
		expect(canonical.content).not.toContain(theme.sep.dot);
	});

	it("decides on the newest turn for the selected model, not an older one", () => {
		const recovered = renderSegment(
			"model",
			createServedContext("claude-opus-4-6", [
				servedTurn("claude-opus-4-6", "claude-opus-4-7"),
				servedTurn("claude-opus-4-6"),
			]),
		);
		expect(recovered.content).not.toContain(theme.sep.dot);
		const swapped = renderSegment(
			"model",
			createServedContext("claude-opus-4-6", [
				servedTurn("claude-opus-4-6"),
				servedTurn("claude-opus-4-6", "claude-opus-4-7"),
			]),
		);
		expect(swapped.content).toContain(theme.fg("warning", `${theme.sep.dot}claude-opus-4-7`));
	});

	it("ignores turns produced for other models", () => {
		const rendered = renderSegment(
			"model",
			createServedContext("claude-opus-4-6", [servedTurn("gpt-4o-mini", "gpt-4o")]),
		);
		expect(rendered.content).not.toContain(theme.sep.dot);
	});
});
