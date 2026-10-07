import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { UsageDashboardComponent, buildProviderCards } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

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
	it("shows the current Codex plan in interactive account and reset rows without a single-account UUID", () => {
		const now = Date.now();
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			limits: [
				{
					id: "codex-weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "workspace-id" },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: {
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
				planType: "prolite",
			},
			resetCredits: { availableCount: 1 },
		};
		const output = stripVTControlCharacters(
			renderUsageReports([report], theme, now, 98, () => ({
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
			})),
		);
		expect(output).toContain("in use by this session: user@example.test (prolite)");
		expect(output).toContain("user@example.test (prolite): 1 saved reset");
		expect(output).toMatch(/^  ● user@example\.test \(prolite\)/m);
		expect(output).not.toContain("workspace-id");
		expect(output).not.toContain("(free)");
	});

	it("distinguishes same-email Codex accounts even if one has no current plan or limits", () => {
		const now = Date.now();
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map((orgId, index) => ({
			provider: "openai-codex",
			fetchedAt: now,
			limits: [],
			metadata: {
				email: "shared@example.test",
				orgId,
				orgName: "free",
				...(index === 0 ? { planType: "prolite" } : {}),
			},
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("shared@example.test (workspace-one) (prolite) -- no limits");
		expect(output).toContain("shared@example.test (workspace-two) -- no limits");
		expect(output).not.toContain("(free)");
	});

	it("keeps colliding Codex accounts distinct in quota columns", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(orgId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: orgId },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: { email: "shared@example.test", orgId, orgName: "free", planType: "prolite" },
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(output).toMatch(
			/^  shared@example\.test \(workspace-one\) \(prolite\) +shared@example\.test \(workspace-two\) \(prolite\)$/m,
		);
		expect(output).not.toContain("(free)");
	});
	it("marks the matching legacy Codex workspace active when accounts share an email", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(accountId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "shared@example.test", accountId, orgName: "free" },
			resetCredits: { availableCount: 1 },
		}));
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, () => ({
				email: "shared@example.test",
				accountId: "workspace-two",
			})),
		);
		expect(output).toContain("in use by this session: shared@example.test (workspace-two)");
		expect(output).toContain("shared@example.test (workspace-two): 1 saved reset (active)");
		expect(output).toContain("shared@example.test (workspace-one): 1 saved reset\n");
	});

	it("keeps unavailable status visible beside a long account label in a narrow terminal", () => {
		const width = 40;
		const output = stripVTControlCharacters(
			renderUsageReports(
				[],
				theme,
				1_790_424_000_000,
				width,
				undefined,
				[],
				[{ provider: "anthropic", label: `alex · ${"界".repeat(80)}` }],
			),
		);

		expect(output).toMatch(/alex.*usage unavailable/);
		for (const line of output.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps control characters in unavailable account labels from changing terminal layout", () => {
		const rendered = renderUsageReports(
			[],
			theme,
			1_790_424_000_000,
			80,
			undefined,
			[],
			[{ provider: "anthropic", label: "\x1b[2Jalex\r\n\tteam" }],
		);
		const output = stripVTControlCharacters(rendered);

		expect(output).toMatch(/alex +team.*usage unavailable/);
		expect(rendered).not.toContain("\x1b[2J");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
	});

	it("uses the newest shared snapshot instead of stale max headroom", () => {
		const now = Date.now();
		// Production shape: `fetchCharmHyperUsage` marks the balance with an
		// endpoint-scoped pool group, which is what makes two key probes of one
		// account the same pool rather than two accounts.
		const balance = (fetchedAt: number, remaining: number): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: {
						provider: "charm-hyper",
						windowId: "balance",
						shared: true,
						sharedGroup: "charm-hyper:credits",
					},
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

	it("classifies an omitted status the same way the dashboard does", () => {
		// The dismissed review finding: a limit with no provider status used to
		// render a dim/unknown group icon here while the dashboard inferred a
		// verdict from the same numbers.
		const now = Date.now();
		const gemini = (usedFraction: number, status?: "unknown"): UsageReport => ({
			provider: "gemini",
			fetchedAt: now,
			metadata: { email: "a@example.test" },
			limits: [
				{
					id: "gemini:7d",
					label: "7 days",
					scope: { provider: "gemini", windowId: "7d" },
					window: { id: "7d", label: "7 days" },
					amount: { usedFraction, unit: "percent" },
					...(status === undefined ? {} : { status }),
				},
			],
		});

		const groupIcon = (report: UsageReport): string => {
			const lines = stripVTControlCharacters(renderUsageReports([report], theme, now, 100)).split("\n");
			return lines.find(line => line.includes("7 days")) ?? "";
		};

		// Same glyph as the dashboard's verdict for these fractions.
		expect(groupIcon(gemini(1))).toContain("✘");
		expect(groupIcon(gemini(0.95))).toContain("⚠");
		expect(groupIcon(gemini(0.2))).toContain("✔");
		// `unknown` is unreported, not a verdict: the fraction still decides.
		expect(groupIcon(gemini(1, "unknown"))).toContain("✘");
		expect(groupIcon(gemini(1))).toBe(
			groupIcon({ ...gemini(1), limits: [{ ...gemini(1).limits[0]!, status: "exhausted" }] }),
		);
	});
});

describe("interactive /usage account visibility", () => {
	const now = 1_790_424_000_000;
	const email = "shared@example.test";
	const sessionId = "usage-visibility-test";
	let authStorage: AuthStorage;
	let mounted: UsageDashboardComponent | undefined;
	let terminalRows: PropertyDescriptor | undefined;

	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	beforeEach(async () => {
		terminalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
			push([]);
		});
		authStorage = await AuthStorage.create(":memory:");
		await authStorage.credentials.set(
			"anthropic",
			["org-team", "org-personal"].map(orgId => ({
				type: "oauth" as const,
				access: `test-access-${orgId}`,
				refresh: `test-refresh-${orgId}`,
				expires: now + 3_600_000,
				email,
				accountId: "shared-account",
				orgId,
			})),
		);
		await authStorage.credentials.set("tavily", { type: "api_key", key: "test-key" });
		const personal = authStorage.oauth.accounts("anthropic").find(account => account.orgId === "org-personal");
		if (!personal || !authStorage.sessions.pin("anthropic", sessionId, personal.credentialId)) {
			throw new Error("Expected the personal account to be selectable");
		}
	});

	afterEach(() => {
		mounted?.dispose();
		mounted = undefined;
		authStorage?.close();
		if (terminalRows) Object.defineProperty(process.stdout, "rows", terminalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
		vi.restoreAllMocks();
	});

	function command(
		fetchUsageReports?: () => Promise<UsageReport[] | null>,
		warnings: string[] = [],
	): CommandController {
		const ctx = createInteractiveModeContext({
			session: {
				sessionId,
				model: { provider: "anthropic" },
				modelRegistry: { authStorage },
				fetchUsageReports,
				getUsageReportingModelSelectors: () => [],
			},
			ui: {
				showOverlay: component => {
					if (!(component instanceof UsageDashboardComponent)) throw new Error("Expected usage dashboard");
					mounted = component;
					return {
						hide: () => {
							mounted = undefined;
						},
						setHidden: () => {},
						isHidden: () => false,
					};
				},
			},
			showWarning: message => {
				warnings.push(message);
			},
		});
		const selector = new SelectorController(ctx);
		ctx.showUsageDashboard = reports => selector.showUsageDashboard(reports);
		return new CommandController(ctx);
	}

	function display(): string {
		return stripVTControlCharacters(mounted?.render(120).join("\n") ?? "");
	}

	it("warns without opening the dashboard when usage reporting is not configured", async () => {
		const warnings: string[] = [];
		await command(undefined, warnings).handleUsageCommand();

		expect(warnings).toEqual([expect.stringContaining("not configured")]);
		expect(mounted).toBeUndefined();
	});

	it("keeps a missing Claude subscription visible beside its same-email sibling's real usage", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			metadata: { email, accountId: "shared-account", orgId: "org-team" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", accountId: "shared-account", orgId: "org-team", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: now + 3_600_000 },
					amount: { usedFraction: 0.25, unit: "percent" },
					status: "ok",
				},
			],
			resetCredits: { availableCount: 2, redeemableCount: 1 },
		};
		await command(async () => [report]).handleUsageCommand();

		const overview = display();
		expect(overview).toContain("2 accts");
		expect(overview).toContain(email);
		expect(overview).toContain("org-personal");
		expect(overview).toContain("usage unavailable");
		expect(overview).toContain("75%");
		expect(overview).not.toContain("Tavily");

		mounted?.handleInput("\r");
		const details = display();
		expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
		expect(details).toContain("shared@example.test (org-team)");
		expect(details).toContain("75% free");
		expect(details).toContain("2 saved resets");
		expect(details).toContain("1 usable now");
		expect(details).toContain("in use by this session: shared@example.test (org-personal)");
		expect(details).not.toMatch(/org-team.*usage unavailable/);
	});

	it.each(["empty", "null", "error"] as const)(
		"opens both stored Claude subscriptions with unknown usage when lookup returns %s",
		async result => {
			await command(async () => {
				if (result === "error") throw new Error("usage endpoint unavailable");
				return result === "null" ? null : [];
			}).handleUsageCommand();

			const overview = display();
			expect(overview).toContain("2 accts");
			expect(overview.match(/shared@example\.test/g)).toHaveLength(2);
			expect(overview).toContain("org-team");
			expect(overview).toContain("org-personal");
			expect(overview.match(/usage unavailable/g)).toHaveLength(2);
			expect(overview).not.toContain("%");
			expect(overview).not.toContain("untouched");
			expect(overview).not.toContain("no limits");
			expect(overview).not.toContain("Tavily");

			mounted?.handleInput("\r");
			const details = display();
			expect(details).toMatch(/shared@example\.test.*org-team.*usage unavailable/);
			expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
			expect(details).toContain("in use by this session: shared@example.test (org-personal)");
			expect(details).not.toContain("%");
			expect(details).not.toContain("Infinity");

			mounted?.handleInput("\x1b");
			expect(display()).toContain("2 accts");
			mounted?.handleInput("\x1b");
			expect(mounted).toBeUndefined();
		},
	);
});
