/**
 * Regression for #3268 (TUI aggregate path, command-controller.ts).
 *
 * Two contracts that the CLI `formatUsageBreakdown` test cannot cover, because
 * the bug lives in the TUI cross-account grouping renderer `renderUsageReports`:
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE above the per-account
 *     sections, not once per account/window.
 *  2. Identical per-limit notes from multiple accounts that fall in the same
 *     `label|windowId` group are de-duplicated (the `[...new Set(...)]` at the
 *     per-group note line). Without the dedup the note is bullet-joined N times.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@pk-nerdsaver-ai/pi-ai";
import { renderUsageReports } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function limit(label: string, windowId: string, durationMs: number, frac: number, notes?: string[]) {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	} satisfies UsageReport["limits"][number];
}

function report(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]) {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	} satisfies UsageReport;
}

describe("renderUsageReports (#3268 TUI aggregate)", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const disclaimer = "OMP-observed spend only; OpenCode usage outside OMP is not included.";
		const reports: UsageReport[] = [
			report(
				"opencode-go",
				"acct-a@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[disclaimer],
			),
			report(
				"opencode-go",
				"acct-b@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[disclaimer],
			),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(disclaimer).length - 1;
		expect(occurrences).toBe(1);
	});

	it("deduplicates identical per-limit notes when accounts share one window group", () => {
		// Both accounts report the SAME label+windowId, so their limits land in
		// one aggregate group; both carry an identical per-limit note.
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			report("github-copilot", "acct-a@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note])]),
			report("github-copilot", "acct-b@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note])]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(note).length - 1;
		// Deduped: appears once on the group note line. Pre-fix `flatMap(...).join`
		// would bullet-join it twice (one per account in the group).
		expect(occurrences).toBe(1);
	});
});
