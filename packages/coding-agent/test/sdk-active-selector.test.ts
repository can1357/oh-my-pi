import { afterEach, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveAgentModelPatterns, resolveModelOverride } from "../src/config/model-resolver";
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
			const inherited = resolveAgentModelPatterns({
				requestModel: "@default",
				activeModelPattern: selected,
				settings,
			});
			expect(inherited).toEqual([selected!]);
			const resolved = resolveModelOverride(inherited, modelRegistry, settings);
			expect(resolved.thinkingLevel).toBe(Effort.High);
			expect(resolved.model?.compat).toMatchObject(routing);
			session.setThinkingLevel(Effort.Low);
			expect(captured.session?.getActiveModelString?.()).toBe(`${provider}/anthropic/fixture-model@anthropic:low`);
			const overridden = resolveModelOverride(
				resolveAgentModelPatterns({
					requestModel: "@default:high",
					activeModelPattern: captured.session?.getActiveModelString?.(),
					settings,
				}),
				modelRegistry,
				settings,
			);
			expect(overridden.thinkingLevel).toBe(Effort.High);
			expect(overridden.model?.compat).toMatchObject(routing);
			const explicit = `${provider}/anthropic/fixture-model:high`;
			expect(
				resolveAgentModelPatterns({
					requestModel: explicit,
					activeModelPattern: captured.session?.getActiveModelString?.(),
					settings,
				}),
			).toEqual([explicit]);
		} finally {
			await session.dispose();
			authStorage.close();
			dir.remove();
		}
	});
}
