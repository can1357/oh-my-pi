import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isAuthRetryableError } from "@oh-my-pi/pi-ai/error/auth-classify";
import { isUsageLimitOutcome, parseRateLimitReason } from "@oh-my-pi/pi-ai/error/rate-limit";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

// omp names the rejected request's dump file in the error it shows. The path
// is local text: a HOME or logs directory can hold any phrase a decision about
// the provider's rejection keys on. Each provider below is driven against a
// local server that rejects the request; each row puts one decision's phrase
// in the logs path and requires every decision to equal the plain-path run.

const REJECTION_MESSAGE = "messages: text content blocks must be non-empty";

interface ProviderCase {
	name: string;
	model(baseUrl: string): Model<Api>;
	rejection: string;
}

const PROVIDERS: ProviderCase[] = [
	{
		name: "Anthropic",
		model: baseUrl =>
			buildModel({
				api: "anthropic-messages",
				name: "Local Anthropic",
				id: "claude-local-test",
				provider: "anthropic",
				baseUrl,
				contextWindow: 200_000,
				maxTokens: 8192,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} satisfies ModelSpec<"anthropic-messages">),
		rejection: JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: REJECTION_MESSAGE },
			request_id: "req_local",
		}),
	},
	{
		name: "OpenAI-compatible",
		model: baseUrl =>
			buildModel({
				api: "openai-completions",
				name: "Local OpenAI-compatible",
				id: "local-chat-test",
				provider: "custom",
				baseUrl,
				contextWindow: 200_000,
				maxTokens: 8192,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} satisfies ModelSpec<"openai-completions">),
		rejection: JSON.stringify({ error: { message: REJECTION_MESSAGE, type: "invalid_request_error" } }),
	},
];

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

/** One failed turn from `provider`, with omp's request dumps written under a path holding `localText`. */
async function rejectedTurn(provider: ProviderCase, localText: string): Promise<AssistantMessage> {
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			await request.text();
			return new Response(provider.rejection, { status: 400, headers: { "content-type": "application/json" } });
		},
	});
	const root = TempDir.createSync("@pi-local-diagnostics-");
	cleanups.push(() => {
		server.stop(true);
		root.removeSync();
	});
	// Dumps are off under the test runner; turn them on for this turn only.
	vi.spyOn(piUtils, "isBunTestRuntime").mockReturnValue(false);
	vi.spyOn(piUtils, "getLogsDir").mockReturnValue(path.join(root.path(), `home-${localText}`, ".omp", "logs"));
	const model = provider.model(server.url.toString().replace(/\/$/, ""));
	const message = await streamSimple(
		model,
		{ systemPrompt: ["Test"], messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
		{ apiKey: "local-test-key" },
	).result();
	vi.restoreAllMocks();
	return message;
}

/** Every decision omp makes from a failed turn's error, as recovery reads it. */
function decisions(message: AssistantMessage) {
	const text = message.errorMessage ?? "";
	return {
		stopReason: message.stopReason,
		status: message.errorStatus,
		errorId: AIError.classifyMessage({ ...message }),
		contextOverflow: AIError.isContextOverflow(message, 200_000),
		payloadRejected: AIError.isPayloadRejection(message),
		creditBalanceTooLow: AIError.isCreditBalanceTooLow(message.errorStatus, text),
		immutableThinking: AIError.isImmutableLatestThinkingText(text),
		retryHintMs: extractProviderRetryHint(message.provider, text),
		rateLimitReason: parseRateLimitReason(text),
		usageLimitOutcome: isUsageLimitOutcome(message.errorStatus, text),
		credentialRetry: isAuthRetryableError(message),
	};
}

describe.each(PROVIDERS)("$name rejection with local text in the request-dump path", provider => {
	it.each([
		["retry timing", "retry-after-ms=3600000"],
		["context overflow", "prompt is too long"],
		["payload rejection", "request entity too large"],
		["credit balance", "Your credit balance is too low"],
		["immutable thinking", "messages.0.content.0 thinking latest assistant message cannot be modified"],
		["usage limit", "usage_limit_reached"],
		["rate-limit reason", "MODEL_CAPACITY_EXHAUSTED"],
		["concurrency cap", "Concurrent requests limit reached"],
		["empty response", "thought-only response without final output"],
		["account policy", "cyber_policy"],
		["decode fault", "floating point nan detected in generation"],
		["invalidated credential", "invalidated oauth token"],
	])("leaves the %s decision as the plain path makes it", async (_decision, localText) => {
		const plain = await rejectedTurn(provider, "plain");
		const hostile = await rejectedTurn(provider, localText);

		// The instrument: omp's displayed error names the dump under the path.
		expect(hostile.errorDisplayMessage ?? hostile.errorMessage).toContain(`home-${localText}`);
		expect(decisions(hostile)).toEqual(decisions(plain));
	});
});
