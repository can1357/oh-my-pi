import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, type CustomTool, type ExtensionFactory, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage, type AgentStorage as AgentStorageType } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
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
if (process.env["PI_SDK_MCP_HANDOFF_CHILD"] !== "1") {
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
}
const MCP_HANDOFF_CHILD_ENV = "PI_SDK_MCP_HANDOFF_CHILD";
const MCP_HANDOFF_ROOT_ENV = "PI_SDK_MCP_HANDOFF_ROOT";
const MCP_HANDOFF_CASE_ENV = "PI_SDK_MCP_HANDOFF_CASE";
const MCP_HANDOFF_STALL_ENV = "PI_SDK_MCP_HANDOFF_STALL";
const MCP_HANDOFF_FUNCTIONAL_CHILD_DEADLINE_MS = 8_000;
const MCP_HANDOFF_STALLED_CHILD_DEADLINE_MS = 2_000;
const MCP_HANDOFF_FUNCTIONAL_TEST_TIMEOUT_MS = 30_000;
const MCP_HANDOFF_STALLED_TEST_TIMEOUT_MS = 10_000;
const MCP_HANDOFF_SERVER = "fund";
const MCP_HANDOFF_RAW_TOOL = "probe";
const MCP_HANDOFF_PUBLIC_TOOL = "mcp__fund_probe";
const MCP_HANDOFF_TEST_PATH = path.join(import.meta.dir, "sdk-mcp-defer.test.ts");

type McpHandoffCase = "initial" | "replacement" | "removal";
type McpHandoffChildResult = {
	creation_lifecycle: "adoption" | "fulfilled" | "rejected";
	adoption_was_pending: boolean;
	active_tool_names: string[];
	final_description?: string;
	execution_text?: string;
};

const MCP_HANDOFF_INITIAL_TOOL = {
	name: MCP_HANDOFF_RAW_TOOL,
	description: "Initial fund tool",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
} satisfies MCPToolDefinition;

