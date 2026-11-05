import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	FetchImpl,
	Model,
	ProviderSessionState,
	Tool,
	ToolResultMessage,
	Usage,
} from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseInput, ResponseOutputItem } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAutoLearnCaptureRunner } from "@oh-my-pi/pi-coding-agent/sdk";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly captures: string[] = [];
	planEnabled = false;
	goalEnabled = false;
	captureGate: Promise<void> | undefined;
	captureError: Error | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async capture(content: string): Promise<void> {
		this.captures.push(content);
		const gate = this.captureGate;
		const error = this.captureError;
		if (gate) await gate;
		if (error) throw error;
	}

	notifyAutolearnCapturePending(): void {}

	getPlanModeState(): { enabled: boolean } | undefined {
		return this.planEnabled ? { enabled: true } : undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(n: number): void {
		for (let i = 0; i < n; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: null });
		}
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	agentEnd(messages: AgentMessage[] = []): void {
		this.emit({ type: "agent_end", messages });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({
		session: session as unknown as AgentSession,
		settings,
		capture: content => session.capture(content),
	});
	return settings;
}

async function settleCaptures(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function googleInteractionsModel(): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});
}

function storedAssistant(responseId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-3.5-flash",
		content: [{ type: "text", text: "Primary answer" }],
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
		responseId,
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "primary-native-item" }] },
	};
}

