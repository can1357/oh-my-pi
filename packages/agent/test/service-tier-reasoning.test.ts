import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import { GenAIAttr, GenAIOperation, OpenAIAttr, PiGenAIAttr } from "@oh-my-pi/pi-agent-core/telemetry";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("service tier resolution at the request boundary", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	});

	afterEach(async () => {
		exporter.reset();
		await provider.shutdown();
	});

	it("re-resolves the tier per request and lets an authoritative-off resolver omit it without static fallback", async () => {
		const mock = createMockModel({
			id: "gpt-mock",
			provider: "openai",
			reasoning: true,
			responses: [
				{ content: ["one"], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
				{ content: ["two"], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
				{ content: ["three"], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
			],
		});

		const agent = new Agent({
			initialState: { model: mock.model, messages: [], thinkingLevel: ThinkingLevel.High },
			streamFn: mock.stream,
			serviceTier: "priority",
			serviceTierResolver: (_model, reasoning, disableReasoning) => {
				if (disableReasoning) return undefined;
				return reasoning === ThinkingLevel.High ? "priority" : "flex";
			},
			telemetry: { tracer: provider.getTracer("service-tier-reasoning-test") },
		});

		// The tier must already ride the message when it leaves the loop — the
		// `message_end` emission, not a post-hoc patch after the fact.
		const messageEnds: AssistantMessage[] = [];
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				messageEnds.push(event.message);
			}
		});

		await agent.prompt("first");
		agent.setThinkingLevel(ThinkingLevel.Low);
		await agent.prompt("second");
		agent.setDisableReasoning(true);
		await agent.prompt("third");

		expect(mock.calls[0]?.options?.reasoning).toBe(ThinkingLevel.High);
		expect(mock.calls[0]?.options?.serviceTier).toBe("priority");
		expect(mock.calls[0]?.options?.disableReasoning).toBe(false);
		expect(mock.calls[1]?.options?.reasoning).toBe(ThinkingLevel.Low);
		expect(mock.calls[1]?.options?.serviceTier).toBe("flex");
		expect(mock.calls[2]?.options?.disableReasoning).toBe(true);
		expect(mock.calls[2]?.options?.serviceTier).toBeUndefined();

		const chats = exporter
			.getFinishedSpans()
			.filter(span => span.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat)
			.sort(
				(a, b) =>
					(a.attributes[PiGenAIAttr.AgentStepNumber] as number) -
					(b.attributes[PiGenAIAttr.AgentStepNumber] as number),
			);
		expect(chats).toHaveLength(3);
		expect(chats[0]?.attributes[PiGenAIAttr.RequestReasoningEffort]).toBe(ThinkingLevel.High);
		expect(chats[0]?.attributes[OpenAIAttr.RequestServiceTier]).toBe("priority");
		expect(chats[1]?.attributes[PiGenAIAttr.RequestReasoningEffort]).toBe(ThinkingLevel.Low);
		expect(chats[1]?.attributes[OpenAIAttr.RequestServiceTier]).toBe("flex");
		expect(chats[2]?.attributes[OpenAIAttr.RequestServiceTier]).toBeUndefined();

		expect(messageEnds).toHaveLength(3);
		expect(messageEnds.map(message => message.serviceTier)).toEqual(["priority", "flex", null]);

		const persistedAssistant = agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(persistedAssistant.map(message => message.serviceTier)).toEqual(["priority", "flex", null]);
	});

	it("keeps static force-off active when its dynamic resolver returns false", async () => {
		const mock = createMockModel({
			id: "gpt-mock",
			provider: "openai",
			reasoning: true,
			responses: [
				{ content: ["ok"], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
			],
		});
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			reasoning: ThinkingLevel.High,
			serviceTier: "priority",
			forceReasoningOff: true,
			getForceReasoningOff: () => false,
			getServiceTier: (_model, reasoning, disableReasoning) => {
				if (disableReasoning) return undefined;
				return reasoning === ThinkingLevel.High ? "priority" : "flex";
			},
		};

		const messages = await agentLoop([createUserMessage("run")], context, config, undefined, mock.stream).result();

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options).toMatchObject({
			reasoning: ThinkingLevel.High,
			forceReasoningOff: true,
			disableReasoning: true,
		});
		expect(mock.calls[0]?.options?.serviceTier).toBeUndefined();
		expect(messages.at(-1)).toMatchObject({ role: "assistant", serviceTier: null });
	});
});
