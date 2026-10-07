import { afterAll, expect, it, vi } from "bun:test";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, McpServer } from "@oh-my-pi/pi-utils/acp";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const API = "test-acp-resume-mcp-prefix";
const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const modelSpec: ModelSpec<Api> = {
	id: "anthropic/claude-sonnet-5.5",
	name: "Claude Sonnet 5.5",
	api: API,
	provider: "stub",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};
const model = buildModel(modelSpec);
authStorage.keys.setRuntime(model.provider, "test-key");
modelRegistry.registerProvider("stub", {
	api: API,
	apiKey: "test-key",
	baseUrl: model.baseUrl,
	models: [
		{
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: ["text"],
			cost: modelSpec.cost,
			contextWindow: 200_000,
			maxTokens: 8192,
		},
	],
});

afterAll(() => {
	unregisterCustomApis(API);
	authStorage.close();
});

async function runResumeTest(delayed: boolean): Promise<void> {
	using dir = TempDir.createSync("@pi-acp-resume-mcp-");
	const originalAgentDir = getAgentDir();
	const originalAgentEnv = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(dir.join("agent"));
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.join("agent") });
	const requests: string[][] = [];
	const deferredTools = Promise.withResolvers<void>();
	let delayTools = false;
	registerCustomApi(
		API,
		(_model, context) => {
			requests.push(context.systemPrompt ?? []);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
		API,
	);
	const mcp = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = await request.json();
			if (typeof message !== "object" || message === null || !("id" in message)) {
				return new Response(null, { status: 202 });
			}
			const method = "method" in message ? message.method : undefined;
			if (method === "tools/list" && delayTools) await deferredTools.promise;
			const result =
				method === "initialize"
					? {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "demo", version: "1.0.0" },
						}
					: method === "tools/list"
						? {
								tools: [
									{
										name: "lookup",
										description: "Demo MCP tool",
										inputSchema: { type: "object", properties: { q: { type: "string" } } },
									},
								],
							}
						: {};
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		},
	});
	const servers: McpServer[] = [{ type: "http", name: "demo", url: `http://127.0.0.1:${mcp.port}/`, headers: [] }];
	const sessions: AgentSession[] = [];
	const agents: AcpAgent[] = [];
	try {
		const factory = createAcpSessionFactory({
			baseOptions: {
				agentDir: dir.join("agent"),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableLsp: false,
				skipPythonPreflight: true,
			},
			settings,
			authStorage,
			modelRegistry,
			parsedArgs: { invalidFlagValues: [] },
			rawArgs: [],
			createSession: createAgentSession,
		});
		const connection = {
			sessionUpdate: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		async function process(): Promise<AcpAgent> {
			const initial = (await factory(dir.path())).session;
			sessions.push(initial);
			const agent = new AcpAgent(
				connection,
				async cwd => {
					const created = await factory(cwd);
					sessions.push(created.session);
					return created;
				},
				initial,
			);
			agents.push(agent);
			return agent;
		}
		const first = await process();
		const { sessionId } = await first.newSession({ cwd: dir.path(), mcpServers: servers });
		await first.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		const stored = sessions.find(session => session.sessionId === sessionId);
		if (!stored) throw new Error("ACP session was not created");
		await stored.sessionManager.ensureOnDisk();
		await stored.sessionManager.flush();
		await first.dispose();
		delayTools = delayed;
		const second = await process();
		await second.loadSession({ sessionId, cwd: dir.path(), mcpServers: servers });
		if (delayed) {
			const resumed = sessions.find(session => session.sessionId === sessionId && !session.isDisposed);
			if (!resumed) throw new Error("ACP session was not restored");
			expect(resumed.agent.state.systemPrompt.join("\n")).not.toContain("## MCP Tool Routes");
			const rebuilt = Promise.withResolvers<void>();
			const originalRefresh = resumed.refreshBaseSystemPrompt.bind(resumed);
			const refresh = vi.spyOn(resumed, "refreshBaseSystemPrompt").mockImplementation(async commitIf => {
				await originalRefresh(commitIf);
				rebuilt.resolve();
			});
			try {
				deferredTools.resolve();
				await rebuilt.promise;
			} finally {
				refresh.mockRestore();
			}
			expect(resumed.agent.state.systemPrompt.join("\n")).toContain("## MCP Tool Routes");
		}
		await second.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });
		expect(requests).toHaveLength(2);
		expect(requests[0].join("\n")).toContain("## MCP Tool Routes");
		expect(requests[1]).toEqual(requests[0]);
	} finally {
		deferredTools.resolve();
		for (const agent of agents.reverse()) await agent.dispose();
		for (const session of sessions) if (!session.isDisposed) await session.dispose();
		mcp.stop(true);
		settings.cancelPendingSaves();
		AgentStorage.close();
		setAgentDir(originalAgentDir);
		if (originalAgentEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	}
}

it.each([false, true])("preserves MCP routes on ACP resume (late tools: %p)", runResumeTest, 15_000);
