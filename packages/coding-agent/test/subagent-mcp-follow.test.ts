/**
 * A subagent session reuses its parent's MCP manager through proxy tools. Those
 * proxies must register as manager-owned (`mcpTools`), so a parent `/mcp reload`
 * that adds or removes a server reaches the live child instead of the child
 * retaining its spawn-time snapshot forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createMCPProxyTools, followMCPTools } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

function serversOf(session: AgentSession): string[] {
	const servers = new Set<string>();
	for (const name of session.getEnabledToolNames()) {
		const match = /^mcp__([a-z]+)_/.exec(name);
		if (match?.[1]) servers.add(match[1]);
	}
	return [...servers].sort();
}

describe("subagent session MCP tools follow the shared manager", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let manager: MCPManager;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), `omp-subagent-mcp-follow-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		await manager.disconnectAll();
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	function sessionOptions(): CreateAgentSessionOptions {
		return {
			cwd: dir,
			agentDir: dir,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	it("adds and removes a live child's MCP tools across parent reloads", async () => {
		await manager.connectServers({ alpha: fixtureConfig() }, {});
		const follower = followMCPTools(manager);
		const { session: child } = await createAgentSession({
			...sessionOptions(),
			mcpManager: manager,
			mcpTools: createMCPProxyTools(manager),
			parentTaskPrefix: "Follow-1",
		});
		sessions.push(child);
		follower.bind(child);
		expect(serversOf(child)).toEqual(["alpha"]);

		// Parent: `/mcp add bravo`, then `/mcp reload`.
		await manager.disconnectAll();
		await manager.connectServers({ alpha: fixtureConfig(), bravo: fixtureConfig() }, {});
		await child.runToolRegistryMutation(async () => undefined);
		expect(serversOf(child)).toEqual(["alpha", "bravo"]);

		// Parent: remove alpha, then `/mcp reload`. Its proxies must leave the child too.
		await manager.disconnectAll();
		await manager.connectServers({ bravo: fixtureConfig() }, {});
		await child.runToolRegistryMutation(async () => undefined);
		expect(serversOf(child)).toEqual(["bravo"]);
	}, 20_000);

	it("keeps a child's explicitly supplied same-name tool over the MCP proxy, before and after a reload", async () => {
		await manager.connectServers({ alpha: fixtureConfig() }, {});
		const collidingName = `mcp__alpha_${manyToolName(0)}`;
		const KERNEL_RESULT = "kernel-defined tool ran";
		const kernelTool: CustomTool = {
			name: collidingName,
			label: collidingName,
			description: "Kernel-defined tool sharing an MCP tool's minted name.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: KERNEL_RESULT }] }),
		};
		const follower = followMCPTools(manager, new Set([collidingName]));
		const { session: child } = await createAgentSession({
			...sessionOptions(),
			mcpManager: manager,
			mcpTools: createMCPProxyTools(manager),
			customTools: [kernelTool],
			parentTaskPrefix: "Follow-2",
		});
		sessions.push(child);
		follower.bind(child);
		const runColliding = async (): Promise<string> => {
			const tool = child.getToolByName(collidingName);
			if (!tool) throw new Error(`${collidingName} missing from the child`);
			const result = await tool.execute("call-colliding", {});
			return result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		};
		expect(await runColliding()).toBe(KERNEL_RESULT);

		// Parent `/mcp reload`: the rebind must not hand the name back to the MCP proxy.
		await manager.disconnectAll();
		await manager.connectServers({ alpha: fixtureConfig() }, {});
		await child.runToolRegistryMutation(async () => undefined);
		expect(await runColliding()).toBe(KERNEL_RESULT);
		// The rest of alpha's proxies still follow the reload.
		expect(child.getEnabledToolNames()).toContain(`mcp__alpha_${manyToolName(1)}`);
	}, 20_000);
});
