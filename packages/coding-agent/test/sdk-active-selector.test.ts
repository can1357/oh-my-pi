import { afterEach, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { createTaskModelRoute, resolveRoleRoute } from "../src/task/role-routing";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import * as tools from "../src/tools";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());
for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
	it(`real SDK inheritance preserves ${provider} route and live effort without overriding explicit child choices`, async () => {
		const dir = TempDir.createSync("sdk-active-selector-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		authStorage.keys.setRuntime(provider, "fixture");
		const routing =
			provider === "openrouter"
				? { openRouterRouting: { only: ["anthropic"] } }
				: { vercelGatewayRouting: { only: ["anthropic"] } };
		const base = buildModel({
			id: "anthropic/fixture-model",
			name: "Fixture",
			provider,
			api: "openai-completions",
			baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ai-gateway.vercel.sh/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 4096,
		});
		const routed = buildModel({ ...base, compat: routing });
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([base]);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([base]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("fixture");
		const captured: { session?: ToolSession } = {};
		const originalCreateTools = tools.createTools;
		vi.spyOn(tools, "createTools").mockImplementation((session, names) => {
			captured.session = session;
			return originalCreateTools(session, names);
		});
		const settings = Settings.isolated({});
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			model: routed,
			thinkingLevel: Effort.High,
			settings,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
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
			toolNames: ["read"],
		});
		try {
			const selected = captured.session?.getActiveModelString?.();
			expect(selected).toBe(`${provider}/anthropic/fixture-model@anthropic:high`);
			const authority = {
				settings,
				agentName: "worker",
				getParentSelector: () => captured.session?.getActiveModelString?.(),
				getParentModel: () => session.model,
			};
			const inherited = await createTaskModelRoute({
				authority,
				modelRegistry,
				selectors: ["@default"],
				explicit: true,
			});
			const resolved = resolveRoleRoute(inherited.permit, modelRegistry);
			expect(resolved.thinkingLevel).toBe(Effort.High);
			expect(resolved.model.compat).toMatchObject(routing);
			session.setThinkingLevel(Effort.Low);
			expect(captured.session?.getActiveModelString?.()).toBe(`${provider}/anthropic/fixture-model@anthropic:low`);
			const overridden = await createTaskModelRoute({
				authority,
				modelRegistry,
				selectors: ["@default:high"],
				explicit: true,
			});
			const overriddenSelection = resolveRoleRoute(overridden.permit, modelRegistry);
			expect(overriddenSelection.thinkingLevel).toBe(Effort.High);
			expect(overriddenSelection.model.compat).toMatchObject(routing);
			session.setThinkingLevel("off");
			const disabled = await createTaskModelRoute({
				authority,
				modelRegistry,
				selectors: ["@default"],
				explicit: true,
			});
			expect(resolveRoleRoute(disabled.permit, modelRegistry).thinkingLevel).toBe("off");
		} finally {
			await session.dispose();
			authStorage.close();
			dir.remove();
		}
	});
}
