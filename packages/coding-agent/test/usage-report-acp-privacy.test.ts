import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function report(email: string, orgName: string, orgId: string, accountId: string, limits: boolean): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 1,
		metadata: { email, orgName, orgId, accountId },
		notes: [`Provider notice for ${orgName}`],
		resetCredits: { availableCount: 2, redeemableCount: 0, reason: `Reset unavailable for ${orgName}` },
		limits: limits
			? ["weekly", "daily"].map(windowId => ({
					id: windowId,
					label: windowId,
					scope: { provider: "anthropic", accountId, windowId },
					amount: { unit: "percent", usedFraction: 0.25 },
					notes: [`Limit note for ${orgName}`],
				}))
			: [],
	};
}

function render(reports: UsageReport[], maskAccountLabels: boolean, maskOrganizationNames: boolean): Promise<string> {
	const runtime = {
		settings: Settings.isolated({
			"usage.maskAccountLabels": maskAccountLabels,
			"usage.maskOrganizationNames": maskOrganizationNames,
		}),
		session: { model: undefined, fetchUsageReports: async () => reports },
	} as unknown as SlashCommandRuntime;
	return buildUsageReportText(runtime);
}

function aliasOnRow(text: string, email: string): string {
	const line = text.split("\n").find(value => value.includes(`${email} (`));
	const alias = line?.match(/Org-[a-f0-9]{16}/)?.[0];
	if (!alias) throw new Error(`No organization alias on account row for ${email}`);
	return alias;
}

describe("ACP usage organization privacy", () => {
	for (const maskAccountLabels of [false, true]) {
		it(`keeps organization names visible when disabled while identifier masking is ${maskAccountLabels ? "enabled" : "disabled"}`, async () => {
			const email = "visible@example.test";
			const text = await render(
				[report(email, "Acme North", "org-north", "account-one", true)],
				maskAccountLabels,
				false,
			);
			expect(text).toContain("(Acme North)");
			expect(text).toContain("Provider notice for Acme North");
			expect(text).toContain("Limit note for Acme North");
			expect(text).toContain("Reset unavailable for Acme North");
			expect(text.includes(email)).toBe(!maskAccountLabels);
			expect(text).not.toMatch(/Org-[a-f0-9]{16}/);
		});
		it(`uses one organization alias on account, limit, reset and note rows while identifier masking is ${maskAccountLabels ? "enabled" : "disabled"}`, async () => {
			const emails = ["north-one@example.test", "north-two@example.test"];
			const reports = [
				report(emails[0], "Acme North", "org-north", "account-one", true),
				report(emails[1], "Acme North", "org-north", "account-two", false),
			];
			const text = await render(reports, maskAccountLabels, true);
			expect(text).not.toContain("Acme North");
			for (const email of emails) expect(text.includes(email)).toBe(!maskAccountLabels);
			const aliases = [...new Set(text.match(/Org-[a-f0-9]{16}/g))];
			expect(aliases).toHaveLength(1);
			const alias = aliases[0];
			const rows = text.split("\n");
			expect(rows.filter(value => value.includes(`(${alias}): 2 saved rate-limit resets`))).toHaveLength(2);
			expect(rows.filter(value => value.includes(`(${alias}): 25.00% used`))).toHaveLength(2);
			expect(rows.filter(value => value.includes(`(${alias}): no limits reported`))).toHaveLength(1);
			expect(rows.filter(value => value.includes(`Provider notice for ${alias}`))).toHaveLength(1);
			expect(rows.filter(value => value.includes(`Limit note for ${alias}`))).toHaveLength(2);
			expect(rows.filter(value => value.includes(`Reset unavailable for ${alias}`))).toHaveLength(2);
			const reordered = await render([...reports].reverse(), maskAccountLabels, true);
			expect([...new Set(reordered.match(/Org-[a-f0-9]{16}/g))]).toEqual(aliases);
		});
	}

	it("keeps same-name organizations with different IDs distinct on ACP rows and stable after reordering and renaming", async () => {
		const reports = [
			report("first@example.test", "Shared Team", "org-one", "account-one", true),
			report("second@example.test", "Shared Team", "org-two", "account-two", false),
		];
		const text = await render(reports, false, true);
		expect(text).not.toContain("Shared Team");
		const first = aliasOnRow(text, "first@example.test");
		const second = aliasOnRow(text, "second@example.test");
		expect(first).not.toBe(second);
		const reordered = await render([...reports].reverse(), false, true);
		expect(aliasOnRow(reordered, "first@example.test")).toBe(first);
		expect(aliasOnRow(reordered, "second@example.test")).toBe(second);
		const renamed = reports.map((entry, index) => ({
			...entry,
			metadata: { ...entry.metadata, orgName: `Renamed ${index}` },
		}));
		const renamedText = await render(renamed, false, true);
		expect(aliasOnRow(renamedText, "first@example.test")).toBe(first);
		expect(aliasOnRow(renamedText, "second@example.test")).toBe(second);
		expect(renamedText).not.toContain("Renamed 0");
		expect(renamedText).not.toContain("Renamed 1");
	});
});