async function runMcpCatalogHandoffChild(): Promise<McpHandoffChildResult> {
	const root = process.env[MCP_HANDOFF_ROOT_ENV];
	const scenario = process.env[MCP_HANDOFF_CASE_ENV];
	if (!root || (scenario !== "initial" && scenario !== "replacement" && scenario !== "removal")) {
		throw new Error("MCP catalog handoff child is missing its isolated root or scenario");
	}
	const handoffCase = scenario as McpHandoffCase;
	const cwd = path.join(root, "cwd");
	const agentDir = path.join(root, "agent");
	for (const directory of [cwd, agentDir]) fs.mkdirSync(directory, { recursive: true });

	let server: Bun.Server<undefined> | undefined;
	let manager: InstanceType<typeof MCPManager> | undefined;
	let createdSession: InstanceType<typeof AgentSession> | undefined;
	let authStorage: AuthStorage | undefined;
	let storage: AgentStorageType | undefined;
	let creation: Promise<CreateAgentSessionResult> | undefined;
	let creationState: "pending" | "fulfilled" | "rejected" = "pending";
	let toolsListRequests = 0;
	let serverTools: MCPToolDefinition[] = [{ ...MCP_HANDOFF_INITIAL_TOOL }];
	let executionText = "initial";
	const firstToolsList = Promise.withResolvers<void>();
	const releaseFirstToolsList = Promise.withResolvers<void>();
	const connected = Promise.withResolvers<void>();
	const adoptionStarted = Promise.withResolvers<void>();
	const releaseAdoption = Promise.withResolvers<void>();
	let adoptionHeld = false;
	const originalRefreshMCPTools = AgentSession.prototype.refreshMCPTools;
	const creationSettled = Promise.withResolvers<"fulfilled" | "rejected">();

	try {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "GET") return new Response(null, { status: 405 });
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				const message = (await request.json()) as { id?: string | number; method: string; params?: unknown };
				if (message.id === undefined) return new Response(null, { status: 202 });
				if (message.method === "initialize") {
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "mcp-catalog-handoff", version: "1" },
						},
					});
				}
				if (message.method === "tools/list") {
					toolsListRequests += 1;
					if (toolsListRequests === 1) {
						firstToolsList.resolve();
						await releaseFirstToolsList.promise;
					}
					return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: serverTools } });
				}
				if (message.method === "tools/call") {
					const params = message.params as { name?: unknown } | undefined;
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						result: { content: [{ type: "text", text: executionText }] },
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Unsupported fixture method" },
				});
			},
		});
		const config: MCPServerConfig = { type: "http", url: server.url.toString() + "mcp" };
		fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { [MCP_HANDOFF_SERVER]: config } }));
		authStorage = createInMemoryAuthStorage();
		storage = await AgentStorage.open(path.join(root, "agent.db"));
		if (handoffCase !== "initial") {
			await new MCPToolCache(storage).set(MCP_HANDOFF_SERVER, config, [MCP_HANDOFF_INITIAL_TOOL]);
		}
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), {
			fetch: async () => {
				throw new Error("Unexpected model discovery fetch during MCP handoff regression");
			},
		});
		const settings = Settings.isolated(
			{ "mcp.enableProjectConfig": true, "memory.backend": "off", "startup.quiet": true, "tools.xdev": false },
			{ storage },
		);
		const extension: ExtensionFactory = async api => {
			api.registerTool({
				name: "web_fetch",
				label: "web_fetch",
				description: "Uncalled local fixture tool",
				parameters: type({ url: "string" }),
				async execute() {
					throw new Error("The catalog fixture never executes the extension tool");
				},
			});
			const ownedManager = MCPManager.instance();
			if (!ownedManager) throw new Error("MCP manager was not created for the catalog handoff fixture");
			manager = ownedManager;
			await firstToolsList.promise;
			const cachedTools = ownedManager.getTools();
			const cachedCatalogIsValid =
				handoffCase === "initial"
					? cachedTools.length === 0
					: cachedTools.length === 1 && cachedTools[0]?.description === MCP_HANDOFF_INITIAL_TOOL.description;
			if (!cachedCatalogIsValid) {
				throw new Error("MCP catalog handoff fixture did not load its expected initial catalog");
			}
			const unsubscribe = ownedManager.addConnectionStatusListener(event => {
				if (event.type === "connected" && event.serverName === MCP_HANDOFF_SERVER) connected.resolve();
			});
			releaseFirstToolsList.resolve();
			try {
				await connected.promise;
				if (ownedManager.getTools()[0]?.description !== MCP_HANDOFF_INITIAL_TOOL.description) {
					throw new Error("MCP catalog handoff fixture initial tool was not connected");
				}
				if (handoffCase === "replacement") {
					serverTools = [{ ...MCP_HANDOFF_INITIAL_TOOL, description: "Replacement fund tool" }];
					executionText = "replacement";
					await ownedManager.refreshServerTools(MCP_HANDOFF_SERVER);
					if (ownedManager.getTools()[0]?.description !== "Replacement fund tool") {
						throw new Error("MCP catalog handoff fixture replacement was not installed");
					}
				} else if (handoffCase === "removal") {
					serverTools = [];
					await ownedManager.refreshServerTools(MCP_HANDOFF_SERVER);
					if (ownedManager.getTools().length !== 0) {
						throw new Error("MCP catalog handoff fixture removal was not installed");
					}
				}
			} finally {
				unsubscribe();
			}
		};

		AgentSession.prototype.refreshMCPTools = async function (this: InstanceType<typeof AgentSession>, mcpTools: CustomTool[]) {
			if (!adoptionHeld) {
				adoptionHeld = true;
				await Promise.resolve();
				await Promise.resolve();
				adoptionStarted.resolve();
				await releaseAdoption.promise;
			}
			return originalRefreshMCPTools.call(this, mcpTools);
		};
		creation = createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			settings,
			sessionManager: SessionManager.inMemory(cwd),
			hasUI: false,
			enableMCP: true,
			restrictToolNames: false,
			enableLsp: false,
			toolNames: ["todo", "web_search"],
			enableIrc: false,
			skipPythonPreflight: true,
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			systemPrompt: "Local catalog fixture; no prompts will be submitted.",
		}).then(
			result => {
				creationState = "fulfilled";
				creationSettled.resolve("fulfilled");
				createdSession = result.session;
				return result;
			},
			(error: unknown) => {
				creationState = "rejected";
				creationSettled.resolve("rejected");
				throw error;
			},
		);
		if (process.env[MCP_HANDOFF_STALL_ENV] === "1") {
			await new Promise<void>(() => {});
		}
		const lifecycle = await Promise.race([
			adoptionStarted.promise.then(() => "adoption" as const),
			creationSettled.promise,
		]);
		let adoptionWasPending = false;
		if (lifecycle === "adoption") {
			adoptionWasPending = creationState === "pending";
			releaseAdoption.resolve();
		}
		if (lifecycle !== "adoption") throw new Error("createAgentSession settled before MCP catalog adoption");
		if (!adoptionWasPending) throw new Error("createAgentSession was not pending while MCP catalog adoption was held");
		const created = await creation;
		createdSession = created.session;
		if (!createdSession) throw new Error("MCP catalog handoff fixture returned no session");
		if (handoffCase === "removal") {
			if (createdSession.getToolByName(MCP_HANDOFF_PUBLIC_TOOL) !== undefined) {
				throw new Error("MCP catalog handoff retained the removed tool after creation");
			}
			if (createdSession.getActiveToolNames().includes(MCP_HANDOFF_PUBLIC_TOOL)) {
				throw new Error("MCP catalog handoff retained the removed active tool after creation");
			}
		} else {
			const currentTool = createdSession.getToolByName(MCP_HANDOFF_PUBLIC_TOOL);
			const expectedDescription = handoffCase === "initial" ? "Initial fund tool" : "Replacement fund tool";
			const expectedExecution = handoffCase === "initial" ? "initial" : "replacement";
			if (!currentTool || currentTool.description !== expectedDescription) {
				throw new Error("MCP catalog handoff did not expose the current tool after creation");
			}
			if (!createdSession.getActiveToolNames().includes(MCP_HANDOFF_PUBLIC_TOOL)) {
				throw new Error("MCP catalog handoff current tool was not active after creation");
			}
			const result = await currentTool.execute("catalog-call", {}, undefined, undefined, undefined);
			if (JSON.stringify(result.content) !== JSON.stringify([{ type: "text", text: expectedExecution }])) {
				throw new Error("MCP catalog handoff execution used stale tool state");
			}
		}
		return {
			creation_lifecycle: lifecycle,
			adoption_was_pending: adoptionWasPending,
			active_tool_names: createdSession.getActiveToolNames(),
			...(handoffCase !== "removal" ? { final_description: handoffCase === "initial" ? "Initial fund tool" : "Replacement fund tool", execution_text: executionText } : {}),
		};
	} finally {
		releaseFirstToolsList.resolve();
		releaseAdoption.resolve();
		if (creation) {
			try {
				const completed = await creation;
				createdSession ??= completed.session;
			} catch {}
		}
		AgentSession.prototype.refreshMCPTools = originalRefreshMCPTools;
		const teardown = createdSession ? createdSession.dispose() : manager?.disconnectAll() ?? Promise.resolve();
		await Promise.allSettled([teardown]);
		AgentStorage.close();
		authStorage?.close();
		server?.stop(true);
		MCPManager.resetForTests();
	}
}

