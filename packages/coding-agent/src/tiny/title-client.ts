/**
 * Title-generation policy over the shared tiny-model worker client.
 *
 * Worker transport, model lifecycle, and generic completion behavior live in
 * `model-client.ts`; this facade keeps only the title prompt and output policy.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { formatTitleUserMessage } from "./message-preproc";
import { isTinyTitleLocalModelKey } from "./models";
import { tinyModelClient, type TinyModelClient } from "./model-client";
import { normalizeGeneratedTitle } from "./text";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt, { includeExamples: false });

/**
 * Per-request controls for {@link TinyTitleClient.generate}.
 *
 * Carries the optional abort signal and title-system-prompt override used by
 * callers that customize automatic session-title generation.
 */
export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

function extractTinyTitle(text: string, sourceText: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	// Self-closing tag: <title/> or <title /> (only when the prefill is present).
	if (titleStart >= 0 && /^\s*\/>/.test(withoutPrefix)) return null;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag, sourceText);
}

export class TinyTitleClient {
	#client: Pick<TinyModelClient, "complete" | "prewarm">;

	constructor(client: Pick<TinyModelClient, "complete" | "prewarm"> = tinyModelClient) {
		this.#client = client;
	}

	prewarm(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey)) return;
		this.#client.prewarm(modelKey);
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;
		const text = await this.#client.complete(modelKey, formatTitleUserMessage(message), {
			maxTokens: TITLE_MAX_NEW_TOKENS,
			prefill: TITLE_PREFILL,
			signal: options.signal,
			stop: TITLE_CLOSE,
			systemPrompt: options.systemPrompt?.trim() || TINY_TITLE_SYSTEM_PROMPT,
		});
		return text ? extractTinyTitle(text, message) : null;
	}
}

export const tinyTitleClient = new TinyTitleClient(tinyModelClient);
