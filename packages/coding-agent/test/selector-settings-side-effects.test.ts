import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgUsageMaskAccountLabels } from "@oh-my-pi/pi-coding-agent/commands/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const email = "private@example.test";
const reports: UsageReport[] = [
	{
		provider: "anthropic",
		fetchedAt: 1,
		metadata: { email, orgName: "Team" },
		notes: [`Account ${email}`],
		resetCredits: { availableCount: 2 },
		limits: [
			{
				id: "weekly",
				label: "Weekly",
				scope: { provider: "anthropic", accountId: "sensitive-account" },
				amount: { usedFraction: 0.5, unit: "percent" },
				notes: [`Quota for ${email}`],
			},
		],
	},
];
beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("usage setting side effects", () => {
	it("loads global privacy into the overlay and text report without persisting temporary toggles", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-privacy-"));
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(agentDir);
		await fs.mkdir(cwd);
		const config = "usage:\n  maskAccountLabels: true\n  mergeAccounts: false\n";
		await Bun.write(path.join(agentDir, "config.yml"), config);
		const authStorage = await AuthStorage.create(":memory:");
		let mounted: UsageDashboardComponent | undefined;
		try {
			const settings = await Settings.loadReadOnly({ agentDir, cwd });
			vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
				push([]);
			});
			const ctx = createInteractiveModeContext({
				settings,
				session: { modelRegistry: { authStorage }, getUsageReportingModelSelectors: () => [] },
				ui: {
					showOverlay: component => {
						if (!(component instanceof UsageDashboardComponent)) throw new Error("Expected dashboard");
						mounted = component;
						return { hide() {}, setHidden() {}, isHidden: () => false };
					},
				},
			});
			const selector = new SelectorController(ctx);
			selector.showUsageDashboard(reports);
			expect(Bun.stripANSI(mounted!.render(120).join("\n"))).not.toContain(email);
			mounted!.handleInput("p");
			expect(Bun.stripANSI(mounted!.render(120).join("\n"))).toContain(email);
			mounted!.handleInput("\u001b");
			mounted!.dispose();
			expect(cfgUsageMaskAccountLabels.get(settings)).toBe(true);
			expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(config);
			selector.showUsageDashboard(reports);
			expect(Bun.stripANSI(mounted!.render(120).join("\n"))).not.toContain(email);
			const text = await buildUsageReportText({
				settings,
				session: { model: undefined, fetchUsageReports: async () => reports },
			} as never);
			expect(text).not.toContain(email);
			expect(text).toContain("Account pri***");
			expect(text).toContain("saved rate-limit resets");
		} finally {
			mounted?.dispose();
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("lets one session mask usage without changing another session or the default report", async () => {
		const normal = Settings.isolated();
		const masked = Settings.isolated({ "usage.maskAccountLabels": true });
		const render = (settings: Settings) =>
			buildUsageReportText({
				settings,
				session: { model: undefined, fetchUsageReports: async () => reports },
			} as never);
		expect(await render(normal)).toContain(email);
		expect(await render(masked)).not.toContain(email);
		expect(await render(normal)).toContain(email);
	});
});

it("organization privacy seeds both reports and temporary overlay controls without hiding email or saving toggles", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-org-privacy-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir);
	await fs.mkdir(cwd);
	const config = "usage:\n  maskAccountLabels: false\n  maskOrganizationNames: true\n  mergeAccounts: false\n";
	await Bun.write(path.join(agentDir, "config.yml"), config);
	const authStorage = await AuthStorage.create(":memory:");
	let mounted: UsageDashboardComponent | undefined;
	try {
		const settings = await Settings.loadReadOnly({ agentDir, cwd });
		vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
			push([]);
		});
		const ctx = createInteractiveModeContext({
			settings,
			session: { modelRegistry: { authStorage }, getUsageReportingModelSelectors: () => [] },
			ui: {
				showOverlay: component => {
					if (!(component instanceof UsageDashboardComponent)) throw new Error("Expected dashboard");
					mounted = component;
					return { hide() {}, setHidden() {}, isHidden: () => false };
				},
			},
		});
		const selector = new SelectorController(ctx);
		selector.showUsageDashboard(reports);
		expect(Bun.stripANSI(mounted!.render(120).join("\n"))).not.toContain("Team");
		expect(Bun.stripANSI(mounted!.render(120).join("\n"))).toContain(email);
		mounted!.handleInput("enter");
		expect(Bun.stripANSI(mounted!.render(120).join("\n"))).not.toContain("Team");
		mounted!.handleInput("o");
		expect(Bun.stripANSI(mounted!.render(120).join("\n"))).toContain("Team");
		mounted!.dispose();
		selector.showUsageDashboard(reports);
		expect(Bun.stripANSI(mounted!.render(120).join("\n"))).not.toContain("Team");
		const text = await buildUsageReportText({
			settings,
			session: { model: undefined, fetchUsageReports: async () => reports },
		} as never);
		expect(text).not.toContain("Team");
		expect(text).toContain(email);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(config);
	} finally {
		mounted?.dispose();
		authStorage.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