async function runIsolatedMcpCase(
	tempDir: string,
	scenario: McpHandoffCase,
	options?: { stall?: boolean },
): Promise<McpHandoffChildResult> {
	const home = path.join(tempDir, "home");
	const agentDir = path.join(tempDir, "agent");
	const tmpDir = path.join(tempDir, "tmp");
	const xdgConfig = path.join(tempDir, "xdg-config");
	const xdgData = path.join(tempDir, "xdg-data");
	const xdgState = path.join(tempDir, "xdg-state");
	const xdgCache = path.join(tempDir, "xdg-cache");
	for (const directory of [home, agentDir, tmpDir, xdgConfig, xdgData, xdgState, xdgCache]) {
		fs.mkdirSync(directory, { recursive: true });
	}
	const childEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: tmpDir,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_DATA_HOME: xdgData,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
		CI: "1",
		[MCP_HANDOFF_CHILD_ENV]: "1",
		[MCP_HANDOFF_ROOT_ENV]: tempDir,
		[MCP_HANDOFF_CASE_ENV]: scenario,
	};
	if (options?.stall) childEnv[MCP_HANDOFF_STALL_ENV] = "1";
	const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", MCP_HANDOFF_TEST_PATH], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: childEnv,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let childExited = false;
	let deadlineExpired = false;
	let failure: Error | undefined;
	let childResult: McpHandoffChildResult | undefined;
	const exitPromise = child.exited.then(exitCode => {
		childExited = true;
		return exitCode;
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const childDeadlineMs = options?.stall ? MCP_HANDOFF_STALLED_CHILD_DEADLINE_MS : MCP_HANDOFF_FUNCTIONAL_CHILD_DEADLINE_MS;
	const childDeadline = setTimeout(() => {
		deadlineExpired = true;
		if (!childExited) child.kill("SIGKILL");
	}, childDeadlineMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([exitPromise, stdoutPromise, stderrPromise]);
		if (deadlineExpired) {
			failure = new Error("MCP catalog handoff child deadline exceeded");
		} else if (exitCode !== 0) {
			failure = new Error("MCP catalog handoff child failed\nstderr:\n" + stderr + "\nstdout:\n" + stdout);
		} else {
			const output = stdout.trim();
			if (!output) failure = new Error("MCP catalog handoff child produced no result");
			else childResult = JSON.parse(output.split(/\r?\n/).at(-1) ?? output) as McpHandoffChildResult;
		}
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(childDeadline);
		if (!childExited) child.kill("SIGKILL");
		const [reaped, stdoutDrained, stderrDrained] = await Promise.allSettled([
			exitPromise,
			stdoutPromise,
			stderrPromise,
		]);
		const cleanupSummary =
			"child_reaped=" +
			(reaped.status === "fulfilled") +
			" stdout_drained=" +
			(stdoutDrained.status === "fulfilled") +
			" stderr_drained=" +
			(stderrDrained.status === "fulfilled");
		if (failure) failure = new Error(failure.message + "; " + cleanupSummary);
		else if (reaped.status !== "fulfilled" || stdoutDrained.status !== "fulfilled" || stderrDrained.status !== "fulfilled") {
			failure = new Error("MCP catalog handoff child cleanup failed; " + cleanupSummary);
		}
	}
	if (failure) throw failure;
	if (!childResult) throw new Error("MCP catalog handoff child produced no parsed result");
	return childResult;
}

if (process.env[MCP_HANDOFF_CHILD_ENV] === "1") {
	console.log(JSON.stringify(await runMcpCatalogHandoffChild()));
	process.exit(0);
}

// This test proves owned MCP catalogs are adopted before SDK construction returns, including no-cache discovery, identity changes and cleanup ownership.
describe("createAgentSession MCP catalog handoff", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), "pi-sdk-mcp-handoff-" + Snowflake.next());
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	it("adopts a newly discovered tool from an initially empty catalog", async () => {
		const result = await runIsolatedMcpCase(tempDir, "initial");
		expect(result.creation_lifecycle).toBe("adoption");
		expect(result.adoption_was_pending).toBe(true);
		expect(result.active_tool_names).toContain(MCP_HANDOFF_PUBLIC_TOOL);
		expect(result.final_description).toBe("Initial fund tool");
		expect(result.execution_text).toBe("initial");
	}, MCP_HANDOFF_FUNCTIONAL_TEST_TIMEOUT_MS);

	it("adopts a same-cardinality replacement during the awaited handoff", async () => {
		const result = await runIsolatedMcpCase(tempDir, "replacement");
		expect(result.creation_lifecycle).toBe("adoption");
		expect(result.adoption_was_pending).toBe(true);
		expect(result.active_tool_names).toContain(MCP_HANDOFF_PUBLIC_TOOL);
		expect(result.final_description).toBe("Replacement fund tool");
		expect(result.execution_text).toBe("replacement");
	}, MCP_HANDOFF_FUNCTIONAL_TEST_TIMEOUT_MS);

	it("adopts complete removal during the awaited handoff", async () => {
		const result = await runIsolatedMcpCase(tempDir, "removal");
		expect(result.creation_lifecycle).toBe("adoption");
		expect(result.adoption_was_pending).toBe(true);
		expect(result.active_tool_names).not.toContain(MCP_HANDOFF_PUBLIC_TOOL);
	}, MCP_HANDOFF_FUNCTIONAL_TEST_TIMEOUT_MS);

	it("owns a stalled child before test state cleanup", async () => {
		let failure: unknown;
		try {
			await runIsolatedMcpCase(tempDir, "initial", { stall: true });
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof Error)) throw new Error("Expected the stalled child to fail with a bounded error");
		expect(failure.message).toContain("MCP catalog handoff child deadline exceeded");
		expect(failure.message).toContain("child_reaped=true");
		expect(failure.message).toContain("stdout_drained=true");
		expect(failure.message).toContain("stderr_drained=true");
	}, MCP_HANDOFF_STALLED_TEST_TIMEOUT_MS);
});
