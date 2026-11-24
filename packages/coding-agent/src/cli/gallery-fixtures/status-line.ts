/**
 * Gallery fixtures for the status line, rendered through the real status
 * line over the gallery session's status facts.
 *
 * `context_gauge`: the box top border that bridges the segment groups, at four
 * usage levels mapped from the gallery lifecycle states; `error` shows the
 * >100% overflow case (usage anchored to a larger window than the active
 * model's, e.g. after switching to a smaller model mid-session), where the
 * gauge clamps to full while the context_pct segment reports the raw percent.
 *
 * `prompt_cache`: the bar's `cache` marker (the cache glyph, struck through when not cached) beside the cost, followed by
 * the details rows as `/session` lists them, for each cache lifecycle.
 */
import type { PromptCacheStatus } from "../../modes/view-model/status-line/host";
import { promptCacheDetails } from "../../modes/view-model/status-line/prompt-cache";
import { printRows } from "../../ui/print-rows";
import { StatusLine } from "../../ui/status/status-line";
import { renderComposerPreview } from "./composer";
import {
	GALLERY_BAR_PLACEMENT,
	GALLERY_NOW,
	GALLERY_PROMPT_CACHE,
	galleryStatusFacts,
	galleryStatusSettings,
} from "./status-facts";
import type { GalleryFixture, GalleryFixtureState } from "./types";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const GAUGE_WINDOW = 200_000;

/** Simulated usage per gallery lifecycle state, against {@link GAUGE_WINDOW}. */
const GAUGE_CASES: Record<GalleryFixtureState, { tokens: number; note: string }> = {
	streaming: { tokens: 6_000, note: "3% used — fresh session" },
	progress: { tokens: 124_000, note: "62% used — warning zone" },
	success: { tokens: 194_000, note: "97% used — past compaction threshold" },
	error: { tokens: 240_000, note: "120% used — overflow: percent breaks past the window label in red" },
};

/** The box composer's top border for one contextLine mode at `tokens` of usage. */
function renderGaugeVariant(tokens: number, contextLine: "annotated" | "embedded", width: number): string {
	const settings = galleryStatusSettings(
		contextLine === "embedded" ? ["model", "context_pct"] : ["model"],
		contextLine === "embedded" ? ["session_name"] : ["context_pct"],
		{ contextLine },
	);
	const facts = galleryStatusFacts({
		model: { id: "test-model", thinking: false, contextWindow: GAUGE_WINDOW },
		thinkingLevel: undefined,
		context: { tokens, window: GAUGE_WINDOW, percent: (tokens / GAUGE_WINDOW) * 100 },
	});
	// The composer's top border is the row under the preview's label.
	const rows = renderComposerPreview("box", width, settings, facts);
	return rows[rows.findIndex(row => Bun.stripANSI(row).startsWith("Preview:")) + 1] ?? "";
}

function renderContextGaugeState(state: GalleryFixtureState, width: number): readonly string[] {
	const { tokens, note } = GAUGE_CASES[state];
	return [
		currentTheme().fg("dim", `  ${note}`),
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

/** The classic bar with the `cache` marker beside the cost. */
function renderPromptCacheBar(status: PromptCacheStatus, width: number): readonly string[] {
	const settings = galleryStatusSettings(["model"], ["cache", "cost"]);
	const facts = galleryStatusFacts({ promptCache: status });
	return printRows(
		() => StatusLine({ settings: () => settings, facts: () => facts, placement: () => GALLERY_BAR_PLACEMENT }),
		width,
		{ now: GALLERY_NOW },
	);
}

function renderPromptCacheState(state: GalleryFixtureState, width: number): readonly string[] {
	const lines: string[] = [];
	for (const { status, note } of PROMPT_CACHE_CASES[state]) {
		lines.push(currentTheme().fg("dim", `  ${note}`), ...renderPromptCacheBar(status, width));
		for (const row of promptCacheDetails(status, PROMPT_CACHE_NOW)) {
			const value = row.tone ? currentTheme().fg(row.tone, row.value) : row.value;
			lines.push(`  ${currentTheme().fg("muted", `${row.label}:`)} ${value}`);
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
		args: { note: "prompt-cache marker and /session details preview" },
		result: { content: [{ type: "text", text: "Rendered the prompt-cache marker and its details." }] },
	},
};
