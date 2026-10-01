import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	generateNextPromptSuggestion,
	NEXT_PROMPT_CONTEXT_MAX_CHARS,
	NEXT_PROMPT_MAX_TOKENS,
	NEXT_PROMPT_SUGGESTION_MAX_CHARS,
} from "@oh-my-pi/pi-coding-agent/modes/next-prompt-suggestion";
import { obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface GeneratorHarnessOptions {
	eventMessages?: AgentMessage[];
	sessionMessages?: AgentMessage[];
	convert?: (messages: AgentMessage[]) => Message[];
	obfuscator?: SecretObfuscator;
	responseText?: string;
}

interface ProviderPayloadCarrier {
	providerPayload?: UserMessage["providerPayload"];
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function toolResultMessage(timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		isError: false,
		timestamp,
	};
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const text: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") text.push(part.text);
	}
	return text.join("\n");
}

function createHarness(options: GeneratorHarnessOptions = {}) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
	const convertToLlmForSideRequest = vi.fn(
		options.convert ??
			((messages: AgentMessage[]): Message[] =>
				messages.map(message => {
					if (
						message.role === "user" ||
						message.role === "developer" ||
						message.role === "assistant" ||
						message.role === "toolResult"
					)
						return message;
					throw new Error(`Unexpected selected role: ${message.role}`);
				})),
	);
	const modelRegistry = {
		getAvailable: () => [model],
		getApiKey: vi.fn(async () => "test-key"),
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const event: Extract<AgentSessionEvent, { type: "agent_end" }> = {
		type: "agent_end",
		isTerminal: true,
		messages: options.eventMessages ?? [userMessage("Question", 1), assistantMessage("Answer", 2)],
	};
	const completeSideRequest = vi.fn(
		async (_model: Model, _context: Context, _streamOptions: SimpleStreamOptions): Promise<AssistantMessage> =>
			assistantMessage(options.responseText ?? "Suggested follow-up", 30),
	);
	const session = {
		messages: options.sessionMessages ?? [
			userMessage("Session-history question", 20),
			assistantMessage("Session-history answer", 21),
		],
		modelRegistry,
		sessionId: "session-1",
		obfuscator: options.obfuscator,
		convertToLlmForSideRequest,
		completeSideRequest,
	} as unknown as AgentSession;
	const settings = Settings.isolated({
		modelRoles: { tiny: `${model.provider}/${model.id}` },
	});
	return {
		completeSideRequest,
		convertToLlmForSideRequest,
		event,
		model,
		modelRegistry,
		session,
		settings,
	};
}

