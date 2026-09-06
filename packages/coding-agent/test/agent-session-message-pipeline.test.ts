import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	AppendOnlyContextManager,
	type StreamFn,
} from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	clearCustomApis,
	type ImageContent,
	type Message,
	type Model,
	type ModelSpec,
	registerCustomApi,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { type MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { obfuscateProviderContext, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

function createModelRegistryStub(key = "key") {
	return {
		getApiKey: vi.fn(async () => key),
		resolver: vi.fn(() => async () => key),
	};
}

function getConvertedUserText(message: Message | undefined): string {
	if (message?.role !== "user") {
		throw new Error("Expected converted user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find((content): content is TextContent => content.type === "text");
	if (!text) {
		throw new Error("Expected converted text content");
	}
	return text.text;
}

async function withNativeDialectEnv<T>(fn: () => Promise<T>): Promise<T> {
	const previous = Bun.env.PI_DIALECT;
	delete Bun.env.PI_DIALECT;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete Bun.env.PI_DIALECT;
		} else {
			Bun.env.PI_DIALECT = previous;
		}
	}
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("marks queued user steers without changing the public queue text", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		// #queueUserMessage schedules an idle-queue drain that would agent.continue()
		// and pop the steer before we can inspect it; stub it out to observe the queue.
		vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);

		await session.sendUserMessage("raw <steer> &", { deliverAs: "steer" });

		expect(session.getQueuedMessages().steering).toEqual(["raw <steer> &"]);
		const queued = session.agent.popLastSteer();
		if (queued?.role !== "user") {
			throw new Error("Expected queued user steer");
		}
		expect(queued.steering).toBe(true);
		expect(queued.content).toEqual([{ type: "text", text: "raw <steer> &" }]);
		session.clearQueue();
	});

	it("resolves image attachments from submitted messages, not tool-result images", () => {
		const userImage: ImageContent = { type: "image", data: "user-image", mimeType: "image/png" };
		const toolImage: ImageContent = { type: "image", data: "tool-image", mimeType: "image/png" };
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "inspect this" }, userImage],
			timestamp: Date.now(),
		});
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "eval-1",
			toolName: "eval",
			content: [{ type: "text", text: "plot output" }, toolImage],
			timestamp: Date.now(),
			isError: false,
		});

		const attachments = session.getImageAttachments();
		const sourcePath = attachments[0]?.sourcePath;
		if (!sourcePath) {
			throw new Error("Expected attachment sourcePath to be populated");
		}
		expect(attachments).toEqual([{ label: "Image #1", uri: "attachment://1", image: userImage, sourcePath }]);
	});

	it("normalizes historical WebP on the main provider request path", async () => {
		using tempDir = TempDir.createSync("@pi-stb-main-path-");
		const api = "test-stb-main-path";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const seed = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		const webpData = Buffer.from(await new Bun.Image(seed).resize(2, 2).webp({ quality: 90 }).bytes()).toBase64();
		const historicalImage: ImageContent = {
			type: "image",
			data: webpData,
			// Confirm byte sniffing catches persisted blocks with stale metadata.
			mimeType: "image/png",
		};
		const model = buildModel({
			id: "stb-main-path",
			name: "STB main path",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
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
		try {
			session.agent.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "screenshot" }, historicalImage],
				isError: false,
				timestamp: 1,
			});

			await session.sendUserMessage("continue");

			expect(contexts).toHaveLength(1);
			const outboundImages: ImageContent[] = [];
			for (const message of contexts[0]!.messages) {
				if (typeof message.content === "string") continue;
				for (const part of message.content) {
					if (part.type === "image") outboundImages.push(part);
				}
			}
			expect(outboundImages).toHaveLength(1);
			expect(outboundImages[0]!.mimeType).not.toBe("image/webp");
			expect(Buffer.from(outboundImages[0]!.data.slice(0, 16), "base64").toString("ascii", 8, 12)).not.toBe("WEBP");
			expect(historicalImage.mimeType).toBe("image/png");
			expect(Buffer.from(historicalImage.data.slice(0, 16), "base64").toString("ascii", 8, 12)).toBe("WEBP");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("continues a user turn when an attached WebP is undecodable by an STB model", async () => {
		using tempDir = TempDir.createSync("@pi-stb-corrupt-attachment-");
		const api = "test-stb-corrupt-attachment";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "stb-corrupt-attachment",
			name: "STB corrupt attachment",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
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
		try {
			// Session persistence accepts historical image blocks without MIME
			// metadata, so exercise that runtime shape through the real provider path.
			const corrupt = {
				type: "image",
				data: Buffer.from("RIFF0000WEBPbroken-attachment").toBase64(),
			} as unknown as ImageContent;

			await session.sendUserMessage([{ type: "text", text: "inspect this" }, corrupt]);

			expect(contexts).toHaveLength(1);
			const userMessage = contexts[0]!.messages.find(message => message.role === "user");
			// The date/cwd reminder rides on the first user turn (#7404); the contract
			// here is that the undecodable WebP is replaced by the placeholder text.
			expect(userMessage?.content).toEqual([
				{ type: "text", text: expect.stringContaining("<system-reminder>") },
				{ type: "text", text: "inspect this" },
				{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
			]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("keeps stored steering text raw while pre-LLM conversion wraps it", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext: wrapSteeringForModel,
			convertToLlm,
		});
		sessions.push(session);
		const raw: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "steer with <xml> & ampersand" }],
			steering: true,
			timestamp: 1,
		};
		session.agent.appendMessage(raw);

		const converted = await session.convertMessagesToLlm(session.messages);

		expect(session.messages[0]).toBe(raw);
		expect(raw.content).toEqual([{ type: "text", text: "steer with <xml> & ampersand" }]);
		const convertedText = getConvertedUserText(converted[0]);
		expect(convertedText).toContain("<system-notice>");
		expect(convertedText).not.toContain("<message>");
		expect(convertedText).toContain("steer with <xml> & ampersand");
		expect(convertedText).not.toContain("&lt;xml&gt;");
		expect(convertedText).not.toContain("&amp;");
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});
	it("keeps ephemeral side-channel cache key separate from provider routing while preserving websocket state", async () => {
		const api = "test-ephemeral-side-channel";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model",
			name: "Side Model",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const promptCacheKey = "inherited-parent-cache";
		const session = new AgentSession({
			agent: new Agent({
				promptCacheKey,
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			preferWebsockets: true,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.promptCacheKey).toBe(promptCacheKey);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(capturedOptions?.sessionId).not.toBe(cacheSessionId);
		expect(capturedOptions?.preferWebsockets).toBe(true);
		expect(capturedOptions?.providerSessionState).toBe(session.providerSessionState);
	});

	it("runs ephemeral side-channel requests through the configured side stream function", async () => {
		const model = buildModel({
			id: "side-stream-model",
			name: "Side Stream Model",
			api: "anthropic",
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let capturedOptions: SimpleStreamOptions | undefined;
		let capturedContext: Context | undefined;
		const sideStreamFn: StreamFn = (_model, context, options) => {
			capturedContext = context;
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Side answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Side answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			sideStreamFn,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Side answer");
		expect(capturedContext?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Question?" }]);
		expect(capturedOptions?.sessionId).toStartWith(`${session.sessionId}:side:`);
	});

	it("rotates ephemeral side-channel credentials on Google Resource exhausted", async () => {
		const api = "test-ephemeral-google-resource-exhausted";
		const googleErrorMessage = "Google API error (429): Resource exhausted. Please try again later.";
		const keys: unknown[] = [];
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			keys.push(options?.apiKey);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (options?.apiKey === "next-key") {
					const message = createAssistantMessage("Recovered");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Recovered", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					return;
				}

				const error = createAssistantMessage("");
				error.content = [];
				error.stopReason = "error";
				error.errorMessage = googleErrorMessage;
				error.errorStatus = 429;
				stream.push({ type: "start", partial: error });
				stream.push({ type: "error", reason: "error", error });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-google-model",
			name: "Side Google Model",
			api,
			provider: "google",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const resolver = vi.fn(
			() => async (ctx: { error: unknown }) => (ctx.error === undefined ? "old-key" : "next-key"),
		);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "old-key"),
				resolver,
			} as never,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Recovered");
		expect(keys).toEqual(["old-key", "next-key"]);
		expect(capturedOptions?.promptCacheKey).toBe(cacheSessionId);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(resolver).toHaveBeenCalledWith(model, cacheSessionId);
	});

	it("applies configured OpenRouter routing variant to ephemeral side-channel options", async () => {
		const api = "test-ephemeral-openrouter-variant";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "anthropic/claude-sonnet-4",
			name: "OpenRouter Model",
			api,
			provider: "openrouter",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"providers.openrouterVariant": "nitro",
			}),
			modelRegistry: createModelRegistryStub() as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.openrouterVariant).toBe("nitro");
	});

	it("obfuscates user messages on ephemeral side-channel requests", async () => {
		const api = "test-ephemeral-secret-redaction";
		const secret = "EPHEMERAL_SECRET_TOKEN_12345";
		let capturedContext: Context | undefined;
		registerCustomApi(api, (_model, context, _options) => {
			capturedContext = context;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model-secrets",
			name: "Side Model Secrets",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: `question about ${secret}` });

		expect(result.replyText).toBe("Answer");
		expect(capturedContext).toBeDefined();
		// The secret entered only via the user prompt, which the opt-in obfuscator redacts.
		expect(JSON.stringify(capturedContext)).not.toContain(secret);
	});

	it("keeps obfuscated side-channel stable prefix byte-identical to the main turn", async () => {
		await withNativeDialectEnv(async () => {
			const api = "test-ephemeral-obfuscated-prefix-parity";
			const secret = "PREFIX_SECRET_TOKEN_12345";
			let callCount = 0;
			let mainContext: Context | undefined;
			let sideContext: Context | undefined;
			registerCustomApi(api, (_model, context, _options) => {
				if (callCount === 0) {
					mainContext = context;
				} else {
					sideContext = context;
				}
				callCount += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Answer");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			});

			const model = buildModel({
				id: "side-model-prefix-parity",
				name: "Side Model Prefix Parity",
				api,
				provider: "test-provider",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;
			const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
			const tool: AgentTool = {
				name: "secret_probe",
				label: "Secret Probe",
				description: `Tool description ${secret}`,
				parameters: {
					type: "object",
					properties: {
						value: { type: "string", description: `Schema description ${secret}` },
					},
					required: ["value"],
				},
				execute: async () => ({ content: [], details: {} }),
			};
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: [`system prompt with ${secret}`],
					messages: [],
					tools: [tool],
				},
				transformProviderContext: context => obfuscateProviderContext(obfuscator, context),
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: createModelRegistryStub() as never,
				obfuscator,
			});
			sessions.push(session);

			await agent.prompt("Main Question?");
			await session.runEphemeralTurn({ promptText: `Side Question ${secret}?` });

			// The static prefix (system prompt + tools) is left untouched, so it stays byte-identical
			// between the main turn and the side turn and the prompt cache prefix survives.
			expect(JSON.stringify(mainContext?.systemPrompt)).toBe(JSON.stringify(sideContext?.systemPrompt));
			expect(JSON.stringify(mainContext?.tools)).toBe(JSON.stringify(sideContext?.tools));
			// The side turn's user prompt secret is redacted from the outbound messages.
			expect(JSON.stringify(sideContext?.messages)).not.toContain(secret);
		});
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent).toHaveBeenCalledWith(
			{ event: "message", data: "{}", raw: ["event: message", "data: {}"] },
			undefined,
		);
	});

	it("emits message_update to session listeners before slow extension handlers finish", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(async (event: { type: string }) => {
			if (event.type === "message_update") {
				await promise;
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				hasHandlers: () => true,
				emit: extensionEmit,
			} as never,
		});
		sessions.push(session);

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "edit",
					arguments: {},
					partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as const;

		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistantMessage as never,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "rep",
			},
		} as never);

		await Bun.sleep(0);

		expect(events.some(event => event.type === "message_update")).toBe(true);
		expect(extensionEmit).toHaveBeenCalledTimes(1);

		resolve();
		await Bun.sleep(0);
	});

	it("keeps first-turn memory in the stable prompt on the next turn", async () => {
		const api = "test-injected-memory-append-only-cache";
		const contexts: Context[] = [];
		let remembered = false;
		const injected = "<memories>remember blue</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "provider.appendOnlyContext": "on" }),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);

		await session.sendUserMessage("first");
		await session.sendUserMessage("second");

		expect(contexts).toHaveLength(2);
		const firstSystemPrompt = contexts[0]!.systemPrompt;
		expect(firstSystemPrompt).toBeDefined();
		expect(firstSystemPrompt!.join("\n")).toContain(injected);
		expect(contexts[1]!.systemPrompt).toEqual(firstSystemPrompt);
	});

	it("preserves append-only prefixes in subagent sessions when context handlers rewrite prior turns", async () => {
		using tempDir = TempDir.createSync("@pi-subagent-append-only-");
		const api = "test-subagent-append-only-cache";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(`ok-${contexts.length}`);
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-subagent-model",
			name: "Local Subagent Model",
			api,
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const rewritePriorAssistant: ExtensionFactory = pi => {
			pi.on("context", async event => {
				const hasSecondTurn = event.messages.some(message => {
					if (message.role !== "user") return false;
					const content = message.content;
					if (typeof content === "string") return content.includes("second");
					return content.some(part => part.type === "text" && part.text.includes("second"));
				});
				if (!hasSecondTurn) return undefined;
				return {
					messages: event.messages.map(message =>
						message.role === "assistant"
							? { ...message, content: [{ type: "text" as const, text: "rewritten assistant" }] }
							: message,
					),
				};
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"provider.appendOnlyContext": "auto",
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [rewritePriorAssistant],
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
		try {
			expect(session.agent.appendOnlyContext).toBeDefined();

			await session.sendUserMessage("first");
			await session.sendUserMessage("second");

			expect(contexts).toHaveLength(2);
			expect(contexts[0]!.messages).toHaveLength(1);
			expect(contexts[1]!.messages).toHaveLength(3);
			expect(contexts[1]!.messages[0]).toBe(contexts[0]!.messages[0]);
			expect((contexts[1]!.messages[1] as { content: unknown }).content).toEqual([
				{ type: "text", text: "rewritten assistant" },
			]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
	it("applies a tool_call input revision at arg-prep time across events, execution, and history", async () => {
		// End-to-end wiring for the loop-level tool_call emission (session
		// #beforeToolCall): the handler fires once per dispatch (the wrapper's
		// own emission is suppressed via the runner marker), the revision is what
		// tool_execution_start reports, what bash executes, and what the
		// assistant message persists.
		using tempDir = TempDir.createSync("@pi-tool-call-revision-");
		const api = "test-tool-call-revision";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-revise-1",
						name: "bash",
						arguments: { command: "echo original" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "local-revision-model",
			name: "Local Revision Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let handlerCalls = 0;
		const reviseBash: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolName !== "bash") return undefined;
				handlerCalls++;
				return { input: { command: "echo revised" } };
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [reviseBash],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash"],
		});
		try {
			const startArgs: unknown[] = [];
			session.subscribe(event => {
				if (event.type === "tool_execution_start") startArgs.push(event.args);
			});

			await session.sendUserMessage("run it");

			expect(handlerCalls).toBe(1);
			expect(startArgs).toEqual([{ command: "echo revised" }]);
			const messages = session.agent.state.messages;
			const toolCallBlock = messages
				.filter(m => m.role === "assistant")
				.flatMap(m => (m as { content: Array<{ type: string }> }).content)
				.find(c => c.type === "toolCall") as { arguments?: unknown } | undefined;
			expect(toolCallBlock?.arguments).toEqual({ command: "echo revised" });
			const toolResult = messages.find(m => m.role === "toolResult") as
				| { content: Array<{ type: string; text?: string }> }
				| undefined;
			const text = toolResult?.content.find(block => block.type === "text")?.text ?? "";
			expect(text).toContain("revised");
			expect(text).not.toContain("original");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
	it("exposes ctx.invokeTool to a re-registered built-in so it can delegate to the native tool", async () => {
		// End-to-end for the extension path: a tool that re-registers `bash` receives ctx.invokeTool
		// (bound to its own name), delegates to the native bash, and the native output flows back.
		using tempDir = TempDir.createSync("@pi-invoke-tool-");
		const api = "test-invoke-tool";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-invoke-1",
						name: "bash",
						arguments: { command: "echo from-model" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "local-invoke-model",
			name: "Local Invoke Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		let invokeToolPresent = false;
		let delegatedText = "";
		// Re-register `bash`: the wrapper ignores the model's args, delegates to the native bash with
		// its own command via ctx.invokeTool, and returns the native result.
		const wrapBash: ExtensionFactory = pi => {
			pi.registerTool({
				name: "bash",
				label: "Bash",
				description: "wrapped bash",
				parameters: pi.arktype({ command: pi.arktype("string") }),
				async execute(
					_toolCallId: string,
					_params: unknown,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					invokeToolPresent = typeof ctx.invokeTool === "function";
					const native = await ctx.invokeTool?.({ command: "echo from-wrapper" });
					const textBlock = native?.content.find(b => b.type === "text");
					delegatedText = textBlock?.type === "text" ? textBlock.text : "";
					return native ?? { content: [{ type: "text" as const, text: "no invokeTool" }], details: {} };
				},
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"tools.xdev": false,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [wrapBash],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash"],
		});
		try {
			await session.sendUserMessage("run it");

			expect(invokeToolPresent).toBe(true);
			// The native bash actually ran the wrapper's command, not the model's.
			expect(delegatedText).toContain("from-wrapper");
			expect(delegatedText).not.toContain("from-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clears promoted memory from the base prompt when switching sessions", async () => {
		using tempDir = TempDir.createSync("@pi-injected-memory-switch-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const firstSessionFile = sessionManager.getSessionFile();
		expect(firstSessionFile).toBeString();
		await sessionManager.flush();
		const nextSessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const nextSessionFile = nextSessionManager.getSessionFile();
		expect(nextSessionFile).toBeString();
		await nextSessionManager.flush();

		const api = "test-injected-memory-switch-cache";
		const contexts: Context[] = [];
		let remembered = false;
		let recallAvailable = true;
		const injected = "<memories>session A only</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered || !recallAvailable) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);
		recallAvailable = false;

		await session.switchSession(nextSessionFile!);
		await session.sendUserMessage("second");

		expect(session.systemPrompt.join("\n")).not.toContain(injected);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.systemPrompt?.join("\n")).not.toContain(injected);
	});

	it("clears promoted memory from the base prompt when starting a new session", async () => {
		const api = "test-injected-memory-new-session-cache";
		const contexts: Context[] = [];
		let remembered = false;
		let recallAvailable = true;
		const injected = "<memories>previous session only</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered || !recallAvailable) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);
		recallAvailable = false;

		await session.newSession();
		await session.sendUserMessage("second");

		expect(session.systemPrompt.join("\n")).not.toContain(injected);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.systemPrompt?.join("\n")).not.toContain(injected);
	});

	it("does not duplicate promoted memory in the base prompt when forking", async () => {
		using tempDir = TempDir.createSync("@pi-injected-memory-fork-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		expect(sessionManager.getSessionFile()).toBeString();
		await sessionManager.flush();

		const api = "test-injected-memory-fork-cache";
		const contexts: Context[] = [];
		let remembered = false;
		const injected = "<memories>forked recall</memories>";
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return remembered ? `static memory instructions\n\n${injected}` : "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				if (remembered) return undefined;
				remembered = true;
				return injected;
			},
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "local-model",
			name: "Local Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base", "static memory instructions"],
				messages: [],
				tools: [],
			},
		});
		agent.setAppendOnlyContext(new AppendOnlyContextManager());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "mnemopi",
				"provider.appendOnlyContext": "on",
			}),
			modelRegistry: createModelRegistryStub() as never,
			rebuildSystemPrompt: async () => ({
				systemPrompt: remembered
					? ["base", `static memory instructions\n\n${injected}`]
					: ["base", "static memory instructions"],
			}),
		});
		sessions.push(session);
		setMnemopiSessionState(session, {
			aliasOf: undefined,
			setSessionId(_sessionId: string) {},
			resetConversationTracking() {
				remembered = false;
			},
			async dispose() {},
		} as unknown as MnemopiSessionState);

		await session.sendUserMessage("first");
		expect(session.systemPrompt.join("\n")).toContain(injected);

		await session.fork();
		await session.sendUserMessage("second");

		const forkedPrompt = contexts[1]!.systemPrompt?.join("\n") ?? "";
		const occurrences = forkedPrompt.split(injected).length - 1;
		expect(occurrences).toBe(1);
	});

	it("ephemeral side-channel forwards native tools, injects developer reminder, leaves toolChoice auto", async () => {
		await withNativeDialectEnv(async () => {
			const api = "test-ephemeral-tools-warm-cache";
			let capturedContext: Context | undefined;
			let capturedOptions: SimpleStreamOptions | undefined;
			registerCustomApi(api, (_model, context, options) => {
				capturedContext = context;
				capturedOptions = options;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Not using tools");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Not using tools", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			});

			const model = buildModel({
				id: "side-model-with-tools",
				name: "Side Model with Tools",
				api,
				provider: "test-provider",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;

			const tool: AgentTool = {
				name: "side_tool",
				label: "Side Tool",
				description: "A tool in side channel",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: {} }),
			};

			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["system prompt"],
						messages: [],
						tools: [tool],
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: createModelRegistryStub() as never,
			});
			sessions.push(session);

			const result = await session.runEphemeralTurn({ promptText: "Side Question?" });

			expect(result.replyText).toBe("Not using tools");
			expect(capturedContext).toBeDefined();
			expect(capturedContext!.tools).toBeDefined();
			expect(capturedContext!.tools!.length).toBe(1);
			expect(capturedContext!.tools![0].name).toBe("side_tool");

			// Developer reminder injected immediately before user prompt
			const messages = capturedContext!.messages;
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const lastMessage = messages.at(-1);
			const secondToLast = messages.at(-2);

			expect(lastMessage?.role).toBe("user");
			expect(getConvertedUserText(lastMessage)).toBe("Side Question?");

			expect(secondToLast?.role).toBe("developer");
			const textContent = secondToLast?.content as TextContent[];
			expect(textContent).toHaveLength(1);
			expect(textContent[0]?.type).toBe("text");
			expect(textContent[0]?.text).toMatch(/^<system-reminder>\n[\s\S]+\n<\/system-reminder>\n?$/);

			// Tool choice must be undefined (not "none") for cache hits
			expect(capturedOptions?.toolChoice).toBeUndefined();
		});
	});

	it("ephemeral side-channel discards any emitted tool calls", async () => {
		const api = "test-ephemeral-tools-discard";
		registerCustomApi(api, (_model, _context, _options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Here is text");
				message.content.push({
					type: "toolCall",
					id: "call_123",
					name: "side_tool",
					arguments: {},
				});
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Here is text", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model-discard",
			name: "Side Model Discard",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;

		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: createModelRegistryStub() as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Side Question?" });

		expect(result.replyText).toBe("Here is text");
		expect(result.assistantMessage.content.some(block => block.type === "toolCall")).toBe(false);
		expect(result.assistantMessage.content.every(block => block.type !== "toolCall")).toBe(true);
	});
});
