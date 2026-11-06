import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPProxyTools } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { LATE_LOADER_TOOL, LIST_DELAY_ENV, LOADED_TOOL, LOADER_TOOL } from "./fixtures/lazy-loader-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "lazy-loader-mcp.ts");
const ctx = {} as CustomToolContext;

function mcpToolNames(tools: readonly { mcpToolName?: string }[]): string[] {
	return tools.map(tool => tool.mcpToolName ?? "");
}

function findTool(tools: readonly CustomTool[], mcpToolName: string): CustomTool {
	const tool = tools.find(candidate => candidate.mcpToolName === mcpToolName);
	if (!tool?.execute) throw new Error(`expected ${mcpToolName}`);
	return tool;
}

/** Call `mcpToolName` as the session whose view is `scope` would. */
async function callAs(manager: MCPManager, scope: string, mcpToolName: string, toolCallId: string): Promise<void> {
	await findTool(createMCPProxyTools(manager, scope), mcpToolName).execute!(toolCallId, {}, undefined, ctx);
}

describe("per-session MCP tool views", () => {
	let workDir: string;
	let manager: MCPManager;
	let ownerSnapshots: string[][];

	async function connect(env: Record<string, string> = {}): Promise<void> {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-scope-"));
		manager = new MCPManager(workDir);
		ownerSnapshots = [];
		manager.setOnToolsChanged(tools => {
			ownerSnapshots.push(mcpToolNames(tools));
		});
		// No startup deadline: the slow-list case must not fall back to cached tools.
		await manager.connectServers(
			{ alpha: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH], env } },
			{},
			undefined,
			0,
		);
	}

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("shows tools a session's call loads to that session alone until another session calls the server", async () => {
		await connect();
		manager.openToolScope("loader");
		manager.openToolScope("sibling");

		await callAs(manager, "loader", LOADER_TOOL, "a-load");

		// The call returns only after its refresh landed, with the tool in its own view.
		expect(mcpToolNames(manager.getTools("loader"))).toContain(LOADED_TOOL);
		expect(mcpToolNames(manager.getTools("sibling"))).not.toContain(LOADED_TOOL);
		expect(mcpToolNames(manager.getTools())).not.toContain(LOADED_TOOL);
		expect(ownerSnapshots.some(names => names.includes(LOADED_TOOL))).toBe(false);

		// The sibling's own call reaches the server; nothing changes there, yet it now sees the tool.
		await callAs(manager, "sibling", LOADER_TOOL, "b-load");
		expect(mcpToolNames(manager.getTools("sibling"))).toContain(LOADED_TOOL);
		expect(mcpToolNames(manager.getTools())).not.toContain(LOADED_TOOL);

		// The owner's call does the same for the owner.
		await findTool(manager.getTools(), LOADER_TOOL).execute!("owner-load", {}, undefined, ctx);
		expect(mcpToolNames(manager.getTools())).toContain(LOADED_TOOL);
		expect(ownerSnapshots.at(-1)).toContain(LOADED_TOOL);
	});

	it("keeps a reopened view's tools and starts a new view from its spawner's", async () => {
		await connect();
		manager.openToolScope("parent");
		await callAs(manager, "parent", LOADER_TOOL, "parent-load");

		// A revived session reopens its view: the seed is ignored and its own grants stay.
		manager.openToolScope("parent", "unrelated");
		expect(mcpToolNames(manager.getTools("parent"))).toContain(LOADED_TOOL);

		// A child spawned by that session starts from its view; one spawned by the owner does not.
		manager.openToolScope("nested", "parent");
		manager.openToolScope("top-level");
		expect(mcpToolNames(manager.getTools("nested"))).toContain(LOADED_TOOL);
		expect(mcpToolNames(manager.getTools("top-level"))).not.toContain(LOADED_TOOL);
	});

	it("scopes a load whose notice lands while an unrelated refresh is still listing", async () => {
		await connect({ [LIST_DELAY_ENV]: "300" });
		manager.openToolScope("loader");
		const connection = manager.getConnection("alpha");
		if (!connection?.transport.onNotification) throw new Error("expected transport onNotification to be wired");

		// A server-initiated change starts a refresh whose list predates the load below.
		void connection.transport.onNotification("notifications/tools/list_changed", {});
		await callAs(manager, "loader", LOADER_TOOL, "a-load");

		expect(mcpToolNames(manager.getTools("loader"))).toContain(LOADED_TOOL);
		expect(mcpToolNames(manager.getTools())).not.toContain(LOADED_TOOL);
		expect(ownerSnapshots.some(names => names.includes(LOADED_TOOL))).toBe(false);
	});

	it("shows every session a change the server announces while no call to it runs", async () => {
		await connect();
		manager.openToolScope("loader");
		const { promise: announced, resolve } = Promise.withResolvers<void>();
		const off = manager.addToolsChangedListener(() => {
			if (mcpToolNames(manager.getTools()).includes(LOADED_TOOL)) resolve();
		});
		try {
			await callAs(manager, "loader", LATE_LOADER_TOOL, "late-load");
			await announced;
		} finally {
			off();
		}

		manager.openToolScope("later");
		expect(mcpToolNames(manager.getTools("later"))).toContain(LOADED_TOOL);
		expect(ownerSnapshots.at(-1)).toContain(LOADED_TOOL);
	});
});
