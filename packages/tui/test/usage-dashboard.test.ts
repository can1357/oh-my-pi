import { createAccountMasker, createUsageTextMasker } from "@oh-my-pi/pi-tui/overlays/usage-mask";
import * as os from "node:os";
import { beforeAll, describe, expect, it } from "bun:test";
import type { DailyActivityPoint, UnavailableUsageAccount } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildHeatmapLayout,
	buildProviderCards,
	formatActivityErrorDetail,
	formatReportAccountLabel,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
beforeAll(async () => {
	await initTheme();
});

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests };
}

function report(
	provider: string,
	email: string,
	limits: UsageReport["limits"],
	organization?: { orgId: string; orgName?: string },
): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email, ...organization } };
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

	it("keeps same-email organization accounts separate by their account IDs", () => {
		const reports = ["first-id", "second-id"].map((id, index) =>
			report("openai", "shared@example.test", [limit("openai", id, "weekly", "Weekly", index ? 0.8 : 0.2, "ok")], {
				orgId: "shared-org",
			}),
		);
		for (const enabled of [false, true]) {
			const cards = buildProviderCards(reports, now, {
				merge: false,
				mask: createAccountMasker(reports.map(formatReportAccountLabel), enabled),
			});
			expect(cards.map(card => card.accounts)).toEqual([1, 1]);
			expect(cards.map(card => card.windows[0].fraction).sort()).toEqual([0.2, 0.8]);
			expect(new Set(cards.map(card => card.account)).size).toBe(2);
		}
	});

	it("does not merge anonymous reports with real identifiers matching fallback labels", () => {
		const reports: UsageReport[] = [0.2, 0.8].map((fraction, index) => ({
			provider: "openai",
			fetchedAt: now,
			metadata: index === 0 ? {} : { accountId: "account-1" },
			limits: [{ ...limit("openai", "", "weekly", "Weekly", fraction, "ok"), scope: { provider: "openai" } }],
		}));
		const cards = buildProviderCards(reports, now, { merge: false });
		expect(cards.map(card => card.accounts)).toEqual([1, 1]);
		expect(cards.map(card => card.windows[0].fraction).sort()).toEqual([0.2, 0.8]);
	});

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
					amount: { remaining: 100, unit: "credits" },
				},
			]),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards[0].windows[0].usedText).toBe("100 credits left");
		expect(cards[0].windows[0].fraction).toBeUndefined();
		// Untouched providers collapse into a tick; a live balance must not.
		expect(cards[0].idle).toBe(false);
	});

	it("collapses an account-wide balance reported once per key, whatever the order", () => {
		// AuthStorage probes every stored key, so a two-key Charm Hyper account
		// yields two shared rows for one pool. The two probes fire moments
		// apart against a moving balance, so they rarely agree exactly — the
		// values differ here deliberately, or reversing them would prove
		// nothing and a first-wins implementation would still pass.
		const balance = (remaining: number) => ({
			id: "charm-hyper:credits",
			label: "Credit balance",
			scope: { provider: "charm-hyper" as const, windowId: "balance", shared: true },
			amount: { remaining, unit: "credits" as const },
		});
		const forward = buildProviderCards(
			[report("charm-hyper", "a@x.test", [balance(100)]), report("charm-hyper", "b@x.test", [balance(95)])],
			now,
		);
		const reversed = buildProviderCards(
			[report("charm-hyper", "b@x.test", [balance(95)]), report("charm-hyper", "a@x.test", [balance(100)])],
			now,
		);

		// One pool, so never the 195 a sum would claim, and never dependent on
		// which credential happened to be probed first.
		expect(forward[0].windows[0].usedText).toBe("100 credits left");
		expect(reversed[0].windows[0].usedText).toBe("100 credits left");
	});
});

