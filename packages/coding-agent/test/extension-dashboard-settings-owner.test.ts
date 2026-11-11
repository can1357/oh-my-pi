import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { cfgDisabledProviders, cfgEnabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, isProviderEnabled, isUserSourceEnabled } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import { toggleProvider, toggleUserSource } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("extension dashboard settings ownership", () => {
	let state: SettingsTestState;
	let root: string;
	let home: string;
	let cwdA: string;
	let cwdB: string;
	let dirA: string;
	let dirB: string;
	let ownerA: Settings;
	let ownerB: Settings;
	let release: (() => void) | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-dashboard-owner-")));
		home = path.join(root, "home");
		cwdA = path.join(root, "project-a");
		cwdB = path.join(root, "project-b");
		dirA = path.join(home, ".omp", "agent");
		dirB = path.join(home, ".omp", "profiles", "projects", "agent");
		await Promise.all(
			[dirA, dirB, path.join(cwdA, ".git"), path.join(cwdB, ".git")].map(dir => fs.mkdir(dir, { recursive: true })),
		);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.APPDATA = path.join(home, "AppData", "Roaming");
		process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.COPILOT_HOME;
		delete process.env.PI_CONFIG_FILES;
		delete process.env.PI_CONFIG_DIR;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(dirA);
		setProjectDir(cwdA);
		await Bun.write(
			path.join(dirA, "config.yml"),
			YAML.stringify({ disabledProviders: ["cursor"], enabledProviders: ["codex"] }),
		);
		await Bun.write(path.join(dirB, "config.yml"), YAML.stringify({ enabledProviders: ["opencode"] }));
		await Bun.write(
			path.join(dirA, "mcp.json"),
			JSON.stringify({ mcpServers: { ownerA: { command: "echo" } }, disabledServers: ["keep-a"] }),
		);
		await Bun.write(path.join(dirB, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		ownerA = await Settings.loadIsolated({ cwd: cwdA, agentDir: dirA });
		ownerB = await Settings.loadIsolated({ cwd: cwdB, agentDir: dirB });
		await Promise.all([ownerA.flush(), ownerB.flush()]);
		release = initializeWithSettings(ownerA);
		clearFsCache();
	}, 30_000);

	afterEach(async () => {
		release?.();
		release = undefined;
		await Promise.all([ownerA?.flush(), ownerB?.flush()]);
		clearFsCache();
		restoreSettingsTestState(state);
		AgentStorage.close();
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	}, 30_000);

	const runtime = () => createExtensionDashboardRuntime({ cwd: cwdB, settings: ownerB });
	const readSettings = async (dir: string): Promise<Record<string, unknown>> =>
		YAML.parse(await Bun.file(path.join(dir, "config.yml")).text()) as Record<string, unknown>;

	test("foreign MCP toggles persist B's deny/allow lists and rediscover B without writing bound A", async () => {
		const foreignPath = path.join(cwdB, "opencode.json");
		const foreign = JSON.stringify({
			mcp: { foreign: { type: "local", command: ["echo", "foreign"], enabled: false } },
		});
		await Bun.write(foreignPath, foreign);
		await Bun.write(path.join(dirB, "mcp.json"), JSON.stringify({ mcpServers: {}, enabledServers: ["foreign"] }));
		clearFsCache();
		const beforeA = await Bun.file(path.join(dirA, "mcp.json")).text();
		const dashboard = runtime();
		expect((await loadAllMCPConfigs(cwdB, { settings: ownerB })).configs.foreign).toBeDefined();

		await dashboard.persistMcpToggle("foreign", false);
		expect(await readMCPConfigFile(path.join(dirB, "mcp.json"))).toMatchObject({ disabledServers: ["foreign"] });
		expect((await readMCPConfigFile(path.join(dirB, "mcp.json"))).enabledServers ?? []).toEqual([]);
		expect((await loadAllMCPConfigs(cwdB, { settings: ownerB })).configs.foreign).toBeUndefined();
		expect((await dashboard.loadExtensions([])).find(row => row.id === "mcp:foreign")?.state).toBe("disabled");

		await dashboard.persistMcpToggle("foreign", true);
		const restored = await readMCPConfigFile(path.join(dirB, "mcp.json"));
		expect(restored.disabledServers ?? []).toEqual([]);
		expect(restored.enabledServers).toEqual(["foreign"]);
		expect((await loadAllMCPConfigs(cwdB, { settings: ownerB })).configs.foreign).toBeDefined();
		expect((await dashboard.loadExtensions([])).find(row => row.id === "mcp:foreign")?.state).toBe("active");
		expect(await Bun.file(foreignPath).text()).toBe(foreign);
		expect(await Bun.file(path.join(dirA, "mcp.json")).text()).toBe(beforeA);
	}, 30_000);

	test("owned MCP enable clears B's stale overrides and preserves raw source indirections without touching A", async () => {
		const sourcePath = path.join(dirB, "mcp.json");
		const raw = { command: "echo", args: ["${HOME}"], env: { ROOT: "${HOME}" }, enabled: false };
		await Bun.write(
			sourcePath,
			JSON.stringify({ mcpServers: { owned: raw }, disabledServers: ["owned"], enabledServers: ["owned"] }),
		);
		clearFsCache();
		const beforeA = await Bun.file(path.join(dirA, "mcp.json")).text();
		const dashboard = runtime();

		await dashboard.persistMcpToggle("owned", true, sourcePath);
		const persisted = await readMCPConfigFile(sourcePath);
		expect(persisted.mcpServers?.owned).toEqual({ ...raw, enabled: true });
		expect(persisted.disabledServers ?? []).toEqual([]);
		expect(persisted.enabledServers ?? []).toEqual([]);
		expect((await loadAllMCPConfigs(cwdB, { settings: ownerB })).configs.owned?.enabled).toBe(true);
		expect((await dashboard.loadExtensions([])).find(row => row.id === "mcp:owned")?.state).toBe("active");

		await dashboard.persistMcpToggle("owned", false, sourcePath);
		expect((await readMCPConfigFile(sourcePath)).mcpServers?.owned).toEqual(raw);
		expect((await loadAllMCPConfigs(cwdB, { settings: ownerB })).configs.owned).toBeUndefined();
		expect(await Bun.file(path.join(dirA, "mcp.json")).text()).toBe(beforeA);
	}, 30_000);

	test("provider and user-source callbacks mutate displayed B and survive reload while A stays bound and unchanged", async () => {
		const beforeA = await Bun.file(path.join(dirA, "config.yml")).text();
		const dashboard = runtime();
		expect(dashboard.getProviders().find(provider => provider.id === "cursor")?.enabled).toBe(true);
		expect(dashboard.toggleProvider("cursor")).toBe(false);
		expect(isProviderEnabled("cursor", ownerB)).toBe(false);
		expect(dashboard.toggleUserSource("codex")).toBe(true);
		expect(isUserSourceEnabled("codex", { settings: ownerB })).toBe(true);
		await ownerB.flush();
		expect(await readSettings(dirB)).toMatchObject({
			disabledProviders: ["cursor"],
			enabledProviders: ["opencode", "codex"],
		});
		await ownerB.reloadFromDisk();
		expect(dashboard.getProviders().find(provider => provider.id === "cursor")?.enabled).toBe(false);
		expect(dashboard.getProviders().find(provider => provider.id === "codex")?.userSourceEnabled).toBe(true);

		expect(dashboard.toggleProvider("cursor")).toBe(true);
		expect(dashboard.toggleUserSource("codex")).toBe(false);
		await ownerB.flush();
		await ownerB.reloadFromDisk();
		expect(cfgDisabledProviders.get(ownerB)).toEqual([]);
		expect(cfgEnabledProviders.get(ownerB)).toEqual(["opencode"]);
		expect(await Bun.file(path.join(dirA, "config.yml")).text()).toBe(beforeA);
		expect(cfgDisabledProviders.get(ownerA)).toEqual(["cursor"]);
		expect(cfgEnabledProviders.get(ownerA)).toEqual(["codex"]);
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(isUserSourceEnabled("codex")).toBe(true);
	}, 30_000);

	test("omitted-owner toggles still persist to the process-bound owner rather than B", async () => {
		const beforeB = await Bun.file(path.join(dirB, "config.yml")).text();
		expect(toggleProvider("cursor")).toBe(true);
		expect(toggleUserSource("codex")).toBe(false);
		await ownerA.flush();
		await ownerA.reloadFromDisk();
		expect(isProviderEnabled("cursor")).toBe(true);
		expect(isUserSourceEnabled("codex")).toBe(false);
		expect(await Bun.file(path.join(dirB, "config.yml")).text()).toBe(beforeB);
	}, 30_000);

	test("B's path-scoped switches use B's cwd instead of the process-bound owner's cwd", async () => {
		await Bun.write(
			path.join(dirB, "config.yml"),
			YAML.stringify({
				disabledProviders: [
					{ path: cwdB, providers: ["cursor"] },
					{ path: cwdA, providers: ["codex"] },
				],
				enabledProviders: [
					{ path: cwdB, providers: ["codex"] },
					{ path: cwdA, providers: ["cursor"] },
				],
			}),
		);
		await ownerB.reloadFromDisk();
		const providers = runtime().getProviders();
		expect(providers.find(provider => provider.id === "cursor")).toMatchObject({
			enabled: false,
			userSourceEnabled: false,
		});
		expect(providers.find(provider => provider.id === "codex")).toMatchObject({
			enabled: true,
			userSourceEnabled: true,
		});
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(isProviderEnabled("codex")).toBe(true);
	}, 30_000);
});
