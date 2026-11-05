/**
 * The chat span must carry the organization of the credential that served the
 * turn, so a spend or attribution pipeline can tell one machine's several
 * logins apart. The value is read from the message the AI layer stamped from
 * the resolved credential, never from a provider response header: a provider
 * that sends no organization header, and a session's first request, must still
 * be attributable.
 *
 * A request that fails before response headers is the same spend: the provider
 * may already have billed the input, and the attempt's credential is known
 * before the socket is opened, so the failed span must name the same
 * organization the successful one would have.
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
		expect(span?.attributes).not.toHaveProperty(OmpGenAIAttr.AuthOrganizationId);
	});
});

/**
 * A pre-header transport failure never reaches `finishChatSpan`: `runAttempt`
 * in `packages/ai/src/stream.ts` fails the outer stream and the chat span ends
 * through `failChatSpan`. These cases drive the real `completeSimple` against a
 * registered API that fails before any event, so the attempt's resolved
 * credential — not a process default — is the only source of the organization.
 */
const FAIL_SOURCE_ID = "chat-span-organization-failure-test";
const FAIL_API = "chat-span-organization-failure-test" as Api;
const ORG = "d0529c17-8bdc-42a1-9569-875928df83fe";
/** Placeholder bearers: nothing in these tests reaches a provider. */
const OAUTH_BEARER = "bearer-from-a-stored-oauth-credential";
const STATIC_KEY = "key-that-belongs-to-no-stored-account";

const FAIL_MODEL = {
	id: "test-model",
	name: "test-model",
	api: FAIL_API,
	provider: "test-provider",
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as Model<Api>;

async function failedChatSpanFor(apiKey: SimpleStreamOptions["apiKey"]): Promise<ReadableSpan | undefined> {
	registerCustomApi(
		FAIL_API,
		() => {
			const stream = new AssistantMessageEventStream();
			// A socket reset before any event: no status, no headers, not rotatable.
			queueMicrotask(() => stream.fail(new TypeError("fetch failed")));
			return stream;
		},
		FAIL_SOURCE_ID,
	);
	const telemetry = resolveTelemetry(
		{ conversationId: "conv-org-fail", tracer: provider.getTracer("chat-span-organization-test") },
		"session-org-fail",
	);
	await expect(
		instrumentedCompleteSimple(FAIL_MODEL, CTX, { apiKey } as SimpleStreamOptions, {
			telemetry,
			oneshotKind: "organization_failure_test",
		}),
	).rejects.toThrow("fetch failed");
	return exporter.getFinishedSpans().find(span => span.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat);
}

describe("chat span credential organization on a pre-header failure", () => {
	afterEach(() => {
		unregisterCustomApis(FAIL_SOURCE_ID);
	});

	it("stamps the attempt's organization on a span that failed before response headers", async () => {
		const span = await failedChatSpanFor(() => ({
			apiKey: OAUTH_BEARER,
			credentialId: 7,
			oauthIdentity: { orgId: ORG },
		}));

		expect(span).toBeDefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes[OmpGenAIAttr.AuthOrganizationId]).toBe(ORG);
	});

	it("leaves the attribute off a pre-header failure served by a key with no stored account", async () => {
		const span = await failedChatSpanFor(STATIC_KEY);

		expect(span).toBeDefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes).not.toHaveProperty(OmpGenAIAttr.AuthOrganizationId);
	});
});
