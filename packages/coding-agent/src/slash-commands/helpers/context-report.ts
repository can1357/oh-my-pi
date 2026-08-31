import { computeContextBreakdown } from "../../modes/utils/context-usage";
import { buildStaticContextReport, formatStaticContextReport } from "../../modes/utils/static-context-report";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "./format";

function appendStaticContextReport(lines: string[], runtime: SlashCommandRuntime, contextWindowTokens?: number): void {
	const sources = runtime.session.getStaticContextSources();
	if (!sources) return;
	lines.push(
		"",
		formatStaticContextReport(
			buildStaticContextReport({
				sources,
				tokenizer: runtime.session.agent.tokenizer,
				contextWindowTokens,
			}),
		),
	);
}

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			const lines = ["Context usage is unavailable: no model is selected for this session."];
			appendStaticContextReport(lines, runtime);
			return lines.join("\n");
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [`Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens`);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.autoCompactBufferTokens} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.freeTokens} tokens`);
		}
		appendStaticContextReport(lines, runtime, breakdown.contextWindow);
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push("Snapcompact: inactive (model has no image input)");
			} else {
				lines.push("Snapcompact (estimated wire savings):");
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? `  System prompt: ${sp.textTokens} text tokens → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${sp.imageTokens} tokens (saves ~${sp.savedTokens})`
							: "  System prompt: stays text (no net savings)",
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? `  Tool results: ${tr.swapped} of ${tr.total} imaged, ${tr.textTokens} text tokens → ${tr.frames} frames ≈ ${tr.imageTokens} tokens (saves ~${tr.savedTokens})`
							: `  Tool results: none imaged (${tr.total} in history)`,
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(`  Estimated next request: ~${breakdown.usedTokens - snap.savedTokens} tokens on the wire`);
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return "Context usage is unavailable.";
		return ["Context", `Window: ${fallback.contextWindow}`, `Used: ${fallback.tokens ?? 0}`].join("\n");
	}
}
