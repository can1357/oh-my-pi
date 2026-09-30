import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("marks only the matching organization name active on metadata-only reset rows", () => {
		const reports: UsageReport[] = ["East", "West"].map(orgName => ({
			provider: "openai",
			fetchedAt: 1,
			limits: [],
			metadata: { email: "shared@example.test", orgName },
			resetCredits: { availableCount: 1 },
		}));
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, 1, 120, () => ({
				email: "shared@example.test",
				orgName: "East",
			})),
		);
		const resetRows = text.split("\n").filter(line => line.includes("saved reset"));
		expect(resetRows.find(line => line.includes("(East)"))).toContain("(active)");
		expect(resetRows.find(line => line.includes("(West)"))).not.toContain("(active)");
	});

	it("separates opaque parentheses from trusted reset and active-account qualifiers", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai",
				fetchedAt: 1,
				limits: [],
				metadata: { accountId: "Jane Doe (finance)" },
				resetCredits: { availableCount: 1 },
			},
			{
				provider: "openai",
				fetchedAt: 1,
				limits: [],
				metadata: { accountId: "Jane Doe", orgName: "finance" },
				resetCredits: { availableCount: 2 },
			},
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, 1, 120, () => ({ accountId: "Jane Doe (finance)" }), {
				maskAccountLabels: true,
			}),
		);
		expect(text).toContain("Jan***: 1 saved reset");
		expect(text).toContain("Jan*** (finance): 2 saved resets");
		expect(text).not.toContain("Jane Doe");
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
		expect(output).toMatch(/[█░]/);
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

	it("marks the saved reset row when its report matches the active account", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", accountId: "acct-active" },
						window: { id: "weekly", label: "weekly" },
						amount: { usedFraction: 0.2, unit: "percent" },
						status: "ok",
					},
				],
				metadata: { email: "active@example.com", accountId: "acct-active" },
				resetCredits: { availableCount: 1 },
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, now, 98, () => ({ accountId: "acct-active" })),
		);
		expect(output).toContain("active@example.com: 1 saved reset (active)");
	});

	it("disambiguates a reportless active account against a colliding reported sibling", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", accountId: "acct-sibling" },
						window: { id: "weekly", label: "weekly" },
						amount: { usedFraction: 0.2, unit: "percent" },
						status: "ok",
					},
				],
				metadata: { email: "shared@example.com", accountId: "acct-sibling" },
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(
				reports,
				theme,
				now,
				98,
				() => ({ email: "shared@example.com", accountId: "acct-active" }),
				{ maskAccountLabels: true },
			),
		);
		expect(output).toContain("in use by this session: sha*** (2)");
		expect(output).toContain("  sha***");
	});

	it("uses the reported account mask for an email-only active credential", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1,
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", accountId: "reported-account" },
						window: { id: "weekly", label: "weekly" },
						amount: { usedFraction: 0.2, unit: "percent" },
						status: "ok",
					},
				],
				metadata: { email: "alice@example.test", accountId: "reported-account" },
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, 1, 98, () => ({ email: "alice@example.test" }), {
				maskAccountLabels: true,
			}),
		);
		expect(output).toContain("in use by this session: ali***");
		expect(output).not.toContain("ali*** (2)");
		expect(output).not.toContain("alice@example.test");
	});

	it("distinguishes scoped sibling masks despite retained report metadata", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1,
				metadata: { email: "alice@example.test", accountId: "retained-account" },
				limits: ["first", "second"].map(accountId => ({
					id: accountId,
					label: "Weekly",
					scope: { provider: "openai-codex", accountId },
					window: { id: "weekly", label: "weekly" },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				})),
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, 1, 120, undefined, {
				maskAccountLabels: true,
			}),
		);
		expect(output).toContain("ali*** (2)");
		expect(output).not.toContain("alice@example.test");
	});

	it.each(["accountId", "projectId"])("retains the matching scoped %s in the active-session banner", field => {
		const active = field === "accountId" ? { accountId: "active-account" } : { projectId: "active-project" };
		const other = field === "accountId" ? { accountId: "other-account" } : { projectId: "other-project" };
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1,
				limits: [other, active].map((identity, index) => ({
					id: `weekly-${index}`,
					label: "Weekly",
					scope: { provider: "openai-codex", ...identity },
					window: { id: "weekly", label: "weekly" },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				})),
			},
		];
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, 1, 120, () => active));
		expect(output).toContain(
			`in use by this session: ${field === "accountId" ? active.accountId : active.projectId}`,
		);
		expect(output).not.toContain("in use by this session: account ");
	});

	it("keeps combined fractional quota rows within narrow report widths", () => {
		const reports: UsageReport[] = ["acct-1", "acct-2"].map((accountId, index) => ({
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			limits: [
				{
					id: "codex-weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", tier: "pro", accountId },
					window: { id: "weekly", label: "weekly" },
					amount: { usedFraction: index === 0 ? 0.25 : 0.75, unit: "requests" },
					status: "ok",
				},
			],
			metadata: { email: `user${index + 1}@example.com`, accountId },
		}));

		for (const width of [20, 16]) {
			const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), width));
			const quotaLines = output.split("\n").filter(line => line.includes("free") || line.includes("combined"));
			expect(quotaLines.every(line => [...line].length <= width)).toBe(true);
			if (width === 20) expect(output).toContain("combined");
			else expect(output).not.toContain("combined 50% free");
		}
	});

	it("marks metadata-only saved resets active and bounds sanitized organization labels", () => {
		const width = 48;
		const orgName = `Team\t\x1b[2J${" very-long".repeat(12)}`;
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: {
					email: "active@example.com",
					accountId: "acct-active",
					orgName,
				},
				resetCredits: { availableCount: 1 },
			},
		];
		const rendered = renderUsageReports(reports, theme, Date.now(), width, () => ({
			email: "active@example.com",
			accountId: "acct-active",
			orgName,
		}));
		const output = stripVTControlCharacters(rendered);
		const resetLine = output.split("\n").find(line => line.includes("saved reset"));
		expect(resetLine).toBeDefined();
		expect(resetLine).toContain("(active)");
		expect(resetLine).not.toContain("\t");
		expect(resetLine!.length).toBeLessThanOrEqual(width);
	});

	it("distinguishes masked saved reset labels whose qualified account labels differ", () => {
		const reports: UsageReport[] = ["First org", "Second org"].map((orgName, index) => ({
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			limits: [],
			metadata: {
				email: index === 0 ? "main-one@example.com" : "main-two@example.com",
				accountId: `acct-${index + 1}`,
				orgName,
			},
			resetCredits: { availableCount: 1 },
		}));

		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 98, undefined, { maskAccountLabels: true }),
		);
		expect(output).toContain("mai*** (First org): 1 saved reset");
		expect(output).toContain("mai*** (Second org): 1 saved reset");
	});

	it("normalizes CRLF account labels and masks short opaque identities", () => {
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { accountId: "ab\r\ncd", orgName: "Org\tName" },
				resetCredits: { availableCount: 1 },
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 80, undefined, { maskAccountLabels: true }),
		);
		const resetLine = output.split("\n").find(line => line.includes("saved reset"));
		expect(resetLine).toContain("ab *** (Org   Name): 1 saved reset");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
	});

	it("preserves reset count and active marker at minimum width", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { email: "active@example.com" },
				resetCredits: { availableCount: 1 },
			},
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { email: "other@example.com" },
				resetCredits: { availableCount: 2 },
			},
		];
		const width = 20;
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), width, () => ({ email: "active@example.com" })),
		);
		const resetLines = output
			.split("\n")
			.filter(line => line.includes("saved reset") || /\d+ resets?(?: \(|$)/.test(line));
		expect(resetLines.some(line => line.includes("1 reset") && line.includes("(active)"))).toBe(true);
		expect(resetLines.some(line => line.includes("2 resets"))).toBe(true);
		expect(resetLines.filter(line => line.includes("saved reset")).every(line => [...line].length <= width)).toBe(
			true,
		);
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
			renderUsageReports([], theme, 1_790_424_000_000, width, undefined, {
				unavailableAccounts: [{ provider: "anthropic", label: `alex · ${"界".repeat(80)}` }],
			}),
		);

		expect(output).toMatch(/alex.*usage unavailable/);
		for (const line of output.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps control characters in unavailable account labels from changing terminal layout", () => {
		const rendered = renderUsageReports([], theme, 1_790_424_000_000, 80, undefined, {
			unavailableAccounts: [{ provider: "anthropic", label: "\x1b[2Jalex\r\n\tteam" }],
		});
		const output = stripVTControlCharacters(rendered);

		expect(output).toMatch(/alex +team.*usage unavailable/);
		expect(rendered).not.toContain("\x1b[2J");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
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
