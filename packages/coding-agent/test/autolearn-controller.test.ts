import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentOptions, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, FetchImpl, Model, ProviderSessionState, Usage } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAutoLearnCaptureRunner } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";

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

	it("does not nudge during plan mode", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
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
		settings.set("autolearn.enabled", true);
		new AutoLearnController({
			session: session as unknown as AgentSession,
			settings,
			capture: content => session.capture(content),
		});
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // fires while enabled
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		settings.set("autolearn.enabled", true);
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

	it("uses constrained tools and sends full Google context without the primary anchor", async () => {
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
			captureTools: [manageSkillTool],
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
		expect(requestBody).not.toContain('"name":"read"');
		expect(sourceAgent.state.messages).toHaveLength(2);
		const sourceAssistant = sourceAgent.state.messages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(sourceAssistant?.responseId).toBe("primary-interaction");
		expect(sourceAgent.peekSteeringQueue()).toEqual([queuedUserMessage]);
		expect(primaryEvents).toBe(0);
	});

	it("forwards provider lifecycle hooks to the detached capture", async () => {
		const captureMock = createMockModel({ responses: [{ content: ["Captured."] }] });
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const sourceAgent = new Agent({
			initialState: { model: captureMock, systemPrompt: ["Test"], tools: [manageSkillTool] },
		});
		const onPayload: NonNullable<AgentOptions["onPayload"]> = async payload => payload;
		const onResponse: NonNullable<AgentOptions["onResponse"]> = async () => {};
		let captureOnPayload: AgentOptions["onPayload"];
		let captureOnResponse: AgentOptions["onResponse"];
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool],
			onPayload,
			onResponse,
			createAgent: options => {
				captureOnPayload = options.onPayload;
				captureOnResponse = options.onResponse;
				return new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				});
			},
		});

		await runCapture("Capture with provider hooks");

		expect(captureMock.calls).toHaveLength(1);
		expect(captureOnPayload).toBe(onPayload);
		expect(captureOnResponse).toBe(onResponse);
	});

	it("adds learn alongside manage_skill when a memory backend provides it", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const learnTool = captureTool("learn", "Store long-term memory");
		const sourceAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [manageSkillTool, learnTool] },
		});
		const captureMock = createMockModel({ responses: [{ content: ["Captured."] }] });
		let captureToolNames: string[] = [];
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool, learnTool],
			createAgent: options => {
				captureToolNames = options.initialState?.tools?.map(tool => tool.name) ?? [];
				return new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				});
			},
		});

		await runCapture("Capture reusable knowledge");

		expect(captureToolNames).toEqual(["manage_skill", "learn"]);
		expect(captureMock.calls).toHaveLength(1);
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
			captureTools: [manageSkillTool],
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
			captureTools: [manageSkillTool],
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
