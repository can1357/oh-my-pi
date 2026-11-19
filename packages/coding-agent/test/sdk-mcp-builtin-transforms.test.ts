import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

// Contract: a session whose eval tool runs JavaScript starts without connecting
// Codex Desktop's bundled `node_repl` (a second JavaScript kernel inherited from
// Codex's config), and one whose eval cannot run JavaScript still connects it.
// Regression guard for the startup path: the session's transform context must
// reach discovery, or the server is spawned as before with nothing reporting it.
describe("createAgentSession built-in MCP transforms", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config through the process-global agent
	// directory and os.homedir(); point both at an empty home so only the
	// project fixture is discovered.
	let originalAgentDir: string;
	let isolatedHome: string;
	let projectDir: string;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-transform-home-${Snowflake.next()}`);
		const isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		closeModelCache();
		setAgentDir(originalAgentDir);
		if (fs.existsSync(isolatedHome)) removeSyncWithRetries(isolatedHome);
	});

	beforeEach(() => {
		projectDir = path.join(os.tmpdir(), `pi-sdk-mcp-transform-${Snowflake.next()}`);
		fs.mkdirSync(path.join(projectDir, ".codex"), { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		// The binary does not exist: a session that keeps the server only fails to spawn it.
		fs.writeFileSync(
			path.join(projectDir, ".codex", "config.toml"),
			'[mcp_servers.node_repl]\ncommand = "/nonexistent/cua_node/bin/node_repl"\n',
		);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		if (fs.existsSync(projectDir)) removeSyncWithRetries(projectDir);
		mock.restore();
	});

	async function startSession(values: Record<string, unknown>) {
		const { session, mcpManager } = await createAgentSession({
			cwd: projectDir,
			agentDir: projectDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "browser.enabled": false, "disassembler.backend": "none", ...values }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
		});
		sessions.push(session);
		if (!mcpManager) throw new Error("expected the session to own an MCP manager");
		return mcpManager;
	}

	it("does not start Codex's node_repl while eval runs JavaScript", async () => {
		const manager = await startSession({});

		expect([...manager.getBuiltinDrops().keys()]).toEqual(["node_repl"]);
		expect(manager.getAllServerNames()).toEqual([]);
	});

	it("starts it when eval cannot run JavaScript", async () => {
		const manager = await startSession({ "eval.js": false });

		expect(manager.getBuiltinDrops().size).toBe(0);
		expect(manager.getAllServerNames()).toEqual(["node_repl"]);
	});
});
