/**
 * The per-session MCP tool view has three load-bearing arguments that are all
 * optional, so dropping one compiles and leaves every narrower test green:
 *
 * 1. `DeferredMCPTool.fromTools(..., observeCall)` in the manager's lazy
 *    startup branch. Without it a cached lazy server's first use is attributed
 *    to nobody, the tools that call loads are scoped to no session, and they
 *    leak into every session's list.
 * 2. `explainMissingTool(name, scope)` at the session's agent-loop wiring
 *    (`sdk.ts`). Without the scope a subagent reads the owner's note.
 * 3. `explainMissingTool(name, scope)` at the session's `xd://` state
 *    (`tools/index.ts`). Same miss on the device-dispatch path.
 *
 * The notes in (2) and (3) are asserted through a real `AgentSession` whose
 * `mcpToolScope` is set — the only thing that holds those two call sites
 * correct, since every other test calls the manager or the remote directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import type { CustomTool, CustomToolContext } from "../src/extensibility/custom-tools/types";
import { MCPManager } from "../src/mcp/manager";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";
import { createMCPProxyTools } from "../src/task/executor";
import { LATE_LOADER_TOOL, LOADED_TOOL, LOADER_TOOL } from "./fixtures/lazy-loader-mcp";
import { MARKER_ENV, RENAME_TOOL, RENAMED_TOOL } from "./fixtures/renaming-mcp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const LOADER_FIXTURE = path.join(FIXTURES, "lazy-loader-mcp.ts");
const RENAMING_FIXTURE = path.join(FIXTURES, "renaming-mcp.ts");
const ctx = {} as CustomToolContext;
/** A tool name no configured server serves, so the miss is explained rather than resolved. */
const GHOST_TOOL = "mcp__kata_other";

const cleanups: Array<() => unknown | Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	MCPManager.resetForTests();
});

function memoryStorage(): AgentStorage {
	const store = new Map<string, string>();
	return {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
}

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => removeSyncWithRetries(dir));
	return dir;
}

function mcpToolNames(tools: readonly { mcpToolName?: string }[]): string[] {
	return tools.map(tool => tool.mcpToolName ?? "").sort();
}

function findTool(tools: readonly CustomTool[], mcpToolName: string): CustomTool {
	const tool = tools.find(candidate => candidate.mcpToolName === mcpToolName);
	if (!tool?.execute) throw new Error(`expected a proxy for ${mcpToolName}`);
	return tool;
}

/** Every text block of every tool result in `context`, in order. */
function toolResultTexts(context: Context): string[] {
	const texts: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

/**
 * A real session over `manager`, viewing it as `scope`, whose first turn calls
 * `toolName` and whose second ends the turn. Returns the tool-result text the
 * model was sent back.
 */
async function toolMissText(
	manager: MCPManager,
	scope: string,
	call: { name: string; arguments: Record<string, unknown> },
): Promise<string> {
	const root = tempDir("omp-mcp-scope-session-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	cleanups.push(() => auth.close());
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", name: call.name, arguments: call.arguments }] }],
		handler: { content: ["done"] },
	});
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRegistry: new ModelRegistry(auth),
		model: mock,
		sessionManager: SessionManager.inMemory(root),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		enableMCP: true,
		mcpManager: manager,
		mcpToolScope: scope,
	});
	cleanups.push(() => session.dispose());
	session.agent.streamFn = (streamModel, context, options) => mock.stream(streamModel, context, options);
	await session.prompt("go");
	const texts = mock.calls.flatMap(entry => toolResultTexts(entry.context));
	const miss = texts.find(text => text.includes(GHOST_TOOL));
	if (miss === undefined) throw new Error(`no miss message for ${GHOST_TOOL} in: ${JSON.stringify(texts)}`);
	return miss;
}

/**
 * The renaming fixture, driven so its whole catalog is a tool one scope's call
 * loaded, and the server is then down for good. `seen` sees the renamed tool;
 * `blind` sees nothing of the server.
 */
