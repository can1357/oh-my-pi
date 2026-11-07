/**
 * Zed Hosted Models dynamic discovery.
 *
 * Fetches the dynamic model catalog from cloud.zed.dev/models.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";

export const ZED_HOSTED_DEFAULT_BASE_URL = "https://cloud.zed.dev";
const ZED_MODELS_PATH = "/models";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ZedHostedModelDiscoveryOptions {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function fetchZedHostedModels(
	options: ZedHostedModelDiscoveryOptions = {},
): Promise<ModelSpec<"zed-hosted">[] | null> {
	const baseUrl = (options.baseUrl || ZED_HOSTED_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	const fetchImpl = discoveryFetch(options.fetch);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"x-zed-client-supports-x-ai": "true",
	};

	if (options.apiKey) {
		headers.Authorization = options.apiKey.startsWith("Bearer ") ? options.apiKey : `Bearer ${options.apiKey}`;
	}

	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${ZED_MODELS_PATH}`, {
			method: "GET",
			headers,
			signal,
		});
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) return null;

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		return null;
	}

	if (!isRecord(data) || !Array.isArray(data.models)) return null;

	const specs: ModelSpec<"zed-hosted">[] = [];
	for (const raw of data.models) {
		if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) continue;
		if (raw.is_disabled || raw.isDisabled) continue;

		const id = raw.id;
		const name =
			(typeof raw.display_name === "string" ? raw.display_name : undefined) ||
			(typeof raw.displayName === "string" ? raw.displayName : undefined) ||
			id;

		const inputs: ("text" | "image")[] = raw.supports_images ? ["text", "image"] : ["text"];
		const contextWindow =
			typeof raw.max_token_count === "number"
				? raw.max_token_count
				: typeof raw.maxTokenCount === "number"
					? raw.maxTokenCount
					: 200_000;
		const maxTokens =
			typeof raw.max_output_tokens === "number"
				? raw.max_output_tokens
				: typeof raw.maxOutputTokens === "number"
					? raw.maxOutputTokens
					: 8192;

		const providerType = typeof raw.provider === "string" ? raw.provider : undefined;

		specs.push({
			id,
			name,
			api: "zed-hosted",
			provider: "zed-hosted",
			baseUrl,
			reasoning: Boolean(raw.supports_thinking || raw.supportsThinking),
			input: inputs,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			headers: providerType ? { "x-provider": providerType } : undefined,
		});
	}

	return specs.length ? specs : null;
}
