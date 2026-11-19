import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";

import { getDiagnostics } from "./diagnostics";
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_TEMPLATE } from "./prompts";

export const DEFAULT_EXTRACTION_MODEL = process.env.MNEMOPI_EXTRACTION_MODEL || "google/gemini-2.5-flash";
export const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
	/\/+$/,
	"",
);
export const FALLBACK_MODELS = ["google/gemini-flash-latest"] as const;
const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;
const FALLBACK_MODEL_DELAY_MS = 1_000;

export interface ChatMessage {
	role: string;
	content: string;
}

export interface ExtractedFact {
	subject?: string;
	predicate?: string;
	object?: string;
	timestamp?: string;
	source?: number;
	confidence?: number;
	[key: string]: unknown;
}

export interface ExtractionClientOptions {
	model?: string | null;
	apiKey?: ApiKey | null;
	baseUrl?: string | null;
	fetch?: FetchImpl;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function authHeader(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey !== "") {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

export class ExtractionClient {
	model: string;
	apiKey: ApiKey;
	baseUrl: string;
	callCount = 0;
	private readonly fetchImpl: FetchImpl;

	constructor(opts: ExtractionClientOptions = {}) {
		this.model = opts.model || DEFAULT_EXTRACTION_MODEL;
		this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
		this.baseUrl = (opts.baseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = opts.fetch ?? fetch;
	}

	async chat(messages: readonly ChatMessage[], temperature = 0, maxTokens = 4096): Promise<string> {
		const diag = getDiagnostics();
		diag.recordAttempt("cloud");
		const models = [this.model, ...FALLBACK_MODELS.filter(m => m !== this.model)];
		let lastError: unknown = null;

		for (const model of models) {
			try {
				// withAuth re-resolves the key on 401/usage-limit (force-refresh,
				// then sibling rotation) when `apiKey` is a resolver; the 429
				// backoff loop stays inside the attempt so rate-limit retries
				// reuse the already-resolved key.
				const result = await withAuth(this.apiKey, async key => {
					let rateLimitError: unknown = null;
					for (let attempt = 0; attempt < 3; attempt += 1) {
						try {
							return await this.callApi(model, messages, temperature, maxTokens, key);
						} catch (exc) {
							const flags = AIError.classify(exc);
							if (AIError.is(flags, AIError.Flag.UsageLimit) || AIError.is(flags, AIError.Flag.Transient)) {
								rateLimitError = exc;
								await sleep(Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2 ** attempt));
								continue;
							}
							throw exc;
						}
					}
					throw rateLimitError;
				});
				if (result === "") {
					diag.recordNoOutput("cloud");
				}
				return result;
			} catch (exc) {
				lastError = exc;
			}
			await sleep(FALLBACK_MODEL_DELAY_MS);
		}

		diag.recordFailure("cloud", lastError, "all_models_failed");
		return "";
	}

	async callApi(
		model: string,
		messages: readonly ChatMessage[],
		temperature: number,
		maxTokens: number,
		apiKey = "",
	): Promise<string> {
		const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: authHeader(apiKey),
			body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
			signal: AbortSignal.timeout(60000),
		});
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`.trim());
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		this.callCount += 1;
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	}

	async extractFacts(messages: readonly ChatMessage[]): Promise<ExtractedFact[]> {
		let conversationText = "";
		for (let i = 0; i < messages.length; i += 1) {
			const msg = messages[i];
			if (msg === undefined) continue;
			const content = msg.content.trim();
			if (content !== "") {
				conversationText += `[${i}] [${msg.role || "unknown"}]: ${content}\n`;
			}
		}
		if (conversationText.trim() === "") {
			return [];
		}

		const userPrompt = EXTRACTION_USER_TEMPLATE.replace("{conversation_text}", conversationText);
		const response = await this.chat(
			[
				{ role: "system", content: EXTRACTION_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			0,
			4096,
		);

		const diag = getDiagnostics();
		if (response === "") {
			diag.recordCall({ succeeded: false, allEmpty: true });
			return [];
		}

		try {
			const jsonStart = response.indexOf("[");
			const jsonEnd = response.lastIndexOf("]") + 1;
			if (jsonStart >= 0 && jsonEnd > jsonStart) {
				const facts = JSON.parse(response.slice(jsonStart, jsonEnd)) as unknown;
				if (Array.isArray(facts)) {
					diag.recordSuccess("cloud", facts.length);
					diag.recordCall({ succeeded: true });
					return facts as ExtractedFact[];
				}
			}
			diag.recordFailure("cloud", undefined, "no_facts_in_response");
			diag.recordCall({ succeeded: false, allEmpty: true });
		} catch (exc) {
			diag.recordFailure("cloud", exc, "json_parse_failed");
			diag.recordCall({ succeeded: false });
		}
		return [];
	}

	xtractFacts(messages: readonly ChatMessage[]): Promise<ExtractedFact[]> {
		return this.extractFacts(messages);
	}
}
