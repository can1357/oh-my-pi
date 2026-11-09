import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpWorkspaceRoots } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	removeWithRetries,
	setAgentDir,
	setProfile,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

async function writeJson(file: string, content: unknown): Promise<void> {
	await Bun.write(file, JSON.stringify(content));
}

async function writeMcp(
	file: string,
	mcpServers: Record<string, unknown>,
	lists: { enabledServers?: string[]; disabledServers?: string[] } = {},
): Promise<void> {
	await writeJson(file, { mcpServers, ...lists });
}

function server(command: string): { command: string } {
	return { command };
}

describe("trusted workspace MCP inheritance", () => {
	let state: SettingsTestState;
	let fixture: string;
	let home: string;
	let agentDir: string;
	let canetoad: string;
	let frontend: string;
	let eda: string;
	let outside: string;
	let releaseSettings: (() => void) | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-workspace-")));
		home = path.join(fixture, "home");
		agentDir = path.join(home, ".omp", "agent");
		canetoad = path.join(home, "workspaces", "Canetoad");
		frontend = path.join(canetoad, "frontend", "src");
		eda = path.join(home, "workspaces", "EDA");
		outside = path.join(home, "outside", "src");
		await Promise.all(
			[agentDir, frontend, path.join(eda, "boards", "src"), outside].map(dir => fs.mkdir(dir, { recursive: true })),
		);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.APPDATA = path.join(home, "AppData", "Roaming");
		process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.COPILOT_HOME;
		delete process.env.PI_CONFIG_DIR;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(agentDir);
		setProjectDir(frontend);
		clearFsCache();
	});

	afterEach(async () => {
		releaseSettings?.();
		releaseSettings = undefined;
		clearFsCache();
		restoreSettingsTestState(state);
		AgentStorage.close();
		__resetDirsFromEnvForTests();
		await removeWithRetries(fixture);
	});

	async function bindSettings(
		cwd: string,
		options: { configFiles?: string[]; overrides?: Readonly<Record<string, unknown>> } = {},
	): Promise<Settings> {
		releaseSettings?.();
		clearFsCache();
		setProjectDir(cwd);
		const settings = await Settings.loadReadOnly({ cwd, agentDir, ...options });
		releaseSettings = initializeWithSettings(settings);
		return settings;
	}

	async function trust(roots: string[], cwd = frontend): Promise<void> {
		await writeJson(path.join(agentDir, "config.yml"), { mcp: { workspaceRoots: roots } });
		await bindSettings(cwd);
	}

	async function discover(cwd: string, providers = ["native", "mcp-json"]): Promise<MCPServer[]> {
		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers });
		return result.items;
	}

	async function workspaceOwners(): Promise<{
		ownerA: Settings;
		ownerB: Settings;
		dirA: string;
		dirB: string;
	}> {
		const dirA = agentDir;
		const dirB = path.join(home, ".omp", "profiles", "eda", "agent");
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), {
			signoz: { command: "owner-a-signoz", enabled: false },
		});
		await writeMcp(path.join(canetoad, "mcp.json"), { canetoadDocs: server("owner-a-docs") });
		await writeMcp(path.join(eda, ".omp", "mcp.json"), { kicad: server("owner-b-kicad") });
		await writeMcp(path.join(eda, "mcp.json"), { boardTools: server("owner-b-boards") });
		await writeMcp(path.join(dirA, "mcp.json"), { globalA: server("global-a") }, { enabledServers: ["signoz"] });
		await writeMcp(path.join(dirB, "mcp.json"), { globalB: server("global-b") }, { disabledServers: ["signoz"] });
		await writeJson(path.join(dirA, "config.yml"), { mcp: { workspaceRoots: [canetoad] } });
		await writeJson(path.join(dirB, "config.yml"), { mcp: { workspaceRoots: [eda] } });
		const ownerA = await Settings.loadIsolated({ cwd: frontend, agentDir: dirA });
		const ownerB = await Settings.loadIsolated({ cwd: path.join(eda, "boards", "src"), agentDir: dirB });
		clearFsCache();
		return { ownerA, ownerB, dirA, dirB };
	}

	test("Canetoad SigNoz crosses child Git roots while EDA KiCad and unrelated launches stay isolated", async () => {
		await fs.mkdir(path.join(canetoad, "frontend", ".git"));
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("canetoad-signoz") });
		await writeMcp(path.join(eda, ".omp", "mcp.json"), { kicad: server("eda-kicad") });
		await writeMcp(path.join(home, "workspaces", ".omp", "mcp.json"), { above: server("must-not-load") });
		await trust([canetoad, eda]);

		const canetoadResult = await loadAllMCPConfigs(frontend);
		expect(Object.keys(canetoadResult.configs)).toEqual(["signoz"]);
		expect(canetoadResult.sources.signoz).toMatchObject({
			provider: "native",
			level: "project",
			path: path.join(canetoad, ".omp", "mcp.json"),
		});
		const generic = await discover(frontend);
		expect(generic.map(item => item.name)).toEqual(["signoz"]);
		expect(generic[0]._source).toEqual(canetoadResult.sources.signoz);

		const edaResult = await loadAllMCPConfigs(path.join(eda, "boards", "src"));
		expect(Object.keys(edaResult.configs)).toEqual(["kicad"]);
		expect(Object.keys((await loadAllMCPConfigs(outside)).configs)).toEqual([]);
	});

	test("child definitions replace the entire inherited server without leaking args, environment or auth", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), {
			shared: {
				command: "ancestor-server",
				args: ["--ancestor-secret"],
				env: { ANCESTOR_SECRET: "fixture-only" },
				cwd: "./ancestor-cwd",
				auth: { type: "apikey", credentialId: "ancestor-credential" },
				oauth: { clientId: "ancestor-oauth" },
			},
			inherited: server("inherited-server"),
		});
		const childFile = path.join(canetoad, "frontend", ".omp", "mcp.json");
		await writeMcp(childFile, { shared: server("child-server"), added: server("child-added") });
		await trust([canetoad]);

		const result = await loadAllMCPConfigs(frontend);
		expect(Object.keys(result.configs).sort()).toEqual(["added", "inherited", "shared"]);
		const shared = result.configs.shared;
		expect(shared).toMatchObject({ type: "stdio", command: "child-server" });
		if (shared.type !== "stdio") throw new Error("Expected a stdio child definition");
		for (const key of ["args", "env", "cwd", "auth", "oauth"] as const) {
			expect(shared[key]).toBeUndefined();
		}
		expect(result.sources.shared.path).toBe(childFile);
	});

	test("a disabled inherited definition claims its name, user force-enable restores it, and deny wins", async () => {
		const inheritedFile = path.join(canetoad, ".omp", "mcp.json");
		const userFile = path.join(agentDir, "mcp.json");
		await writeMcp(inheritedFile, { signoz: { command: "disabled-inherited", enabled: false } });
		await writeMcp(userFile, { signoz: server("user-fallback") });
		await trust([canetoad]);

		expect((await discover(frontend)).find(item => item.name === "signoz")).toMatchObject({
			command: "disabled-inherited",
			enabled: false,
		});
		expect((await loadAllMCPConfigs(frontend)).configs.signoz).toBeUndefined();

		await writeMcp(userFile, { signoz: server("user-fallback") }, { enabledServers: ["signoz"] });
		await bindSettings(frontend);
		const forced = await loadAllMCPConfigs(frontend);
		expect(forced.configs.signoz).toMatchObject({ command: "disabled-inherited" });
		expect(forced.sources.signoz.path).toBe(inheritedFile);

		await writeMcp(
			userFile,
			{ signoz: server("user-fallback") },
			{
				enabledServers: ["signoz"],
				disabledServers: ["signoz"],
			},
		);
		await bindSettings(frontend);
		expect((await loadAllMCPConfigs(frontend)).configs.signoz).toBeUndefined();
	});

	test("the most-specific overlapping root excludes the outer workspace and prefix siblings", async () => {
		const inner = path.join(canetoad, "frontend");
		const sibling = path.join(home, "workspaces", "Canetoad-other", "src");
		await fs.mkdir(sibling, { recursive: true });
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { outer: server("outer") });
		await writeMcp(path.join(inner, ".omp", "mcp.json"), { inner: server("inner") });
		await writeMcp(path.join(home, "workspaces", "Canetoad-other", ".omp", "mcp.json"), {
			sibling: server("prefix-sibling"),
		});
		await trust([canetoad, inner]);

		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["inner"]);
		expect(Object.keys((await loadAllMCPConfigs(sibling)).configs)).toEqual([]);
	});

	test("active profiles isolate both trusted roots and global MCP definitions", async () => {
		const defaultAgentDir = agentDir;
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("canetoad-signoz") });
		await writeMcp(path.join(eda, ".omp", "mcp.json"), { kicad: server("eda-kicad") });
		await writeMcp(path.join(defaultAgentDir, "mcp.json"), { defaultGlobal: server("default-global") });
		await trust([canetoad]);
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs).sort()).toEqual(["defaultGlobal", "signoz"]);

		setProfile("eda");
		agentDir = getAgentDir();
		await writeMcp(path.join(agentDir, "mcp.json"), { profileGlobal: server("profile-global") });
		await trust([eda], path.join(eda, "boards", "src"));
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["profileGlobal"]);
		expect(Object.keys((await loadAllMCPConfigs(path.join(eda, "boards", "src"))).configs).sort()).toEqual([
			"kicad",
			"profileGlobal",
		]);

		setProfile(undefined);
		agentDir = getAgentDir();
		await bindSettings(frontend);
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs).sort()).toEqual(["defaultGlobal", "signoz"]);
	});

	test("explicit discovery owners keep their own trust and user MCP config despite another bound session", async () => {
		const { ownerA, ownerB, dirA, dirB } = await workspaceOwners();
		const edaCwd = path.join(eda, "boards", "src");
		setAgentDir(dirB);
		releaseSettings = initializeWithSettings(ownerB);

		const loadedA = await loadAllMCPConfigs(frontend, { settings: ownerA });
		expect(Object.keys(loadedA.configs).sort()).toEqual(["canetoadDocs", "globalA", "signoz"]);
		expect(loadedA.sources.globalA.path).toBe(path.join(dirA, "mcp.json"));
		expect(Object.keys((await loadAllMCPConfigs(frontend, { settings: ownerB })).configs)).toEqual(["globalB"]);
		expect(Object.keys((await loadAllMCPConfigs(edaCwd, { settings: ownerA })).configs)).toEqual(["globalA"]);
		expect(Object.keys((await loadAllMCPConfigs(edaCwd, { settings: ownerB })).configs).sort()).toEqual([
			"boardTools",
			"globalB",
			"kicad",
		]);
		for (const [settings, cwd, expected] of [
			[ownerA, frontend, ["canetoadDocs", "globalA", "signoz"]],
			[ownerA, edaCwd, ["globalA"]],
			[ownerB, frontend, ["globalB"]],
			[ownerB, edaCwd, ["boardTools", "globalB", "kicad"]],
		] as const) {
			const generic = await loadCapability<MCPServer>(mcpCapability.id, {
				cwd,
				settings,
				providers: ["native", "mcp-json"],
			});
			expect(generic.items.map(item => item.name).sort()).toEqual([...expected]);
		}

		// The newest binding owns generic discovery even if another SDK host changes process directory state.
		setAgentDir(dirA);
		const defaultOwner = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: edaCwd,
			providers: ["native", "mcp-json"],
		});
		expect(defaultOwner.items.map(item => item.name).sort()).toEqual(["boardTools", "globalB", "kicad"]);
		expect(defaultOwner.items.find(item => item.name === "globalB")?._source.path).toBe(path.join(dirB, "mcp.json"));

		await writeJson(path.join(dirB, "config.yml"), { mcp: { workspaceRoots: [] } });
		await ownerB.reloadFromDisk();
		expect(Object.keys((await loadAllMCPConfigs(frontend, { settings: ownerA })).configs).sort()).toEqual([
			"canetoadDocs",
			"globalA",
			"signoz",
		]);
		expect(Object.keys((await loadAllMCPConfigs(edaCwd, { settings: ownerB })).configs)).toEqual(["globalB"]);

		await writeJson(path.join(dirB, "config.yml"), { mcp: { workspaceRoots: [canetoad, eda] } });
		await ownerB.reloadFromDisk();
		await writeJson(path.join(dirA, "config.yml"), { mcp: { workspaceRoots: [] } });
		await ownerA.reloadFromDisk();
		expect(Object.keys((await loadAllMCPConfigs(frontend, { settings: ownerA })).configs)).toEqual(["globalA"]);
		expect(Object.keys((await loadAllMCPConfigs(frontend, { settings: ownerB })).configs).sort()).toEqual([
			"canetoadDocs",
			"globalB",
		]);
		expect((await loadAllMCPConfigs(frontend, { settings: null })).configs.signoz).toBeUndefined();
		const untrusted = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: frontend,
			settings: null,
			providers: ["native", "mcp-json"],
		});
		expect(untrusted.items.some(item => item.name === "signoz" || item.name === "canetoadDocs")).toBe(false);
	});

	test("MCP managers retain their explicit or captured owner across rediscovery and project reconciliation", async () => {
		const { ownerA, ownerB, dirB } = await workspaceOwners();
		const edaCwd = path.join(eda, "boards", "src");
		setAgentDir(dirB);
		releaseSettings = initializeWithSettings(ownerB);
		// A is never process-bound: SDK sessions with bindProcessState:false use this explicit-owner path.
		const managerA = new MCPManager(frontend, null, loadAllMCPConfigs, undefined, ownerA);
		const managerB = new MCPManager(edaCwd, null, loadAllMCPConfigs, undefined, ownerB);
		const capturedB = new MCPManager(edaCwd);
		// Only the connection boundary is replaced. Discovery, file loading, trust and dedupe remain real.
		const emptyConnections = { tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] };
		const connectA = vi.spyOn(managerA, "connectServers").mockResolvedValue(emptyConnections);
		const connectB = vi.spyOn(managerB, "connectServers").mockResolvedValue(emptyConnections);
		const connectCapturedB = vi.spyOn(capturedB, "connectServers").mockResolvedValue(emptyConnections);
		try {
			await managerA.discoverAndConnect({ enableProjectConfig: true });
			await managerB.discoverAndConnect({ enableProjectConfig: true });
			expect(Object.keys(connectA.mock.calls[0][0]).sort()).toEqual(["canetoadDocs", "globalA", "signoz"]);
			expect(Object.keys(connectB.mock.calls[0][0]).sort()).toEqual(["boardTools", "globalB", "kicad"]);

			await managerA.reconcileProjectConfig(false);
			await managerA.reconcileProjectConfig(true);
			expect(Object.keys(connectA.mock.calls[1][0]).sort()).toEqual(["canetoadDocs", "signoz"]);

			releaseSettings?.();
			releaseSettings = initializeWithSettings(ownerA);
			await managerA.discoverAndConnect({ enableProjectConfig: true });
			await managerB.discoverAndConnect({ enableProjectConfig: true });
			await capturedB.discoverAndConnect({ enableProjectConfig: true });
			expect(Object.keys(connectA.mock.calls[2][0]).sort()).toEqual(["canetoadDocs", "globalA", "signoz"]);
			expect(Object.keys(connectB.mock.calls[1][0]).sort()).toEqual(["boardTools", "globalB", "kicad"]);
			expect(Object.keys(connectCapturedB.mock.calls[0][0]).sort()).toEqual(["boardTools", "globalB", "kicad"]);

			await writeJson(path.join(dirB, "config.yml"), { mcp: { workspaceRoots: [] } });
			await ownerB.reloadFromDisk();
			await managerB.discoverAndConnect({ enableProjectConfig: true });
			expect(Object.keys(connectB.mock.calls[2][0])).toEqual(["globalB"]);
		} finally {
			await Promise.all([managerA.disconnectAll(), managerB.disconnectAll(), capturedB.disconnectAll()]);
		}
	});

	test("disabling project config excludes inherited entries before dedupe and keeps user definitions", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), {
			shared: { command: "disabled-project", enabled: false },
			projectOnly: server("project-only"),
		});
		await writeMcp(path.join(agentDir, "mcp.json"), { shared: server("user-server") });
		await trust([canetoad]);

		const result = await loadAllMCPConfigs(frontend, { enableProjectConfig: false });
		expect(Object.keys(result.configs)).toEqual(["shared"]);
		expect(result.configs.shared).toMatchObject({ command: "user-server" });
		expect(result.sources.shared.level).toBe("user");
	});

	test("project settings and config overlays cannot grant or broaden user workspace trust", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("signoz") });
		await writeMcp(path.join(eda, ".omp", "mcp.json"), { kicad: server("kicad") });
		await writeJson(path.join(frontend, ".omp", "config.yml"), { mcp: { workspaceRoots: [canetoad, eda] } });
		const overlay = path.join(fixture, "overlay.yml");
		await writeJson(overlay, { mcp: { workspaceRoots: [canetoad, eda] } });
		await bindSettings(frontend, {
			configFiles: [overlay],
			overrides: { "mcp.workspaceRoots": [canetoad, eda] },
		});
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual([]);

		await trust([canetoad]);
		await bindSettings(frontend, { configFiles: [overlay] });
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["signoz"]);
		expect(Object.keys((await loadAllMCPConfigs(path.join(eda, "boards", "src"))).configs)).toEqual([]);
	});

	test("session overlay global writes cannot grant roots or broaden the owning profile's trust", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("owner-signoz") });
		await writeMcp(path.join(eda, ".omp", "mcp.json"), { kicad: server("untrusted-kicad") });
		const untrustedOwner = await bindSettings(frontend);
		for (const derived of [false, true]) {
			const overlay = untrustedOwner.overlay({}, { derived });
			cfgMcpWorkspaceRoots.set(overlay, [canetoad, eda]);
			releaseSettings?.();
			releaseSettings = initializeWithSettings(overlay);
			expect((await discover(frontend)).map(item => item.name)).toEqual([]);
		}

		await trust([canetoad]);
		const trustedOwner = await bindSettings(frontend);
		const overlay = trustedOwner.overlay();
		cfgMcpWorkspaceRoots.set(overlay, [eda]);
		releaseSettings?.();
		releaseSettings = initializeWithSettings(overlay);
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["signoz"]);
		expect(Object.keys((await loadAllMCPConfigs(path.join(eda, "boards", "src"))).configs)).toEqual([]);
	});

	test("foreign project MCP discovery stays literal-cwd even inside a trusted workspace", async () => {
		await writeMcp(path.join(canetoad, ".cursor", "mcp.json"), { ancestorForeign: server("must-not-inherit") });
		await writeMcp(path.join(frontend, ".cursor", "mcp.json"), { localForeign: server("local-cursor") });
		await trust([canetoad]);

		const generic = await discover(frontend, ["cursor"]);
		expect(generic.map(item => item.name)).toEqual(["localForeign"]);
		const result = await loadAllMCPConfigs(frontend);
		expect(Object.keys(result.configs)).toEqual(["localForeign"]);
		expect(result.sources.localForeign.path).toBe(path.join(frontend, ".cursor", "mcp.json"));
	});

	test("inherited stdio commands, relative args and explicit cwd are not rebased to their config directory", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), {
			explicit: { command: "./bin/server", args: ["./relative.json", "../shared"], cwd: "./runtime" },
			implicit: { command: "bare-server", args: ["./launch-relative.json"] },
		});
		await writeMcp(path.join(canetoad, "mcp.json"), {
			standalone: { command: "./standalone/server", args: ["./standalone.json"], cwd: "../standalone-cwd" },
		});
		await trust([canetoad]);

		const result = await loadAllMCPConfigs(frontend);
		expect(result.configs.explicit).toMatchObject({
			command: "./bin/server",
			args: ["./relative.json", "../shared"],
			cwd: "./runtime",
		});
		expect(result.configs.implicit).toMatchObject({ command: "bare-server", args: ["./launch-relative.json"] });
		expect(result.configs.implicit).not.toHaveProperty("cwd");
		expect(result.configs.standalone).toMatchObject({
			command: "./standalone/server",
			args: ["./standalone.json"],
			cwd: "../standalone-cwd",
		});
	});

	test("closest native files win whole definitions, primary beats compat, and native beats foreign and standalone", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), {
			shared: server("root-native"),
			rootPrimary: server("root-primary"),
			closerCompat: server("root-primary-loses-to-child-compat"),
		});
		await writeMcp(path.join(canetoad, ".omp", ".mcp.json"), {
			rootPrimary: server("root-compat-loses"),
			compatOnly: server("root-compat"),
		});
		await writeMcp(path.join(frontend, ".omp", "mcp.json"), { shared: server("child-primary") });
		await writeMcp(path.join(frontend, ".omp", ".mcp.json"), {
			shared: server("child-compat-loses"),
			closerCompat: server("child-compat"),
		});
		await writeMcp(path.join(frontend, ".cursor", "mcp.json"), {
			shared: server("foreign-loses"),
			foreignFirst: server("foreign-first"),
		});
		await writeMcp(path.join(frontend, "mcp.json"), {
			shared: server("standalone-loses"),
			foreignFirst: server("standalone-foreign-loses"),
			standalonePrimary: server("standalone-primary"),
		});
		await writeMcp(path.join(frontend, ".mcp.json"), {
			standalonePrimary: server("standalone-compat-loses"),
			standaloneCompat: server("standalone-compat"),
		});
		await writeMcp(path.join(agentDir, "mcp.json"), { userPrimary: server("user-primary") });
		await writeMcp(path.join(agentDir, ".mcp.json"), {
			userPrimary: server("user-compat-loses"),
			userCompat: server("user-compat"),
		});
		await trust([canetoad]);

		const result = await loadAllMCPConfigs(frontend);
		expect(result.configs.shared).toMatchObject({ command: "child-primary" });
		expect(result.configs.rootPrimary).toMatchObject({ command: "root-primary" });
		expect(result.configs.compatOnly).toMatchObject({ command: "root-compat" });
		expect(result.configs.closerCompat).toMatchObject({ command: "child-compat" });
		expect(result.configs.userPrimary).toMatchObject({ command: "user-primary" });
		expect(result.configs.userCompat).toMatchObject({ command: "user-compat" });
		expect(result.configs.foreignFirst).toMatchObject({ command: "foreign-first" });
		expect(result.configs.standalonePrimary).toMatchObject({ command: "standalone-primary" });
		expect(result.configs.standaloneCompat).toMatchObject({ command: "standalone-compat" });
		expect(result.sources.shared.provider).toBe("native");
		expect(result.sources.foreignFirst.provider).toBe("cursor");
		expect(result.sources.standalonePrimary.provider).toBe("mcp-json");
	});

	test("standalone files inherit through every directory without overriding a higher-priority native ancestor", async () => {
		await writeMcp(path.join(canetoad, "mcp.json"), {
			shared: server("root-standalone"),
			inherited: server("root-primary"),
		});
		await writeMcp(path.join(canetoad, ".mcp.json"), { inherited: server("root-compat-loses") });
		await writeMcp(path.join(canetoad, "frontend", "mcp.json"), { shared: server("closer-standalone") });
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { shared: server("native-ancestor") });
		await trust([canetoad]);

		const standalone = await discover(frontend, ["mcp-json"]);
		expect(standalone.find(item => item.name === "shared")?.command).toBe("closer-standalone");
		expect(standalone.find(item => item.name === "inherited")?.command).toBe("root-primary");
		const result = await loadAllMCPConfigs(frontend);
		expect(result.configs.shared).toMatchObject({ command: "native-ancestor" });
		expect(result.configs.inherited).toMatchObject({ command: "root-primary" });
	});

	test("without trusted roots native and standalone discovery remain literal-cwd only", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { ancestorNative: server("ancestor-native") });
		await writeMcp(path.join(canetoad, "mcp.json"), { ancestorStandalone: server("ancestor-standalone") });
		await writeMcp(path.join(frontend, ".omp", "mcp.json"), { localNative: server("local-native") });
		await writeMcp(path.join(frontend, "mcp.json"), { localStandalone: server("local-standalone") });
		await bindSettings(frontend);

		expect((await discover(frontend)).map(item => item.name).sort()).toEqual(["localNative", "localStandalone"]);
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs).sort()).toEqual([
			"localNative",
			"localStandalone",
		]);
	});

	test("relative roots and home, shared-temp, filesystem and user-config ceilings do not grant inheritance", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { inherited: server("must-not-load") });
		for (const root of [".", "workspaces/Canetoad", home, os.tmpdir(), path.parse(fixture).root]) {
			await trust([root]);
			expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual([]);
		}
		const configChild = path.join(agentDir, "nested", "src");
		await fs.mkdir(configChild, { recursive: true });
		await writeMcp(path.join(agentDir, "nested", "mcp.json"), { configTree: server("must-not-inherit-config") });
		for (const root of [path.join(home, ".omp"), agentDir, path.join(agentDir, "nested")]) {
			await trust([root], configChild);
			expect(Object.keys((await loadAllMCPConfigs(configChild)).configs)).toEqual([]);
		}
	});

	test("home-relative roots grant the same workspace as absolute roots", async () => {
		await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("home-relative-signoz") });
		await trust(["~/workspaces/Canetoad"]);
		expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["signoz"]);
	});

	test.skipIf(process.platform === "win32")(
		"a cwd symlink escaping a trusted root cannot inherit its logical ancestors",
		async () => {
			await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("must-not-escape") });
			await fs.symlink(outside, path.join(canetoad, "escape"), "dir");
			await trust([canetoad]);

			expect(Object.keys((await loadAllMCPConfigs(path.join(canetoad, "escape"))).configs)).toEqual([]);
			expect((await discover(path.join(canetoad, "escape"))).map(item => item.name)).toEqual([]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"symlinked native directories and standalone files outside the boundary are not loaded",
		async () => {
			const externalNative = path.join(fixture, "external-native");
			await writeMcp(path.join(externalNative, "mcp.json"), { escapedNative: server("escaped-native") });
			await writeMcp(path.join(fixture, "external.json"), { escapedStandalone: server("escaped-standalone") });
			await fs.symlink(externalNative, path.join(canetoad, ".omp"), "dir");
			await fs.symlink(path.join(fixture, "external.json"), path.join(canetoad, "mcp.json"), "file");
			await writeMcp(path.join(canetoad, "frontend", ".omp", "mcp.json"), { safe: server("safe-child") });
			await trust([canetoad]);

			expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual(["safe"]);
			expect((await discover(frontend)).map(item => item.name)).toEqual(["safe"]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"symlinked native config files cannot import an external target",
		async () => {
			await writeMcp(path.join(fixture, "external.json"), { escaped: server("escaped") });
			await fs.mkdir(path.join(canetoad, ".omp"));
			await fs.symlink(path.join(fixture, "external.json"), path.join(canetoad, ".omp", "mcp.json"), "file");
			await trust([canetoad]);
			expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual([]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"an escaping config directory is rejected even if its file points back inside",
		async () => {
			const internalFile = path.join(canetoad, "internal-config.json");
			const externalDir = path.join(fixture, "external-directory");
			await writeMcp(internalFile, { escapedDirectory: server("must-not-load") });
			await fs.mkdir(externalDir);
			await fs.symlink(internalFile, path.join(externalDir, "mcp.json"), "file");
			await fs.symlink(externalDir, path.join(canetoad, ".omp"), "dir");
			await trust([canetoad]);

			expect(Object.keys((await loadAllMCPConfigs(frontend)).configs)).toEqual([]);
			expect((await discover(frontend)).map(item => item.name)).toEqual([]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a configured symlink root grants its canonical target for physical and alias launches",
		async () => {
			const alias = path.join(home, "canetoad-alias");
			await fs.symlink(canetoad, alias, "dir");
			await writeMcp(path.join(canetoad, ".omp", "mcp.json"), { signoz: server("canonical-signoz") });
			await trust([alias]);

			for (const cwd of [frontend, path.join(alias, "frontend", "src")]) {
				const result = await loadAllMCPConfigs(cwd);
				expect(Object.keys(result.configs)).toEqual(["signoz"]);
				expect(result.sources.signoz.path).toBe(path.join(canetoad, ".omp", "mcp.json"));
			}
		},
	);
});
