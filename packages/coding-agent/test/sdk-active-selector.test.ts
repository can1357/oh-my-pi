import { afterEach, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createTaskModelRoute } from "../src/task/role-routing";
import * as tools from "../src/tools";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface ServedRequest {
	model: string;
	reasoning_effort?: string;
	reasoning?: { effort?: string; enabled?: boolean };
	provider?: { only?: string[] };
	providerOptions?: { gateway?: { only?: string[] } };
}

afterEach(() => vi.restoreAllMocks());

for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
	it(`display identity stays stable while explicit @default serves the exact live ${provider} route and effort`, async () => {
		const requests: ServedRequest[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push((await request.json()) as ServedRequest);
				return new Response(
					'data: {"id":"selector-fixture","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{"role":"assistant","content":"done"}}]}\n\n' +
						'data: {"id":"selector-fixture","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const dir = TempDir.createSync("sdk-active-selector-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"), {
			fetch: async () => {
				throw new Error("Selector fixtures must not contact catalog endpoints");
			},
		});
		authStorage.keys.setRuntime(provider, "fixture");
		const routing =
			provider === "openrouter"
				? { openRouterRouting: { only: ["anthropic"] } }
				: { vercelGatewayRouting: { only: ["anthropic"] } };
		const id = "anthropic/fixture-model:max";
		const identity = `${provider}/${id}`;
		const base = {
			id,
			name: "Fixture",
			provider,
			api: "openai-completions",
			baseUrl: new URL("v1", server.url).toString(),
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 4096,
			compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
		} satisfies ModelSpec<"openai-completions">;
		modelRegistry.registerProvider(provider, {
			api: base.api,
			baseUrl: base.baseUrl,
			apiKey: "fixture",
			models: [base],
		});
		const routed = buildModel({ ...base, compat: { ...base.compat, ...routing } });
		const captured: { session?: ToolSession } = {};
		const originalCreateTools = tools.createTools;
		vi.spyOn(tools, "createTools").mockImplementation((session, names) => {
			captured.session ??= session;
			return originalCreateTools(session, names);
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		const options = {
			cwd: dir.path(),
			agentDir: dir.path(),
			settings,
			authStorage,
			modelRegistry,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			cacheWarming: false,
			toolNames: ["read"],
		};
		const sessions: AgentSession[] = [];
		try {
			const { session: parent } = await createAgentSession({
				...options,
				model: routed,
				thinkingLevel: Effort.High,
				sessionManager: SessionManager.inMemory(),
			});
			sessions.push(parent);
			const authority = {
				settings,
				agentName: "worker",
				getParentSelector: () => captured.session?.getActiveModelSelector?.(),
				getParentModel: () => parent.model,
			};
			const serveDefault = async (selector: string, effort: string) => {
				const { permit } = await createTaskModelRoute({
					authority,
					modelRegistry,
					selectors: [selector],
					explicit: true,
				});
				const { session: child } = await createAgentSession({
					...options,
					roleRoute: permit,
					sessionManager: SessionManager.inMemory(),
				});
				sessions.push(child);
				const before = requests.length;
				await child.prompt("Work");
				await child.waitForIdle();
				expect(requests).toHaveLength(before + 1);
				const served = requests.at(-1)!;
				expect(served.model).toBe(id);
				expect(served.reasoning_effort ?? served.reasoning?.effort).toBe(effort);
				expect(provider === "openrouter" ? served.provider?.only : served.providerOptions?.gateway?.only).toEqual([
					"anthropic",
				]);
				expect(child.servingModel?.selector).toBe(`${identity}@anthropic:${effort}`);
			};

			expect(captured.session?.getActiveModelString?.()).toBe(identity);
			expect(captured.session?.getActiveModelSelector?.()).toBe(`${identity}@anthropic:high`);
			await serveDefault("@default", "high");

			parent.setThinkingLevel(Effort.Low);
			expect(captured.session?.getActiveModelString?.()).toBe(identity);
			expect(captured.session?.getActiveModelSelector?.()).toBe(`${identity}@anthropic:low`);
			await serveDefault("@default", "low");
			await serveDefault("@default:high", "high");
			expect(captured.session?.getActiveModelSelector?.()).toBe(`${identity}@anthropic:low`);
		} finally {
			await Promise.all(sessions.map(session => session.dispose()));
			server.stop(true);
			authStorage.close();
			await dir.remove();
		}
	});
}
