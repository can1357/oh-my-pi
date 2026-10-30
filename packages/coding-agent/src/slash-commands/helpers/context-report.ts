import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return __ompTranslate("Context usage is unavailable: no model is selected for this session.");
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [
			__ompTranslate("Context window: {0} tokens ({1}% used)", `${breakdown.contextWindow}`, `${usedPct}`),
		];
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
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push(__ompTranslate("Snapcompact: inactive (model has no image input)"));
			} else {
				lines.push(__ompTranslate("Snapcompact (estimated wire savings):"));
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
					lines.push(
						__ompTranslate(
							"  Estimated next request: ~{0} tokens on the wire",
							`${breakdown.usedTokens - snap.savedTokens}`,
						),
					);
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return __ompTranslate("Context usage is unavailable.");
		return [
			__ompTranslate("Context"),
			__ompTranslate("Window: {0}", `${fallback.contextWindow}`),
			__ompTranslate("Used: {0}", `${fallback.tokens ?? 0}`),
		].join("\n");
	}
}
