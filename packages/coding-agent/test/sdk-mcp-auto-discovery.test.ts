import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import { MANY_TOOL_COUNT } from "./fixtures/many-tools-mcp";

// Contracts for deferred (hasUI) MCP discovery follow-ups:
//
// 1. `tools.discoveryMode: "auto"` is resolved at session build time against a
//    registry that cannot yet contain the deferred MCP tools. When the
//    background connect reports a toolset large enough to cross the auto
//    threshold, the session MUST upgrade to discovery mode — register and
//    activate `search_tool_bm25`, mark discovery enabled, and expose the MCP
//    tools as discoverable — instead of force-activating all of them.
//
// 2. A session disposed while servers are still connecting MUST NOT be touched
//    by the late discovery result: no tools resurrected onto the disposed
//    session and the manager's transports disconnected.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

describe("createAgentSession deferred MCP auto discovery", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;
	// Discovery resolves user-level MCP config from `os.homedir()`; redirect it
	// to an empty dir so the test connects ONLY to the fixture server and never
	// spawns the developer's real MCP servers.
	let isolatedHome: string;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-auto-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-auto-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		originalAgentDir = getAgentDir();
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-auto-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		setAgentDir(tempDir);
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	const writeMcpConfig = (extraArgs: string[] = []) => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					many: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, ...extraArgs] },
				},
			}),
		);
	};

	const baseOptions = () => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		enableMCP: true,
		hasUI: true,
	});

	it("flips auto discovery on when the deferred MCP toolset crosses the threshold", async () => {
		writeMcpConfig();
		// A small explicit toolset keeps the pre-discovery registry far below the
		// 40-tool auto threshold; the fixture's 45 tools must push it across.
		const { session } = await createAgentSession({ ...baseOptions(), toolNames: ["read", "edit", "bash"] });
		try {
			// Genuine integration wait: discovery spawns the fixture as a real
			// subprocess and connects asynchronously, and the SDK fires that work
			// fire-and-forget with no completion promise or event exposed — fake
			// timers cannot drive a child process, so poll the live session with
			// a generous ceiling, exiting the instant discovery flips on.
			const deadline = Date.now() + 30_000;
			while (!session.isMCPDiscoveryEnabled() && Date.now() < deadline) {
				await Bun.sleep(50);
			}

			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("search_tool_bm25");
			// Discovery mode means the MCP tools are searchable, NOT force-activated.
			expect(activeNames.filter(name => name.startsWith("mcp__"))).toEqual([]);
			const discoverable = session.getDiscoverableTools({ source: "mcp" });
			expect(discoverable.length).toBe(MANY_TOOL_COUNT);
		} finally {
			await session.dispose();
		}
	}, 40_000);

	it("disposing mid-connect disconnects the manager and never resurrects tools", async () => {
		// Stall `initialize` in the real fixture subprocess so the connect is
		// guaranteed to still be in flight when dispose() runs. Deterministic
		// time control cannot order a race against a child process.
		writeMcpConfig(["--delay", "750"]);
		const { session, mcpManager } = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(mcpManager).toBeDefined();
		if (!mcpManager) throw new Error("expected deferred session to own an MCPManager");
		const disconnectSpy = spyOn(mcpManager, "disconnectAll");

		await session.dispose();
		expect(session.isDisposed).toBe(true);

		// Genuine integration wait (see above): the deferred task notices the
		// disposed session once the stalled connect resolves and must disconnect
		// instead of refreshing tools. Exits the instant the spy fires.
		const deadline = Date.now() + 30_000;
		while (disconnectSpy.mock.calls.length === 0 && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		expect(disconnectSpy).toHaveBeenCalled();
		expect(session.getActiveToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		expect(session.getActiveToolNames()).not.toContain("search_tool_bm25");
		expect(session.isMCPDiscoveryEnabled()).toBe(false);
	}, 40_000);

	it("disconnects the owned MCP manager when a top-level session disposes", async () => {
		writeMcpConfig();
		const { session, mcpManager } = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(mcpManager).toBeDefined();
		if (!mcpManager) throw new Error("expected owning session to create an MCPManager");
		try {
			// Let the deferred connect FINISH first, so a later disconnectAll can
			// only originate from dispose() itself — not the mid-connect disposal
			// path (covered by the test above). Genuine integration wait: discovery
			// connects a real subprocess fire-and-forget with no awaitable signal,
			// and fake timers cannot drive a child process; poll the live session
			// with a generous ceiling, exiting the instant discovery flips on.
			const deadline = Date.now() + 30_000;
			while (!session.isMCPDiscoveryEnabled() && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(session.isMCPDiscoveryEnabled()).toBe(true);
			expect(mcpManager.getConnectedServers()).toContain("many");

			const disconnectSpy = spyOn(mcpManager, "disconnectAll");
			await session.dispose();
			expect(disconnectSpy).toHaveBeenCalled();
		} finally {
			// dispose() already tore it down; this is idempotent belt-and-braces.
			await mcpManager.disconnectAll();
		}
	}, 40_000);

	it("does not disconnect a reused parent MCP manager when a child session disposes", async () => {
		writeMcpConfig();
		const parent = await createAgentSession({
			...baseOptions(),
			toolNames: ["read", "edit", "bash"],
		});
		expect(parent.mcpManager).toBeDefined();
		if (!parent.mcpManager) throw new Error("expected parent session to create an MCPManager");
		const parentManager = parent.mcpManager;
		try {
			// A subagent-style session reuses the parent's manager via
			// `mcpManager` and therefore does NOT own it.
			const child = await createAgentSession({
				...baseOptions(),
				hasUI: false,
				toolNames: ["read"],
				mcpManager: parentManager,
			});
			const disconnectSpy = spyOn(parentManager, "disconnectAll");
			await child.session.dispose();
			expect(disconnectSpy).not.toHaveBeenCalled();
		} finally {
			await parent.session.dispose();
			await parentManager.disconnectAll();
		}
	}, 40_000);
});
