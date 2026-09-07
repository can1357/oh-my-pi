/**
 * Service-tier × reasoning contract at the request boundary.
 *
 * Runs the real Agent loop with an injected mock stream and an in-memory
 * telemetry tracer, then drives three requests: a high→low thinking-level
 * transition (each request's concrete effective reasoning must re-resolve
 * its tier, and the same resolved pair must land in both the provider
 * request options and the recorded chat-span telemetry), followed by an
 * explicitly disabled request whose resolver returns `undefined` — the
 * authoritative-off tier reaches neither the provider options nor the
 * telemetry, and never falls back to the static `serviceTier`.
 *
 * Each request's final assistant message must additionally carry the
 * same per-request fact in `serviceTier` — the concrete tier, or `null`
 * for the authoritative-off request — observable on both the emitted
 * `message_end` metadata and the persisted message, stamped before
 * either leaves the loop.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { GenAIAttr, GenAIOperation, OpenAIAttr, PiGenAIAttr } from "@oh-my-pi/pi-agent-core/telemetry";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

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

		// Static session tier kept for contrast: the resolver is authoritative,
		// and its `undefined` for disabled reasoning must not fall back to it.
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
		// Transition: the next request must run at low effort and re-resolve its tier.
		agent.setThinkingLevel(ThinkingLevel.Low);
		await agent.prompt("second");
		// Explicitly disabled reasoning: the resolver is authoritative-off for this request.
		agent.setDisableReasoning(true);
		await agent.prompt("third");

		// The provider stream received the same resolved pair per request.
		expect(mock.calls[0]?.options?.reasoning).toBe(ThinkingLevel.High);
		expect(mock.calls[0]?.options?.serviceTier).toBe("priority");
		expect(mock.calls[0]?.options?.disableReasoning).toBe(false);
		expect(mock.calls[1]?.options?.reasoning).toBe(ThinkingLevel.Low);
		expect(mock.calls[1]?.options?.serviceTier).toBe("flex");
		// Authoritative-off: the disabled request carries no tier at all.
		expect(mock.calls[2]?.options?.disableReasoning).toBe(true);
		expect(mock.calls[2]?.options?.serviceTier).toBeUndefined();

		// Recorded telemetry matches the provider request options, request by request.
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
		// Authoritative-off leaves the telemetry request tier absent as well.
		expect(chats[2]?.attributes[OpenAIAttr.RequestServiceTier]).toBeUndefined();

		// The emitted `message_end` metadata carries the same per-request fact:
		// priority → flex → authoritative-off (`null`, never the static tier).
		expect(messageEnds).toHaveLength(3);
		expect(messageEnds.map(message => message.serviceTier)).toEqual(["priority", "flex", null]);

		// The persisted assistant messages carry the identical sequence, so
		// session history records what each request actually asked for.
		const persistedAssistant = agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(persistedAssistant.map(message => message.serviceTier)).toEqual(["priority", "flex", null]);
	});
});
