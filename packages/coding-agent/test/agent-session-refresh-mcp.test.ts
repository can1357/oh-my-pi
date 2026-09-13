/**
 * `AgentSession.refresh('mcp')` MCP reconnect path, driven through the real
 * session so it defends two contracts:
 *
 *   - The session's extension roots are threaded into `discoverAndConnect`, so
 *     extension-declared MCP servers survive the reconnect instead of vanishing
 *     until restart (pre-fix, the session called discoverAndConnect WITHOUT
 *     extensionRoots).
 *   - The plain refresh serialization still runs its happy path after the dead
 *     restart-latch layer was removed: sequential and overlapping refreshes both
 *     complete and reconnect.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { applyMCPEnvironment, getSessionExaApiKey } from "@oh-my-pi/pi-coding-agent/mcp/reload";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const roots: EffectiveExtensionRoots = {
	explicit: ["/ext/pkg"],
	mode: "merge",
	configured: [],
	provenance: "session",
} as unknown as EffectiveExtensionRoots;

function fakeManager() {
	return {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({
			tools: [],
			errors: new Map<string, string>(),
			connectedServers: [],
			exaApiKeys: [],
		})),
		getTools: vi.fn(() => []),
		setNotificationsEnabled: vi.fn((_enabled: boolean) => {}),
		setCwd: vi.fn((_cwd: string) => {}),
	};
}

describe("AgentSession.refresh('mcp')", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		MCPManager.setInstance(undefined);
		vi.restoreAllMocks();
	});

	async function makeSession(mcpManager?: MCPManager, options: { subagent?: boolean } = {}): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		// The MCP refresh branches gate on subagent DEPTH: only a child shares a
		// manager with a parent. A top-level session refreshes whether or not it
		// built the manager itself.
		const subagent = options.subagent ?? false;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager,
			disconnectOwnedMcpManager: mcpManager ? async () => {} : undefined,
			memoryTaskDepth: subagent ? 1 : 0,
		});
		sessions.push(session);
		return session;
	}

	it("threads the session's extension roots into MCP rediscovery", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		// Pre-fix: refresh called discoverAndConnect WITHOUT extensionRoots, so
		// extension-declared servers were dropped on reconnect.
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({ extensionRoots: roots });
	});

	// Startup does not pass the raw `browser.enabled` setting to discovery: it
	// passes `shouldFilterBrowserMCPForPrelude(...)`, which additionally requires
	// the callable browser prelude to be reachable (`eval` registered AND active).
	// This session has an EMPTY tool registry, so no prelude exists — filtering
	// browser MCP servers here would strip browser automation with nothing to
	// replace it, leaving the session worse off after a refresh than before.
	it("filters browser MCP servers only when the callable prelude is available", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);
		session.settings.set("browser.enabled", true);

		await session.refresh("mcp");

		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		// Pre-fix this was `true` (the bare setting), dropping the servers even
		// though `eval` is not registered so no prelude replaces them.
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({ filterBrowser: false });
	});

	it("refreshes THIS session's own manager, not the process-global instance()", async () => {
		// Two top-level sessions with distinct managers. The process-global
		// instance() points at session B's manager (the last setInstance wins),
		// but refreshing session A must reconnect A's own manager.
		const managerA = fakeManager();
		const managerB = fakeManager();
		const sessionA = await makeSession(managerA as unknown as MCPManager);
		MCPManager.setInstance(managerB as unknown as MCPManager);

		await sessionA.refresh("mcp");

		// Pre-fix (refresh read MCPManager.instance()), session B's manager was
		// reconnected — disconnecting B's servers — and A's was untouched.
		expect(managerA.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(managerB.discoverAndConnect).not.toHaveBeenCalled();
		expect(managerB.disconnectAll).not.toHaveBeenCalled();
	});

	it("syncs mcp.notifications onto this session's manager on a settings refresh", async () => {
		const tempDir = TempDir.createSync("@pi-refresh-mcp-notif-");
		const settingsPath = `${tempDir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  notifications: false\n");
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const manager = fakeManager();
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager as unknown as MCPManager,
			// This session OWNS the manager, which is what licenses it to change
			// subscriptions from its own settings scope.
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// Flip notifications false->true on disk, then refresh settings.
		await fsp.writeFile(settingsPath, "mcp:\n  notifications: true\n");
		await session.refresh("settings");

		// Pre-fix: reloading Settings never called setNotificationsEnabled, so
		// the manager kept its stale flag and servers stayed unsubscribed.
		expect(manager.setNotificationsEnabled).toHaveBeenCalledWith(true);
		await tempDir.remove();
	});

	it("surfaces per-server reconnect errors instead of reporting unconditional success", async () => {
		const manager = fakeManager();
		manager.discoverAndConnect = vi.fn(async (_options?: unknown) => ({
			tools: [],
			errors: new Map<string, string>([["broken-server", "ECONNREFUSED"]]),
			connectedServers: [],
			exaApiKeys: [],
		}));
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		// Pre-fix: refresh discarded the MCPLoadResult and never populated
		// mcpErrors, so a failed reconnect reported plain "MCP reconnected".
		expect(result.mcpErrors).toBeInstanceOf(Map);
		expect(result.mcpErrors?.get("broken-server")).toBe("ECONNREFUSED");
	});

	it("leaves mcpErrors unset when every server reconnects", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		expect(result.mcpErrors).toBeUndefined();
	});

	it("runs sequential and overlapping refreshes to completion (no dead restart latch)", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		// Sequential.
		expect((await session.refresh("mcp")).mcp).toBe(true);
		expect((await session.refresh("mcp")).mcp).toBe(true);

		// Overlapping: both serialize onto the tail and both resolve to a real
		// reconnect result — never a `refused` refusal (the removed latch).
		const [a, b] = await Promise.all([session.refresh("mcp"), session.refresh("mcp")]);
		expect(a.mcp).toBe(true);
		expect(b.mcp).toBe(true);
		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(4);
	});

	it("does not disconnect or rediscover an inherited (parent's) manager", async () => {
		// A subagent granted the `refresh` tool shares its parent's live manager
		// (`structured-subagent.ts` forwards `session.mcpManager`).
		// `refresh('mcp')` on that child must NOT touch the shared manager: it
		// would interrupt concurrent parent calls and replace the parent's MCP
		// configuration with the child's settings/extension scope.
		const inherited = fakeManager();
		const child = await makeSession(inherited as unknown as MCPManager, { subagent: true });

		const result = await child.refresh("mcp");

		// Pre-fix (branch ran for any non-null manager), the shared manager was
		// disconnected and rediscovered under the child's scope.
		expect(inherited.disconnectAll).not.toHaveBeenCalled();
		expect(inherited.discoverAndConnect).not.toHaveBeenCalled();
		expect(result.mcp).toBeUndefined();
		// Nor may the child REPOINT the shared manager's discovery cwd. The
		// repoint runs on every scope, ahead of `settings.reload()`, so without
		// the depth gate a subagent whose cwd differs from its parent's would
		// silently aim the parent's MCP discovery — and its browser-filter
		// reconcile — at the child's directory.
		expect(inherited.setCwd).not.toHaveBeenCalled();

		// A top-level session still refreshes its manager.
		const owned = fakeManager();
		const top = await makeSession(owned as unknown as MCPManager);
		expect((await top.refresh("mcp")).mcp).toBe(true);
		expect(owned.discoverAndConnect).toHaveBeenCalledTimes(1);
	});

	// A live session can MOVE project (`/move`, a cross-project resume):
	// `SessionManager` and `Settings` are repointed, but the owned `MCPManager`
	// captured its discovery cwd at construction. So a reconnect disconnected the
	// CURRENT project's servers and then reloaded `.mcp.json` from the ORIGINAL
	// one, respawning the old project's stdio commands.
	it("reloads MCP config from the session's CURRENT directory after a move", async () => {
		const origin = TempDir.createSync("@pi-refresh-mcp-origin-");
		const moved = TempDir.createSync("@pi-refresh-mcp-moved-");
		// A REAL manager, so the cwd its config loader receives is the one
		// discovery would actually read — a stubbed `setCwd` could not show that.
		const loadedFrom: string[] = [];
		const manager = new MCPManager(origin.path(), null, async cwd => {
			loadedFrom.push(cwd);
			return { configs: {}, exaApiKeys: [], sources: {} };
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const sessionManager = SessionManager.inMemory(origin.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// Guard the premise: before any move, discovery reads the origin.
		expect((await session.refresh("mcp")).mcp).toBe(true);
		expect(loadedFrom).toEqual([origin.path()]);

		// `/move` relocates the session: SessionManager's cwd is the new project.
		sessionManager.setCwdWithoutRelocation(moved.path());

		expect((await session.refresh("mcp")).mcp).toBe(true);

		// Pre-fix this was the ORIGIN again — the manager's constructor-time cwd —
		// so the destination project's servers never loaded and the source
		// project's stdio commands were respawned.
		expect(loadedFrom).toEqual([origin.path(), moved.path()]);

		await origin.remove();
		await moved.remove();
	});

	// The ordering half of the same bug, and the one the `mcp`-scope test above
	// cannot reach: `refresh('settings')` never enters the MCP reconnect block,
	// but `settings.reload()` emits `browser.enabled` synchronously and the
	// eval-prelude listener answers it by calling
	// `MCPManager.reconcileBrowserFilter`, which loads the MCP configuration
	// itself. With the cwd repoint living inside the reconnect block, that load
	// ran against the manager's CONSTRUCTION-time cwd — so on a moved session a
	// browser-prelude enablement flip read the PREVIOUS project's `.mcp.json`
	// and connected its stdio browser servers.
	it("reconciles the browser filter from the CURRENT directory on a settings refresh after a move", async () => {
		const origin = TempDir.createSync("@pi-refresh-mcp-browser-origin-");
		const moved = TempDir.createSync("@pi-refresh-mcp-browser-moved-");
		// The reload must see `browser.enabled` genuinely MOVE, so the value comes
		// from the on-disk config layer rather than an override.
		const settingsPath = `${origin.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "browser:\n  enabled: true\n");
		const settings = await Settings.loadIsolated({ cwd: origin.path(), agentDir: origin.path() });
		// A REAL manager, so the cwd its config loader receives is the one the
		// browser reconcile would actually read.
		const loadedFrom: string[] = [];
		const manager = new MCPManager(origin.path(), null, async cwd => {
			loadedFrom.push(cwd);
			return { configs: {}, exaApiKeys: [], sources: {} };
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const sessionManager = SessionManager.inMemory(origin.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
			// The same wiring sdk.ts installs: this is the hook the eval-prelude
			// listener calls, and the reason a settings reload can reach MCP
			// config loading without any `mcp`-scope refresh.
			reconcileBrowserMcpFilter: async enabled => {
				await manager.reconcileBrowserFilter(enabled);
				return manager.getTools();
			},
		});
		sessions.push(session);

		// `/move` relocates the session: SessionManager's cwd is the new project.
		sessionManager.setCwdWithoutRelocation(moved.path());
		// Turning the browser prelude OFF is the severe direction: the reconcile
		// CONNECTS the browser servers it finds, so reading the wrong project's
		// config spawns that project's stdio commands.
		await fsp.writeFile(settingsPath, "browser:\n  enabled: false\n");

		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix `loadedFrom` was `[origin]`: the listener fired before the
		// reconnect block's `setCwd`, which a `settings` scope never runs anyway.
		expect(loadedFrom).toEqual([moved.path()]);
		expect(loadedFrom).not.toContain(origin.path());

		await origin.remove();
		await moved.remove();
	});

	// `mcp.enableProjectConfig` is consumed only during discovery, and a
	// `settings`-scope refresh never enters the reconnect block — so flipping it
	// off left the project servers this session had already started connected and
	// their tools callable until an `mcp`/`all` refresh or a restart.
	it("disconnects already-running project MCP servers when enableProjectConfig is turned off", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-projectcfg-");
		const settingsPath = `${dir.path()}/config.yml`;
		// On-disk, so the reload sees the value genuinely MOVE.
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		// One project-level server and one user-level server, so the reconcile has
		// to discriminate by source level rather than dropping everything.
		const configs = {
			"proj-server": { command: "true", args: [] },
			"user-server": { command: "true", args: [] },
		};
		const sources: Record<string, SourceMeta> = {
			"proj-server": {
				level: "project",
				path: `${dir.path()}/.mcp.json`,
				provider: "mcp",
				providerName: "MCP",
			},
			"user-server": {
				level: "user",
				path: `${dir.path()}/user.json`,
				provider: "mcp",
				providerName: "MCP",
			},
		};
		const manager = new MCPManager(dir.path(), null, async () => ({ configs, exaApiKeys: [], sources }));
		const disconnected: string[] = [];
		const realDisconnect = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async (name: string) => {
			disconnected.push(name);
			return realDisconnect(name);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// Start both servers, as a session with the setting on would.
		await manager.connectServers(configs, sources);

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix nothing was disconnected: the setting moved, the merged value
		// updated, and the running subprocess stayed callable.
		expect(disconnected).toContain("proj-server");
		// The user-level server is not a project opt-out and must survive.
		expect(disconnected).not.toContain("user-server");

		await dir.remove();
	});

	// `loadConfigs` drops project entries BEFORE deduplication, so a project
	// `foo` that shadowed a user-level `foo` was keeping that user server from
	// connecting at all. Disconnecting the project one alone therefore left NO
	// `foo`, where a fresh session with the setting off runs the user's.
	it("connects a user server the disabled project config was shadowing", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-shadow-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		// One NAME, two levels — the shadow case. The loader answers as the real
		// one does: with project config on, the project entry wins the name; with
		// it off, the project entry is dropped and the user entry is revealed.
		const projectSource: SourceMeta = {
			level: "project",
			path: `${dir.path()}/.mcp.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const userSource: SourceMeta = {
			level: "user",
			path: `${dir.path()}/user.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const manager = new MCPManager(dir.path(), null, async (_cwd, options) =>
			options?.enableProjectConfig === false
				? { configs: { foo: { command: "true", args: ["user"] } }, exaApiKeys: [], sources: { foo: userSource } }
				: {
						configs: { foo: { command: "true", args: ["project"] } },
						exaApiKeys: [],
						sources: { foo: projectSource },
					},
		);
		const connected: Array<Record<string, unknown>> = [];
		const realConnect = manager.connectServers.bind(manager);
		manager.connectServers = async (configs, sources, onStatus) => {
			connected.push(configs as Record<string, unknown>);
			return realConnect(configs, sources, onStatus);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// The project entry owns the name, as it would at startup.
		await manager.connectServers({ foo: { command: "true", args: ["project"] } }, { foo: projectSource });
		connected.length = 0;

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix the disable path returned straight after disconnecting, so
		// `connected` stayed empty and the session was left with no `foo`.
		expect(connected.flatMap(batch => Object.keys(batch))).toContain("foo");
		// The USER entry's config, not the project one that was disconnected —
		// `args` distinguishes them, and narrowing keeps the union honest.
		const revealed = manager.getServerConfig("foo");
		expect(revealed && "args" in revealed ? revealed.args : undefined).toEqual(["user"]);

		await dir.remove();
	});

	// A subagent granted the `refresh` tool INHERITS its parent's manager
	// (`disconnectOwnedMcpManager` unset). Reconciling there would disconnect the
	// parent's project servers and rewrite its discovery policy from the child's
	// own settings scope — the same hazard the `mcp`-scope path already guards.
	it("does not reconcile an inherited MCP manager from a child's settings", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-inherited-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const configs = { "proj-server": { command: "true", args: [] } };
		const sources: Record<string, SourceMeta> = {
			"proj-server": {
				level: "project",
				path: `${dir.path()}/.mcp.json`,
				provider: "mcp",
				providerName: "MCP",
			},
		};
		const manager = new MCPManager(dir.path(), null, async () => ({ configs, exaApiKeys: [], sources }));
		const disconnected: string[] = [];
		const realDisconnect = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async (name: string) => {
			disconnected.push(name);
			return realDisconnect(name);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			// A subagent: it shares the manager its parent handed it.
			memoryTaskDepth: 1,
		});
		sessions.push(session);

		await manager.connectServers(configs, sources);

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		// The refresh still succeeds and the child still re-reads its tool view.
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// The shared manager is untouched: the parent's server stays connected.
		expect(disconnected).toEqual([]);
		expect(manager.getServerConfig("proj-server")).toBeDefined();

		await dir.remove();
	});

	// The other direction of the same shadow. A session that STARTED with project
	// config off has the user-level `foo` connected; turning the setting on makes
	// the project `foo` outrank it, so leaving the user server running keeps a
	// command a freshly started session would not run.
	it("replaces a user server when re-enabling project config promotes a project entry", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-promote-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const projectSource: SourceMeta = {
			level: "project",
			path: `${dir.path()}/.mcp.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const userSource: SourceMeta = {
			level: "user",
			path: `${dir.path()}/user.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const manager = new MCPManager(dir.path(), null, async (_cwd, options) =>
			options?.enableProjectConfig === false
				? { configs: { foo: { command: "true", args: ["user"] } }, exaApiKeys: [], sources: { foo: userSource } }
				: {
						configs: { foo: { command: "true", args: ["project"] } },
						exaApiKeys: [],
						sources: { foo: projectSource },
					},
		);
		const disconnected: string[] = [];
		const realDisconnect = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async (name: string) => {
			disconnected.push(name);
			return realDisconnect(name);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// The real startup path, so the manager records the same discover options a
		// session would carry — including `enableProjectConfig: false`, which is
		// what makes the later flip a genuine transition rather than a no-op.
		await manager.discoverAndConnect({ enableProjectConfig: false });

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix the name was already connected, so the reconcile skipped it and
		// the session kept running the user command the project entry outranks.
		expect(disconnected).toContain("foo");
		const promoted = manager.getServerConfig("foo");
		expect(promoted && "args" in promoted ? promoted.args : undefined).toEqual(["project"]);

		await dir.remove();
	});

	// The converse guard: an unrelated server whose selection did not move must
	// not be torn down and restarted just because the setting was touched.
	it("leaves an uncontested server connected across a project config flip", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-stable-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const userSource: SourceMeta = {
			level: "user",
			path: `${dir.path()}/user.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const configs = { solo: { command: "true", args: ["user"] } };
		const manager = new MCPManager(dir.path(), null, async () => ({
			configs,
			exaApiKeys: [],
			sources: { solo: userSource },
		}));
		const disconnected: string[] = [];
		const realDisconnect = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async (name: string) => {
			disconnected.push(name);
			return realDisconnect(name);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		await manager.discoverAndConnect({ enableProjectConfig: false });

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Nothing about `solo` moved, so the running process is untouched.
		expect(disconnected).toEqual([]);

		await dir.remove();
	});

	// Exa MCP entries are filtered out in favour of the native integration, so the
	// key discovery extracts never rides a connection. The reconcile discarded it,
	// which left the native integration unauthenticated when project config
	// revealed a project Exa entry.
	it("applies the Exa credentials a project config flip reveals", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-exa-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		// Discovery returns the key only with project config ON, and — as the real
		// loader does for Exa — filters the server itself out of `configs`.
		const manager = new MCPManager(dir.path(), null, async (_cwd, options) => ({
			configs: {},
			exaApiKeys: options?.enableProjectConfig === false ? [] : ["project-exa-key"],
			sources: {},
		}));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		await manager.discoverAndConnect({ enableProjectConfig: false });

		// `applyMCPEnvironment` writes the live environment, so restore it: a
		// leaked `EXA_API_KEY` would change how every later test in the run sees
		// the native integration.
		const previousExaKey = process.env.EXA_API_KEY;
		try {
			await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
			// `refresh` joins the registered host reconciliation internally before
			// returning, so the credential is applied by the time this resolves.
			expect((await session.refresh("settings")).settingsChanged).toBe(true);

			// Pre-fix `#connectNewlyDiscovered` dropped `exaApiKeys` on the floor, so
			// the revealed credential never reached the native integration. Asserted
			// on the live environment, which is what the integration actually reads.
			expect(process.env.EXA_API_KEY).toBe("project-exa-key");
		} finally {
			if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = previousExaKey;
		}

		await dir.remove();
	});

	// Beyond the same-name REPLACEMENT case: a project entry can claim a name
	// during capability dedup and then be suppressed (its own `enabled: false`),
	// so the new selection contains NO entry for that name while the user-level
	// server it outranked is still connected. A fresh session would expose none.
	it("disconnects a user server a suppressed project entry hides", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-suppressed-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const userSource: SourceMeta = {
			level: "user",
			path: `${dir.path()}/user.json`,
			provider: "mcp",
			providerName: "MCP",
		};
		const manager = new MCPManager(dir.path(), null, async (_cwd, options): Promise<LoadMCPConfigsResult> =>
			options?.enableProjectConfig === false
				? { configs: { foo: { command: "true", args: ["user"] } }, exaApiKeys: [], sources: { foo: userSource } }
				: // Project config ON: the project `foo` wins the name and is then
					// suppressed, so `configs` carries no `foo` at all.
					{ configs: {}, exaApiKeys: [], sources: {} },
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		await manager.discoverAndConnect({ enableProjectConfig: false });
		expect(manager.getAllServerNames()).toContain("foo");

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix the reconcile iterated only the newly loaded configs, so a name
		// absent from them was never dropped and the user server stayed live.
		expect(manager.getAllServerNames()).not.toContain("foo");

		await dir.remove();
	});

	// The inverse of the test above: an unrelated settings edit leaves
	// `enableProjectConfig` alone, so discovery never runs — and an empty key
	// list is NOT the same claim as "discovery found none". `applyMCPEnvironment`
	// reads an empty list as "config removed the key" and clears the credential.
	it("keeps the Exa credential when a settings refresh does not move project config", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-exa-keep-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const manager = new MCPManager(dir.path(), null, async () => ({
			configs: {},
			exaApiKeys: ["session-exa-key"],
			sources: {},
		}));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		await manager.discoverAndConnect({ enableProjectConfig: true });
		applyMCPEnvironment({ exaApiKeys: ["session-exa-key"] }, manager);
		expect(getSessionExaApiKey(manager)).toBe("session-exa-key");

		const previousExaKey = process.env.EXA_API_KEY;
		try {
			// An edit that has nothing to do with MCP discovery.
			await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n  notifications: true\n");
			expect((await session.refresh("settings")).settingsChanged).toBe(true);

			// Pre-fix the no-op reconcile returned `exaApiKeys: []`, which the caller
			// applied as a removal — dropping the session's own key and clearing the
			// environment the native Exa paths authenticate with.
			expect(getSessionExaApiKey(manager)).toBe("session-exa-key");
			expect(process.env.EXA_API_KEY).toBe("session-exa-key");
		} finally {
			if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = previousExaKey;
		}

		await dir.remove();
	});

	// Same ownership rule as the project-config reconcile: a subagent granted the
	// `refresh` tool inherits its parent's manager, so subscribing or
	// unsubscribing there rewrites the PARENT's live server subscriptions from the
	// child's own settings scope.
	// The browser listener fires from `settings.reload()` on ANY session holding
	// the hook — including a subagent that inherited its parent's manager
	// (`mcpManager` set, `disconnectOwnedMcpManager` unset). Reconciling there
	// connects or disconnects the PARENT's browser transports from the child's
	// settings scope while only the child's tool registry is rebuilt.
	//
	// Keyed on task DEPTH, not on owning the manager: a top-level embedder that
	// supplies its own manager still has to reconcile.
	it("does not reconcile browser MCP on a subagent's inherited manager", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-browser-inherited-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "browser:\n  enabled: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });
		const manager = new MCPManager(dir.path(), null, async () => ({ configs: {}, exaApiKeys: [], sources: {} }));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const reconciledWith: boolean[] = [];
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			// A subagent: the manager it was handed belongs to its parent.
			memoryTaskDepth: 1,
			reconcileBrowserMcpFilter: async enabled => {
				reconciledWith.push(enabled);
				return manager.getTools();
			},
		});
		sessions.push(session);

		await fsp.writeFile(settingsPath, "browser:\n  enabled: false\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		expect(reconciledWith).toEqual([]);

		await dir.remove();
	});

	// The filter means "a callable browser prelude replaces these servers", so it
	// needs `eval` registered AND active — the predicate startup and the full MCP
	// refresh both use. Forwarding the raw setting disconnects the browser servers
	// of a session that has no prelude to replace them.
	it("does not filter browser MCP when no callable prelude replaces it", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-browser-noprelude-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "browser:\n  enabled: false\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });
		const manager = new MCPManager(dir.path(), null, async () => ({ configs: {}, exaApiKeys: [], sources: {} }));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			// No `eval` tool: nothing can serve the browser prelude.
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const reconciledWith: boolean[] = [];
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
			reconcileBrowserMcpFilter: async enabled => {
				reconciledWith.push(enabled);
				return manager.getTools();
			},
		});
		sessions.push(session);

		// Turning the setting ON is the severe direction: pre-fix this forwarded
		// `true` and stripped the session's only browser capability.
		await fsp.writeFile(settingsPath, "browser:\n  enabled: true\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		expect(reconciledWith).toEqual([false]);

		await dir.remove();
	});

	it("does not reconcile mcp.notifications on an inherited manager", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-notif-");
		const settingsPath = `${dir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  notifications: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		const manager = new MCPManager(dir.path(), null, async () => ({ configs: {}, exaApiKeys: [], sources: {} }));
		const applied: boolean[] = [];
		manager.setNotificationsEnabled = (enabled: boolean) => {
			applied.push(enabled);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			// A subagent: it shares the manager its parent handed it.
			memoryTaskDepth: 1,
		});
		sessions.push(session);

		await fsp.writeFile(settingsPath, "mcp:\n  notifications: false\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix this call was unconditional, so the child's scope flipped the
		// parent's subscriptions.
		expect(applied).toEqual([]);

		await dir.remove();
	});
});
