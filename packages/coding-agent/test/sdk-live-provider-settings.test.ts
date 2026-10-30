import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

import {
	cfgProvidersKimiApiFormat,
	cfgProvidersOpenaiWebsockets,
	cfgThinkingBudgetsLow,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgToolsFormat } from "@oh-my-pi/pi-coding-agent/session/context-settings";

describe("primary-agent provider settings changed mid-session", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];
	const previousDialectEnv = Bun.env.PI_DIALECT;

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) await session.dispose();
		if (previousDialectEnv === undefined) delete Bun.env.PI_DIALECT;
		else Bun.env.PI_DIALECT = previousDialectEnv;
	});

	it("applies thinking budgets, Kimi format, websocket policy, and tool format on the next request", async () => {
		delete Bun.env.PI_DIALECT;
		using tempDir = TempDir.createSync("@pi-live-provider-settings-");
		const api = "test-live-provider-settings";
		const requests: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		registerCustomApi(api, (_model, context, options) => {
			requests.push({ context, options });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "live-provider-settings",
			name: "Live provider settings",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		await session.sendUserMessage("first");
		const first = requests.at(-1);
		expect(first?.options?.thinkingBudgets?.low).toBe(2048);
		expect(first?.options?.kimiApiFormat).toBeUndefined();
		expect(first?.options?.preferWebsockets).toBeUndefined();
		expect(first?.context.tools?.length).toBeGreaterThan(0);

		cfgThinkingBudgetsLow.set(settings, 777);
		cfgProvidersKimiApiFormat.set(settings, "openai");
		cfgProvidersOpenaiWebsockets.set(settings, "off");
		cfgToolsFormat.set(settings, "glm");
		// Let the coalesced `tools.format` watcher republish the base prompt.
		await Promise.resolve();

		await session.sendUserMessage("second");
		const second = requests.at(-1);
		expect(second).not.toBe(first);
		expect(second?.options?.thinkingBudgets?.low).toBe(777);
		expect(second?.options?.kimiApiFormat).toBe("openai");
		expect(second?.options?.preferWebsockets).toBe(false);
		// Owned dialect: no native tool specs; the catalog rides in the system prompt.
		expect(second?.context.tools).toBeUndefined();
		expect((second?.context.systemPrompt?.length ?? 0) > (first?.context.systemPrompt?.length ?? 0)).toBe(true);
	});
});
