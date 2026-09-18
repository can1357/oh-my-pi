import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	bedrockTestModel,
	BEDROCK_TEST_CONTEXT,
	encodeBedrockFrame,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";

function bedrockFrameFetch(frame: Uint8Array): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(frame);
					controller.close();
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		},
		{ preconnect: fetch.preconnect },
	) as FetchImpl;
}

async function consumeBedrockFrame(frame: Uint8Array): Promise<AssistantMessage> {
	setBedrockProviderModule({ streamBedrock });
	let result: AssistantMessage | undefined;
	await withSkippedBedrockAuth(async () => {
		result = await streamSimple(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
			fetch: bedrockFrameFetch(frame),
		}).result();
	});
	if (!result) throw new Error("Bedrock stream did not produce a result");
	return result;
}

function exceptionFrame(code: string): Uint8Array {
	return encodeBedrockFrame(
		{ ":message-type": "exception", ":exception-type": code },
		new TextEncoder().encode('{"message":"temporary failure"}'),
	);
}

function errorFrame(code: string): Uint8Array {
	return encodeBedrockFrame(
		{ ":message-type": "error", ":error-code": code, ":error-message": "temporary failure" },
		new Uint8Array(),
	);
}

describe("amazon-bedrock eventstream errors", () => {
	it("preserves AWS statuses and transient classification for known temporary exceptions", async () => {
		const cases = [
			{ code: "internalServerException", status: 500, kind: "exception" as const },
			{ code: "serviceUnavailableException", status: 503, kind: "exception" as const },
			{ code: "throttlingException", status: 429, kind: "exception" as const },
			{ code: "modelNotReadyException", status: 429, kind: "error" as const },
			{ code: "modelTimeoutException", status: 408, kind: "error" as const },
			{ code: "modelStreamErrorException", status: 424, kind: "exception" as const },
			{ code: "ModelErrorException", status: 424, kind: "error" as const },
		];

		for (const item of cases) {
			const result = await consumeBedrockFrame(
				item.kind === "exception" ? exceptionFrame(item.code) : errorFrame(item.code),
			);
			expect(result.errorStatus).toBe(item.status);
			expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(result.errorId)).toBe(true);
		}
	});

	it("keeps validation, auth, and unknown eventstream failures terminal", async () => {
		for (const frame of [
			exceptionFrame("validationException"),
			errorFrame("AccessDeniedException"),
			errorFrame("UnknownError"),
			errorFrame("constructor"),
		]) {
			const result = await consumeBedrockFrame(frame);
			expect(result.errorStatus).toBe(400);
			expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(false);
			expect(AIError.retriable(result.errorId)).toBe(false);
		}
	});

	it("limits 424 provider retryability to Bedrock model-processing codes", () => {
		const modelError = new AIError.BedrockApiError("ModelErrorException: temporary failure", 424, {
			code: "ModelErrorException",
		});
		expect(AIError.is(AIError.classify(modelError), AIError.Flag.Transient)).toBe(true);
		expect(AIError.isProviderRetryableError(modelError)).toBe(true);

		const arbitraryBedrockError = new AIError.BedrockApiError("SomeException: temporary failure", 424, {
			code: "SomeException",
		});
		expect(AIError.isProviderRetryableError(arbitraryBedrockError)).toBe(false);
		expect(AIError.is(AIError.classify(arbitraryBedrockError), AIError.Flag.Transient)).toBe(false);

		const foreignProviderError = new AIError.ProviderHttpError("ModelErrorException: temporary failure", 424, {
			code: "ModelErrorException",
		});
		expect(AIError.isProviderRetryableError(foreignProviderError)).toBe(false);
		expect(AIError.is(AIError.classify(foreignProviderError), AIError.Flag.Transient)).toBe(false);

		const arbitraryRetryText = new AIError.BedrockApiError("SomeException: Retry your request", 424, {
			code: "SomeException",
		});
		expect(AIError.is(AIError.classify(arbitraryRetryText), AIError.Flag.Transient)).toBe(true);
		expect(AIError.isProviderRetryableError(arbitraryRetryText)).toBe(false);

		const foreignRetryText = new AIError.ProviderHttpError("ModelErrorException: Retry your request", 424, {
			code: "ModelErrorException",
		});
		expect(AIError.is(AIError.classify(foreignRetryText), AIError.Flag.Transient)).toBe(true);
		expect(AIError.isProviderRetryableError(foreignRetryText)).toBe(false);
	});

	it("classifies a persisted Bedrock model error without widening 424 globally", () => {
		const bedrockId = AIError.classifyMessage({
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			errorStatus: 424,
			errorMessage: "ModelStreamErrorException: temporary failure",
		});
		expect(AIError.is(bedrockId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(bedrockId)).toBe(true);

		const aliasId = AIError.classifyMessage({
			api: "bedrock-converse-stream",
			provider: "acme-bedrock",
			errorStatus: 424,
			errorMessage: "ModelStreamErrorException: temporary failure",
		});
		expect(AIError.is(aliasId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(aliasId)).toBe(true);

		const foreignId = AIError.classifyMessage({
			api: "anthropic-messages",
			errorStatus: 424,
			errorMessage: "ModelStreamErrorException: temporary failure",
			provider: "some-other-provider",
		});
		expect(AIError.is(foreignId, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(foreignId)).toBe(false);
	});
});
