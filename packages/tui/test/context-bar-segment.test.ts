import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, theme } from "../src/theme";
import { formatOffloadIndicator, renderCompactContextBar } from "../src/status-line/context-bar";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";

beforeAll(async () => {
	await initTheme();
});

describe("context bar", () => {
	it("renders compact root context label", () => {
		const line = stripVTControlCharacters(
			renderCompactContextBar(
				{
					model: undefined,
					contextWindow: 200_000,
					categories: [{ id: "messages", label: "Messages", tokens: 62_000, color: "userMessageText", glyph: "▮" }],
					usedTokens: 62_000,
					autoCompactBufferTokens: 20_000,
					freeTokens: 118_000,
				},
				theme,
				40,
			),
		);
		expect(line).toContain("CTX");
		expect(line).toContain("31");
	});

	it("formats offload indicator", () => {
		expect(formatOffloadIndicator(1_800_000, 318)).toBe("↓1.8M→318t");
		expect(formatOffloadIndicator(0, 0)).toBeNull();
	});

	it("renders context_offload segment when summary present", () => {
		const ctx = {
			session: { getContextOffloadSummary: () => ({ externalBytes: 1_800_000, reintroducedTokens: 318 }) },
			width: 120,
			contextWindow: 200_000,
			contextTokens: 62000,
			contextPercent: 31,
		} as SegmentContext;
		const seg = renderSegment("context_offload", ctx);
		expect(stripVTControlCharacters(seg.content)).toContain("↓1.8M→318t");
	});
});
