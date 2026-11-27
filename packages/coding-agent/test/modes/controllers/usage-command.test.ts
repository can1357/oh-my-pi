import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { defaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type JSXNode, type KeyEvent, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { printRows } from "../../../src/ui/print-rows";
import { Overlays } from "../../../src/ui/shell/overlays";
import { initTheme } from "../../../src/ui/theme/service";
import { nativeShell } from "../../helpers/native-shell";

let theme: Theme;

/** A key as the driver reports it. */
function key(id: string, raw: string): KeyEvent {
	return { id, kind: "press", raw };
}

describe("renderUsageReports content", () => {
	beforeAll(() => {
		initTheme();
		theme = currentTheme();
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

	it("renders each marked shared quota once in expanded details", () => {
		const quota = (
			counter: "google" | "anthropic" | "openai",
			windowId: "5h" | "weekly",
		): UsageReport["limits"][number] => {
			const sharedGroup = counter === "google" ? undefined : `3p-${windowId}`;
			return {
				id: `google:${counter}:default:${counter === "google" ? "gemini" : "3p"}-${windowId}`,
				label: counter === "google" ? "Gemini" : "Claude & GPT (shared)",
				scope: {
					provider: "google",
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
				provider: "google",
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
});

describe("interactive /usage account visibility", () => {
	const now = 1_790_424_000_000;
	const email = "shared@example.test";
	const sessionId = "usage-visibility-test";
	let authStorage: AuthStorage;
	let overlays: Overlays;
	let terminalRows: PropertyDescriptor | undefined;

	beforeAll(() => {
		initTheme();
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
		overlays?.closeAll();
		authStorage?.close();
		if (terminalRows) Object.defineProperty(process.stdout, "rows", terminalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
		vi.restoreAllMocks();
	});

	function rowsShell() {
		const focused = signal<UiNode | null>(null);
		return {
			overlays: new Overlays({ focused, focus: node => focused.set(node), fallback: () => null }),
			focus: (node: UiNode | null) => focused.set(node),
			size: () => ({ columns: 120, rows: 40 }),
			native: () => false,
		};
	}

	function command(
		fetchUsageReports?: () => Promise<UsageReport[] | null>,
		warnings: string[] = [],
		shell: Pick<InteractiveModeContext["shell"], "overlays" | "focus" | "size" | "native"> = rowsShell(),
	): CommandController {
		overlays = shell.overlays;
		const ctx = {
			session: {
				sessionId,
				model: { provider: "anthropic" },
				modelRegistry: { authStorage },
				fetchUsageReports,
				getUsageReportingModelSelectors: () => [],
			},
			sessionManager: { getStorage: defaultSessionStorage },
			shell,
			showWarning: (message: string) => {
				warnings.push(message);
			},
			showError: () => {},
		} as unknown as InteractiveModeContext;
		const selector = new SelectorController(ctx);
		ctx.showUsageDashboard = reports => selector.showUsageDashboard(reports);
		return new CommandController(ctx);
	}

	/** The open dashboard's layer (its keys are taken there), if any. */
	function mounted(): UiNode | undefined {
		return overlays.top()?.node;
	}

	function display(): string {
		const layer = mounted();
		return layer
			? stripVTControlCharacters(renderBlock(layer, 120, { theme: currentTheme(), height: 40 }).rows.join("\n"))
			: "";
	}

	function press(id: string, raw: string): void {
		mounted()?.handlers.onKey?.(key(id, raw));
	}

	it("renders advisor status before usage refresh returns", async () => {
		const refresh = Promise.withResolvers<UsageReport[] | null>();
		let report: (() => JSXNode) | undefined;
		const ctx = {
			commandReportRows: () => 20,
			keybindings: { keysFor: () => ["escape"] },
			shell: {
				native: () => false,
				size: () => ({ columns: 120, rows: 30 }),
				dock: { slot: () => ({ set: (factory: () => JSXNode) => (report = factory), clear: () => {} }) },
			},
			session: {
				getAdvisorStats: () => ({
					configured: true,
					active: false,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					messages: { user: 0, assistant: 0, total: 0 },
					advisors: [],
				}),
				fetchUsageReports: () => refresh.promise,
				modelRegistry: { authStorage },
			},
		} as unknown as InteractiveModeContext;
		const result = new CommandController(ctx).handleAdvisorStatusCommand();
		if (!report) throw new Error("Expected the advisor report above the editor");
		expect(stripVTControlCharacters(printRows(report, 120).join("\n"))).toContain("Advisor Status");
		refresh.resolve([]);
		await result;
	});

	it("warns without opening the dashboard when usage reporting is not configured", async () => {
		const warnings: string[] = [];
		await command(undefined, warnings).handleUsageCommand();

		expect(warnings).toEqual([expect.stringContaining("not configured")]);
		expect(mounted()).toBeUndefined();
	});

	it("mounts /usage as a centered native sheet with a scrolling report and a Close footer", async () => {
		await using ui = await nativeShell();
		await command(async () => [], [], ui.shell).handleUsageCommand();

		const sheet = ui.node("overlay");
		expect(sheet.parent).toBe("layer");
		expect(sheet.p).toMatchObject({
			role: "omp.overlay.usage",
			head: "Usage",
			anchor: "center",
			size: "lg",
			modal: true,
		});
		const body = ui.node("col", "overview");
		const footer = ui.node("row", "actions");
		// The renderer pads the direct content column and pins its last action row.
		expect(sheet.c).toHaveLength(1);
		expect(body.parent).toBe(sheet.c[0] ?? null);
		expect(body.p.role).toBe("omp.usage.body");
		expect(footer.parent).toBe(body.parent);
		expect(footer.p.role).toBe("omp.actions");
		expect(mounted()?.children()[0]?.children().at(-1)?.key()).toBe("actions");
		expect(ui.node("button", "close").parent).toBe(footer.id);

		ui.send({ ev: "select", sf: ui.sf, id: ui.node("tabs", "tabs").id, item: "detail" });
		expect(ui.node("tabs", "tabs").p.active).toBe("detail");
		ui.click("button", "close");
		expect(mounted()).toBeUndefined();
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

		expect(mounted()?.props()).toMatchObject({ size: "full", role: "omp.app.screen" });
		const overview = display();
		expect(overview).toContain("2 accts");
		expect(overview).toContain(email);
		expect(overview).toContain("org-personal");
		expect(overview).toContain("usage unavailable");
		expect(overview).toContain("75%");
		expect(overview).not.toContain("Tavily");

		press("enter", "\r");
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

			press("enter", "\r");
			const details = display();
			expect(details).toMatch(/shared@example\.test.*org-team.*usage unavailable/);
			expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
			expect(details).toContain("in use by this session: shared@example.test (org-personal)");
			expect(details).not.toContain("%");
			expect(details).not.toContain("Infinity");

			press("escape", "\x1b");
			expect(display()).toContain("2 accts");
			press("escape", "\x1b");
			expect(mounted()).toBeUndefined();
		},
	);
});
