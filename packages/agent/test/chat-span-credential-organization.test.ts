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
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-5",
	name: "claude-opus-5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const CTX: Context = { systemPrompt: [], messages: [] };

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
	};
}

const CUSTOM_API_SOURCE = "chat-span-credential-organization-test";
const CUSTOM_API = "chat-span-credential-organization-api" as Api;

// The boundary test needs the real `completeSimple` path, which means a
// provider it can register — and a registered API is a runtime name the `Api`
// union cannot spell, so this one model is cast where the others are built.
const FAIL_MODEL = {
	id: "test-model",
	name: "Test Model",
	api: CUSTOM_API,
	provider: "test-provider",
	contextWindow: 1000,
	maxTokens: 100,
} as Model<Api>;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});

afterEach(async () => {
	unregisterCustomApis(CUSTOM_API_SOURCE);
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

	it("leaves the attribute off a turn whose credential resolved but which produced no final message", async () => {
		// The boundary this change draws, and it is deliberate. A request that
		// ends without a final assistant result ends its span through
		// `failChatSpan`, which has no message to read the organization from —
		// and a failed request owns no object that could carry one. Three
		// carriers were built and measured: the thrown error (one error object is
		// shared by two requests), a per-request observer threaded through the
		// stream options (a cache warmer clones them and replays into a live
		// turn's observer), and a per-request token (cannot tell the caller's own
		// next request from an inherited replay). Each wrote another account's
		// organization onto a real span, which is worse than none.
		//
		// The resolver here really does hand back an organization, and the real
		// `completeSimple` path really does resolve it, so reintroducing any of
		// those carriers reds this test. A version that merely rejected before
		// reaching the credential layer would stay green against exactly the
		// behaviour it is meant to forbid.
		let resolvedOrg: string | undefined;
		registerCustomApi(
			CUSTOM_API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new TypeError("fetch failed")));
				return stream;
			},
			CUSTOM_API_SOURCE,
		);
		const telemetry = resolveTelemetry(
			{ conversationId: "conv-org-fail", tracer: provider.getTracer("chat-span-organization-test") },
			"session-org-fail",
		);
		await expect(
			instrumentedCompleteSimple(
				FAIL_MODEL,
				CTX,
				{
					apiKey: async () => {
						resolvedOrg = "d0529c17-8bdc-42a1-9569-875928df83fe";
						return { apiKey: "alpha-bearer", credentialId: 7, oauthIdentity: { orgId: resolvedOrg } };
					},
				} as SimpleStreamOptions,
				{
					telemetry,
					oneshotKind: "organization_failure_test",
				},
			),
		).rejects.toThrow("fetch failed");

		// The precondition that makes the absence below mean something.
		expect(resolvedOrg).toBe("d0529c17-8bdc-42a1-9569-875928df83fe");

		const span = exporter.getFinishedSpans().find(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat);
		expect(span).toBeDefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBeUndefined();
	});
});
