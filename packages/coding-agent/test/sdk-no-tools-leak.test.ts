import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression: `--no-tools` must not leak ambient custom tools (`.omp/tools/tui`),
// MCP-shaped tools (`mcp__node_repl_js*`), or xdev-mounted MCP devices onto the
// provider wire. Before restrictToolNames was wired from the CLI, an empty
// toolNames whitelist still force-activated custom/MCP tools via alwaysInclude
// and xdev presentation, breaking text-only grokbot requests (HTTP 400).
describe("--no-tools leak prevention", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-no-tools-leak-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	function customTool(name: string, mcp = false): CustomTool {
		return {
			name,
			label: name,
			description: name,
			parameters: { type: "object", properties: {} },
			...(mcp ? { mcpServerName: "node_repl_js", mcpToolName: name.replace(/^mcp__node_repl_js__?/, "") } : {}),
			execute: async () => ({ content: [] }),
		} as CustomTool;
	}

	async function restrictedActiveToolNames(customTools: CustomTool[]): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.xdev": true, "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			restrictToolNames: true,
			toolNames: [],
			customTools,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("sets restrictToolNames from --no-tools in buildSessionOptions", async () => {
		const options = await buildSessionOptions(
			parseArgs(["--no-tools"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);
		expect(options.restrictToolNames).toBe(true);
		expect(options.toolNames).toEqual([]);
	});

	it("excludes ambient custom tools from the active wire set", async () => {
		const names = await restrictedActiveToolNames([customTool("tui")]);
		expect(names).toEqual([]);
		expect(names).not.toContain("tui");
	});

	it("excludes MCP-shaped custom tools from the active wire set", async () => {
		const names = await restrictedActiveToolNames([
			customTool("mcp__node_repl_js", true),
			customTool("mcp__node_repl_js_add_node_module_dir", true),
			customTool("mcp__node_repl_js_reset", true),
		]);
		expect(names).toEqual([]);
		for (const name of ["mcp__node_repl_js", "mcp__node_repl_js_add_node_module_dir", "mcp__node_repl_js_reset"]) {
			expect(names).not.toContain(name);
		}
	});

	it("does not allocate xdev transport for a restricted empty tool set", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.xdev": true, "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			restrictToolNames: true,
			toolNames: [],
			customTools: [customTool("tui"), customTool("mcp__node_repl_js", true)],
		});
		sessions.push(session);
		expect(session.getXdevToolEntries()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
	});
});
