import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { buildProviderCards } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders Claude banked reset availability and the next expiry", () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					redeemableCount: 0,
					reason: "weekly cooldown",
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain("0 usable now");
		expect(output).toContain("unavailable: weekly cooldown");
		expect(output).not.toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("shows one prepaid balance for a provider whose keys share an account pool", () => {
		// Production shape: `fetchCharmHyperUsage` emits no accountId and marks
		// the limit shared, because Hyper's balance is account-wide — spending
		// through one key moves every key's reported balance. AuthStorage still
		// probes once per stored key, so two keys yield two identical rows.
		// Summing them would claim 200 credits the account never had.
		const now = Date.now();
		const keyReport = (remaining: number): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt: now,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					amount: { remaining, unit: "credits" },
				},
			],
		});

		const output = stripVTControlCharacters(renderUsageReports([keyReport(100), keyReport(100)], theme, now, 98));
		expect(output).toContain("100 credits left");
		expect(output).not.toContain("200 credits left");
		// The balance must reach the user at all: a remaining-only limit used
		// to fall through to a bare account count.
		expect(output).not.toContain("accts");
	});

	it("renders each marked Antigravity shared quota once in expanded details", () => {
		const quota = (
			counter: "google" | "anthropic" | "openai",
			windowId: "5h" | "weekly",
		): UsageReport["limits"][number] => {
			const sharedGroup = counter === "google" ? undefined : `3p-${windowId}`;
			return {
				id: `google-antigravity:${counter}:default:${counter === "google" ? "gemini" : "3p"}-${windowId}`,
				label: counter === "google" ? "Gemini" : "Claude & GPT (shared)",
				scope: {
					provider: "google-antigravity",
					accountId: "account",
					windowId,
					...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
				},
				window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "Weekly" },
				amount: { unit: "percent", usedFraction: 0.25 },
				status: "ok",
			};
		};
		const reports: UsageReport[] = [
			{
				provider: "google-antigravity",
				fetchedAt: Date.now(),
				limits: [
					quota("google", "5h"),
					quota("google", "weekly"),
					quota("anthropic", "5h"),
					quota("openai", "5h"),
					quota("anthropic", "weekly"),
					quota("openai", "weekly"),
				],
				metadata: { email: "user@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(output.match(/Claude & GPT \(shared\)/g)).toHaveLength(2);
		expect(output.match(/Gemini/g)).toHaveLength(2);
	});

	it("uses the newest shared snapshot instead of stale max headroom", () => {
		const now = Date.now();
		const balance = (fetchedAt: number, remaining: number): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					amount: { remaining, unit: "credits" },
				},
			],
		});

		// Two probes of one pool: the later one observed 95. Reporting the
		// earlier 100 would claim headroom the account already spent.
		const output = stripVTControlCharacters(renderUsageReports([balance(1, 100), balance(2, 95)], theme, now, 98));
		expect(output).toContain("95 credits left");
		expect(output).not.toContain("100 credits left");
	});

	it("keeps independent account pools apart in the detail grid", () => {
		const now = Date.now();
		const balance = (accountId: string, remaining: number): UsageReport => ({
			provider: "zai",
			fetchedAt: now,
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

		const output = stripVTControlCharacters(
			renderUsageReports([balance("acct-a", 100), balance("acct-b", 50)], theme, now, 120),
		);
		expect(output).toContain("150 credits left");
	});

	it("disambiguates duplicate account labels in the detail grid", () => {
		const now = Date.now();
		const shared = (accountId: string, usedFraction: number): UsageReport => ({
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:primary",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", accountId, windowId: "7d" },
					window: { id: "7d", label: "7 days" },
					amount: { usedFraction, unit: "percent" },
				},
			],
			metadata: { accountId, email: "same@example.test" },
		});

		const output = stripVTControlCharacters(
			renderUsageReports([shared("acct-a", 0.2), shared("acct-b", 0.8)], theme, now, 140),
		);
		expect(output).toContain("same@example.test (acct-a)");
		expect(output).toContain("same@example.test (acct-b)");
	});

	it("reports the same pooled balance as the dashboard card model", () => {
		// The two surfaces share one collapse rule now; a divergence here means
		// one of them drifted back to its own aggregation.
		const now = Date.now();
		const charmReport = (remaining: number, endpoint = "https://api.example.test/credits"): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt: now,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: {
						provider: "charm-hyper",
						windowId: "balance",
						shared: true,
						sharedGroup: `charm-hyper:credits:${endpoint}`,
					},
					amount: { remaining, unit: "credits" },
				},
			],
			metadata: { endpoint },
		});
		const onePool = [charmReport(100), charmReport(95)];
		const twoPools = [charmReport(100), charmReport(95, "https://other.example.test/credits")];

		for (const [label, reports, expected] of [
			["one pool", onePool, "100 credits left"],
			["two pools", twoPools, "195 credits left"],
		] as const) {
			const dashboardText = buildProviderCards([...reports], now)[0]?.windows[0]?.usedText;
			expect(dashboardText, label).toBe(expected);
			expect(stripVTControlCharacters(renderUsageReports([...reports], theme, now, 120)), label).toContain(expected);
		}
	});
});
