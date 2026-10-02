import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { acquireFileLock, getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgProvidersMaxInFlightRequests, cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";

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

	it("never adopts an invalid on-disk value through the save that merges external edits", async () => {
		await writeConfig({ providers: { maxInFlightRequests: { openai: 2 } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		await writeConfig({ providers: { maxInFlightRequests: { openai: 0 } } });
		await expect(settings.reloadFromDisk()).rejects.toThrow("Provider request limits must be positive numbers");

		cfgTemperature.set(settings, 0.5);
		await settings.flush();
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
		expect(cfgTemperature.get(settings)).toBe(0.5);
		// The file keeps the external edit for the user to fix, merged with the save.
		expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({
			providers: { maxInFlightRequests: { openai: 0 } },
			temperature: 0.5,
		});
	});

	it("keeps global writes made while a save waits on the lock live and persists them next", async () => {
		await writeConfig({ compaction: { enabled: false } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange([cfgTemperature, cfgCompactionEnabled, cfgProvidersMaxInFlightRequests], setting => {
			seen.push([setting.id, setting.get(settings)]);
		});

		// Another writer holds config.yml's lock: the save snapshots its pending write, then waits.
		const lock = await acquireFileLock(configPath());
		cfgTemperature.set(settings, 0.5);
		const saving = settings.flush();
		cfgCompactionEnabled.unset(settings);
		cfgProvidersMaxInFlightRequests.set(settings, { openai: 3 });
		lock.release();
		await saving;

		expect(cfgCompactionEnabled.get(settings)).toBe(true);
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 3 });
		await settings.flush();
		expect(seen).toEqual([
			["temperature", 0.5],
			["compaction.enabled", true],
			["providers.maxInFlightRequests", { openai: 3 }],
		]);
		expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({
			temperature: 0.5,
			providers: { maxInFlightRequests: { openai: 3 } },
		});
	});

	it("persists a setting written again while its save waits on the lock without a stale-edit warning", async () => {
		await writeConfig({ temperature: 0.1 });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const warn = spyOn(logger, "warn");
		try {
			const lock = await acquireFileLock(configPath());
			cfgTemperature.set(settings, 0.5);
			const saving = settings.flush();
			cfgTemperature.set(settings, 0.7);
			lock.release();
			await saving;
			expect(cfgTemperature.get(settings)).toBe(0.7);

			await settings.flush();
			expect(warn).not.toHaveBeenCalled();
			expect(cfgTemperature.get(settings)).toBe(0.7);
			expect(YAML.parse(await Bun.file(configPath()).text())).toEqual({ temperature: 0.7 });
		} finally {
			warn.mockRestore();
		}
	});

	it("notifies listeners when a reload only reorders a precedence-sensitive record", async () => {
		await writeConfig({ edit: { modelVariants: { claude: "patch", sonnet: "replace" } } });
		const settings = await Settings.init({ cwd: startProject, agentDir });
		const seen: string[][] = [];
		cfgEditModelVariants.listen(settings, value => {
			seen.push(Object.keys(value));
		});

		await writeConfig({ edit: { modelVariants: { sonnet: "replace", claude: "patch" } } });
		await settings.reloadFromDisk();
		expect(Object.keys(cfgEditModelVariants.get(settings))).toEqual(["sonnet", "claude"]);
		await Promise.resolve();
		expect(seen).toEqual([["sonnet", "claude"]]);
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
