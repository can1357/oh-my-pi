import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	BOUNDED_GUIDANCE_MODE,
	CONTEXT_MODE_NO_INSTRUCTIONS_MODE,
	SERVER_INSTRUCTIONS,
	TOOL_RESULT,
} from "./fixtures/instructions-mcp";

// Contract: a deferred interactive (`hasUI`) session runs MCP discovery off the
// first-paint path. Once the background connection completes, the resulting
// `refreshMCPTools` rebuild must add one global bounded route section for every
// mounted MCP tool, whether or not its server returned optional `instructions`.
// Any supplied server instructions join their separately framed section for the
// rest of the session. Regression guards cover both previously dropped deferred
// instructions and the installed Context Mode server's absent instructions.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const MCP_TOOL_NAME = "mcp__instr_do_thing";
const MCP_ROUTE_SECTION = "## MCP Tool Routes";
const CONTEXT_MODE_ROUTE = '- "ctx_execute" → `xd://mcp__context_mode_ctx_execute`';
const CONTEXT_MODE_MCP_TOOL_NAME = "mcp__context_mode_ctx_execute";

describe("createAgentSession MCP server instructions (deferred UI)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config through the process-global agent
	// directory. Redirect both that path and os.homedir() so the test connects
	// only to the fixture and never spawns the developer's real MCP servers.
	let originalAgentDir: string;
	let isolatedHome: string;
	let isolatedAgentDir: string;

	beforeAll(async () => {
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-instr-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		for (const dir of [isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("folds server instructions into the prompt once deferred discovery connects", async () => {
		const { session } = await createAgentSession({
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
		try {
			// First paint: discovery is still in flight, so the server's
			// instructions are not yet present.
			expect(session.systemPrompt.join("\n")).not.toContain(SERVER_INSTRUCTIONS);

			// Background connect + `refreshMCPTools` rebuild must surface the
			// instructions. This is a genuine integration wait: discovery spawns
			// the fixture as a real subprocess and connects asynchronously, and
			// the SDK fires that work fire-and-forget with no completion promise
			// or event exposed to await — so fake timers cannot drive it and we
			// poll the live prompt with a generous ceiling, exiting the instant
			// the rebuilt prompt carries the instructions.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			// The instructions are framed under the MCP section, and guidance keeps
			// the escaped original tool name while routing through the exact
			// normalized name actually mounted in the live xd:// registry.
			expect(prompt).toContain("MCP Server Instructions");
			expect(prompt).toContain('- "do\\u0060thing" → `xd://mcp__instr_do_thing`');
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("renders a mounted Context Mode route when initialize omits instructions", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"context-mode": {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, CONTEXT_MODE_NO_INSTRUCTIONS_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
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
		try {
			// Context Mode advertises mounted MCP tools but currently supplies no
			// `connection.instructions`. Deferred discovery must still rebuild the
			// prompt with the globally rendered route guidance. The SDK exposes no
			// completion signal for this real child-process handshake, and fake
			// timers cannot drive it, so poll only until the route becomes visible.
			let prompt = session.systemPrompt.join("\n");
			expect(prompt).not.toContain(CONTEXT_MODE_ROUTE);
			const deadline = Date.now() + 12_000;
			while (!prompt.includes(CONTEXT_MODE_ROUTE) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(CONTEXT_MODE_ROUTE);
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(session.getActiveToolNames()).not.toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(prompt.split(MCP_ROUTE_SECTION)).toHaveLength(2);
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain("## MCP Server Instructions");
			expect(prompt).not.toContain("### context-mode");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("bounds mounted route guidance deterministically and points to the live xd:// inventory", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, BOUNDED_GUIDANCE_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
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
		try {
			// Deferred discovery is a real child-process handshake with no
			// completion signal exposed to this integration harness; fake timers
			// cannot advance it, so retain the established polling bounds above.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			const renderedMappings = prompt.split("\n").filter(line => line.startsWith('- "row_'));
			expect(renderedMappings).toHaveLength(64);
			expect(renderedMappings[0]).toBe('- "row_aa" → `xd://mcp__instr_row_aa`');
			expect(renderedMappings[63]).toBe('- "row_cl" → `xd://mcp__instr_row_cl`');
			expect(prompt).not.toContain('- "row_cm" → `xd://mcp__instr_row_cm`');
			// Truncation notice present (row_cm absent above proves the cap applied).
			expect(prompt).toContain("omitted");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("mounts deferred MCP tools when CLI filtering grants read but omits write", async () => {
		const { session } = await createAgentSession({
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
			toolNames: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");

			// A device-only write supplies the xd:// execution half without granting
			// filesystem mutation, so deferred MCP tools mount after connection
			// instead of shipping their full schemas top-level.
			// Real stdio discovery is fire-and-forget with no completion signal;
			// fake timers cannot drive the child-process handshake.
			// Mount state lands before the awaited system-prompt rebuild while
			// agent tools land after it, so poll for the whole applied selection
			// (mounted MCP tool AND transport write) — not the mount alone.
			const deadline = Date.now() + 12_000;
			let mountedNames = session.getXdevToolEntries().map(entry => entry.name);
			let activeNames = session.getActiveToolNames();
			while ((!mountedNames.includes(MCP_TOOL_NAME) || !activeNames.includes("write")) && Date.now() < deadline) {
				await Bun.sleep(10);
				mountedNames = session.getXdevToolEntries().map(entry => entry.name);
				activeNames = session.getActiveToolNames();
			}
			expect(activeNames).toContain("read");
			expect(activeNames).toContain("write");
			expect(activeNames).not.toContain(MCP_TOOL_NAME);
			expect(mountedNames).toContain(MCP_TOOL_NAME);
			const mcpTool = session.getToolByName(MCP_TOOL_NAME);
			expect(mcpTool).toBeDefined();
			const result = await mcpTool!.execute("deferred-mcp-call", {});
			expect(result.content.find(part => part.type === "text")?.text).toBe(TOOL_RESULT);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps an explicitly requested deferred MCP tool top-level after connection", async () => {
		const { session } = await createAgentSession({
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
			toolNames: ["read", MCP_TOOL_NAME],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}
			const activeNames = session.getActiveToolNames();

			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
			expect(prompt).toContain("## MCP Server Instructions");
			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain(`xd://${MCP_TOOL_NAME}`);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred tools top-level when an explicit session omitted read", async () => {
		const { session } = await createAgentSession({
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
			toolNames: ["bash"],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(10);
				prompt = session.systemPrompt.join("\n");
			}
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(10);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).not.toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
