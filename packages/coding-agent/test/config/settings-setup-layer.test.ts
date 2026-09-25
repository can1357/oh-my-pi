import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { findScopedSettings, type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRetryFallbackChains, cfgTemperature, cfgTopP } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// The session setup holds a loaded profile: it ranks between runtime overrides and `--config`
// overlays, never persists, and yields exactly what a persisted write touches.
describe("Settings session setup layer", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;
	let overlayPath: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-setup-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		overlayPath = tempDir.join("overlay.yml");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const readConfig = async (): Promise<RawSettings> => YAML.parse(await Bun.file(configPath()).text()) as RawSettings;

	async function load(config: RawSettings, overlay?: RawSettings): Promise<Settings> {
		await Bun.write(configPath(), YAML.stringify(config));
		if (!overlay) return Settings.loadIsolated({ agentDir, cwd });
		await Bun.write(overlayPath, YAML.stringify(overlay));
		return Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] });
	}

	it("ranks above --config overlays and below runtime overrides, and clearing it restores them", async () => {
		const settings = await load(
			{ temperature: 0.1, modelRoles: { smol: "global/smol" } },
			{ temperature: 0.2, topP: 0.3 },
		);

		settings.applySetupLayer({ temperature: 0.4, modelRoles: { smol: "setup/smol" } });
		expect(cfgTemperature.get(settings)).toBe(0.4);
		expect(cfgTemperature.provenance(settings)).toBe("setup");
		expect(cfgTopP.get(settings)).toBe(0.3);
		expect(settings.getModelRole("smol")).toBe("setup/smol");
		expect(settings.getModelRoleProvenance("smol")).toBe("setup");
		// A write releases the setup role, so the layer beneath is what the role falls back to.
		expect(settings.getModelRoleProvenance("smol", { ignoreSetup: true })).toBe("global");

		cfgTemperature.override(settings, 0.5);
		expect(cfgTemperature.get(settings)).toBe(0.5);
		cfgTemperature.clearOverride(settings);
		expect(cfgTemperature.get(settings)).toBe(0.4);

		settings.applySetupLayer(undefined);
		expect(cfgTemperature.get(settings)).toBe(0.2);
		expect(cfgTemperature.provenance(settings)).toBe("overlay");
		expect(settings.getModelRole("smol")).toBe("global/smol");
		await settings.flush();
		expect(await readConfig()).toEqual({ temperature: 0.1, modelRoles: { smol: "global/smol" } });
	});

	it("releases only the setting or model role a persisted write touches", async () => {
		const settings = await load({});
		settings.applySetupLayer({
			temperature: 0.4,
			topP: 0.6,
			compaction: { enabled: false },
			modelRoles: { smol: "setup/smol", slow: "setup/slow" },
		});

		cfgTemperature.set(settings, 0.7);
		cfgCompactionEnabled.unset(settings);
		settings.setModelRole("smol", "user/smol");
		// A runtime override never releases the setup value beneath it.
		cfgTopP.override(settings, 0.9);
		cfgTopP.clearOverride(settings);

		expect(cfgTemperature.get(settings)).toBe(0.7);
		expect(cfgTemperature.provenance(settings)).toBe("global");
		expect(cfgCompactionEnabled.get(settings)).toBe(true);
		expect(settings.getModelRole("smol")).toBe("user/smol");
		expect(settings.getSetupLayer()).toEqual({ topP: 0.6, modelRoles: { slow: "setup/slow" } });
		expect(cfgTopP.get(settings)).toBe(0.6);
		expect(settings.getModelRole("slow")).toBe("setup/slow");
		await settings.flush();
		expect(await readConfig()).toEqual({ temperature: 0.7, modelRoles: { smol: "user/smol" } });
	});

	it("releases only the edited record entry while the setup's other entries keep applying", async () => {
		const settings = await load({});
		settings.applySetupLayer({ retry: { fallbackChains: { smol: ["setup/smol"], slow: ["setup/slow"] } } });

		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow"]);

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ smol: ["setup/smol"], slow: ["user/slow"] });
		expect(settings.getSetupLayer()).toEqual({ retry: { fallbackChains: { smol: ["setup/smol"] } } });
		await settings.flush();
		expect(await readConfig()).toEqual({ retry: { fallbackChains: { slow: ["user/slow"] } } });
	});

	it("refreshes derived reads and listeners when clearing a model role the setup supplies", async () => {
		const settings = await load({ temperature: 0.1 });
		settings.applySetupLayer({ modelRoles: { advisor: "provider/advisor" } });
		const advisor = cfgModelRoles.map(roles => roles.advisor);
		expect(advisor.get(settings)).toBe("provider/advisor");
		const heard: (string | undefined)[] = [];
		cfgModelRoles.listen(settings, roles => {
			heard.push(roles.advisor);
		});

		settings.setModelRole("advisor", undefined);
		await Promise.resolve();

		expect(settings.getModelRole("advisor")).toBeUndefined();
		expect(advisor.get(settings)).toBeUndefined();
		expect(heard).toEqual([undefined]);
		await settings.flush();
		expect(await readConfig()).not.toHaveProperty(["modelRoles", "advisor"]);
	});

	it("refreshes derived reads and listeners when clearing a record entry only the setup supplies", async () => {
		const settings = Settings.isolated();
		settings.applySetupLayer({ retry: { fallbackChains: { smol: ["setup/smol"], slow: ["setup/slow"] } } });
		const chainKeys = cfgRetryFallbackChains.map(chains => Object.keys(chains));
		expect(chainKeys.get(settings)).toEqual(["smol", "slow"]);
		const heard: string[][] = [];
		cfgRetryFallbackChains.listen(settings, chains => {
			heard.push(Object.keys(chains));
		});

		cfgRetryFallbackChains.setEntry(settings, "slow", undefined);
		await Promise.resolve();

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ smol: ["setup/smol"] });
		expect(chainKeys.get(settings)).toEqual(["smol"]);
		expect(heard).toEqual([["smol"]]);
		expect(settings.getSetupLayer()).toEqual({ retry: { fallbackChains: { smol: ["setup/smol"] } } });
	});

	it("applies a list member change to a setup-owned list and keeps the rest of it", async () => {
		const settings = await load({ task: { disabledAgents: ["reviewer"] } });
		settings.applySetupLayer({ task: { disabledAgents: ["scout", "explore"] } });

		cfgTaskDisabledAgents.setMember(settings, "scout", false);
		cfgTaskDisabledAgents.setMember(settings, "oracle", true);

		expect(cfgTaskDisabledAgents.get(settings)).toEqual(["explore", "oracle"]);
		await settings.flush();
		expect(await readConfig()).toEqual({ task: { disabledAgents: ["reviewer", "oracle"] } });
	});

	it("notifies listeners of exactly the settings it changes and returns them", async () => {
		const settings = Settings.isolated();
		const heard: [string, unknown][] = [];
		cfgTemperature.listen(settings, value => {
			heard.push(["temperature", value]);
		});
		cfgCompactionEnabled.listen(settings, value => {
			heard.push(["compaction.enabled", value]);
		});
		const setup = { temperature: 0.4, compaction: { enabled: cfgCompactionEnabled.get(settings) } };

		expect(settings.applySetupLayer(setup).map(setting => setting.id)).toEqual(["temperature"]);
		await Promise.resolve();
		expect(heard).toEqual([["temperature", 0.4]]);

		expect(settings.applySetupLayer(setup)).toEqual([]);
		await Promise.resolve();
		expect(heard).toEqual([["temperature", 0.4]]);
	});

	it("keeps the setup on top across a disk reload and signals only what the reload changed", async () => {
		const settings = await load({ temperature: 0.1 });
		settings.applySetupLayer({ temperature: 0.4 });
		const heard: string[] = [];
		settings.onEffectiveChange([cfgTemperature, cfgTopP], setting => heard.push(setting.id));

		await Bun.write(configPath(), YAML.stringify({ temperature: 0.2, topP: 0.3 }));
		await settings.reloadFromDisk();

		expect(cfgTemperature.get(settings)).toBe(0.4);
		expect(cfgTopP.get(settings)).toBe(0.3);
		expect(heard).toEqual(["topP"]);
	});

	it("previews a setup at its load rank without touching the live instance", async () => {
		const settings = Settings.isolated({ temperature: 0.5 });
		cfgTopP.set(settings, 0.2);
		let notified = false;
		settings.onEffectiveChange([cfgTemperature, cfgTopP], () => {
			notified = true;
		});

		const preview = settings.previewSetup({ temperature: 0.1, topP: 0.8 });

		// The runtime override outranks the setup, exactly as when the setup loads.
		expect(cfgTemperature.get(preview)).toBe(0.5);
		expect(cfgTopP.get(preview)).toBe(0.8);
		expect(cfgTopP.provenance(preview)).toBe("setup");
		expect(cfgTopP.get(settings)).toBe(0.2);
		expect(settings.getSetupLayer()).toEqual({});
		expect(notified).toBe(false);
		expect(findScopedSettings(settings.getCwd(), settings.getAgentDir())).toBe(settings);
	});

	it("reaches overlay children live and carries into cwd clones", async () => {
		const parent = Settings.isolated();
		const child = parent.overlay();
		const heard: number[] = [];
		cfgTemperature.listen(child, value => {
			heard.push(value);
		});

		parent.applySetupLayer({ temperature: 0.4 });

		expect(cfgTemperature.get(child)).toBe(0.4);
		expect(cfgTemperature.provenance(child)).toBe("setup");
		await Promise.resolve();
		expect(heard).toEqual([0.4]);
		const clone = await parent.cloneForCwd(cwd);
		expect(cfgTemperature.get(clone)).toBe(0.4);
		expect(cfgTemperature.provenance(clone)).toBe("setup");
	});
});
