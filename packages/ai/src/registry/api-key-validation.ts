import * as AIError from "../error";
import type { FetchImpl } from "../types";

type OpenAICompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
};
type AnthropicCompatibleValidationOptions = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
};

type ModelListValidationOptions = {
	provider: string;
	apiKey: string;
	modelsUrl: string;
	headers?: Record<string, string> | (() => Record<string, string> | undefined);
	signal?: AbortSignal;
	fetch?: FetchImpl;
};

const VALIDATION_TIMEOUT_MS = 15_000;

function normalizeAnthropicCompatibleBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function resolveValidationHeaders(
	headers: Record<string, string> | (() => Record<string, string> | undefined) | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

/**
 * Validate an API key against an OpenAI-compatible chat completions endpoint.
 *
 * Performs a minimal request to verify credentials and endpoint access.
 */
export async function validateOpenAICompatibleApiKey(options: OpenAICompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({
			model: options.model,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
			temperature: 0,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new AIError.ApiKeyRequiredError(message);
}

/**
 * Validate an API key against an Anthropic-compatible messages endpoint.
 */
export async function validateAnthropicCompatibleApiKey(options: AnthropicCompatibleValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const baseUrl = normalizeAnthropicCompatibleBaseUrl(options.baseUrl);
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": options.apiKey,
		},
		body: JSON.stringify({
			model: options.model,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new AIError.ApiKeyRequiredError(message);
}

/**
 * Validate an API key against a provider models endpoint.
 *
 * Useful for providers where access to specific models may vary by plan and
 * should not block key validation.
 */
export async function validateApiKeyAgainstModelsEndpoint(options: ModelListValidationOptions): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;

	const response = await fetchImpl(options.modelsUrl, {
		method: "GET",
		headers: {
			...(resolveValidationHeaders(options.headers) ?? {}),
			Authorization: `Bearer ${options.apiKey}`,
		},
		signal,
	});

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `${options.provider} API key validation failed (${response.status}): ${details}`
		: `${options.provider} API key validation failed (${response.status})`;
	throw new AIError.ApiKeyRequiredError(message);
}
