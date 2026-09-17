/**
 * Coverage for the prefill/decode rate split in transcript usage rows: when
 * TTFT is known, the throughput figure rates the decode window alone
 * (duration − TTFT), so a long prefill no longer reads as slow generation.
 * When TTFT is unknown the legacy duration-wide rate renders, and the
 * `(decode)` suffix only appears on the split figure.
 */
import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { formatUsageRow } from "@oh-my-pi/pi-coding-agent/modes/components/usage-row";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function usage(output: number): Usage {
	return {
		input: 100,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100 + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("usage row prefill/decode rate split", () => {
	it("rates the decode window alone when TTFT is known", async () => {
		await initTheme();
		// 2000ms total, 1500ms prefill → 500ms decode window; 200 out tokens.
		// Legacy duration-wide rate would read 100.0/s; decode is 400.0/s.
		const row = formatUsageRow(usage(200), 2000, 1500, Date.now());
		expect(row).toContain("(decode)");
		expect(row).toContain("400.0/s (decode)");
		expect(row).not.toMatch(/\b100\.0\/s/);
	});

	it("keeps the duration-wide rate when TTFT is unknown", () => {
		const row = formatUsageRow(usage(200), 2000, undefined, Date.now());
		expect(row).toContain("100.0/s");
		expect(row).not.toContain("(decode)");
	});

	it("omits the rate when TTFT swallows the whole window", () => {
		// decode = duration - ttft = 50ms <= MIN_DURATION_MS: no honest decode
		// rate exists, and duration-wide would be the misleading figure the
		// split exists to fix, so the row keeps ⤵/⤴/⏱ and drops ⚡.
		const row = formatUsageRow(usage(200), 2000, 1950, Date.now());
		expect(row).toMatch(/⏱ 1\.9s/);
		expect(row).not.toContain("(decode)");
		expect(row).not.toMatch(/\d+\.\d\/s/);
	});

	it("shows both TTFT and the decode rate on the same row", () => {
		const row = formatUsageRow(usage(200), 2000, 1500, Date.now());
		expect(row).toMatch(/⏱ 1\.5s/);
		expect(row).toContain("400.0/s (decode)");
	});
});
