import * as os from "node:os";
import { beforeAll, describe, expect, it } from "bun:test";
import type { DailyActivityPoint, UnavailableUsageAccount } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildHeatmapLayout,
	buildProviderCards,
	formatActivityErrorDetail,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests };
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	accountId: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${accountId}:${windowId}`,
		label,
		scope: { provider, accountId, windowId },
		window: { id: windowId, label: windowId, resetsAt },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

describe("buildHeatmapLayout", () => {
	// 2026-08-31 is a Monday; keeps week alignment deterministic.
	const monday = new Date(2026, 7, 31, 12);

	it("aligns days Monday-first and marks future days null", () => {
		const layout = buildHeatmapLayout([day("2026-08-31", 5)], 2, monday);
		// Monday row, last column = today's week.
		expect(layout.cells[0][1]).toBe(4);
		// Tuesday..Sunday of the current week are in the future.
		for (let row = 1; row < 7; row++) expect(layout.cells[row][1]).toBeNull();
		// Previous week is fully in range but has no activity.
		for (let row = 0; row < 7; row++) expect(layout.cells[row][0]).toBe(0);
	});

	it("scales intensity by magnitude against the busiest day, not by rank", () => {
		const points = [
			day("2026-08-24", 100), // max → level 4
			day("2026-08-25", 30), // sqrt(0.3)≈0.55 → level 3
			day("2026-08-26", 6), // sqrt(0.06)≈0.24 → level 1
			day("2026-08-27", 0), // untouched → level 0
		];
		const layout = buildHeatmapLayout(points, 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(3);
		expect(layout.cells[2][0]).toBe(1);
		expect(layout.cells[3][0]).toBe(0);
	});

	it("falls back to request counts when nothing in range is priced", () => {
		const layout = buildHeatmapLayout([day("2026-08-24", 0, 50), day("2026-08-25", 0, 3)], 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(1);
		expect(layout.totalRequests).toBe(53);
	});

	it("labels a column when its week starts a new month", () => {
		// 6 weeks back from 2026-08-31 spans the July→August boundary.
		const layout = buildHeatmapLayout([], 6, monday);
		expect(layout.monthLabels[0]).toBe("Jul");
		expect(layout.monthLabels.filter(Boolean)).toEqual(["Jul", "Aug"]);
	});
});

describe("buildProviderCards", () => {
	const now = Date.now();

	it("averages a window across accounts instead of showing the worst account", () => {
		// One exhausted + one barely-used account: the classic report shows the
		// aggregate (~50% free), so the card must not read 0% free.
		const reports = [
			report("anthropic", "a@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 1.0, "exhausted", now + 1000)]),
			report("anthropic", "b@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.0, "ok", now + 99_000)]),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards).toHaveLength(1);
		expect(cards[0].windows).toHaveLength(1);
		expect(cards[0].windows[0].fraction).toBeCloseTo(0.5);
		// Mixed healthy/exhausted accounts read as warning, not exhausted.
		expect(cards[0].windows[0].status).toBe("warning");
		// Reset countdown comes from the most-used account (when capacity returns).
		expect(cards[0].windows[0].resetMs).toBe(1000);
		expect(cards[0].accountStatuses.map(account => [account.status, account.fraction])).toEqual([
			["exhausted", 1],
			["ok", 0],
		]);
		expect(cards[0].accountStatuses.map(account => account.windows?.map(window => window.label))).toEqual([
			["Claude 7 Day"],
			["Claude 7 Day"],
		]);
		expect(cards[0].accountStatuses.map(account => account.windows?.[0]?.resetMs)).toEqual([1000, 99000]);
	});

	it("weights combined absolute quotas by their capacities", () => {
		const absoluteLimit = (accountId: string, used: number, limitAmount: number) => ({
			...limit(
				"openai-codex",
				accountId,
				"7d",
				"7 days",
				used / limitAmount,
				used >= limitAmount ? "exhausted" : "ok",
			),
			amount: { used, limit: limitAmount, unit: "usd" as const },
		});
		const cards = buildProviderCards(
			[
				report("openai-codex", "large-a@x.test", [absoluteLimit("large-a", 200, 200)]),
				report("openai-codex", "large-b@x.test", [absoluteLimit("large-b", 200, 200)]),
				report("openai-codex", "small@x.test", [absoluteLimit("small", 0, 20)]),
			],
			now,
		);

		expect(cards[0].windows[0]?.fraction).toBeCloseTo(400 / 420);
		expect(cards[0].windows[0]?.reportedAccounts).toBe(3);
	});
	it("keeps different account tiers out of one combined percentage", () => {
		const tieredReport = (email: string, tier: string, usedFraction: number) => {
			const value = {
				...limit("openai-codex", email, "7d", "7 days", usedFraction, usedFraction >= 1 ? "exhausted" : "ok"),
				id: "openai-codex:primary",
			};
			return {
				...report("openai-codex", email, [value]),
				metadata: { email, planType: tier },
			};
		};
		const card = buildProviderCards(
			[
				tieredReport("pro-a@x.test", "pro", 1),
				tieredReport("pro-b@x.test", "pro", 1),
				tieredReport("plus@x.test", "plus", 0.1),
			],
			now,
		)[0];

		expect(card.windows.map(window => [window.label, window.fraction])).toEqual([
			["7 days (pro)", 1],
			["7 days (plus)", 0.1],
		]);
	});
	it("scopes a pro-only reserve bucket to eligible pro accounts", () => {
		const usage = (email: string, planType: string, includeReserve: boolean) => {
			const primary = { ...limit("openai-codex", email, "7d", "7 days", 0, "ok"), id: "openai-codex:primary" };
			const limits = [primary];
			if (includeReserve) {
				const reserve = limit("openai-codex", email, "7d", "7 days (gpt-reserve)", 0, "ok");
				limits.push({
					...reserve,
					id: "openai-codex:gpt-reserve:primary",
					scope: { ...reserve.scope, tier: "gpt-reserve" },
				});
			}
			return { ...report("openai-codex", email, limits), metadata: { email, planType } };
		};
		const card = buildProviderCards(
			[usage("pro-a@x.test", "pro", true), usage("pro-b@x.test", "pro", false), usage("max@x.test", "max", false)],
			now,
		)[0];
		const reserve = card.windows.find(window => window.label.includes("gpt-reserve"));
		expect(reserve?.label).toBe("7 days (gpt-reserve) (pro)");
		expect(reserve?.reportedAccounts).toBe(1);
		expect(reserve?.eligibleAccounts).toBe(2);
	});
	it("derives an individual window status when the provider omits status", () => {
		const omittedStatus = { ...limit("gemini", "a", "7d", "7 days", 1, "exhausted"), status: undefined };
		const cards = buildProviderCards([report("gemini", "a@x.test", [omittedStatus])], now);
		expect(cards[0].accountStatuses[0].windows?.[0]?.status).toBe("exhausted");
	});

	it("aggregates reset inventory without showing a spent grant's earlier expiry", () => {
		const claude = report("anthropic", "claude@example.test", [
			limit("anthropic", "claude", "5h", "Claude 5 Hour", 0, "ok"),
		]);
		claude.resetCredits = {
			availableCount: 3,
			redeemableCount: 0,
			reason: "weekly cooldown",
			credits: [
				{
					id: "cedar",
					title: "Claude reset",
					program: "cedar_ember",
					remainingCount: 3,
					usable: false,
					requiresLimit: true,
					clears: ["anthropic:5h", "anthropic:7d"],
					blocking: ["anthropic:7d"],
					usedFractions: {},
					expiresAt: new Date(now + 2 * 86_400_000).toISOString(),
				},
				{ id: "spent", remainingCount: 0, expiresAt: new Date(now + 3_600_000).toISOString() },
			],
		};
		const sibling = report("anthropic", "sibling@example.test", [
			limit("anthropic", "sibling", "5h", "Claude 5 Hour", 0, "ok"),
		]);
		sibling.resetCredits = {
			availableCount: 2,
			redeemableCount: 2,
			credits: [{ id: "later", remainingCount: 2, expiresAt: new Date(now + 3 * 86_400_000).toISOString() }],
		};

		const card = buildProviderCards([claude, sibling], now)[0];

		expect(card.resetCredits).toEqual({
			bankedCount: 5,
			redeemableCount: 2,
			soonestExpiryMs: 2 * 86_400_000,
			unavailableReasons: ["weekly cooldown"],
		});
		expect(card.idle).toBe(false);
	});

	it("sorts pressured providers first and collapses untouched ones into idle", () => {
		const reports = [
			report("cursor", "c@x.test", [limit("cursor", "c", "monthly", "Cursor Models", 0.0, "ok")]),
			report("openai-codex", "o@x.test", [limit("openai-codex", "o", "7d", "7 days", 0.4, "ok")]),
			report("ollama-cloud", "l@x.test", []),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards[0].provider).toBe("openai-codex");
		expect(cards[0].idle).toBe(false);
		const idle = cards.filter(card => card.idle).map(card => card.provider);
		expect(idle.sort()).toEqual(["cursor", "ollama-cloud"]);
		const unlimited = cards.find(card => card.provider === "ollama-cloud");
		expect(unlimited?.unlimited).toBe(true);
	});

	it("shows a prepaid balance on the card instead of falling back to no data", () => {
		// Balance-only limits carry no fraction, so the card used to render the
		// literal "no data" for providers that sell prepaid credits.
		const reports = [
			report("charm-hyper", "a@x.test", [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					window: { id: "balance", label: "balance", resetsAt: now + 30_000 },
					amount: { remaining: 100, unit: "credits" },
				},
			]),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards[0].windows[0].usedText).toBe("100 credits left");
		expect(cards[0].windows[0].fraction).toBeUndefined();
		expect(cards[0].windows[0].resetMs).toBe(30_000);
		// A live balance must not be marked idle.
		expect(cards[0].idle).toBe(false);
	});

	it("collapses an account-wide balance reported once per key, whatever the order", () => {
		// AuthStorage probes every stored key, so a two-key Charm Hyper account
		// yields two shared rows for one pool. The two probes fire moments

		// apart against a moving balance, so they rarely agree exactly — the
		// values differ here deliberately, or reversing them would prove
		// nothing and a first-wins implementation would still pass.
		const balance = (remaining: number, sharedGroup: string) => ({
			id: "charm-hyper:credits",
			label: "Credit balance",
			scope: {
				provider: "charm-hyper" as const,
				windowId: "balance",
				shared: true,
				sharedGroup,
			},
			amount: { remaining, unit: "credits" as const },
		});
		const probedAt = Date.now();
		const charmReport = (remaining: number, endpoint = "https://api.example.test/credits"): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt: probedAt,
			limits: [balance(remaining, `charm-hyper:credits:${endpoint}`)],
			metadata: { endpoint },
		});
		const forward = buildProviderCards([charmReport(100), charmReport(95)], now);
		const reversed = buildProviderCards([charmReport(95), charmReport(100)], now);
		const separateEndpoints = buildProviderCards(
			[charmReport(100), charmReport(95, "https://other.example.test/credits")],
			now,
		);

		// One pool, so never the 195 a sum would claim, and never dependent on
		// which credential happened to be probed first. Distinct endpoint pools
		// are independent and therefore do add up in the combined amount.
		expect(forward[0].windows[0].usedText).toBe("100 credits left");
		expect(reversed[0].windows[0].usedText).toBe("100 credits left");
		expect(separateEndpoints[0].windows[0].usedText).toBe("195 credits left");
		expect(separateEndpoints[0].accounts).toBe(2);
		expect(forward[0].accounts).toBe(1);
		expect(forward[0].accountStatuses).toHaveLength(1);
		expect(reversed[0].accounts).toBe(1);
		expect(reversed[0].accountStatuses).toHaveLength(1);
	});
	it("sums independent shared balances by account identity", () => {
		const balance = (accountId: string, remaining: number): UsageReport => ({
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:credits",
					label: "Credits",
					scope: { provider: "zai", accountId, windowId: "credits", shared: true },
					window: { id: "credits", label: "credits" },
					amount: { remaining, unit: "credits" },
				},
			],
			metadata: { accountId, email: `${accountId}@example.test` },
		});
		const card = buildProviderCards([balance("acct-a", 100), balance("acct-b", 50)], now)[0];
		expect(card.windows[0]?.usedText).toBe("150 credits left");
	});

	it("qualifies same-email accounts with their organization", () => {
		const makeReport = (orgName: string) => ({
			...report("anthropic", "same@example.test", [limit("anthropic", "account", "7d", "Claude 7 Day", 0.2, "ok")]),
			metadata: { email: "same@example.test", orgId: `id-${orgName}`, orgName },
		});
		const accounts = buildProviderCards([makeReport("Org A"), makeReport("Org B")], now)[0].accountStatuses;
		expect(accounts.map(account => account.label)).toEqual([
			"same@example.test (Org A)",
			"same@example.test (Org B)",
		]);
	});

	it("falls back to the org id when a subscription carries no org name", () => {
		// A token response can carry the org uuid without a display name; the
		// uuid is the scoped identity, so it must still separate the two rows.
		const makeReport = (orgId: string) => ({
			...report("anthropic", "same@example.test", [limit("anthropic", "account", "7d", "Claude 7 Day", 0.2, "ok")]),
			metadata: { email: "same@example.test", orgId },
		});
		const accounts = buildProviderCards([makeReport("org-team"), makeReport("org-max")], now)[0].accountStatuses;
		expect(accounts.map(account => account.label)).toEqual([
			"same@example.test (org-team)",
			"same@example.test (org-max)",
		]);
	});

	it("shows each marked shared quota once without merging independent buckets", () => {
		const sharedLimit = (counter: "anthropic" | "openai", windowId: "5h" | "7d") => {
			const value = limit("google-antigravity", "account", windowId, "Claude & GPT (shared)", 0.25, "ok");
			return {
				...value,
				id: `google-antigravity:${counter}:default:3p-${windowId}`,
				scope: { ...value.scope, shared: true, sharedGroup: `3p-${windowId}` },
			};
		};
		const reports = [
			report("google-antigravity", "user@example.test", [
				limit("google-antigravity", "account", "5h", "Gemini", 0.25, "ok"),
				limit("google-antigravity", "account", "7d", "Gemini", 0.25, "ok"),
				sharedLimit("anthropic", "5h"),
				sharedLimit("openai", "5h"),
				sharedLimit("anthropic", "7d"),
				sharedLimit("openai", "7d"),
			]),
		];

		const windows = buildProviderCards(reports, now)[0].windows;

		expect(windows.map(window => `${window.label} — ${window.windowTag}`).sort()).toEqual([
			"Claude & GPT (shared) — 5h",
			"Claude & GPT (shared) — 7d",
			"Gemini — 5h",
			"Gemini — 7d",
		]);
	});
});
describe("UsageDashboardComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	function dashboard(
		reports: UsageReport[],
		unavailableAccounts: UnavailableUsageAccount[] = [],
	): UsageDashboardComponent {
		return new UsageDashboardComponent({
			reports,
			unavailableAccounts,
			renderDetail: () => "",
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => {},
			onClose: () => {},
		});
	}

	it("keeps usable bars and matching label rows across multi-column cards", () => {
		const component = dashboard([
			report("anthropic", "a@test", [
				limit("anthropic", "a", "7d", "Claude 7 Day", 0.9, "warning"),
				limit("anthropic", "a", "fable", "Claude 7 Day (Fable)", 0.16, "ok"),
			]),
			report("openai", "a@test", [
				limit("openai", "a", "5h", "Codex 5h", 0.4, "ok"),
				limit("openai", "a", "7d", "Codex Weekly", 0.2, "ok"),
			]),
			report("google", "a@test", [
				limit("google", "a", "5h", "Gemini 5h", 0.3, "ok"),
				limit("google", "a", "7d", "Gemini Weekly", 0.1, "ok"),
			]),
		]);
		try {
			// Two stacked cards, two inline cards, then three stacked cards.
			for (const [width, columns, stacked] of [
				[72, 2, true],
				[100, 2, false],
				[120, 3, true],
			] as const) {
				const lines = component.render(width).map(line => Bun.stripANSI(line));
				const labelLine = lines.find(line => line.includes("Claude 7 Day"))!;
				expect(labelLine).toContain("Codex 5h");
				expect(/[█░]/.test(labelLine)).toBe(!stacked);
				const quotaLines = lines.filter(line => /[█░]/.test(line)).slice(0, 2);
				expect(quotaLines).toHaveLength(2);
				for (const line of quotaLines) {
					const bars = [...line.matchAll(/[█░]+/g)];
					expect(bars).toHaveLength(columns);
					expect(bars[0][0].length).toBeGreaterThanOrEqual(12);
					for (const bar of bars) expect(bar[0].length).toBe(bars[0][0].length);
				}
				expect(quotaLines[0]).toContain("10%");
				expect(quotaLines[1]).toContain("84%");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});

	it("sanitizes provider labels and duplicate-window tags before rendering", () => {
		const label = "Claude\t7 Day\x1b[2J\x07\r\n(Fable)";
		const component = dashboard([
			report("anthropic", "a@test", [
				limit("anthropic", "a", "5\th", label, 0.4, "ok"),
				limit("anthropic", "a", "7\nd", label, 0.2, "ok"),
			]),
		]);
		try {
			const lines = component.render(100);
			for (const line of lines) {
				expect(line).not.toMatch(/[\t\r\n\x07]/);
				expect(line).not.toContain("\x1b[2J");
				expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			}
			const output = Bun.stripANSI(lines.join("\n"));
			expect(output).toMatch(/Claude +7 Day +\(Fable\)/);
			expect(output).toMatch(/5 +h/);
			expect(output).toMatch(/7 +d/);
		} finally {
			component.dispose();
		}
	});

	it("bounds long quota labels while retaining suffixes and sibling bar alignment", () => {
		const prefix = `Weekly ${"extended thinking ".repeat(1000)}`;
		const component = dashboard([
			report("anthropic", "a@test", [
				limit("anthropic", "a", "fable", `${prefix}(Fable)`, 0.9, "warning"),
				limit("anthropic", "a", "mythos", `${prefix}(Mythos)`, 0.16, "ok"),
			]),
			report("openai", "a@test", [
				limit("openai", "a", "5h", "Codex 5h", 0.4, "ok"),
				limit("openai", "a", "7d", "Codex Weekly", 0.2, "ok"),
			]),
		]);
		try {
			const lines = component.render(72).map(line => Bun.stripANSI(line));
			for (const suffix of ["(Fable)", "(Mythos)"]) expect(lines.join("\n")).toContain(suffix);
			const starts = lines.flatMap((line, index) => (line.includes("Weekly extended") ? [index] : []));
			const bars = lines.flatMap((line, index) => (/[█░]/.test(line) ? [index] : []));
			expect(starts).toHaveLength(2);
			expect(bars).toHaveLength(2);
			for (let index = 0; index < bars.length; index++) {
				expect(bars[index] - starts[index]).toBeLessThanOrEqual(2);
				expect([...lines[bars[index]].matchAll(/[█░]+/g)]).toHaveLength(2);
			}
			expect(lines.join("\n")).toContain("…");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		} finally {
			component.dispose();
		}
	});

	it("keeps all label characters when they fit the two-line cell budget", () => {
		const label = "Claude 7 Day (Extended Thinking)";
		const component = dashboard([report("anthropic", "a@test", [limit("anthropic", "a", "7d", label, 0.4, "ok")])]);
		try {
			const lines = component.render(24).map(line => Bun.stripANSI(line));
			const first = lines.findIndex(line => line.includes("Claude"));
			const bar = lines.findIndex(line => /[█░]/.test(line));
			expect(bar - first).toBeLessThanOrEqual(2);
			expect(
				lines
					.slice(first, bar)
					.join("")
					.replace(/[│\s]/g, ""),
			).toBe(label.replace(/\s/g, ""));
		} finally {
			component.dispose();
		}
	});

	it("keeps quota names distinguishable beside or above their bars", async () => {
		const now = Date.now();
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			reports: [
				report("anthropic", "user@example.test", [
					limit("anthropic", "account", "7d", "Claude 7 Day", 1, "exhausted", now + 3_600_000),
					limit("anthropic", "account", "fable", "Claude 7 Day (Fable)", 0.16, "ok", now + 3_600_000),
					limit("anthropic", "account", "extra", "Claude Extra Usage", 0.05, "ok"),
				]),
			],
			renderDetail: () => "",
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => markRendered(),
			onClose: () => {},
		});
		try {
			await rendered;
			for (const width of [36, 60]) {
				const lines = component.render(width);
				const output = Bun.stripANSI(lines.join("\n"));
				expect(output).toContain("Claude 7 Day (Fable)");
				expect(output).toContain("Claude Extra Usage");
				expect(output).toContain("84%");
				expect(output).toContain("95%");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});

	it("keeps the error icon on an exhausted card when another account's lookup fails", () => {
		const component = dashboard(
			[report("anthropic", "a@test", [limit("anthropic", "a", "7d", "Claude 7 Day", 1, "exhausted")])],
			[{ provider: "anthropic", label: "b@test" }],
		);
		try {
			const output = Bun.stripANSI(component.render(100).join("\n"));
			const title = output.split("\n").find(line => line.includes("2 accts"));
			expect(title?.replace(/^[│\s]+/, "")).toStartWith(`${theme.status.error} Anthropic`);
		} finally {
			component.dispose();
		}
	});

	it("lists each account's availability and quota windows in the initial dashboard", () => {
		const resetBase = Date.now();
		const component = new UsageDashboardComponent({
			reports: [
				report("openai-codex", "a@x.test", [
					limit("openai-codex", "a", "7d", "7 days", 1, "exhausted", resetBase + 10_000),
					limit("openai-codex", "a", "5h", "5 hours", 1, "exhausted", resetBase + 10_000),
					limit("openai-codex", "a", "1h", "1 hour", 1, "exhausted", resetBase + 10_000),
					limit("openai-codex", "a", "1d", "1 day", 1, "exhausted", resetBase + 10_000),
					limit("openai-codex", "a", "monthly", "Monthly", 1, "exhausted", resetBase + 10_000),
				]),
				report("openai-codex", "b@x.test", [
					limit("openai-codex", "b", "7d", "7 days", 0, "ok", resetBase + 20_000),
					limit("openai-codex", "b", "5h", "5 hours", 0, "ok", resetBase + 20_000),
				]),
				report("cursor", "idle@x.test", [
					limit("cursor", "idle", "monthly", "Cursor Models", 0, "ok", resetBase + 30_000),
				]),
			],
			renderDetail: () => "",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});

		const overview = component.render(100).join("\n");
		expect(overview).toContain("a@x.test");
		expect(overview).toContain("exhausted");
		expect(overview).toContain("0% free");
		expect(overview).toContain("b@x.test");
		expect(overview).toContain("5 hours");
		expect(overview).toContain("Monthly");
		expect(overview).toContain("100% free");
		expect(overview).toContain("1/2");
		const partialQuotaLine = overview.split("\n").find(line => line.includes("1/2"));
		expect(partialQuotaLine).toBeDefined();
		expect(partialQuotaLine).toMatch(/10\.\ds/);
		// The Cursor card holds a single account, so it renders through the grid
		// and carries no account label — only aggregating cards list their accounts.
		expect(overview).not.toContain("untouched:");
		expect(overview).toMatch(/10\.\ds/);
		expect(overview).toMatch(/20\.\ds/);
		const narrowOverview = component.render(80).join("\n");
		const narrowQuotaLine = narrowOverview.split("\n").find(line => line.includes("7 days"));
		expect(narrowQuotaLine).toBeDefined();
		expect(narrowQuotaLine ? (narrowQuotaLine.match(/█/g) ?? []).length : 0).toBeGreaterThanOrEqual(8);
		const monthlyLine = overview.split("\n").find(line => line.includes("Monthly") && line.includes("1/2"));
		const sevenDayLine = overview.split("\n").find(line => line.includes("7 days") && line.includes("50%"));
		expect(monthlyLine).toBeDefined();
		expect(sevenDayLine).toBeDefined();
		expect(monthlyLine ? (monthlyLine.match(/[█░]/g) ?? []).length : 0).toBe(
			sevenDayLine ? (sevenDayLine.match(/[█░]/g) ?? []).length : 0,
		);
		component.dispose();
	});
	it("renders a single-account card through the shared grid, with no account breakdown", () => {
		const resetBase = Date.now();
		const component = new UsageDashboardComponent({
			reports: [
				report("cursor", "solo@x.test", [
					limit("cursor", "solo", "monthly", "Cursor Models", 0.2, "ok", resetBase + 30_000),
				]),
			],
			renderDetail: () => "",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});

		const overview = component.render(100).join("\n");
		// One account renders as one card's worth of grid rows. The per-account
		// breakdown is reserved for cards that actually aggregate accounts, so a
		// single-account card never repeats its quota rows under an account label.
		expect(overview).toContain("Cursor Models");
		expect(overview).not.toContain("combined");
		expect(overview.match(/Cursor Models/g)).toHaveLength(1);
		component.dispose();
	});
	it("still combines when a card aggregates several accounts", () => {
		const resetBase = Date.now();
		const component = new UsageDashboardComponent({
			reports: [
				report("openai-codex", "a@x.test", [
					limit("openai-codex", "a", "7d", "7 days", 0.2, "ok", resetBase + 10_000),
				]),
				report("openai-codex", "b@x.test", [
					limit("openai-codex", "b", "7d", "7 days", 0.4, "ok", resetBase + 20_000),
				]),
			],
			renderDetail: () => "",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});

		const overview = component.render(100).join("\n");
		expect(overview).toContain("combined");
		component.dispose();
	});
	it("renders specific error reason when activity loading fails instead of generic DB read error", async () => {
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			reports: [],
			renderDetail: () => "",
			loadActivity: () => Promise.reject(new Error("worker spawn failed")),
			requestRender: () => markRendered(),
			onClose: () => {},
		});

		await rendered;
		const lines = component.render(80).join("\n");
		expect(lines).toContain("Usage history unavailable (worker spawn failed).");
		expect(lines).not.toContain("stats database could not be read");
	});
	it("sanitizes control sequences, collapses multiline errors, and shortens paths", async () => {
		const home = os.homedir();
		const rawError = `subprocess crashed at ${home}/.omp/stats.db:\n\tfailed to open\x1b[2J\r\nline 2\x1b[31m...`;
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			reports: [],
			renderDetail: () => "",
			loadActivity: () => Promise.reject(new Error(rawError)),
			requestRender: () => markRendered(),
			onClose: () => {},
		});

		await rendered;
		const renderedLines = component.render(140);
		const contentLine = renderedLines.find(l => l.includes("Usage history unavailable"));
		expect(contentLine).toBeDefined();
		expect(contentLine).not.toContain("\x1b[2J");
		expect(contentLine).not.toContain("\n");
		expect(contentLine).not.toContain("\t");
		expect(contentLine).not.toContain(home);
		expect(contentLine).toContain("~/.omp/stats.db");
		expect(contentLine).toContain(
			"Usage history unavailable (subprocess crashed at ~/.omp/stats.db: failed to open line 2).",
		);
	});
});

describe("formatActivityErrorDetail", () => {
	it("strips ANSI control sequences and collapses multiline error text to single line", () => {
		const input = "worker spawn failed\ntrace\x1b[2J\r\n\tsecond line";
		expect(formatActivityErrorDetail(input)).toBe("worker spawn failed trace second line");
	});

	it("shortens home directory paths to tilde and removes trailing dots", () => {
		const home = "/Users/testuser";
		const input = `Error: failed to open ${home}/.omp/stats.db...`;
		expect(formatActivityErrorDetail(input, home)).toBe("Error: failed to open ~/.omp/stats.db");
	});
});