function interactionsResponse(): Response {
	const events = [
		{ event_type: "interaction.created", interaction: { id: "capture-interaction", status: "in_progress" } },
		{ event_type: "step.start", index: 0, step: { type: "model_output" } },
		{ event_type: "step.delta", index: 0, delta: { type: "text", text: "Captured." } },
		{ event_type: "step.stop", index: 0 },
		{
			event_type: "interaction.completed",
			interaction: {
				id: "capture-interaction",
				status: "completed",
				usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("AutoLearnController", () => {
	it("does not inject a passive nudge into the conversation prefix", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();

		expect(session.captures).toHaveLength(0);
	});

	it("does not nudge below the threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(4);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		// Neither turn reached the threshold; the counter must not accumulate.
		expect(session.captures).toHaveLength(0);
	});

	it("discards plan-mode tool calls instead of leaking them into the next turn", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd(); // plan mode: no fire, counter reset
		session.planEnabled = false;
		session.toolCalls(1);
		session.agentEnd(); // 1 < threshold -> no fire (no plan-mode leak)
		expect(session.captures).toHaveLength(0);
	});

	it("stops auto-continuing when autolearn is disabled mid-session", () => {
		const session = new FakeSession();
		// Enable via the global layer (not an isolated override) so the live flag
		// can be flipped and the controller's fire-time re-check is exercised.
		const settings = Settings.isolated({ "autolearn.autoContinue": true });
		cfgAutolearnEnabled.set(settings, true);
		new AutoLearnController({
			session: session as unknown as AgentSession,
			settings,
			capture: content => session.capture(content),
		});
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // fires while enabled
		cfgAutolearnEnabled.set(settings, false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		cfgAutolearnEnabled.set(settings, true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("does not nudge during goal mode and leaks no suppression latch", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		// Goal mode owns the continuation; auto-learn stays out of the loop.
		expect(session.captures).toHaveLength(0);
		// The skipped stop must not arm suppression for the next non-goal stop.
		session.goalEnabled = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("never nudges a turn that started in goal mode even if the goal ended mid-turn", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		// The turn begins as a goal continuation...
		session.agentStart();
		session.toolCalls(5);
		// ...then a `goal` tool completes/drops the goal mid-turn: the live flag is
		// off by the time the turn stops, but this turn must still never be nudged.
		session.goalEnabled = false;
		session.agentEnd();
		expect(session.captures).toHaveLength(0);

		// The capture is per-turn: a fresh turn that did not start in goal mode
		// nudges normally, proving the latch resets.
		session.agentStart();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("coalesces newer eligible stops behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(3);
	});

	it("does not queue an ineligible stop behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(4);
		session.agentEnd();
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("clears the in-flight guard after capture failure", async () => {
		const session = new FakeSession();
		session.captureError = new Error("capture failed");
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		session.captureError = undefined;
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
	});

	it("respects a custom minToolCalls threshold", async () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true, "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("does not nudge when the turn ended with stopReason aborted", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		const abortedMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		session.agentEnd([abortedMessage]);
		expect(session.captures).toHaveLength(0);
	});
});

describe("isolated auto-learn capture", () => {
	function captureTool(name: string, description: string): AgentTool {
		return {
			name,
			label: name,
			description,
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "captured" }] }),
		};
	}

	/** What a provider serializes from a request's tools: the wire fields of `Tool`, in order. */
	function wireView(tools: readonly Tool[] | undefined): string {
		return JSON.stringify(
			(tools ?? []).map(t => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
				strict: t.strict,
				deferLoading: t.deferLoading,
				customFormat: t.customFormat,
				customWireName: t.customWireName,
				native: t.native,
				examples: t.examples,
			})),
		);
	}

	it("advertises the primary turn's tool list byte for byte, so the capture request reuses its prompt cache", async () => {
		const mock = createMockModel({
			responses: [{ content: ["Primary answer."] }, { content: ["Nothing to keep."] }],
		});
		const readTool: AgentTool = { ...captureTool("read", "Read files"), concurrency: "shared", intent: "require" };
		const learnTool = captureTool("learn", "Remember a fact");
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const sourceAgent = new Agent({
			initialState: {
				model: mock,
				systemPrompt: ["Primary system prompt"],
				tools: [readTool, learnTool, manageSkillTool],
			},
			convertToLlm,
			streamFn: mock.stream,
			sessionId: "primary-session",
			promptCacheKey: "primary-cache",
		});
		await sourceAgent.prompt("Earlier task");
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [learnTool, manageSkillTool],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: mock.stream }),
		});

		await runCapture("Automated capture prompt");

		expect(mock.calls).toHaveLength(2);
		const [primary, capture] = mock.calls;
		expect(wireView(capture?.context.tools)).toBe(wireView(primary?.context.tools));
		expect(capture?.context.tools?.map(t => t.name)).toEqual(["read", "learn", "manage_skill"]);
		// Routed to the primary prompt's cache, under its own provider session (#10869).
		expect(primary?.options?.promptCacheKey).toBe("primary-cache");
		expect(capture?.options?.promptCacheKey).toBe("primary-cache");
		expect(capture?.options?.sessionId).not.toBe("primary-session");
	});

	it("refuses a call to a non-capture tool without running any of its code", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }] },
				{ content: ["Stopping."] },
			],
		});
		let executed = 0;
		let argStreams = 0;
		const readTool: AgentTool = {
			...captureTool("read", "Read files"),
			execute: async () => {
				executed++;
				return { content: [{ type: "text", text: "file contents" }] };
			},
			openArgStream: () => {
				argStreams++;
				return undefined;
			},
		};
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const sourceAgent = new Agent({
			initialState: { model: mock, systemPrompt: ["Test"], tools: [readTool, manageSkillTool] },
		});
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkillTool],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: mock.stream }),
		});

		await runCapture("Automated capture prompt");

		expect(executed).toBe(0);
		expect(argStreams).toBe(0);
		const followUp = mock.calls[1]?.context.messages ?? [];
		const refusal = followUp.find((m): m is ToolResultMessage => m.role === "toolResult");
		expect(refusal?.toolName).toBe("read");
		expect(refusal?.isError).toBe(true);
		expect(JSON.stringify(refusal?.content)).toContain("auto-learn capture");
		expect(JSON.stringify(refusal?.content)).not.toContain("file contents");
	});

	const replayCases = [
		{ api: "openai-responses", history: "native" },
		{ api: "openrouter", history: "native" },
		{ api: "openai-responses", history: "signature-only" },
		{ api: "openai-responses", history: "cross-model" },
	] as const;
	for (const { api, history } of replayCases) {
		it(`keeps inherited ${api} ${history} history stable after a capture tool round`, async () => {
			const model = buildModel({
				id: "gpt-5-mini",
				name: "Capture test",
				api,
				provider: "capture-test",
				baseUrl: "https://example.invalid/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			});
			const sourceReasoning = {
				type: "reasoning" as const,
				id: "rs_source",
				encrypted_content: "enc_source",
				summary: [],
			};
			const sourceAssistant: AssistantMessage = {
				role: "assistant",
				api,
				provider: model.provider,
				model: history === "cross-model" ? "other-model" : model.id,
				content: [
					{ type: "thinking", thinking: "Source reasoning", thinkingSignature: JSON.stringify(sourceReasoning) },
					{
						type: "text",
						text: "Checking source",
						textSignature: JSON.stringify({ v: 1, id: "msg_source", phase: "commentary" }),
					},
					{ type: "toolCall", id: "call_read|fc_source", name: "read", arguments: {} },
				],
				responseId: "response_source",
				providerPayload:
					history === "signature-only"
						? undefined
						: createOpenAIResponsesHistoryPayload(model.provider, [sourceReasoning]),
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			};
			const learnTool = captureTool("learn", "Record a lesson");
			let learned = 0;
			learnTool.execute = async () => {
				learned++;
				return { content: [{ type: "text", text: "Lesson recorded" }] };
			};
			const sourceAgent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Capture test system"],
					tools: [captureTool("read", "Read source"), learnTool],
					messages: [
						{ role: "user", content: "Inspect source", timestamp: 1 },
						sourceAssistant,
						{
							role: "toolResult",
							toolCallId: "call_read|fc_source",
							toolName: "read",
							content: [{ type: "text", text: "Source inspected" }],
							isError: false,
							timestamp: 3,
						},
					],
				},
			});
			const original = structuredClone(sourceAgent.state.messages);
			const requests: Array<{
				input: ResponseInput;
				tools: unknown;
				instructions: unknown;
				prompt_cache_key: string;
			}> = [];
			const captureReasoning: ResponseOutputItem = {
				...sourceReasoning,
				id: "rs_capture",
				encrypted_content: "enc_capture",
			};
			const fetchMock: FetchImpl = async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)));
				const items: ResponseOutputItem[] =
					requests.length === 1
						? [
								captureReasoning,
								{
									type: "function_call",
									id: "fc_learn",
									call_id: "call_learn",
									name: "learn",
									arguments: "{}",
								},
							]
						: [
								{
									type: "message",
									id: "msg_capture",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "Captured", annotations: [] }],
								},
							];
				const events = [
					{ type: "response.created", response: { id: `response_capture_${requests.length}` } },
					...items.flatMap((item, output_index) => [
						{ type: "response.output_item.added", output_index, item },
						{ type: "response.output_item.done", output_index, item },
					]),
					{
						type: "response.completed",
						response: { id: `response_capture_${requests.length}`, status: "completed", output: items },
					},
				];
				return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			};
			Object.assign(fetchMock, { preconnect: fetch.preconnect });
			const runCapture = createAutoLearnCaptureRunner({
				sourceAgent,
				captureTools: () => [learnTool, captureTool("manage_skill", "Manage skills")],
				createAgent: options =>
					new Agent({
						...options,
						convertToLlm,
						streamFn: (_model, context, streamOptions) =>
							streamOpenAIResponses(model as Model<"openai-responses">, context, {
								...streamOptions,
								apiKey: "test-key",
								fetch: fetchMock,
								statefulResponses: false,
							}),
					}),
			});
			const previousOpenRouterResponses = Bun.env.PI_OPENROUTER_RESPONSES;
			if (api === "openrouter") Bun.env.PI_OPENROUTER_RESPONSES = "1";
			try {
				await runCapture("Record the lesson");
			} finally {
				if (api === "openrouter") {
					if (previousOpenRouterResponses === undefined) {
						delete Bun.env.PI_OPENROUTER_RESPONSES;
					} else {
						Bun.env.PI_OPENROUTER_RESPONSES = previousOpenRouterResponses;
					}
				}
			}
			expect(requests).toHaveLength(2);
			const [first, second] = requests;
			expect(second.input.slice(0, first.input.length)).toEqual(first.input);
			expect(second.tools).toEqual(first.tools);
			expect(second.instructions).toEqual(first.instructions);
			expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
			expect(JSON.stringify(second.input)).not.toContain("enc_source");
			expect(second.input.slice(first.input.length)).toContainEqual(
				expect.objectContaining({
					type: "reasoning",
					encrypted_content: "enc_capture",
					summary: [],
				}),
			);
			expect(second.input).toContainEqual({
				type: "function_call_output",
				call_id: "call_learn",
				output: "Lesson recorded",
			});
			if (history !== "cross-model") {
				expect(first.input).toContainEqual(expect.objectContaining({ role: "assistant", phase: "commentary" }));
			}
			expect(learned).toBe(1);
			expect(sourceAgent.state.messages).toEqual(original);
		});
	}

	it("advertises the primary tools and sends full Google context without the primary anchor", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const readTool = captureTool("read", "Read files");
		const primaryAssistant = storedAssistant("primary-interaction");
		const sourceProviderState = new Map<string, ProviderSessionState>();
		const sourceAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Primary system prompt"],
				tools: [readTool, manageSkillTool],
				messages: [{ role: "user", content: "Earlier task", timestamp: 1 }, primaryAssistant],
			},
			providerSessionState: sourceProviderState,
		});
		const queuedUserMessage: AgentMessage = {
			role: "user",
			content: "Concurrent user correction",
			timestamp: 3,
		};
		sourceAgent.steer(queuedUserMessage);
		let primaryEvents = 0;
		sourceAgent.subscribe(() => primaryEvents++);

		let requestBody = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = String(init?.body ?? "");
			return interactionsResponse();
		};
		Object.assign(fetchMock, { preconnect: fetch.preconnect });
		let captureMessages: AgentMessage[] = [];
		let captureProviderState: Map<string, ProviderSessionState> | undefined;
		let captureSessionId: string | undefined;
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkillTool],
			createSessionId: () => "0193c8f2-7b1a-7c4d-9e2f-123456789abc",
			createAgent: options => {
				captureMessages = options.initialState?.messages ?? [];
				captureProviderState = options.providerSessionState;
				captureSessionId = options.sessionId;
				return new Agent({
					...options,
					convertToLlm,
					streamFn: (_requestModel, context, streamOptions) =>
						streamGoogle(model, context, {
							...streamOptions,
							apiKey: "test-key",
							fetch: fetchMock,
						}),
				});
			},
		});

		await runCapture("Automated capture prompt");

		expect(captureSessionId).toBe("0193c8f2-7b1a-7c4d-9e2f-123456789abc");
		expect(captureProviderState).not.toBe(sourceProviderState);
		expect(captureProviderState?.size).toBe(0);
		const detachedAssistant = captureMessages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(detachedAssistant?.responseId).toBeUndefined();
		expect(detachedAssistant?.providerPayload).toBeUndefined();
		expect(requestBody).not.toContain("previous_interaction_id");
		expect(requestBody).toContain("Earlier task");
		expect(requestBody).toContain("Automated capture prompt");
		expect(requestBody).toContain("manage_skill");
		expect(requestBody).not.toContain('"name":"learn"');
		expect(requestBody).toContain('"name":"read"');
		expect(sourceAgent.state.messages).toHaveLength(2);
		const sourceAssistant = sourceAgent.state.messages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(sourceAssistant?.responseId).toBe("primary-interaction");
		expect(sourceAgent.peekSteeringQueue()).toEqual([queuedUserMessage]);
		expect(primaryEvents).toBe(0);
	});

	it("keeps source credentials and account metadata while using a fresh transport session", async () => {
		const captureMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["Captured."] }],
		});
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const credentialsBySession = new Map([
			["primary-affinity", "primary-key"],
			["capture-transport", "other-key"],
		]);
		const accountsBySession = new Map([
			["primary-affinity", "account-primary"],
			["capture-transport", "account-other"],
		]);
		const resolvedAffinities: string[] = [];
		const sourceAgent = new Agent({
			sessionId: "primary-affinity",
			getApiKey: () => async () => {
				const affinity = sourceAgent.sessionId ?? "";
				resolvedAffinities.push(affinity);
				return credentialsBySession.get(affinity);
			},
			initialState: { model: captureMock, systemPrompt: ["Test"], tools: [manageSkillTool] },
		});
		sourceAgent.setMetadataResolver(() => {
			const account = accountsBySession.get(sourceAgent.sessionId ?? "");
			return account ? { user_id: account } : undefined;
		});
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkillTool],
			createSessionId: () => "capture-transport",
			createAgent: options =>
				new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				}),
		});

		await runCapture("Capture with source affinity");

		expect(captureMock.calls[0]?.options?.sessionId).toBe("capture-transport");
		expect(resolvedAffinities).toEqual(["primary-affinity"]);
		expect(captureMock.calls[0]?.options?.metadata).toEqual({ user_id: "account-primary" });
	});

	it("aborts a blocked detached capture and closes its provider state", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const sourceAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [manageSkillTool] },
		});
		const streamStarted = Promise.withResolvers<void>();
		const captureMock = createMockModel({
			responses: [
				() => {
					streamStarted.resolve();
					return { content: ["Blocked capture"], delayMs: 60_000 };
				},
			],
		});
		let providerState: Map<string, ProviderSessionState> | undefined;
		let closeCalls = 0;
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkillTool],
			createAgent: options => {
				providerState = options.providerSessionState;
				providerState?.set("blocked", { close: () => closeCalls++ });
				return new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				});
			},
		});
		const controller = new AbortController();

		const capture = runCapture("Capture before disposal", controller.signal);
		await streamStarted.promise;
		controller.abort();
		await capture;

		expect(closeCalls).toBe(1);
		expect(providerState?.size).toBe(0);
	});
});

