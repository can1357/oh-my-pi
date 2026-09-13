/**
 * /profile slash-command tests: direct activation, off, unknown names, and
 * that switching never rewrites the base modelRoles.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { expandRoleAlias } from "../src/config/model-resolver";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { activateProfile, profilePickerEntries } from "../src/slash-commands/helpers/profile-command";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

describe("/profile", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let settings: Settings;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profile-command-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });

		// Real config layers: Settings.isolated() would put everything in the
		// runtime layer, but profile definitions are (by design) read from the
		// config layers only.
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					modelRoles: { default: "provider/base-main", smol: "provider/base-smol" },
					profiles: {
						cheap: {
							description: "Low-cost",
							modelRoles: { default: "provider/cheap-main", smol: "provider/cheap-smol" },
						},
						normal: { modelRoles: { default: "provider/normal-main" } },
					},
					activeProfile: "",
				},
				null,
				2,
			),
		);
		settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
	});

	afterEach(async () => {
		settings.cancelPendingSaves();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
		await tempDir?.remove();
	});

	test("activateProfile switches the effective roles without touching base", () => {
		activateProfile(settings, "cheap");
		expect(settings.getActiveProfile()).toBe("cheap");
		expect(settings.getModelRole("default")).toBe("provider/cheap-main");
		expect(expandRoleAlias("@smol", settings)).toBe("provider/cheap-smol");
		expect(settings.getGlobalModelRole("default")).toBe("provider/base-main");
		expect(settings.getGlobalModelRole("smol")).toBe("provider/base-smol");
	});

	test("activateProfile with 'off' disables and restores base behavior", () => {
		activateProfile(settings, "cheap");
		expect(settings.isProfileActive()).toBe(true);
		activateProfile(settings, "off");
		expect(settings.getActiveProfile()).toBe("");
		expect(settings.isProfileActive()).toBe(false);
		expect(settings.getModelRole("default")).toBe("provider/base-main");
		expect(expandRoleAlias("@smol", settings)).toBe("provider/base-smol");
	});

	test("activateProfile with unknown name returns an error and changes nothing", () => {
		const message = activateProfile(settings, "nope");
		expect(message).toContain("Unknown profile");
		expect(settings.getActiveProfile()).toBe("");
		expect(settings.getModelRole("default")).toBe("provider/base-main");
	});

	test("bare activation when none is active reports no active profile", () => {
		const message = activateProfile(settings, "");
		expect(message).toBe("No active profile.");
	});

	test("profilePickerEntries lists configured profiles plus off, with descriptions", () => {
		const entries = profilePickerEntries(settings);
		const names = entries.map(entry => entry.name);
		expect(names).toContain("cheap");
		expect(names).toContain("normal");
		expect(names[names.length - 1]).toBe("off");
		expect(entries.find(entry => entry.name === "cheap")?.description).toBe("Low-cost");
	});
});
