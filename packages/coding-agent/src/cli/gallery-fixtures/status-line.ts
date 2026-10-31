/**
 * Gallery fixtures for the status line, rendered through the real
 * `StatusLineComponent` against fake sessions.
 *
 * `context_gauge`: the box top border that bridges the segment groups, at four
 * usage levels mapped from the gallery lifecycle states; `error` shows the
 * >100% overflow case (usage anchored to a larger window than the active
 * model's, e.g. after switching to a smaller model mid-session), where the
 * gauge clamps to full while the context_pct segment reports the raw percent.
 *
 * `prompt_cache`: the bar's cached/not cached `cache` chip beside the cost, followed by
 * the details rows as `/session` lists them, for each cache lifecycle.
 */
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { promptCacheDetails, StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "../../modes/status-line-host";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "../../session/agent-session";
import { createGallerySession, GALLERY_PROMPT_CACHE } from "./preview-session";
import type { GalleryFixture, GalleryFixtureState } from "./types";

const GAUGE_WINDOW = 200_000;

/** Simulated usage per gallery lifecycle state, against {@link GAUGE_WINDOW}. */
const GAUGE_CASES: Record<GalleryFixtureState, { tokens: number; note: string }> = {
	streaming: { tokens: 6_000, note: "3% used — fresh session" },
	progress: { tokens: 124_000, note: "62% used — warning zone" },
	success: { tokens: 194_000, note: "97% used — past compaction threshold" },
	error: { tokens: 240_000, note: "120% used — overflow: percent breaks past the window label in red" },
};

/** Minimal session double satisfying every query `getTopBorder` makes. */
function fakeGaugeSession(tokens: number): AgentSession {
	const model = { id: "test-model", contextWindow: GAUGE_WINDOW };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: undefined,
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
				cost: 0,
			}),
			getSessionName: () => "gallery",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => ({ tokens, contextWindow: GAUGE_WINDOW, percent: (tokens / GAUGE_WINDOW) * 100 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** Render one contextLine variant of the top border for the given usage. */
function renderGaugeVariant(tokens: number, contextLine: "annotated" | "embedded", width: number): string {
	const component = new StatusLineComponent(fakeGaugeSession(tokens), statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: contextLine === "embedded" ? ["model", "context_pct"] : ["model"],
		rightSegments: contextLine === "embedded" ? ["session_name"] : ["context_pct"],
		separator: "powerline-thin",
		sessionAccent: false,
		contextLine,
	});
	try {
		return component.getTopBorder(width).content;
	} finally {
		component.dispose();
	}
}

function renderContextGaugeState(state: GalleryFixtureState, width: number): readonly string[] {
	const { tokens, note } = GAUGE_CASES[state];
	return [
		theme.fg("dim", `  ${note}`),
		renderGaugeVariant(tokens, "annotated", width),
		renderGaugeVariant(tokens, "embedded", width),
	];
}

/** Prompt-cache lifecycle per gallery state; `error` shows both reasons it is not cached. */
const PROMPT_CACHE_CASES: Record<GalleryFixtureState, readonly { status: PromptCacheStatus; note: string }[]> = {
	streaming: [{ status: GALLERY_PROMPT_CACHE.warm, note: "cached — omp refreshes it before the 5m tier lapses" }],
	progress: [{ status: GALLERY_PROMPT_CACHE.likelyWarm, note: "likely cached — read off a reopened session" }],
	success: [{ status: GALLERY_PROMPT_CACHE.refreshing, note: "cached — 1h tier, refresh in flight" }],
	error: [
		{ status: GALLERY_PROMPT_CACHE.coldModel, note: "not cached — the model changed" },
		{ status: GALLERY_PROMPT_CACHE.coldExpired, note: "not cached — the entry expired" },
	],
};

/** The `/session` snapshot time of the details: two minutes after the samples' last touch. */
const PROMPT_CACHE_NOW = GALLERY_PROMPT_CACHE.warm.touchedAt + 2 * 60_000;

/** The classic bar with the `cache` chip beside the cost, through the real status-line pipeline. */
function renderPromptCacheBar(status: PromptCacheStatus, width: number): string {
	const component = new StatusLineComponent(createGallerySession({ promptCache: status }), statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["cache", "cost"],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	try {
		return component.renderBottomBar(width, "full");
	} finally {
		component.dispose();
	}
}

function renderPromptCacheState(state: GalleryFixtureState, width: number): readonly string[] {
	const lines: string[] = [];
	for (const { status, note } of PROMPT_CACHE_CASES[state]) {
		lines.push(theme.fg("dim", `  ${note}`), renderPromptCacheBar(status, width));
		for (const row of promptCacheDetails(status, PROMPT_CACHE_NOW, "snapshot")) {
			const value = row.tone ? theme.fg(row.tone, row.value) : row.value;
			lines.push(`  ${theme.fg("muted", `${row.label}:`)} ${value}`);
		}
	}
	return lines;
}

export const statusLineFixtures: Record<string, GalleryFixture> = {
	context_gauge: {
		label: "Context Gauge",
		renderState: renderContextGaugeState,
		args: { note: "status-line context gauge preview" },
		result: { content: [{ type: "text", text: "Rendered annotated and embedded context gauges." }] },
	},
	prompt_cache: {
		label: "Prompt Cache",
		renderState: renderPromptCacheState,
		args: { note: "prompt-cache chip and /session details preview" },
		result: { content: [{ type: "text", text: "Rendered the prompt-cache chip and its details." }] },
	},
};