describe("buildAutoLearnInstructions", () => {
	it("returns null when manage_skill is not in the active tool set", () => {
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: false })).toBeNull();
		// learn without manage_skill still yields no guidance (manage_skill gates it).
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: true })).toBeNull();
	});

	it("includes the learn addendum when the learn tool is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: true });
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("omits the learn addendum when only manage_skill is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: false });
		expect(text).toContain("manage_skill");
		expect(text).not.toContain("long-term memory");
	});
});

describe("autolearn capture lifecycle events", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-autolearn-lifecycle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	/** A real session with a recorder subscribed last, after any capture starter. */
	function createSession(options?: {
		/** Model calls that answer with a tool call before the final text answer. */
		toolTurns?: number;
		/** Extension loaded into the session's runner. */
		extension?: { extension: Extension; runtime: ExtensionRuntime };
	}): { events: AgentSessionEvent[]; session: AgentSession } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const probeTool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Records a tool execution",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "probed" }] }),
		};
		let modelCalls = 0;
		let turnToolCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [probeTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const wantsTool = turnToolCalls < (options?.toolTurns ?? 0);
				const call = modelCalls++;
				if (wantsTool) turnToolCalls++;
				else turnToolCalls = 0;
				const message: AssistantMessage = wantsTool
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: `tc-${call}`, name: "probe", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: ZERO_USAGE,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: ZERO_USAGE,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: wantsTool ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"autolearn.autoContinue": true,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const built = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[probeTool.name, probeTool]]),
			extensionRunner: options?.extension
				? new ExtensionRunner(
						[options.extension.extension],
						options.extension.runtime,
						tempDir.path(),
						sessionManager,
						modelRegistry,
					)
				: undefined,
		});
		session = built;
		const events: AgentSessionEvent[] = [];
		return { events, session: built };
	}

	it("emits autolearn_capture_start synchronously and autolearn_capture_end(completed) on settle", async () => {
		const { events, session: current } = createSession();
		current.subscribe(event => events.push(event));
		const release = Promise.withResolvers<void>();
		const capture = current.runAutolearnCapture(async () => {
			await release.promise;
		});

		// Start is emitted before runAutolearnCapture's first await, so it is
		// already observable when the call returns its promise.
		expect(events.map(event => event.type)).toContain("autolearn_capture_start");
		expect(events.some(event => event.type === "autolearn_capture_end")).toBe(false);

		release.resolve();
		await capture;
		const end = events.find(event => event.type === "autolearn_capture_end");
		expect(end).toMatchObject({ type: "autolearn_capture_end", outcome: "completed" });
	});

	it("settles an aborted capture with autolearn_capture_end(aborted) instead of rejecting", async () => {
		const { events, session: current } = createSession();
		current.subscribe(event => events.push(event));
		const capture = current.runAutolearnCapture(signal => {
			// Resolves-with-rejection on abort: the shape a real capture LLM
			// call presents when its AbortSignal fires.
			const { promise, reject } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			return promise;
		});
		expect(events.map(event => event.type)).toContain("autolearn_capture_start");

		await current.abort();
		await capture;
		const end = events.find(event => event.type === "autolearn_capture_end");
		expect(end).toMatchObject({ type: "autolearn_capture_end", outcome: "aborted" });
	});

	it("settles a failing capture with autolearn_capture_end(error) while rejecting", async () => {
		const { events, session: current } = createSession();
		current.subscribe(event => events.push(event));
		const capture = current.runAutolearnCapture(async () => {
			throw new Error("capture exploded");
		});
		await expect(capture).rejects.toThrow("capture exploded");
		const end = events.find(event => event.type === "autolearn_capture_end");
		expect(end).toMatchObject({ type: "autolearn_capture_end", outcome: "error" });
	});

	it("starts nothing while a capture is already in flight", async () => {
		const { events, session: current } = createSession();
		current.subscribe(event => events.push(event));
		const release = Promise.withResolvers<void>();
		const first = current.runAutolearnCapture(async () => {
			await release.promise;
		});
		const second = current.runAutolearnCapture(async () => {});
		await second;
		expect(events.filter(event => event.type === "autolearn_capture_start")).toHaveLength(1);
		release.resolve();
		await first;
		expect(events.filter(event => event.type === "autolearn_capture_end")).toHaveLength(1);
	});

	it("forwards autolearn_capture_start before agent_end to later subscribers on a qualifying turn", async () => {
		const { events, session: current } = createSession({ toolTurns: 5 });
		// Install the controller first, exactly like createAgentSession does;
		// the recorder below plays the role of rpc-mode's forwarder.
		const release = Promise.withResolvers<void>();
		const agentEnd = Promise.withResolvers<void>();
		const captureEnd = Promise.withResolvers<void>();
		new AutoLearnController({
			session: current,
			settings: current.settings,
			capture: () =>
				current.runAutolearnCapture(async () => {
					await release.promise;
				}),
		});
		current.subscribe(event => {
			events.push(event);
			if (event.type === "agent_end") agentEnd.resolve();
			if (event.type === "autolearn_capture_end") captureEnd.resolve();
		});

		const run = current.prompt("go");
		await agentEnd.promise;

		// The recorder is subscribed after the controller, so by the time it
		// sees agent_end the controller's synchronous capture start has already
		// been dispatched to every listener.
		const types = events.map(event => event.type);
		const startAt = types.indexOf("autolearn_capture_start");
		const endAt = types.indexOf("agent_end");
		expect(startAt).toBeGreaterThanOrEqual(0);
		expect(startAt).toBeLessThan(endAt);

		release.resolve();
		await run;
		await captureEnd.promise;
		expect(events.find(event => event.type === "autolearn_capture_end")).toMatchObject({
			type: "autolearn_capture_end",
			outcome: "completed",
		});
	});

	it("emits neither autolearn event on a non-qualifying turn", async () => {
		const { events, session: current } = createSession({ toolTurns: 0 });
		const agentEnd = Promise.withResolvers<void>();
		new AutoLearnController({
			session: current,
			settings: current.settings,
			capture: () => current.runAutolearnCapture(async () => {}),
		});
		current.subscribe(event => {
			events.push(event);
			if (event.type === "agent_end") agentEnd.resolve();
		});

		await current.prompt("go");
		await agentEnd.promise;
		// The recorder runs after the controller's listener in the same
		// agent_end dispatch, so a qualifying-turn bug would already be visible.
		expect(events.filter(event => event.type.startsWith("autolearn_capture"))).toHaveLength(0);
	});

	it("announces a queued second capture before its triggering agent_end while the first capture is held", async () => {
		const { events, session: current } = createSession({ toolTurns: 5 });
		const releaseFirst = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const secondCaptureStarted = Promise.withResolvers<void>();
		const secondCaptureEnded = Promise.withResolvers<void>();
		let captureCall = 0;
		let outstandingCaptures = 0;
		const outstandingAtAgentEnd: number[] = [];

		new AutoLearnController({
			session: current,
			settings: current.settings,
			capture: () => {
				const callIndex = captureCall++;
				return current.runAutolearnCapture(async () => {
					if (callIndex === 0) {
						await releaseFirst.promise;
					} else {
						secondCaptureStarted.resolve();
						await releaseSecond.promise;
					}
				});
			},
		});
		current.subscribe(event => {
			events.push(event);
			if (event.type === "autolearn_capture_start") outstandingCaptures++;
			if (event.type === "autolearn_capture_end") {
				outstandingCaptures--;
				if (outstandingCaptures === 0) secondCaptureEnded.resolve();
			}
			if (event.type === "agent_end") outstandingAtAgentEnd.push(outstandingCaptures);
		});

		// Turn 1 qualifies and holds Capture 1 in flight.
		await current.prompt("turn 1");
		// Turn 2 qualifies while Capture 1 is still held: its pending capture must
		// be announced synchronously before Turn 2's agent_end.
		await current.prompt("turn 2");

		const relevant = events
			.filter(event => event.type === "agent_end" || event.type.startsWith("autolearn_capture"))
			.map(event => event.type);
		expect(relevant).toEqual(["autolearn_capture_start", "agent_end", "autolearn_capture_start", "agent_end"]);
		expect(outstandingAtAgentEnd).toEqual([1, 2]);
		expect(outstandingCaptures).toBe(2);

		// Settling Capture 1 emits the first end (leaving 1 outstanding) and
		// immediately starts the queued second capture without a duplicate start.
		releaseFirst.resolve();
		await secondCaptureStarted.promise;
		expect(outstandingCaptures).toBe(1);

		releaseSecond.resolve();
		await secondCaptureEnded.promise;
		expect(outstandingCaptures).toBe(0);
		expect(
			events
				.filter(event => event.type === "agent_end" || event.type.startsWith("autolearn_capture"))
				.map(event => event.type),
		).toEqual([
			"autolearn_capture_start",
			"agent_end",
			"autolearn_capture_start",
			"agent_end",
			"autolearn_capture_end",
			"autolearn_capture_end",
		]);
	});

	it("routes autolearn_capture_start and autolearn_capture_end through RpcClient.onSessionEvent", async () => {
		const exited = Promise.withResolvers<number>();
		const proc: RpcAgentProcess = {
			stdin: { write: () => 0 },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					for (const frame of [
						{ type: "ready" },
						{ type: "autolearn_capture_start" },
						{ type: "autolearn_capture_end", outcome: "completed" },
					]) {
						controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
					}
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};

		using client = new RpcClient({ spawn: () => proc });
		const received: AgentSessionEvent[] = [];
		const bothReceived = Promise.withResolvers<void>();
		client.onSessionEvent(event => {
			if (event.type === "autolearn_capture_start" || event.type === "autolearn_capture_end") {
				received.push(event);
				if (received.length === 2) bothReceived.resolve();
			}
		});

		await client.start();
		await bothReceived.promise;
		expect(received).toEqual([
			{ type: "autolearn_capture_start" },
			{ type: "autolearn_capture_end", outcome: "completed" },
		]);
	});

	it("delivers capture lifecycle events to extensions through pi.on", async () => {
		const seen: string[] = [];
		const extensionSawStart = Promise.withResolvers<void>();
		const extensionSawEnd = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("autolearn_capture_start", event => {
					seen.push(event.type);
					extensionSawStart.resolve();
				});
				pi.on("autolearn_capture_end", event => {
					seen.push(`${event.type}:${event.outcome}`);
					extensionSawEnd.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"capture-observer",
		);
		const { session: current } = createSession({ toolTurns: 5, extension: { extension, runtime } });
		const release = Promise.withResolvers<void>();
		new AutoLearnController({
			session: current,
			settings: current.settings,
			capture: () =>
				current.runAutolearnCapture(async () => {
					await release.promise;
				}),
		});

		await current.prompt("go");
		await extensionSawStart.promise;
		// The capture is still held: an extension tracking pane state knows a
		// background capture is running and has not seen it settle.
		expect(seen).toEqual(["autolearn_capture_start"]);

		release.resolve();
		await extensionSawEnd.promise;
		expect(seen).toEqual(["autolearn_capture_start", "autolearn_capture_end:completed"]);
	});

	it("has extensions handle the capture start before the capture turn runs", async () => {
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		let handlerFinished = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				// A slow observer: the capture turn's tool calls must not overtake it.
				pi.on("autolearn_capture_start", async () => {
					handlerEntered.resolve();
					await releaseHandler.promise;
					handlerFinished = true;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"slow-capture-observer",
		);
		const { session: current } = createSession({ extension: { extension, runtime } });
		let handlerFinishedWhenCaptureRan: boolean | undefined;
		const capture = current.runAutolearnCapture(async () => {
			handlerFinishedWhenCaptureRan = handlerFinished;
		});
		await handlerEntered.promise;
		releaseHandler.resolve();
		await capture;
		expect(handlerFinishedWhenCaptureRan).toBe(true);
	});

	/** Controller whose captures hold until released; records lifecycle frames in order. */
	function holdCaptures(current: AgentSession) {
		const runs = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const releases = runs.map(() => Promise.withResolvers<void>());
		const frames: string[] = [];
		const allSettled = Promise.withResolvers<void>();
		let started = 0;
		let outstanding = 0;
		new AutoLearnController({
			session: current,
			settings: current.settings,
			capture: () =>
				current.runAutolearnCapture(async signal => {
					const index = started++;
					runs[index]!.resolve();
					const release = releases[index]!;
					signal.addEventListener("abort", () => release.reject(new Error("aborted")), { once: true });
					await release.promise;
				}),
		});
		current.subscribe(event => {
			if (event.type === "autolearn_capture_start") {
				outstanding++;
				frames.push("start");
			} else if (event.type === "autolearn_capture_end") {
				outstanding--;
				frames.push(`end:${event.outcome}`);
				if (outstanding === 0) allSettled.resolve();
			} else if (event.type === "agent_end") {
				frames.push("agent_end");
			}
		});
		return { runs, releases, frames, allSettled: allSettled.promise, captureRuns: () => started };
	}

	it("joins further qualifying turns to the capture already queued, keeping starts and ends paired", async () => {
		const { session: current } = createSession({ toolTurns: 5 });
		const { runs, releases, frames, allSettled, captureRuns } = holdCaptures(current);

		await current.prompt("turn 1");
		await current.prompt("turn 2");
		await current.prompt("turn 3");
		// Turn 3 joins the capture turn 2 queued: no second start, no end for a capture still running.
		expect(frames).toEqual(["start", "agent_end", "start", "agent_end", "agent_end"]);

		releases[0]!.resolve();
		await runs[1]!.promise;
		releases[1]!.resolve();
		await allSettled;
		expect(frames.slice(5)).toEqual(["end:completed", "end:completed"]);
		expect(captureRuns()).toBe(2);
	});

	it("still runs the queued capture after an abort settles the in-flight one", async () => {
		const { session: current } = createSession({ toolTurns: 5 });
		const { runs, releases, frames, allSettled } = holdCaptures(current);

		await current.prompt("turn 1");
		await current.prompt("turn 2");
		await current.abort();
		await runs[1]!.promise;
		releases[1]!.resolve();
		await allSettled;
		expect(frames).toEqual(["start", "agent_end", "start", "agent_end", "end:aborted", "end:completed"]);
	});

	it("settles a queued capture as aborted without running it when the session is disposed", async () => {
		const { session: current } = createSession({ toolTurns: 5 });
		const { frames, allSettled, captureRuns } = holdCaptures(current);

		await current.prompt("turn 1");
		await current.prompt("turn 2");
		session = undefined;
		await current.dispose();
		await allSettled;
		expect(frames).toEqual(["start", "agent_end", "start", "agent_end", "end:aborted", "end:aborted"]);
		expect(captureRuns()).toBe(1);
	});
});
