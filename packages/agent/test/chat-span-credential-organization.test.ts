/**
 * The chat span must carry the organization of the credential that served the
 * turn, so a spend or attribution pipeline can tell one machine's several
 * logins apart. The value is read from the message the AI layer stamped from
 * the resolved credential, never from a provider response header: a provider
 * that sends no organization header, and a session's first request, must still
 * be attributable.
 *
 * The negative case is a real limitation, not a formality: a key that comes
 * from no stored account (an API-key login, a `models.yml` `apiKey`, an env
 * var, `--api-key`) has no organization, and the span must be left without the
 * attribute rather than carrying a wrong or empty one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	GenAIAttr,
	GenAIOperation,
	instrumentedCompleteSimple,
	OmpGenAIAttr,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";

const MODEL = {
	id: "claude-opus-5",
	name: "claude-opus-5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	contextWindow: 200_000,
	maxTokens: 32_768,
} as unknown as Model<Api>;

const CTX = { systemPrompt: [], messages: [] } as unknown as Context;

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

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

async function chatSpanFor(message: AssistantMessage): Promise<ReadableSpan | undefined> {
	const telemetry = resolveTelemetry(
		{ conversationId: "conv-org", tracer: provider.getTracer("chat-span-organization-test") },
		"session-org",
	);
	await instrumentedCompleteSimple(MODEL, CTX, {} as SimpleStreamOptions, {
		telemetry,
		oneshotKind: "organization_test",
		completeImpl: () => Promise.resolve(message),
	});
	return exporter.getFinishedSpans().find(span => span.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat);
}

describe("chat span credential organization", () => {
	it("stamps the serving credential's organization on the chat span", async () => {
		const span = await chatSpanFor(
			reply({ credentialId: 2, organizationId: "d0529c17-8bdc-42a1-9569-875928df83fe" }),
		);

		expect(span).toBeDefined();
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBe("d0529c17-8bdc-42a1-9569-875928df83fe");
	});

	it("attributes a turn that ended in a terminal error after the provider billed it", async () => {
		const span = await chatSpanFor(
			reply({
				stopReason: "error",
				errorMessage: "provider refused the request",
				organizationId: "d0529c17-8bdc-42a1-9569-875928df83fe",
			}),
		);

		expect(span).toBeDefined();
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBe("d0529c17-8bdc-42a1-9569-875928df83fe");
		expect(span?.attributes[GenAIAttr.UsageInputTokens]).toBe(1);
	});

	it("leaves the attribute off a turn served by a key with no stored account", async () => {
		const span = await chatSpanFor(reply());

		expect(span).toBeDefined();
		// Indexed, never `toHaveProperty`: the attribute name contains dots, which
		// that matcher reads as a nested path, so it can never see this key and
		// its negative form passes against any value at all.
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBeUndefined();
	});

	it("leaves the attribute off a turn that never produced a message", async () => {
		// The boundary this change draws, and it is deliberate. A request that
		// fails before it resolves a credential ends its span through
		// `failChatSpan`, which has no message to read the organization from —
		// and a failed request owns no object that could carry one. Three
		// carriers were built and measured: the thrown error (one error object is
		// shared by two requests), a per-request observer threaded through the
		// stream options (a cache warmer clones them and replays into a live
		// turn's observer), and a per-request token (cannot tell the caller's own
		// next request from an inherited replay). Each wrote another account's
		// organization onto a real span, which is worse than none. So the failed
		// span carries none, and this pins that rather than leaving it to drift.
		const telemetry = resolveTelemetry(
			{ conversationId: "conv-org-fail", tracer: provider.getTracer("chat-span-organization-test") },
			"session-org-fail",
		);
		await expect(
			instrumentedCompleteSimple(MODEL, CTX, {} as SimpleStreamOptions, {
				telemetry,
				oneshotKind: "organization_failure_test",
				completeImpl: () => Promise.reject(new TypeError("fetch failed")),
			}),
		).rejects.toThrow("fetch failed");

		const span = exporter.getFinishedSpans().find(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat);
		expect(span).toBeDefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBeUndefined();
	});
});
