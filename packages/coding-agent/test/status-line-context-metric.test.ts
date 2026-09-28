/**
 * Contract for `statusLine.contextMetric` (`percentage` | `tokens`).
 *
 * The setting swaps the context-usage label for used tokens on every surface:
 * the embedded border gauge (`── 45K ──── 200K ──`), the standalone
 * `context_pct` chip (`45K/200K`), and the footer stats line. The default
 * `percentage` must render byte-identically to the pre-change behavior;
 * threshold colors and gauge fill stay derived from the internal percentage.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { readStatusLineStartupData } from "@oh-my-pi/pi-tui/status-line/startup";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { FooterComponent } from "@oh-my-pi/pi-tui/status-line/footer";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StatusLineTestComponents } from "./helpers/status-line";

const statusLines = new StatusLineTestComponents();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
});

function makeSession(opts: { usage?: ContextUsage; contextWindow?: number }) {
	const contextWindow = opts.contextWindow ?? 200_000;
	const model = { id: "test-model", contextWindow };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "context-metric test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => opts.usage,
		get contextUsageRevision() {
			return 0;
		},
	} as unknown as AgentSession;
}

function plainBorder(component: StatusLineComponent, width: number): string {
	return component.getTopBorder(width).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

describe("statusLine.contextMetric status line surfaces", () => {
	it("default percentage keeps the percent gauge label and chip unchanged", () => {
		const session = makeSession({ usage: { tokens: 45_200, contextWindow: 200_000, percent: 22.6 } });
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
			contextLine: "embedded",
		});

		const plain = plainBorder(comp, 120);
		expect(plain).toContain("23%"); // gauge percent label (rounded)
		expect(plain).toContain("200K");
		expect(plain).not.toContain("45K");
	});

	it("tokens mode swaps the embedded gauge label for used tokens", () => {
		const session = makeSession({ usage: { tokens: 45_200, contextWindow: 200_000, percent: 22.6 } });
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
			contextLine: "embedded",
			contextMetric: "tokens",
		});

		const plain = plainBorder(comp, 120);
		expect(plain).toContain("45K");
		expect(plain).toContain("200K");
		expect(plain).not.toContain("%");
	});

	it("tokens mode chip shows used/window", () => {
		const session = makeSession({ usage: { tokens: 45_200, contextWindow: 200_000, percent: 22.6 } });
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			contextLine: "off",
			contextMetric: "tokens",
		});

		expect(plainBorder(comp, 80)).toContain("45K/200K");
	});

	it("tokens mode chip with an unknown window shows used/?", () => {
		const session = makeSession({
			usage: { tokens: 45_200, contextWindow: 0, percent: 0 },
			contextWindow: 0,
		});
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			contextLine: "off",
			contextMetric: "tokens",
		});

		expect(plainBorder(comp, 80)).toContain("45K/?");
	});

	it("percentage chip default keeps the one-decimal format", () => {
		const session = makeSession({ usage: { tokens: 45_200, contextWindow: 200_000, percent: 22.6 } });
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			contextLine: "off",
		});

		expect(plainBorder(comp, 80)).toContain("22.6%/200K");
	});

	it("embedded overflow keeps the error-color label past the window in tokens mode", () => {
		const session = makeSession({ usage: { tokens: 240_000, contextWindow: 200_000, percent: 120 } });
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
			contextLine: "embedded",
			contextMetric: "tokens",
		});

		const border = comp.getTopBorder(120);
		const plain = border.content.replaceAll(/\x1b\[[0-9;]*m/g, "");
		const windowIndex = plain.indexOf("200K");
		const usedIndex = plain.indexOf("240K");
		expect(windowIndex).toBeGreaterThanOrEqual(0);
		expect(usedIndex).toBeGreaterThan(windowIndex);
		expect(border.content).toContain(`${theme.getFgAnsi("error")}240K`);
	});

	it("the persisted startup snapshot accepts the metric and still rejects unknown values", () => {
		const snapshot = (contextMetric: string) => ({
			settings: { preset: "custom", contextMetric },
			gitEnabled: true,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: true,
			compactionBoundaries: null,
		});
		expect(readStatusLineStartupData(snapshot("tokens"))).toBeDefined();
		expect(readStatusLineStartupData(snapshot("percentage"))).toBeDefined();
		expect(readStatusLineStartupData(snapshot("lights"))).toBeUndefined();
	});
});

describe("FooterComponent context metric", () => {
	function makeFooterSession(): ConstructorParameters<typeof FooterComponent>[0] {
		return {
			state: { messages: [], model: undefined },
			messages: [],
			model: undefined,
			systemPrompt: [],
			agent: { state: { tools: [] } },
			skills: [],
			isStreaming: false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isFastModeActive: () => false,
			isFastModeEnabled: () => false,
			getGoalModeState: () => null,
			getContextUsage: () => ({ tokens: 45_200, contextWindow: 200_000, percent: 22.6 }),
			getAsyncJobSnapshot: () => ({ running: [] }),
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionName: () => "context-metric test",
				getEntries: () => [],
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
	}

	it("renders the percentage by default when the host has no metric", () => {
		const component = new FooterComponent(makeFooterSession(), { gitEnabled: () => false });
		try {
			const rendered = component.render(100).join("\n");
			expect(rendered).toContain("22.6%/200K");
		} finally {
			component.dispose();
		}
	});

	it("renders used tokens when the host provides getContextMetric", () => {
		const component = new FooterComponent(makeFooterSession(), {
			gitEnabled: () => false,
			getContextMetric: () => "tokens",
		});
		try {
			const rendered = component.render(100).join("\n");
			expect(rendered).toContain("45K/200K");
			expect(rendered).not.toContain("22.6%");
		} finally {
			component.dispose();
		}
	});
});