describe("buildProviderCards split + privacy", () => {
	const now = Date.now();
	const reports = [
		report("anthropic", "alice@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 1.0, "exhausted")]),
		report("anthropic", "alina@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.0, "ok")]),
	];

	it("merge=false yields one card per account, each with its own fraction", () => {
		const cards = buildProviderCards(reports, now, { merge: false });
		expect(cards.map(card => card.account)).toEqual(["alice@x.test", "alina@x.test"]);
		expect(cards.map(card => card.windows[0].fraction)).toEqual([1, 0]);
	});

	it("partitions one combined report by scoped account IDs without averaging matching windows", () => {
		const combined = report("anthropic", "shared@x.test", [
			limit("anthropic", "account-a", "7d", "Claude 7 Day", 0.2, "ok"),
			limit("anthropic", "account-a", "5h", "Claude 5 Hour", 0.4, "ok"),
			limit("anthropic", "account-b", "7d", "Claude 7 Day", 0.8, "warning"),
		]);
		combined.metadata = { ...combined.metadata, accountId: "stale-report-account" };

		const cards = buildProviderCards([combined], now, { merge: false });

		expect(cards).toHaveLength(2);
		expect(cards.map(card => card.windows.length).sort()).toEqual([1, 2]);
		expect(
			cards
				.flatMap(card => card.windows)
				.filter(window => window.label === "Claude 7 Day")
				.map(window => window.fraction)
				.sort(),
		).toEqual([0.2, 0.8]);
	});

	it("partitions one combined report by scoped project IDs", () => {
		const projectLimit = (projectId: string, usedFraction: number): UsageReport["limits"][number] => ({
			...limit("google-gemini-cli", "", "daily", "Gemini Daily", usedFraction, "ok"),
			scope: { provider: "google-gemini-cli", projectId, windowId: "daily" },
		});
		const combined = report("google-gemini-cli", "shared@x.test", [
			projectLimit("project-a", 0.1),
			projectLimit("project-b", 0.9),
		]);
		combined.metadata = { ...combined.metadata, projectId: "stale-report-project" };

		const split = buildProviderCards([combined], now, { merge: false });
		expect(split).toHaveLength(2);
		expect(split.map(card => card.windows[0].fraction).sort()).toEqual([0.1, 0.9]);

		const merged = buildProviderCards([combined], now, { merge: true });
		expect(merged).toHaveLength(1);
		expect(merged[0].windows[0].fraction).toBeCloseTo(0.5);
	});

	it("keeps same-label organizations distinct when split and aggregates them when merged", () => {
		const sameEmail = "shared@x.test";
		const reports = [
			report("anthropic", sameEmail, [limit("anthropic", "shared", "7d", "Claude 7 Day", 0.8, "warning")], {
				orgId: "org-team-east",
				orgName: "Team",
			}),
			report("anthropic", sameEmail, [limit("anthropic", "shared", "7d", "Claude 7 Day", 0.2, "ok")], {
				orgId: "org-team-west",
				orgName: "Team",
			}),
		];

		const split = buildProviderCards(reports, now, { merge: false });
		expect(split).toHaveLength(2);
		expect(split.map(card => card.account)).toEqual([`${sameEmail} (Team)`, `${sameEmail} (Team)`]);
		expect(split.map(card => card.windows[0].fraction)).toEqual([0.8, 0.2]);
		for (const enabled of [false, true]) {
			const labeled = buildProviderCards(reports, now, {
				merge: false,
				mask: createAccountMasker(reports.map(formatReportAccountLabel), enabled),
			});
			expect(new Set(labeled.map(card => card.account)).size).toBe(2);
			expect(labeled.every(card => card.account?.includes("Team"))).toBe(true);
		}

		const merged = buildProviderCards(reports, now, { merge: true });
		expect(merged).toHaveLength(1);
		expect(merged[0].accounts).toBe(2);
		expect(merged[0].windows[0].fraction).toBeCloseTo(0.5);
	});

	it("splits same-base accounts by organization name when ids are absent", () => {
		const sameEmail = "shared@x.test";
		const reports = ["East", "West"].map((orgName, index) =>
			report("anthropic", sameEmail, [limit("anthropic", "shared", "7d", "Claude 7 Day", index / 10, "ok")], {
				orgId: "",
				orgName,
			}),
		);
		const cards = buildProviderCards(reports, now, { merge: false });
		expect(cards).toHaveLength(2);
		expect(Object.fromEntries(cards.map(card => [card.account, card.windows[0].fraction]))).toEqual({
			[`${sameEmail} (East)`]: 0,
			[`${sameEmail} (West)`]: 0.1,
		});
	});

	it("retains distinguishing organization tails in narrow split-card headers", () => {
		const reports: UsageReport[] = ["East", "West"].map(region => ({
			provider: "openai",
			fetchedAt: 1,
			limits: [],
			metadata: { email: "shared@example.test", orgName: `Acme Corporation Workspace ${region}` },
		}));
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const lines = dashboard.render(80).map(line => Bun.stripANSI(line));
		expect(lines.join("\n")).toContain("East");
		expect(lines.join("\n")).toContain("West");
		expect(lines.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
	});

	it("masks opaque parentheses while preserving only metadata-attributed organization labels", () => {
		const reports: UsageReport[] = [
			{ provider: "openai", fetchedAt: 1, limits: [], metadata: { accountId: "Jane Doe (finance)" } },
			{ provider: "openai", fetchedAt: 1, limits: [], metadata: { accountId: "Jane Doe", orgName: "finance" } },
		];
		const cards = buildProviderCards(reports, 1, {
			merge: false,
			mask: createAccountMasker(reports.map(formatReportAccountLabel), true),
		});
		expect(cards.map(card => card.account).sort()).toEqual(["Jan***", "Jan*** (finance)"]);
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const text = Bun.stripANSI(dashboard.render(160).join("\n"));
		expect(text).not.toContain("Jane Doe");
		expect(text).toContain("Jan*** (finance)");
	});

	it("neutralizes terminal controls in split-card account labels before fitting", () => {
		const reports = [
			report("anthropic", "alice\t\x1b[31m@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 0.2, "ok")], {
				orgId: "org-a",
				orgName: "East\t\x1b[2J",
			}),
		];
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: false,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const rendered = dashboard.render(36).join("\n");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\x1b[2J");
		expect(
			Bun.stripANSI(rendered)
				.split("\n")
				.every(line => line.length <= 36),
		).toBe(true);
	});

	it("masks split-card account labels and keeps colliding prefixes distinguishable", () => {
		const labels = reports.map(formatReportAccountLabel);
		const cards = buildProviderCards(reports, now, { merge: false, mask: createAccountMasker(labels, true) });

		const masked = cards.map(card => card.account);
		expect(masked.every(label => label !== undefined && !label.includes("@x.test"))).toBe(true);
		expect(new Set(masked).size).toBe(2);
	});
	it.each(["", " (US)"])("keeps organization qualifiers visible in narrow split-card headers: %s", suffix => {
		const email = "shared-account-with-a-long-address@example.test";
		const reports = [
			report("anthropic", email, [limit("anthropic", "east", "7d", "Claude 7 Day", 0.8, "warning")], {
				orgId: "org-east",
				orgName: `East${suffix}`,
			}),
			report("anthropic", email, [limit("anthropic", "west", "7d", "Claude 7 Day", 0.2, "ok")], {
				orgId: "org-west",
				orgName: `West${suffix}`,
			}),
		];
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: false,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const headers = Bun.stripANSI(dashboard.render(36).join("\n"))
			.split("\n")
			.filter(line => line.includes(`(East${suffix})`) || line.includes(`(West${suffix})`));
		expect(headers).toHaveLength(2);
		expect(headers.some(line => line.includes(`(East${suffix})`))).toBe(true);
		expect(headers.some(line => line.includes(`(West${suffix})`))).toBe(true);
		expect(headers.every(line => line.length <= 36)).toBe(true);
	});
	it("keeps collision ordinals visible for narrow same-organization split cards", () => {
		const reports = ["mailone@example.test", "mailtwo@example.test"].map((email, index) =>
			report(
				"anthropic",
				email,
				[limit("anthropic", `account-${index}`, "7d", "Claude 7 Day", 0.2 + index * 0.1, "ok")],
				{ orgId: `org-${index}`, orgName: "Long Organization" },
			),
		);
		const dashboard = new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const headers = Bun.stripANSI(dashboard.render(48).join("\n"))
			.split("\n")
			.filter(line => line.includes("mai***"));

		expect(headers).toHaveLength(2);
		expect(headers.some(line => line.includes("mai*** (2)"))).toBe(true);
		expect(new Set(headers).size).toBe(2);
		expect(headers.every(line => line.length <= 48)).toBe(true);
	});

	it("renders normalized masked short account IDs without embedded line breaks", () => {
		const dashboard = new UsageDashboardComponent({
			reports: [
				{
					provider: "openai-codex",
					fetchedAt: Date.now(),
					limits: [limit("openai-codex", "ab\r\ncd", "5h", "5 hours", 0.2, "ok")],
					metadata: { accountId: "ab\r\ncd", orgName: "Org\tName" },
				},
			],
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: false,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		const rendered = dashboard.render(48).join("\n");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain("\t");
		expect(Bun.stripANSI(rendered)).toContain("ab *** (Org   Name)");
	});
});

describe("UsageDashboardComponent session toggles", () => {
	function mount(maskAccountLabels: boolean, mergeAccounts: boolean) {
		const reports = [
			report("anthropic", "alice@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 0.5, "ok")]),
			report("anthropic", "bob@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.1, "ok")]),
		];
		return new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels,
			mergeAccounts,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
	}

	it("p and m flip privacy/merge only for the open overlay, starting from the settings values", () => {
		const dashboard = mount(true, true);
		expect(dashboard.viewState).toMatchObject({ maskAccountLabels: true, mergeAccounts: true });
		dashboard.handleInput("p");
		dashboard.handleInput("m");
		expect(dashboard.viewState).toMatchObject({ maskAccountLabels: false, mergeAccounts: false });
		const text = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(text).toContain("alice@x.test");
		expect(text).toContain("bob@x.test");
		// A fresh mount re-reads the (unchanged) settings: toggles never persisted.
		expect(mount(true, true).viewState).toMatchObject({ maskAccountLabels: true, mergeAccounts: true });
	});

	it("masks split cards while privacy is on", () => {
		const dashboard = mount(true, false);
		const text = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(text).not.toContain("alice@x.test");
		expect(text).toContain("***");
	});
});

it("aborts the activity load when the dashboard closes", () => {
	let activitySignal: AbortSignal | undefined;
	const dashboard = new UsageDashboardComponent({
		reports: [],
		renderDetail: () => "",
		createMasker: createAccountMasker,
		maskAccountLabels: true,
		mergeAccounts: true,
		labelPlacement: "moving",
		loadActivity: async (_push, signal) => {
			activitySignal = signal;
			const closed = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => closed.resolve(), { once: true });
			await closed.promise;
		},
		requestRender: () => {},
		onClose: () => {},
	});

	expect(activitySignal?.aborted).toBe(false);
	dashboard.dispose();
	expect(activitySignal?.aborted).toBe(true);
});

describe("UsageDashboardComponent", () => {
	function dashboard(
		reports: UsageReport[],
		unavailableAccounts: UnavailableUsageAccount[] = [],
	): UsageDashboardComponent {
		return new UsageDashboardComponent({
			reports,
			labelPlacement: "right",
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
	it("renders specific error reason when activity loading fails instead of generic DB read error", async () => {
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			reports: [],
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: true,
			labelPlacement: "moving",
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
			createMasker: createAccountMasker,
			maskAccountLabels: true,
			mergeAccounts: true,
			labelPlacement: "moving",
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

it("masks short opaque account IDs without corrupting words or ANSI sequences", () => {
	const mask = createUsageTextMasker(
		[{ provider: "test", fetchedAt: 1, metadata: { accountId: "a" }, limits: [] }],
		true,
	);
	expect(mask("Quota available for account a")).toBe("Quota available for account ***");
	expect(mask("\x1b[31mQuota: a:weekly\x1b[0m")).toBe("\x1b[31mQuota: ***:weekly\x1b[0m");
});

it("keeps unavailable accounts on separate split cards without inflating reporting-account counts", () => {
	const cards = buildProviderCards(
		[report("anthropic", "reported@example.test", [limit("anthropic", "reported", "weekly", "Weekly", 0.5, "ok")])],
		1,
		{ merge: false },
		[{ provider: "anthropic", label: "missing@example.test" }],
	);
	expect(cards).toHaveLength(2);
	expect(cards.map(card => card.accounts)).toEqual([1, 1]);
	expect(cards.find(card => card.account === "reported@example.test")?.unavailableAccounts).toEqual([]);
	expect(cards.find(card => card.account === "missing@example.test")?.unavailableAccounts).toEqual([
		"missing@example.test",
	]);
});
