import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
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