async function downServerSeenByOneScope(seen: string, blind: string): Promise<MCPManager> {
	const dir = tempDir("omp-mcp-scope-down-");
	// One connect attempt, no ladder: the server settles as disconnected instead of retrying.
	const manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }), {
		ladderMs: [],
		retryBaseMs: 60_000,
		retryMaxMs: 60_000,
	});
	cleanups.push(() => manager.disconnectAll());
	const { promise: failed, resolve: onFailed } = Promise.withResolvers<void>();
	const unsubscribe = manager.addConnectionStatusListener(event => {
		if (event.type === "failed" && event.serverName === "kata") onFailed();
	});
	try {
		await manager.connectServers(
			{
				kata: {
					type: "stdio",
					command: process.execPath,
					args: [RENAMING_FIXTURE],
					env: { [MARKER_ENV]: path.join(dir, "kata-spawned") },
					timeout: 5_000,
				},
			},
			{},
		);
		manager.openToolScope(seen);
		manager.openToolScope(blind);
		await findTool(createMCPProxyTools(manager, seen), RENAME_TOOL).execute!("kata-call", {}, undefined, ctx);
		await failed;
		await manager.waitForStartup(5_000);
		expect(manager.getTools(seen).map(tool => tool.mcpToolName)).toEqual([RENAMED_TOOL]);
		expect(manager.getTools(blind)).toHaveLength(0);
	} finally {
		unsubscribe();
	}
	return manager;
}

describe("MCP tool views across the session boundary", () => {
	it("shows a cached lazy server's first-use load to the calling session alone", async () => {
		const dir = tempDir("omp-mcp-scope-lazy-");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [LOADER_FIXTURE],
			lazy: true,
		};
		const cached: MCPToolDefinition[] = [LOADER_TOOL, LATE_LOADER_TOOL].map(name => ({
			name,
			description: `${name} (cached)`,
			inputSchema: { type: "object", properties: {} },
		}));
		const cache = new MCPToolCache(memoryStorage());
		await cache.set("alpha", config, cached);
		const manager = new MCPManager(dir, cache);
		cleanups.push(() => manager.disconnectAll());

		await manager.connectServers({ alpha: config }, {});
		// Nothing spawned: the catalog came from the cache, as deferred tools.
		expect(manager.getConnectionStatus("alpha")).toBe("disconnected");

		manager.openToolScope("caller");
		manager.openToolScope("peer");
		// The first use connects the server; the loader announces `extra_tool`
		// while the call is still running, so it belongs to the caller alone.
		await findTool(createMCPProxyTools(manager, "caller"), LOADER_TOOL).execute!("first-use", {}, undefined, ctx);

		const views = () => ({
			owner: mcpToolNames(manager.getTools()),
			caller: mcpToolNames(manager.getTools("caller")),
			peer: mcpToolNames(manager.getTools("peer")),
		});
		expect(views().caller).toContain(LOADED_TOOL);
		expect(views().peer).not.toContain(LOADED_TOOL);
		expect(views().owner).not.toContain(LOADED_TOOL);
		// The peer's own call reaches the server; nothing changes there, yet it
		// now sees the tool, while the owner — which never called — still does not.
		await findTool(createMCPProxyTools(manager, "peer"), LATE_LOADER_TOOL).execute!("peer-use", {}, undefined, ctx);
		expect(views().peer).toContain(LOADED_TOOL);
		expect(views().owner).not.toContain(LOADED_TOOL);
	}, 30_000);

	it("explains a missing MCP tool to a turn through that session's own view", async () => {
		const manager = await downServerSeenByOneScope("child", "sibling");
		MCPManager.setInstance(manager);

		const childNote = await toolMissText(manager, "child", { name: GHOST_TOOL, arguments: {} });
		expect(childNote).toContain("still serving the tools cached from an earlier connect");
		expect(childNote).not.toContain("tools are not mounted");

		const siblingNote = await toolMissText(manager, "sibling", { name: GHOST_TOOL, arguments: {} });
		expect(siblingNote).toContain("so its tools are not mounted: kata");
		expect(siblingNote).not.toContain("still serving the tools cached from an earlier connect");
	}, 60_000);

	it("explains an `xd://` miss to a turn through that session's own view", async () => {
		const manager = await downServerSeenByOneScope("child", "sibling");
		MCPManager.setInstance(manager);

		const childNote = await toolMissText(manager, "child", {
			name: "write",
			arguments: { path: `xd://${GHOST_TOOL}`, content: "{}" },
		});
		expect(childNote).toContain("still serving the tools cached from an earlier connect");
		expect(childNote).not.toContain("tools are not mounted");

		const siblingNote = await toolMissText(manager, "sibling", {
			name: "write",
			arguments: { path: `xd://${GHOST_TOOL}`, content: "{}" },
		});
		expect(siblingNote).toContain("so its tools are not mounted: kata");
		expect(siblingNote).not.toContain("still serving the tools cached from an earlier connect");
	}, 60_000);
});
