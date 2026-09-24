import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgProvidersMaxInFlightRequests } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

describe("Settings layer refresh", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let startProject: string;
	let scopedProject: string;
	let bareProject: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-reload-");
		agentDir = tempDir.join("agent");
		startProject = tempDir.join("start");
		scopedProject = tempDir.join("scoped");
		bareProject = tempDir.join("bare");
		for (const dir of [agentDir, startProject, bareProject]) fs.mkdirSync(dir, { recursive: true });
		writeProjectSettings(scopedProject, { compaction: { enabled: false } });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const writeConfig = (settings: Record<string, unknown>) => Bun.write(configPath(), YAML.stringify(settings));

	function writeProjectSettings(project: string, settings: Record<string, unknown>): void {
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		fs.writeFileSync(path.join(getProjectAgentDir(project), "settings.json"), JSON.stringify(settings));
	}

	it("rejects an on-disk value that fails validation and keeps the previous layers", async () => {
		await writeConfig({ providers: { maxInFlightRequests: { openai: 2 } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });

		await writeConfig({ providers: { maxInFlightRequests: { openai: 0 } } });
		await expect(settings.reloadFromDisk()).rejects.toThrow("Provider request limits must be positive numbers");
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
	});

	it("refuses to re-scope into a project whose settings fail validation", async () => {
		writeProjectSettings(bareProject, { providers: { maxInFlightRequests: { openai: -1 } } });
		const settings = await Settings.init({ cwd: scopedProject, agentDir });
		let notified = false;
		cfgCompactionEnabled.listen(settings, () => {
			notified = true;
		});

		await expect(settings.reloadForCwd(bareProject)).rejects.toThrow(
			"Provider request limits must be positive numbers",
		);
		await Promise.resolve();
		expect(settings.getCwd()).toBe(path.normalize(scopedProject));
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(notified).toBe(false);
	});

	it("never leaves a re-scoped instance on the previous project's layer when a reload overlaps", async () => {
		const settings = await Settings.init({ cwd: scopedProject, agentDir });
		for (let round = 0; round < 4; round++) {
			await settings.reloadForCwd(scopedProject);
			expect(cfgCompactionEnabled.get(settings)).toBe(false);

			await Promise.all([settings.reloadFromDisk(), settings.reloadForCwd(bareProject)]);
			expect(settings.getCwd()).toBe(path.normalize(bareProject));
			expect(cfgCompactionEnabled.get(settings)).toBe(true);
		}
	});

	it("clears a panel field by removing the key from config.yml, letting the env fallback apply", async () => {
		Bun.env.SEARXNG_ENDPOINT = "https://env.example";
		Bun.env.HINDSIGHT_API_TOKEN = "env-secret";
		await writeConfig({ searxng: { endpoint: "https://cfg.example" }, temperature: 0.4 });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const host = createSettingsHost();

		// The panel edits the configured layers: env values are never shown or pre-filled.
		expect(host.get("hindsight.apiToken")).toBeUndefined();
		expect(host.get("searxng.endpoint")).toBe("https://cfg.example");

		host.unset("searxng.endpoint");
		expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
		await settings.flush();
		expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({ temperature: 0.4 });
	});

	it("drops a pinned default once a reloaded or cloned scope configures the setting", async () => {
		const settings = await Settings.init({ cwd: startProject, agentDir });
		cfgCompactionEnabled.pinDefault(settings);
		expect(cfgCompactionEnabled.provenance(settings)).toBe("runtime");

		const clone = await settings.cloneForCwd(scopedProject);
		expect(cfgCompactionEnabled.get(clone)).toBe(false);
		expect(cfgCompactionEnabled.provenance(clone)).toBe("project");

		await writeConfig({ compaction: { enabled: false } });
		await settings.reloadFromDisk();
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(cfgCompactionEnabled.provenance(settings)).toBe("global");
	});
});
