import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { type CustomTool, type ExtensionFactory, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Contract for B1 (interactive MCP deferral): when `hasUI` is true, MCP
// discovery is deferred off the first-paint path, so an explicitly requested
// MCP tool (e.g. via `--tools`) whose server has not yet connected MUST still
// be a *known* tool — registered as a deterministic "still connecting"
// placeholder — rather than vanishing and surfacing as "unknown tool" if the
// model calls it before the background connection completes. With `hasUI`
// false there is no deferral, so an MCP tool name with no real backing is not
// registered at all (the non-UI paths keep the blocking discover path).
describe("createAgentSession MCP deferral (B1)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const PENDING_MCP_TOOL = "mcp__pending_connectingtool";

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
		rules: [],
		preloadedCustomToolPaths: [],
		// No .mcp.json in tempDir, so no real MCP server can ever back this name.
		enableMCP: true,
		toolNames: ["read", PENDING_MCP_TOOL],
	});

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(
			authStorage,
			path.join(os.tmpdir(), `pi-sdk-mcp-defer-models-${Snowflake.next()}.yml`),
		);
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-defer-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("registers a pending placeholder for an explicit MCP tool when hasUI defers discovery", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: true });
		try {
			// The explicitly requested MCP tool is a known, resolvable tool even
			// though no server has connected — deterministic, not "unknown tool".
			expect(session.getActiveToolNames()).toContain(PENDING_MCP_TOOL);
			await session.refreshMCPTools([
				{
					name: PENDING_MCP_TOOL,
					label: "Connected MCP tool",
					description: "Connected replacement.",
					parameters: type({}),
					mcpServerName: "pending",
					mcpToolName: "connectingtool",
					async execute() {
						return { content: [{ type: "text", text: "connected" }] };
					},
				} satisfies CustomTool,
			]);
			expect(session.getToolByName(PENDING_MCP_TOOL)?.label).toBe("Connected MCP tool");
		} finally {
			await session.dispose();
		}
	});

	it("does not fabricate the MCP tool in non-UI mode (no deferral, no backing server)", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: false });
		try {
			// Without deferral there is no placeholder; the name has no real
			// server backing, so it is simply not a registered tool.
			expect(session.getActiveToolNames()).not.toContain(PENDING_MCP_TOOL);
			// A normal builtin is unaffected.
			expect(session.getActiveToolNames()).toContain("read");
		} finally {
			await session.dispose();
		}
	});
});

// Contract: on the non-deferred (SDK/RPC) path, MCP tools that change while
// extension factories load, before the session installs its catalog listener,
// are adopted before `createAgentSession` returns.
describe("createAgentSession MCP catalog handoff", () => {
	const SERVER = "fund";
	const INITIAL_TOOL: MCPToolDefinition = {
		name: "probe",
		description: "Initial fund tool",
		inputSchema: { type: "object", properties: {} },
	};
	let tempDir: string;
	let originalAgentDir: string;
	let server: Bun.Server<undefined> | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-handoff-${Snowflake.next()}`);
		// Discovery also reads user-level MCP config; point it at an empty home so
		// only the fixture server is ever contacted.
		const home = path.join(tempDir, "home");
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(home, ".omp", "agent"));
		spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(() => {
		server?.stop(true);
		MCPManager.resetForTests();
		setAgentDir(originalAgentDir);
		mock.restore();
		removeSyncWithRetries(tempDir);
	});

	// Replacement keeps the catalog size, so only a per-tool comparison sees it;
	// removal shrinks it, so only a size comparison sees it.
	it.each<{ change: string; next: MCPToolDefinition[]; expected: string | undefined }>([
		{
			change: "replaced",
			next: [{ ...INITIAL_TOOL, description: "Replacement fund tool" }],
			expected: "Replacement fund tool",
		},
		{ change: "removed", next: [], expected: undefined },
	])(
		"exposes the tool list after the server $change a tool while extensions loaded",
		async ({ next, expected }) => {
			let tools: MCPToolDefinition[] = [INITIAL_TOOL];
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (request.method !== "POST") return new Response(null, { status: 405 });
					const message = (await request.json()) as { id?: number | string; method: string };
					if (message.id === undefined) return new Response(null, { status: 202 });
					const result =
						message.method === "initialize"
							? {
									protocolVersion: "2025-11-25",
									capabilities: { tools: {} },
									serverInfo: { name: "fund", version: "1" },
								}
							: { tools };
					return Response.json({ jsonrpc: "2.0", id: message.id, result });
				},
			});
			fs.writeFileSync(
				path.join(tempDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: `${server.url}mcp` } } }),
			);
			const changeToolsDuringLoad: ExtensionFactory = async () => {
				tools = next;
				await MCPManager.instance()?.refreshServerTools(SERVER);
			};
			const authStorage = createInMemoryAuthStorage();
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
				model: getBundledModel("openai", "gpt-4o-mini"),
				// A zero startup window waits for the fixture to connect, so its change
				// lands while extensions load, the window this contract covers.
				settings: Settings.isolated({ "mcp.enableProjectConfig": true, "mcp.startupTimeoutMs": 0 }),
				sessionManager: SessionManager.inMemory(tempDir),
				hasUI: false,
				enableMCP: true,
				enableLsp: false,
				skipPythonPreflight: true,
				disableExtensionDiscovery: true,
				extensions: [changeToolsDuringLoad],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			try {
				expect(session.getToolByName("mcp__fund_probe")?.description).toBe(expected);
			} finally {
				await session.dispose();
				authStorage.close();
			}
		},
		20_000,
	);
});