describe("generateNextPromptSuggestion", () => {
	it("sends only the last valid textual pair from the current agent_end event", async () => {
		const latestUser = userMessage("Latest event question", 12);
		const latestAssistant = assistantMessage("Latest event answer", 14);
		const { completeSideRequest, convertToLlmForSideRequest, event, session, settings } = createHarness({
			eventMessages: [
				userMessage("Older event question", 10),
				assistantMessage("Older event answer", 11),
				latestUser,
				toolResultMessage(13),
				latestAssistant,
			],
		});

		await generateNextPromptSuggestion({
			session,
			settings,
			event,
			signal: new AbortController().signal,
		});

		expect(convertToLlmForSideRequest).toHaveBeenCalledTimes(1);
		expect(convertToLlmForSideRequest.mock.calls[0]?.[0]).toEqual([latestUser, latestAssistant]);
		expect(completeSideRequest).toHaveBeenCalledTimes(1);
		const context = completeSideRequest.mock.calls[0]?.[1];
		expect(context?.messages.map(message => ({ role: message.role, text: messageText(message) }))).toEqual([
			{ role: "user", text: "Latest event question" },
			{ role: "assistant", text: "Latest event answer" },
		]);
	});

	it("strips provider replay payloads before converting user or custom text for the auxiliary context", async () => {
		const replayPayload: NonNullable<UserMessage["providerPayload"]> = {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [{ id: "native-history-replay" }],
		};
		const selectedRequests: AgentMessage[] = [
			{ ...userMessage("User request", 1), providerPayload: replayPayload },
			{
				role: "custom",
				customType: "user-action",
				content: "Custom user request",
				display: true,
				attribution: "user",
				providerPayload: replayPayload,
				timestamp: 3,
			} as AgentMessage & ProviderPayloadCarrier,
		];
		const harness = createHarness({
			convert: messages =>
				messages.map(message => {
					if (message.role === "custom") {
						return {
							role: "user",
							content: message.content,
							attribution: "user",
							providerPayload: (message as AgentMessage & ProviderPayloadCarrier).providerPayload,
							timestamp: message.timestamp,
						};
					}
					if (message.role === "user" || message.role === "assistant") return message;
					throw new Error(`Unexpected selected role: ${message.role}`);
				}),
		});

		for (const [index, request] of selectedRequests.entries()) {
			const answer = {
				...assistantMessage(`Answer ${index + 1}`, request.timestamp + 1),
				providerPayload: replayPayload,
			};
			await generateNextPromptSuggestion({
				session: harness.session,
				settings: harness.settings,
				event: { ...harness.event, messages: [request, answer] },
				signal: new AbortController().signal,
			});
		}

		expect(harness.convertToLlmForSideRequest).toHaveBeenCalledTimes(2);
		for (const call of harness.convertToLlmForSideRequest.mock.calls) {
			for (const message of call[0]) {
				expect((message as AgentMessage & ProviderPayloadCarrier).providerPayload).toBeUndefined();
			}
		}
		expect(harness.completeSideRequest).toHaveBeenCalledTimes(2);
		for (const call of harness.completeSideRequest.mock.calls) {
			for (const message of call[1].messages) {
				expect((message as Message & ProviderPayloadCarrier).providerPayload).toBeUndefined();
			}
		}
	});

	it("rejects events without a current real user even when session history has a valid pair", async () => {
		const harness = createHarness();
		const syntheticUser = { ...userMessage("Synthetic continuation", 4), synthetic: true };
		const customAgent: AgentMessage = {
			role: "custom",
			customType: "agent-note",
			content: "Agent-authored context",
			display: true,
			attribution: "agent",
			timestamp: 6,
		};
		const syntheticDeveloper: AgentMessage = {
			role: "developer",
			content: "Continue automatically",
			attribution: "agent",
			timestamp: 8,
		};
		const scenarios: AgentMessage[][] = [
			[assistantMessage("No user in this event", 3)],
			[syntheticUser, assistantMessage("Synthetic answer", 5)],
			[
				{ ...userMessage("Agent-attributed user role", 5), attribution: "agent" },
				assistantMessage("Agent-attributed answer", 6),
			],
			[customAgent, assistantMessage("Custom-agent answer", 7)],
			[syntheticDeveloper, assistantMessage("Loop continuation answer", 9)],
		];

		for (const messages of scenarios) {
			const result = await generateNextPromptSuggestion({
				session: harness.session,
				settings: harness.settings,
				event: { ...harness.event, messages },
				signal: new AbortController().signal,
			});
			expect(result).toBeNull();
		}

		expect(harness.convertToLlmForSideRequest).not.toHaveBeenCalled();
		expect(harness.completeSideRequest).not.toHaveBeenCalled();
	});

	it("accepts a displayed custom message attributed to the user", async () => {
		const customUser: AgentMessage = {
			role: "custom",
			customType: "user-action",
			content: "Run the focused check",
			display: true,
			attribution: "user",
			timestamp: 1,
		};
		const answer = assistantMessage("The focused check passed", 2);
		const harness = createHarness({
			eventMessages: [customUser, answer],
			convert: messages => [
				{ role: "user", content: "Run the focused check", attribution: "user", timestamp: 1 },
				messages[1] as AssistantMessage,
			],
		});

		const result = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(harness.convertToLlmForSideRequest.mock.calls[0]?.[0]).toEqual([customUser, answer]);
		expect(result).toBe("Suggested follow-up");
	});

	it("does not skip an image-only current user to reuse an older textual turn", async () => {
		const imageOnlyUser: UserMessage = {
			role: "user",
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			timestamp: 3,
		};
		const harness = createHarness({
			eventMessages: [
				userMessage("Older textual question", 1),
				assistantMessage("Older textual answer", 2),
				imageOnlyUser,
				assistantMessage("Current answer", 4),
			],
		});

		const result = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(result).toBeNull();
		expect(harness.convertToLlmForSideRequest).not.toHaveBeenCalled();
		expect(harness.completeSideRequest).not.toHaveBeenCalled();
	});

	it.each(["error", "aborted"] as const)(
		"does not fall back to an older successful answer when the latest answer's stop reason is %s",
		async stopReason => {
			const harness = createHarness({
				eventMessages: [
					userMessage("Older event question", 1),
					assistantMessage("Older event answer", 2),
					userMessage("Latest event question", 3),
					{ ...assistantMessage("Latest event answer", 4), stopReason },
				],
			});

			const result = await generateNextPromptSuggestion({
				session: harness.session,
				settings: harness.settings,
				event: harness.event,
				signal: new AbortController().signal,
			});

			expect(result).toBeNull();
			expect(harness.convertToLlmForSideRequest).not.toHaveBeenCalled();
			expect(harness.completeSideRequest).not.toHaveBeenCalled();
		},
	);

	it("converts complete text before applying tiny-message cleanup and limits", async () => {
		const userHash = "a".repeat(64);
		const assistantHash = "b".repeat(64);
		const userText = `Inspect commit ${userHash} and ${"u".repeat(NEXT_PROMPT_CONTEXT_MAX_CHARS)}`;
		const assistantText = `The relevant commit is ${assistantHash} and ${"v".repeat(NEXT_PROMPT_CONTEXT_MAX_CHARS)}`;
		const harness = createHarness({
			eventMessages: [userMessage(userText, 1), assistantMessage(assistantText, 2)],
		});

		await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		const convertedInput = harness.convertToLlmForSideRequest.mock.calls[0]?.[0];
		expect(convertedInput?.map(message => ("content" in message ? messageText(message as Message) : ""))).toEqual([
			userText,
			assistantText,
		]);
		const context = harness.completeSideRequest.mock.calls[0]?.[1];
		const sentTexts = context?.messages.map(messageText) ?? [];
		expect(sentTexts).toHaveLength(2);
		expect(sentTexts[0]).not.toContain(userHash);
		expect(sentTexts[1]).not.toContain(assistantHash);
		expect(sentTexts[0]?.length).toBeLessThanOrEqual(NEXT_PROMPT_CONTEXT_MAX_CHARS);
		expect(sentTexts[1]?.length).toBeLessThanOrEqual(NEXT_PROMPT_CONTEXT_MAX_CHARS);
	});

	it("drops converted secret-bearing context that exceeds the conservative limit", async () => {
		const secret = "0123456789abcdef".repeat(4);
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], "next-prompt-test-key");
		const oversizedUserText = `${"x".repeat(NEXT_PROMPT_CONTEXT_MAX_CHARS)}${secret}`;
		const harness = createHarness({
			eventMessages: [userMessage(oversizedUserText, 1), assistantMessage("Safe short answer", 2)],
			obfuscator,
			convert: messages => obfuscateMessages(obfuscator, messages as Message[]),
		});

		const result = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(messageText(harness.convertToLlmForSideRequest.mock.calls[0]?.[0][0] as Message)).toBe(oversizedUserText);
		expect(result).toBeNull();
		expect(harness.completeSideRequest).not.toHaveBeenCalled();
	});

	it("keeps bounded obfuscated context intact and rejects a known secret placeholder in output", async () => {
		const secret = "abcdef0123456789";
		const obfuscator = new SecretObfuscator(
			[{ type: "regex", content: "(?<=api_key=)[0-9a-f]{16}" }],
			"next-prompt-regex-key",
		);
		const secretContext = `api_key=${secret}`;
		const obfuscatedSecretContext = obfuscator.obfuscate(secretContext);
		const placeholder = obfuscatedSecretContext.slice("api_key=".length);
		const userText = `${"x".repeat(NEXT_PROMPT_CONTEXT_MAX_CHARS - obfuscatedSecretContext.length)}${secretContext}`;
		const harness = createHarness({
			eventMessages: [userMessage(userText, 1), assistantMessage(`Checked ${secretContext}`, 2)],
			obfuscator,
			convert: messages => obfuscateMessages(obfuscator, messages as Message[]),
			responseText: `Ask about ${placeholder}`,
		});

		const result = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		const context = harness.completeSideRequest.mock.calls[0]?.[1];
		const sentText = context?.messages.map(messageText).join("\n") ?? "";
		expect(context?.messages.map(messageText)[0]?.length).toBe(NEXT_PROMPT_CONTEXT_MAX_CHARS);
		expect(sentText).not.toContain(secret);
		expect(sentText).not.toContain(secret.slice(0, 8));
		expect(sentText).not.toContain(secret.slice(-8));
		expect(sentText).toContain(placeholder);
		expect(result).toBeNull();
	});

	it("uses the tiny-to-smol role chain through one bounded session side request", async () => {
		const smolModel = getBundledModel("anthropic", "claude-haiku-4-5");
		const mainModel = getBundledModel("anthropic", "claude-opus-4-8");
		if (!smolModel || !mainModel) throw new Error("Expected bundled smol and main models");
		const harness = createHarness();
		(
			harness.modelRegistry as unknown as {
				getAvailable: () => (typeof harness.model)[];
			}
		).getAvailable = () => [mainModel, smolModel];
		const settings = Settings.isolated({});
		const signal = new AbortController().signal;

		await generateNextPromptSuggestion({
			session: harness.session,
			settings,
			event: harness.event,
			signal,
		});

		expect(harness.completeSideRequest).toHaveBeenCalledTimes(1);
		expect(harness.completeSideRequest.mock.calls[0]?.[0]).toBe(smolModel);
		expect(harness.completeSideRequest.mock.calls[0]?.[0]).not.toBe(mainModel);
		expect(harness.modelRegistry.getApiKey).toHaveBeenCalledWith(smolModel, "session-1", { signal });
		expect(harness.completeSideRequest.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: NEXT_PROMPT_MAX_TOKENS,
			disableReasoning: true,
			signal,
			loopGuard: { enabled: false },
			codexSseMaxAttempts: 1,
		});
		const context = harness.completeSideRequest.mock.calls[0]?.[1];
		const systemPrompt = context?.systemPrompt;
		expect(systemPrompt).toHaveLength(1);
		expect(systemPrompt?.[0]).toContain("untrusted data");
		expect(systemPrompt?.[0]).toContain("NO_SUGGESTION");
		expect(context?.messages).toHaveLength(2);
		expect(context && "tools" in context).toBe(false);
	});

	it("rejects the exact no-suggestion sentinel and blank output", async () => {
		const harness = createHarness({ responseText: "  NO_SUGGESTION  " });

		const sentinelResult = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});
		harness.completeSideRequest.mockResolvedValueOnce(assistantMessage("   ", 31));
		const blankResult = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(sentinelResult).toBeNull();
		expect(blankResult).toBeNull();
	});

	it("rejects line breaks, ANSI escapes, and control characters", async () => {
		const harness = createHarness();
		const invalidOutputs = [
			"First line\nSecond line",
			"First line\rSecond line",
			"\u001b[31mColored\u001b[0m",
			"Bell\u0007sound",
			"Two\twords",
		];

		for (const output of invalidOutputs) {
			harness.completeSideRequest.mockResolvedValueOnce(assistantMessage(output, 31));
			const result = await generateNextPromptSuggestion({
				session: harness.session,
				settings: harness.settings,
				event: harness.event,
				signal: new AbortController().signal,
			});
			expect(result).toBeNull();
		}
	});

	it("rejects Markdown fences and external straight or curly quotes", async () => {
		const harness = createHarness();
		const invalidOutputs = [
			"```Use /status```",
			"~~~Use /status~~~",
			'"Use /status"',
			"'Use /status'",
			"“Use /status”",
			"‘Use /status’",
		];

		for (const output of invalidOutputs) {
			harness.completeSideRequest.mockResolvedValueOnce(assistantMessage(output, 31));
			const result = await generateNextPromptSuggestion({
				session: harness.session,
				settings: harness.settings,
				event: harness.event,
				signal: new AbortController().signal,
			});
			expect(result).toBeNull();
		}
	});

	it("limits suggestions by Unicode code points", async () => {
		const atLimit = "😀".repeat(NEXT_PROMPT_SUGGESTION_MAX_CHARS);
		const overLimit = `${atLimit}😀`;
		const harness = createHarness({ responseText: atLimit });

		const accepted = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});
		harness.completeSideRequest.mockResolvedValueOnce(assistantMessage(overLimit, 31));
		const rejected = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(accepted).toBe(atLimit);
		expect(rejected).toBeNull();
	});

	it("does not start or deliver work for an aborted signal", async () => {
		const harness = createHarness();
		const abortController = new AbortController();
		abortController.abort();

		const result = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: abortController.signal,
		});

		expect(result).toBeNull();
		expect(harness.convertToLlmForSideRequest).not.toHaveBeenCalled();
		expect(harness.completeSideRequest).not.toHaveBeenCalled();
	});

	it("fails silently without an auxiliary model or its credential", async () => {
		const harness = createHarness();
		const registry = harness.modelRegistry as unknown as {
			getAvailable: () => (typeof harness.model)[];
			getApiKey: () => Promise<string | undefined>;
		};
		registry.getAvailable = () => [];

		const missingModel = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});
		registry.getAvailable = () => [harness.model];
		registry.getApiKey = async () => undefined;
		const missingKey = await generateNextPromptSuggestion({
			session: harness.session,
			settings: harness.settings,
			event: harness.event,
			signal: new AbortController().signal,
		});

		expect(missingModel).toBeNull();
		expect(missingKey).toBeNull();
		expect(harness.convertToLlmForSideRequest).not.toHaveBeenCalled();
		expect(harness.completeSideRequest).not.toHaveBeenCalled();
	});
});
