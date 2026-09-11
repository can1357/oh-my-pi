import * as os from "node:os";
import { beforeAll, describe, expect, it } from "bun:test";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildHeatmapLayout,
	buildProviderCards,
	formatActivityErrorDetail,
	formatReportAccountLabel,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/usage-dashboard";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAccountMasker } from "@oh-my-pi/pi-coding-agent/modes/utils/usage-mask";

beforeAll(async () => {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) throw new Error("theme unavailable");
	setThemeInstance(uiTheme);
});

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests, totalTokens: 0 };
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
	it("keeps organization qualifiers visible in narrow split-card headers", () => {
		const email = "shared-account-with-a-long-address@example.test";
		const reports = [
			report("anthropic", email, [limit("anthropic", "east", "7d", "Claude 7 Day", 0.8, "warning")], {
				orgId: "org-east",
				orgName: "East",
			}),
			report("anthropic", email, [limit("anthropic", "west", "7d", "Claude 7 Day", 0.2, "ok")], {
				orgId: "org-west",
				orgName: "West",
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
			.filter(line => line.includes("(East)") || line.includes("(West)"));
		expect(headers).toHaveLength(2);
		expect(headers.some(line => line.includes("(East)"))).toBe(true);
		expect(headers.some(line => line.includes("(West)"))).toBe(true);
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
