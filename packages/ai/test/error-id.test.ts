import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("error-id classification", () => {
	it("composes timeout with transient", () => {
		const id = AIError.classify(new Error("provider stream stall timeout"), "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
	});

	it("classifies OpenAI stream_read_error as transient", () => {
		const assistant = message({
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			errorMessage: "Error Code stream_read_error: stream_read_error",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies provider connection failures as transient", () => {
		const assistant = message({
			errorMessage: "Unable to connect. Is the computer able to access the url?",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps authenticated connection rejections non-retryable", () => {
		const assistant = message({
			errorMessage: "Unable to connect: 401 Unauthorized",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps provider content filters non-retryable", () => {
		const error = new AIError.ProviderResponseError("Provider returned error finish_reason: content_filter", {
			provider: "openrouter",
			kind: "content-blocked",
		});
		const id = AIError.classify(error, "openai-responses");
		expect(AIError.is(id, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ProviderFinishError)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("classifies Codex cyber approval denials as account-scoped policy blocks", () => {
		const assistant = message({
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			errorMessage:
				"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.AccountPolicy)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("classifies only the matching Codex ChatGPT-account model entitlement denial as account policy", () => {
		const errorMessage =
			"The 'gpt-daybreak-blue-latest' model is not supported when using Codex with a ChatGPT account. (code=invalid_request_error)";
		const denial = message({
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-daybreak-blue-latest",
			errorStatus: 400,
			errorMessage,
		});
		const denialId = AIError.classifyMessage(denial);
		expect(AIError.is(denialId, AIError.Flag.AccountPolicy)).toBe(true);
		expect(AIError.is(denialId, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.retriable(denialId)).toBe(false);
		expect(AIError.codexChatGPTAccountPolicyModel(denial)).toBe("gpt-daybreak-blue-latest");
		expect(AIError.isCodexChatGPTAccountPolicyError(denial, denial.provider, denial.model)).toBe(true);

		for (const mismatch of [
			message({
				api: "openai-codex-responses",
				provider: "openrouter",
				model: "gpt-daybreak-blue-latest",
				errorStatus: 400,
				errorMessage,
			}),
			message({
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.3-codex",
				errorStatus: 400,
				errorMessage,
			}),
		]) {
			const mismatchId = AIError.classifyMessage(mismatch);
			expect(AIError.is(mismatchId, AIError.Flag.AccountPolicy)).toBe(false);
			expect(AIError.isCodexChatGPTAccountPolicyError(mismatch, mismatch.provider, mismatch.model)).toBe(false);
		}

		const genericUnsupported = message({
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "some-unsupported-model",
			errorStatus: 400,
			errorMessage: "The 'some-unsupported-model' model is not supported. (code=invalid_request_error)",
		});
		const genericId = AIError.classifyMessage(genericUnsupported);
		expect(AIError.is(genericId, AIError.Flag.AccountPolicy)).toBe(false);
		expect(AIError.codexChatGPTAccountPolicyModel(genericUnsupported)).toBeUndefined();

		const oversizedModel = "m".repeat(257);
		const oversized = message({
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: oversizedModel,
			errorStatus: 400,
			errorMessage: `The '${oversizedModel}' model is not supported when using Codex with a ChatGPT account.`,
		});
		expect(AIError.codexChatGPTAccountPolicyModel(oversized)).toBeUndefined();
		expect(AIError.is(AIError.classifyMessage(oversized), AIError.Flag.AccountPolicy)).toBe(false);
	});
	it("classifies only Cursor plan-gate resource exhaustion as account policy", () => {
		for (const errorMessage of [
			'Connect error resource_exhausted: Error [details: {"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Named models unavailable","detail":"Free plans can only use Auto."}}]',
			'Connect error resource_exhausted: Error [details: {"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Model unavailable on Start","detail":"Switch to an included model to continue."}}]',
		]) {
			const id = AIError.classifyMessage(
				message({
					provider: "cursor",
					model: "cursor-grok-4.6",
					errorMessage,
				}),
			);
			expect(AIError.is(id, AIError.Flag.AccountPolicy)).toBe(true);
			expect(AIError.is(id, AIError.Flag.ContentBlocked)).toBe(true);
			expect(AIError.retriable(id)).toBe(false);
		}

		const relayedMessage =
			'Connect error resource_exhausted: Error [details: {"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Named models unavailable","detail":"Free plans can only use Auto."}}]';
		const relayedId = AIError.classifyMessage(
			message({ provider: "openrouter", model: "cursor-grok-4.6", errorMessage: relayedMessage }),
		);
		expect(AIError.is(relayedId, AIError.Flag.AccountPolicy)).toBe(false);
		expect(AIError.is(relayedId, AIError.Flag.ContentBlocked)).toBe(false);

		for (const errorMessage of [
			"Connect error resource_exhausted: Error",
			'Connect error resource_exhausted: Error [details: {"details":{"title":"Named models unavailable"}}]',
			'Connect error resource_exhausted: Error [details: {"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Temporary capacity unavailable"}}]',
		]) {
			const id = AIError.classifyMessage(message({ provider: "cursor", model: "cursor-grok-4.6", errorMessage }));
			expect(AIError.is(id, AIError.Flag.AccountPolicy)).toBe(false);
		}
	});

	it("keeps raw status fallback unclassified", () => {
		const id = 503;
		expect(AIError.is(id, AIError.Flag.Class)).toBe(false);
		expect(id).toBe(503);
	});

	it("gates stale Responses replay errors by API", () => {
		const text = "Item with id 'resp_123' not found";
		const anthropicId = AIError.classify(new Error(text), "anthropic-messages");
		const responsesId = AIError.classify(new Error(text), "openai-responses");
		expect(AIError.is(anthropicId, AIError.Flag.StaleResponsesItem)).toBe(false);
		expect(AIError.is(responsesId, AIError.Flag.StaleResponsesItem)).toBe(true);
	});

	it("walks causes and preserves carried ids", () => {
		const inner = AIError.attach(new Error("inner"), AIError.create(AIError.Flag.ThinkingLoop));
		const outer = new Error("outer", { cause: inner });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	it("combines wrapper text classification with cause ids", () => {
		const cause = AIError.attach(new Error("quota reached"), AIError.create(AIError.Flag.UsageLimit));
		const outer = new Error("network stream stall", { cause });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("upgrades a stamped status fallback after final error text exists", () => {
		const assistant = message({
			errorId: 503,
			errorStatus: 503,
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});

	it("classifies Cursor NGHTTP2 stream resets as transient", () => {
		for (const errorMessage of [
			"Stream closed with error code NGHTTP2_INTERNAL_ERROR",
			"Stream closed with error code NGHTTP2_REFUSED_STREAM",
			"Connect error failed_precondition: Error: Stream closed with error code NGHTTP2_REFUSED_STREAM",
		]) {
			const assistant = message({
				api: "cursor-agent",
				provider: "cursor",
				model: "composer-2.5",
				errorMessage,
			});
			const id = AIError.classifyMessage(assistant);
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("merges existing cause-chain kinds with finalized error text kinds", () => {
		const assistant = message({
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});
});
