import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatUsageBreakdown } from "@oh-my-pi/pi-coding-agent/usage/usage-breakdown";

const HOUR = 3_600_000;

function win(label: string, windowId: string, durationMs: number, frac: number) {
	return {
		id: windowId,
		label,
		scope: { provider: "kimi-code", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 1 ? "exhausted" : frac >= 0.9 ? "warning" : "ok",
	} satisfies UsageReport["limits"][number];
}

function acct(email: string, total: number, fiveH: number): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			win("Total quota", "usage-window", 7 * 24 * HOUR, total),
			win("5h limit", "rolling-5h", 5 * HOUR, fiveH),
		],
	} satisfies UsageReport;
}

describe("detailed usage account association (#6067)", () => {
	it("keeps every account's limits together when pressure differs by window", () => {
		const reports: UsageReport[] = [acct("alice@example.test", 1, 0), acct("bob@example.test", 0.2, 1)];
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));
		const aliceStart = text.indexOf("alice@example.test");
		const bobStart = text.indexOf("bob@example.test");
		const alice = text.slice(aliceStart, bobStart);
		const bob = text.slice(bobStart);

		expect(alice).toContain("Total quota");
		expect(alice).toContain("100.0% used");
		expect(alice).toContain("5h limit");
		expect(alice).toContain("0.0% used");
		expect(bob).toContain("Total quota");
		expect(bob).toContain("20.0% used");
		expect(bob).toContain("5h limit");
		expect(bob).toContain("100.0% used");
	});
});
