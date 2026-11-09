import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { setDisabledProviders } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { findMcpServerForAuth } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

async function writeJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, JSON.stringify(value));
}

describe("workspace MCP controls select the runtime name owner", () => {
	let state: SettingsTestState;
	let root: string;
	let workspace: string;
	let cwd: string;
	let ownerDir: string;
	let boundDir: string;
	let settings: Settings;
	let release: (() => void) | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-controls-")));
		const home = path.join(root, "home");
		workspace = path.join(root, "projects");
		cwd = path.join(workspace, "repo/src");
		boundDir = path.join(home, ".omp/agent");
		ownerDir = path.join(home, ".omp/profiles/projects/agent");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.APPDATA = path.join(home, "AppData/Roaming");
		process.env.LOCALAPPDATA = path.join(home, "AppData/Local");
		process.env.PI_CONFIG_DIR = ".omp";
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.COPILOT_HOME;
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(boundDir);
		await fs.mkdir(path.join(workspace, "repo/.git"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		setProjectDir(cwd);
		await writeJson(path.join(boundDir, "mcp.json"), { mcpServers: { ambient: { command: "bound-owner" } } });
		await writeJson(path.join(ownerDir, "config.yml"), { mcp: { workspaceRoots: [workspace] } });
		const bound = await Settings.loadIsolated({ cwd, agentDir: boundDir });
		release = initializeWithSettings(bound);
		settings = await Settings.loadIsolated({ cwd, agentDir: ownerDir });
		clearCache();
		initTheme();
	}, 30_000);

	afterEach(async () => {
		release?.();
		release = undefined;
		clearCache();
		restoreSettingsTestState(state);
		AgentStorage.close();
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	}, 30_000);

	async function load(options: { includeSuppressed?: boolean; enableProjectConfig?: boolean } = {}) {
		return loadAllMCPConfigs(cwd, { settings, filterExa: false, ...options });
	}

	async function run(host: "interactive" | "headless", args: string, expectError = false): Promise<string[]> {
		if (host === "interactive") {
			const ctx = createInteractiveModeContext({ settings });
			await new MCPCommandController(ctx).handle(`/mcp ${args}`);
			if (expectError) expect(ctx.showError).toHaveBeenCalled();
			else expect(ctx.showError).not.toHaveBeenCalled();
			return [];
		}
		const output: string[] = [];
		const ctx = createInteractiveModeContext({ settings });
		const runtime = {
			cwd,
			settings,
			session: ctx.session,
			output: (line: string) => {
				output.push(line);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		await handleMcpAcp({ args } as ParsedSlashCommand, runtime);
		return output;
	}

	for (const host of ["interactive", "headless"] as const) {
		test(`${host}: disabling the inherited winner is durable and never edits its user shadow`, async () => {
			const inherited = path.join(workspace, ".omp/mcp.json");
			const user = path.join(ownerDir, "mcp.json");
			const raw = {
				command: "workspace-peer",
				env: { TOKEN: "${CONTROL_TOKEN:-literal-marker}", KEY: "!secret-command" },
			};
			await writeJson(inherited, { mcpServers: { foo: raw }, extensionMetadata: { keep: true } });
			await writeJson(user, { mcpServers: { foo: { command: "shadowed-user-peer" } } });
			const userBefore = await Bun.file(user).text();
			const boundBefore = await Bun.file(path.join(boundDir, "mcp.json")).text();
			clearCache();
			const selected = await findMcpServerForAuth("foo", cwd, undefined, { settings });
			expect(selected?.filePath).toBe(inherited);
			expect(selected?.config).toMatchObject(raw);
			await run(host, "disable foo");
			expect((await load()).configs.foo).toBeUndefined();
			expect((await readMCPConfigFile(inherited)).mcpServers?.foo).toEqual({ ...raw, enabled: false });
			expect(await Bun.file(user).text()).toBe(userBefore);
			expect(await Bun.file(path.join(boundDir, "mcp.json")).text()).toBe(boundBefore);
		}, 30_000);

		test(`${host}: initially disabled inherited standalone entries can be enabled without a manager source`, async () => {
			const source = path.join(workspace, ".mcp.json");
			await writeJson(source, {
				mcpServers: {
					off: { command: "standalone-peer", enabled: false, env: { TOKEN: "${CONTROL_TOKEN:-marker}" } },
				},
			});
			clearCache();
			expect((await load()).configs.off).toBeUndefined();
			await run(host, "enable off");
			expect((await load()).configs.off).toMatchObject({ command: "standalone-peer", enabled: true });
			expect((await readMCPConfigFile(source)).mcpServers?.off).toMatchObject({
				env: { TOKEN: "${CONTROL_TOKEN:-marker}" },
				enabled: true,
			});
		}, 30_000);

		test(`${host}: foreign disabled entries use only the owning profile's overrides`, async () => {
			const foreign = path.join(cwd, ".cursor/mcp.json");
			await writeJson(foreign, { mcpServers: { imported: { command: "foreign-peer", enabled: false } } });
			const foreignBefore = await Bun.file(foreign).text();
			const boundBefore = await Bun.file(path.join(boundDir, "mcp.json")).text();
			clearCache();
			await run(host, "enable imported");
			expect((await load()).configs.imported).toMatchObject({ command: "foreign-peer", enabled: true });
			expect((await readMCPConfigFile(path.join(ownerDir, "mcp.json"))).enabledServers).toContain("imported");
			await run(host, "disable imported");
			expect((await load()).configs.imported).toBeUndefined();
			expect((await readMCPConfigFile(path.join(ownerDir, "mcp.json"))).disabledServers).toContain("imported");
			expect(await Bun.file(foreign).text()).toBe(foreignBefore);
			expect(await Bun.file(path.join(boundDir, "mcp.json")).text()).toBe(boundBefore);
		}, 30_000);

		test(`${host}: default removal selects the inherited owner while explicit user scope removes only its shadow`, async () => {
			const inherited = path.join(workspace, ".omp/.mcp.json");
			const user = path.join(ownerDir, "mcp.json");
			await writeJson(inherited, { mcpServers: { foo: { command: "inherited-peer" } } });
			await writeJson(user, { mcpServers: { foo: { command: "user-shadow" } } });
			clearCache();
			await run(host, "remove foo --scope user");
			expect((await load()).configs.foo).toMatchObject({ command: "inherited-peer" });
			expect((await readMCPConfigFile(user)).mcpServers?.foo).toBeUndefined();
			await run(host, "remove foo");
			expect((await load()).configs.foo).toBeUndefined();
			expect((await readMCPConfigFile(inherited)).mcpServers?.foo).toBeUndefined();
		}, 30_000);

		test(`${host}: default project removal never deletes a user-only definition`, async () => {
			const user = path.join(ownerDir, "mcp.json");
			await writeJson(user, { mcpServers: { userOnly: { command: "profile-peer" } } });
			const before = await Bun.file(user).text();
			clearCache();
			await run(host, "remove userOnly", true);
			expect(await Bun.file(user).text()).toBe(before);
			expect((await load()).configs.userOnly).toMatchObject({ command: "profile-peer" });
			await run(host, "remove userOnly --scope user");
			expect((await readMCPConfigFile(user)).mcpServers?.userOnly).toBeUndefined();
			expect((await load()).configs.userOnly).toBeUndefined();
		}, 30_000);
	}

	test("control inspection preserves native, foreign, standalone and compatibility filename priorities", async () => {
		await writeJson(path.join(workspace, ".omp/mcp.json"), { mcpServers: { native: { command: "native-main" } } });
		await writeJson(path.join(workspace, ".omp/.mcp.json"), {
			mcpServers: { native: { command: "native-compat" }, compat: { command: "compat-peer" } },
		});
		await writeJson(path.join(cwd, ".cursor/mcp.json"), {
			mcpServers: { native: { command: "foreign-shadow" }, foreign: { command: "foreign-winner" } },
		});
		await writeJson(path.join(workspace, "mcp.json"), {
			mcpServers: { foreign: { command: "standalone-shadow" }, standalone: { command: "standalone-main" } },
		});
		await writeJson(path.join(workspace, ".mcp.json"), {
			mcpServers: { standalone: { command: "standalone-compat" } },
		});
		await writeJson(path.join(ownerDir, ".mcp.json"), { mcpServers: { userCompat: { command: "user-compat" } } });
		clearCache();
		for (const [name, command] of Object.entries({
			native: "native-main",
			compat: "compat-peer",
			foreign: "foreign-winner",
			standalone: "standalone-main",
			userCompat: "user-compat",
		})) {
			const found = await findMcpServerForAuth(name, cwd, undefined, { settings });
			expect(found?.config).toMatchObject({ command });
		}
		const excluded = await findMcpServerForAuth("native", cwd, undefined, { settings, enableProjectConfig: false });
		expect(excluded).toBeNull();
		expect((await load({ enableProjectConfig: false })).configs.userCompat).toMatchObject({ command: "user-compat" });
	}, 30_000);

	test("suppressed owners never resurrect same-name shadows or equivalence-shadow active aliases", async () => {
		await writeJson(path.join(workspace, ".omp/mcp.json"), {
			mcpServers: {
				off: { type: "http", url: "https://example.invalid/mcp", enabled: false },
				activeAlias: { type: "http", url: "https://example.invalid/mcp" },
			},
		});
		await writeJson(path.join(ownerDir, "mcp.json"), { mcpServers: { off: { command: "must-not-resurrect" } } });
		clearCache();
		expect(Object.keys((await load()).configs)).toEqual(["activeAlias"]);
		const inspected = await load({ includeSuppressed: true });
		expect(inspected.configs.off).toMatchObject({ type: "http", enabled: false });
		expect(inspected.configs.activeAlias.enabled).not.toBe(false);
	}, 30_000);

	test("disabled-owner inspection does not opt foreign user sources or disabled providers in", async () => {
		await writeJson(path.join(root, "home/.cursor/mcp.json"), {
			mcpServers: { optedOut: { command: "foreign-user-peer", enabled: false } },
		});
		await writeJson(path.join(workspace, ".omp/mcp.json"), {
			mcpServers: { nativeOff: { command: "native-peer", enabled: false } },
		});
		clearCache();
		expect(await findMcpServerForAuth("optedOut", cwd, undefined, { settings })).toBeNull();
		setDisabledProviders(["native"], settings);
		expect(await findMcpServerForAuth("nativeOff", cwd, undefined, { settings })).toBeNull();
	}, 30_000);

	test("an inherited symlink escaping the trust boundary is never selected for auth or mutation", async () => {
		const outside = path.join(root, "outside.json");
		await writeJson(outside, { mcpServers: { escaped: { command: "outside-peer" } } });
		await fs.mkdir(path.join(workspace, ".omp"), { recursive: true });
		await fs.symlink(outside, path.join(workspace, ".omp/mcp.json"));
		await writeJson(path.join(ownerDir, "mcp.json"), { mcpServers: { escaped: { command: "safe-user-peer" } } });
		clearCache();
		const selected = await findMcpServerForAuth("escaped", cwd, undefined, { settings });
		expect(selected?.filePath).toBe(path.join(ownerDir, "mcp.json"));
		await run("headless", "disable escaped");
		expect((await readMCPConfigFile(outside)).mcpServers?.escaped).toEqual({ command: "outside-peer" });
	}, 30_000);
});

test.each([undefined, true])(
	"inherited unauth while user-denied preserves raw enabled=%s and secret indirections",
	async enabled => {
		const state = beginSettingsTest();
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-unauth-")));
		const home = path.join(root, "home");
		const workspace = path.join(root, "projects");
		const cwd = path.join(workspace, "repo/src");
		const agentDir = path.join(home, ".omp/profiles/projects/agent");
		const source = path.join(workspace, ".omp/mcp.json");
		const user = path.join(agentDir, "mcp.json");
		let storage: AuthStorage | undefined;
		try {
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			process.env.XDG_CONFIG_HOME = path.join(home, ".config");
			process.env.PI_CONFIG_DIR = ".omp";
			delete process.env.CLAUDE_CONFIG_DIR;
			delete process.env.COPILOT_HOME;
			delete process.env.OMP_PROFILE;
			delete process.env.PI_PROFILE;
			vi.spyOn(os, "homedir").mockReturnValue(home);
			setAgentDir(agentDir);
			await fs.mkdir(path.join(workspace, "repo/.git"), { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			setProjectDir(cwd);
			await writeJson(path.join(agentDir, "config.yml"), { mcp: { workspaceRoots: [workspace] } });
			const raw: MCPServerConfig = {
				...(enabled === undefined ? {} : { enabled }),
				type: "http",
				url: "https://${CONTROL_AUTH_HOST:-example.invalid}/mcp",
				headers: { "X-API-Key": "!secret-command", "X-Token": "${CONTROL_AUTH_TOKEN:-marker}" },
				oauth: { clientSecret: "${CONTROL_AUTH_SECRET:-marker}" },
			};
			await writeJson(source, {
				mcpServers: { foo: { ...raw, auth: { type: "oauth", credentialId: "mcp_oauth_missing" } } },
			});
			await writeJson(user, {
				mcpServers: { foo: { type: "http", url: "https://shadow.invalid/mcp" } },
				disabledServers: ["foo"],
			});
			const userBefore = await Bun.file(user).text();
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			storage = await AuthStorage.create(":memory:");
			clearCache();
			initTheme();
			const found = await findMcpServerForAuth("foo", cwd, undefined, { settings });
			expect(found?.effectiveEnabled).toBe(false);
			expect(found?.config.enabled).toBe(enabled);
			const ctx = createInteractiveModeContext({ settings, session: { modelRegistry: { authStorage: storage } } });
			await new MCPCommandController(ctx).handle("/mcp unauth foo");
			expect(ctx.showError).not.toHaveBeenCalled();
			expect((await readMCPConfigFile(source)).mcpServers?.foo).toEqual(raw);
			expect(await Bun.file(user).text()).toBe(userBefore);
			expect((await loadAllMCPConfigs(cwd, { settings })).configs.foo).toBeUndefined();
		} finally {
			storage?.close();
			clearCache();
			restoreSettingsTestState(state);
			AgentStorage.close();
			__resetDirsFromEnvForTests();
			await removeWithRetries(root);
		}
	},
	30_000,
);
