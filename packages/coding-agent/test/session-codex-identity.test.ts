import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createOpenAICodexCompatibilityMetadata } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const CODEX_MODEL = getBundledModel("openai-codex", "gpt-5.6-terra");
if (!CODEX_MODEL || CODEX_MODEL.api !== "openai-codex-responses") {
	throw new Error("Expected the bundled Codex test model");
}

interface ObservedRequest {
	sessionId: string | undefined;
	promptCacheKey: string | undefined;
	threadId: string;
	windowId: string;
	turnId: string;
	messages: string[];
}

function createSession(
	sessionManager: SessionManager,
	authStorage: AuthStorage,
	observed: ObservedRequest[],
	options: { model?: Model; settings?: Settings } = {},
): AgentSession {
	const model = options.model ?? CODEX_MODEL;
	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: sessionManager.buildSessionContext().messages,
		},
		promptCacheKey: sessionManager.getSessionId(),
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: (requestModel, context, streamOptions) => {
			const providerSessionState = streamOptions?.providerSessionState;
			const sessionId = streamOptions?.sessionId;
			if (!providerSessionState || !sessionId || requestModel.api !== "openai-codex-responses") {
				throw new Error("Expected Codex session options");
			}
			const metadata = createOpenAICodexCompatibilityMetadata({
				providerSessionState,
				sessionId,
				requestKind: "turn",
			}).clientMetadata;
			observed.push({
				sessionId,
				promptCacheKey: streamOptions.promptCacheKey,
				threadId: metadata.thread_id,
				windowId: metadata["x-codex-window-id"],
				turnId: metadata.turn_id,
				messages: context.messages.map(message => JSON.stringify(message)),
			});
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
	const settings =
		options.settings ??
		Settings.isolated({
			"async.enabled": false,
			"compaction.enabled": false,
			"marketplace.autoUpdate": "off",
			"todo.enabled": false,
		});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	return new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(),
	});
}

it("persists Codex identity after usage preflight switches models and across resume", async () => {
	using tempDir = TempDir.createSync("@omp-codex-session-identity-");
	const cwd = tempDir.join("project");
	const sessionDir = tempDir.join("sessions");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const observed: ObservedRequest[] = [];
	const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!primaryModel) throw new Error("Expected the bundled primary test model");
	const fallbackSettings = Settings.isolated({
		"async.enabled": false,
		"compaction.enabled": false,
		"marketplace.autoUpdate": "off",
		"retry.usageAwareFallback": true,
		"retry.usageReservePolicy": "auto",
		"retry.fallbackChains": {
			default: [`${CODEX_MODEL.provider}/${CODEX_MODEL.id}`],
		},
		"todo.enabled": false,
	});
	vi.spyOn(authStorage, "getModelUsageHealth").mockImplementation(async provider =>
		provider === primaryModel.provider
			? {
					state: "reserve",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							selected: true,
							state: "reserve",
							remainingFraction: 0.05,
						},
					],
				}
			: { state: "healthy", accounts: [] },
	);
	let firstSession: AgentSession | undefined;
	let resumedSession: AgentSession | undefined;
	try {
		const firstManager = SessionManager.create(cwd, sessionDir);
		await firstManager.ensureOnDisk();
		firstSession = createSession(firstManager, authStorage, observed, {
			model: primaryModel,
			settings: fallbackSettings,
		});
		await firstSession.prompt("before exit");
		const sessionFile = firstManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await firstSession.dispose();
		firstSession = undefined;

		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		resumedSession = createSession(resumedManager, authStorage, observed);
		await resumedSession.prompt("after resume");

		expect(observed).toHaveLength(2);
		const before = observed[0]!;
		const resumed = observed[1]!;
		expect(resumed.sessionId).toBe(before.sessionId);
		expect(resumed.promptCacheKey).toBe(before.promptCacheKey);
		expect(resumed.threadId).toBe(before.threadId);
		expect(resumed.windowId).toBe(before.windowId);
		expect(resumed.turnId).not.toBe(before.turnId);
		expect(resumed.messages.slice(0, before.messages.length)).toEqual(before.messages);
	} finally {
		await firstSession?.dispose();
		await resumedSession?.dispose();
		authStorage.close();
		vi.restoreAllMocks();
	}
});
