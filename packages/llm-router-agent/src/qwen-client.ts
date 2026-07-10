import { normalizeRouteLabel, type RouteLabel } from "./validation.js";

export type { RouteLabel };

export interface QwenClassifierConfig {
	endpoint: string;
	timeoutMs: number;
	systemPrompt: string;
	/** Optional OpenAI-compatible model id; defaults to the local Qwen router artifact name. */
	model?: string;
}

export interface QwenClassification {
	label: RouteLabel;
	source: "classifier" | "fallback";
	reason?: string;
	latencyMs: number;
}

const DEFAULT_MODEL = "qwen3-router-q8_0";

/**
 * One non-streaming chat-completions classification call.
 * Caller abort propagates and must not fall back. Only the client's own timeout
 * (and malformed/HTTP/network failures) become typed `mid` fallback.
 */
export async function classifySpawnDifficulty(
	input: string,
	config: QwenClassifierConfig,
	signal?: AbortSignal,
): Promise<QwenClassification> {
	const started = Date.now();
	throwIfAborted(signal);

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), Math.max(1, config.timeoutMs));
	const onCallerAbort = (): void => {
		timeoutController.abort();
	};
	signal?.addEventListener("abort", onCallerAbort, { once: true });

	try {
		const response = await fetch(config.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				model: config.model?.trim() || DEFAULT_MODEL,
				messages: [
					{ role: "system", content: config.systemPrompt },
					{ role: "user", content: input },
				],
				temperature: 0,
				max_tokens: 4,
				stream: false,
			}),
			signal: timeoutController.signal,
		});

		if (!response.ok) {
			return fallback("mid", "classifier_http_error", started);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return fallback("mid", "classifier_malformed", started);
		}

		const raw = extractAssistantText(payload);
		if (raw === undefined) {
			return fallback("mid", "classifier_malformed", started);
		}
		const label = normalizeRouteLabel(raw);
		if (!label) {
			return fallback("mid", "classifier_malformed", started);
		}
		return {
			label,
			source: "classifier",
			latencyMs: elapsed(started),
		};
	} catch (error) {
		if (isAbortError(error)) {
			if (signal?.aborted) {
				throw createAbortError();
			}
			return fallback("mid", "classifier_timeout", started);
		}
		return fallback("mid", classifyNetworkReason(error), started);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onCallerAbort);
	}
}

function fallback(label: RouteLabel, reason: string, started: number): QwenClassification {
	return {
		label,
		source: "fallback",
		reason,
		latencyMs: elapsed(started),
	};
}

function extractAssistantText(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const choices = payload.choices;
	if (!Array.isArray(choices) || choices.length === 0) return undefined;
	const first = choices[0];
	if (!isRecord(first)) return undefined;
	const message = first.message;
	if (isRecord(message) && typeof message.content === "string") return message.content;
	if (typeof first.text === "string") return first.text;
	return undefined;
}

function classifyNetworkReason(error: unknown): string {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	if (message.includes("certificate") || message.includes("tls") || message.includes("ssl")) {
		return "classifier_tls_error";
	}
	return "classifier_network_error";
}

function elapsed(started: number): number {
	return Math.max(0, Date.now() - started);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
	if (typeof DOMException === "function") {
		return new DOMException("This operation was aborted", "AbortError");
	}
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String((error as { name?: unknown }).name) : "";
	return name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
