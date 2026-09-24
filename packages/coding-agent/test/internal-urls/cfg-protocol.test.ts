import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CfgAppliedChange,
	type CfgChangeRequest,
	CfgProtocolHandler,
	setCfgApprovalHost,
} from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

import { cfgAdvisorEnabled, cfgAdvisorSyncBacklog } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { cfgEditFuzzyMatch } from "@oh-my-pi/pi-coding-agent/edit/settings";

function sessionWith(settings: Settings, caller: Partial<ToolSession> = {}): ToolSession {
	return { settings, hasUI: true, settingsApproval: true, taskDepth: 0, ...caller } as unknown as ToolSession;
}

const handler = new CfgProtocolHandler();
const read = (url: string, settings: Settings) =>
	handler.resolve(parseInternalUrl(url), { session: sessionWith(settings) });
const write = (url: string, content: string, settings: Settings, caller?: Partial<ToolSession>) =>
	handler.write(parseInternalUrl(url), content, { session: sessionWith(settings, caller) });

describe("CfgProtocolHandler", () => {
	afterEach(() => setCfgApprovalHost(null));

	it("lists a namespace relative to its prefix and a setting with its source", async () => {
		const settings = Settings.isolated({ "advisor.syncBacklog": "3" });

		const namespace = await read("cfg://advisor", settings);
		expect(namespace.content).toContain('syncBacklog: "3"  # off|1|3|5 · default "off"');
		expect(namespace.content).not.toContain("advisor:");
		expect(namespace.details?.cfg).toMatchObject({ path: "advisor", modified: 1 });

		const leaf = await read("cfg://Advisor.SyncBacklog", settings);
		expect(leaf.content).toStartWith('advisor.syncBacklog: "3"');
		expect(leaf.content).toContain("source: session override");
	});

	it("redacts credential values", async () => {
		const settings = Settings.isolated({ "auth.broker.token": "sekrit" });
		const resource = await read("cfg://auth", settings);
		expect(resource.content).toContain("token: <redacted>");
		expect(resource.content).not.toContain("sekrit");
	});

	it("refuses writes when no host can ask the user", async () => {
		const settings = Settings.isolated();
		await expect(write("cfg://advisor/enabled", "true", settings)).rejects.toThrow("requires user approval");
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
	});

	it("refuses subagent and headless writes without prompting the user", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), true),
			applied: () => {},
			persistentSettings: settings,
		});

		await expect(write("cfg://advisor/enabled", "true", settings, { taskDepth: 1 })).rejects.toThrow(
			"Subagents cannot change settings",
		);
		await expect(write("cfg://advisor/enabled/save", "true", settings, { settingsApproval: false })).rejects.toThrow(
			"no interactive UI",
		);
		expect(asked).toEqual([]);
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
	});

	it("applies a session change only after approval and leaves disk untouched", async () => {
		const settings = Settings.isolated();
		const persistent = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		const applied: CfgAppliedChange[] = [];
		let allow = false;
		setCfgApprovalHost({
			approve: async request => (asked.push(request), allow),
			applied: change => applied.push(change),
			persistentSettings: persistent,
		});

		const declined = await write("cfg://advisor/enabled", "true", settings);
		expect(declined.details?.cfg?.outcome).toBe("declined");
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		expect(applied).toEqual([]);

		allow = true;
		const result = await write("cfg://advisor/enabled", "true", settings);
		expect(result.details?.cfg?.outcome).toBe("applied");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("cfg://advisor/enabled/save");
		// The host must learn about the change to start components (e.g. the advisor) that read it once.
		expect(applied).toEqual([{ path: "advisor.enabled", value: true, settings, save: false }]);
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
		expect(cfgAdvisorEnabled.isConfigured(persistent)).toBe(false);
		expect(asked).toEqual([
			{ path: "advisor.enabled", previous: "false", value: "true", save: false },
			{ path: "advisor.enabled", previous: "false", value: "true", save: false },
		]);
	});

	it("reports a session change an environment variable still overrides", async () => {
		const settings = Settings.isolated();
		setCfgApprovalHost({ approve: async () => true, applied: () => {}, persistentSettings: Settings.isolated() });
		const previous = Bun.env.PI_EDIT_FUZZY;
		Bun.env.PI_EDIT_FUZZY = "1";
		try {
			const result = await write("cfg://edit/fuzzyMatch", "false", settings);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(result.details?.cfg).toMatchObject({ outcome: "applied", effective: "true" });
			expect(text).toContain("Effective value is still true");
			expect(text).not.toContain("/save");
			expect(cfgEditFuzzyMatch.get(settings)).toBe(true);
		} finally {
			if (previous === undefined) delete Bun.env.PI_EDIT_FUZZY;
			else Bun.env.PI_EDIT_FUZZY = previous;
		}
	});

	it("persists /save writes to the host settings and mirrors them into a separate session instance", async () => {
		const settings = Settings.isolated();
		const persistent = Settings.isolated();
		const applied: Settings[] = [];
		setCfgApprovalHost({
			approve: async () => true,
			applied: change => applied.push(change.settings),
			persistentSettings: persistent,
		});

		await write("cfg://advisor/syncBacklog/save", '"5"', settings);
		expect(cfgAdvisorSyncBacklog.get(persistent)).toBe("5");
		expect(cfgAdvisorSyncBacklog.provenance(persistent)).toBe("global");
		expect(cfgAdvisorSyncBacklog.get(settings)).toBe("5");
		expect(applied).toHaveLength(2);
		expect(applied[0]).toBe(persistent);
		expect(applied[1]).toBe(settings);
	});

	it("rejects namespace targets and values outside the schema before asking", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), true),
			applied: () => {},
			persistentSettings: settings,
		});

		await expect(write("cfg://advisor", "true", settings)).rejects.toThrow("is a namespace");
		await expect(write("cfg://advisor/syncBacklog", "7", settings)).rejects.toThrow("Valid values: off, 1, 3, 5");
		await expect(write("cfg://advisr/enabled", "true", settings)).rejects.toThrow("Similar: advisor.enabled");
		expect(asked).toEqual([]);
	});
});
