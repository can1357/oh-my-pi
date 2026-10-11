import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "../../../../src/session/agent-session";
import { StatusLineTestComponents } from "../../../helpers/status-line";

// The cost assertions below care about how the two costs are rendered, not about
// terminal width. The status line also shows the cwd and git branch, so a long
// checkout path or branch name eats the budget and pushes the cost segment out
// at a realistic 120 columns. Render these two cases wide enough that the
// segment always fits, and let the width-sensitive behavior stay covered by the
// truncation tests that target it directly.
const WIDE_ENOUGH_FOR_COST_SEGMENT = 400;
const statusLines = new StatusLineTestComponents();

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
		advisorUsingSubscription = false,
		modelName,
		sessionName = "test-session",
	}: {
		cost?: number;
		advisorCost?: number;
		usingSubscription?: boolean;
		advisorUsingSubscription?: boolean;
		modelName?: string;
		sessionName?: string;
	} = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { name: modelName, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { name: modelName, contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => sessionName,
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isAdvisorUsingSubscription: () => advisorUsingSubscription,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterAll(() => {
	statusLines.dispose();
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage({
					role: "assistant",
					timestamp: 1,
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { offset: 1n, nested: { limit: 2n } },
						},
					],
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession, statusLineHost),
		);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});

	it("shows the context window without a percent while usage is unknown", () => {
		const session = makeSessionWithLastMessage(null);
		const known = statusLines.track(new StatusLineComponent(session as unknown as AgentSession, statusLineHost));
		const unknown = statusLines.track(
			new StatusLineComponent(
				{
					...session,
					getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: null }),
				} as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(Bun.stripANSI(known.getTopBorder(120).content)).toMatch(/\d%/);
		const border = Bun.stripANSI(unknown.getTopBorder(120).content);
		expect(border).toContain("128K");
		expect(border).not.toContain("%");
	});

	it("renders the compact context prefix", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage(null) as unknown as AgentSession,
			statusLineHost,
		);
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["context_pct"],
			rightSegments: [],
			contextLine: "off",
			segmentOptions: { context_pct: { compact: true } },
		});

		const rendered = Bun.stripANSI(statusLine.getTopBorder(80).content);
		expect(rendered).toContain("ctx:0.0%");
	});

	it("renders primary and advisor costs separately with subscription indicator in Unicode preset", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 $0.41");
	});

	it("renders advisor cost with subscription prefix when advisor is on subscription in Unicode preset", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
					advisorUsingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 0.41");
	});

	it("renders ASCII preset fallback with (adv) for advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const asciiTheme = await loadTheme("dark", { symbolPresetOverride: "ascii" });
		setThemeInstance(asciiTheme);
		try {
			const statusLine = statusLines.track(
				new StatusLineComponent(
					makeSessionWithLastMessage(null, false, {
						cost: 2.67,
						advisorCost: 0.41,
						usingSubscription: true,
						advisorUsingSubscription: true,
					}) as unknown as AgentSession,
					statusLineHost,
				),
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("S2.67 + 0.41 (adv)");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					usingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67");
		expect(stripped).not.toContain("(adv)");
	});

	it("renders Nerd Font symbols for subscription and advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const nerdTheme = await loadTheme("dark", { symbolPresetOverride: "nerd" });
		setThemeInstance(nerdTheme);
		try {
			const statusLine = statusLines.track(
				new StatusLineComponent(
					makeSessionWithLastMessage(null, false, {
						cost: 2.67,
						advisorCost: 0.41,
						usingSubscription: true,
						advisorUsingSubscription: true,
					}) as unknown as AgentSession,
					statusLineHost,
				),
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("\u{f067a} 2.67 + \uea70 0.41");
		} finally {
			setThemeInstance(baseTheme);
		}
	});
});
