/**
 * {@link TextBackend} over a chat model: the bridge that lets any smol/tiny
 * LLM serve {@link TextJudge} when no native judgment provider is configured.
 */
import * as AIError from "../error";
import { retryTransientCompletion } from "../oneshot-retry";
import { completeSimple } from "../stream";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "../types";
import type { TextBackend, TextCompletion, TextPrompt } from "./text";
import type { JudgeOptions } from "./types";

/**
 * Output budget for keyword replies. Sized against two independent constraints:
 *   - Backends that ignore `disableReasoning` still emit a thinking preamble
 *     (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` but still thinking;
 *     Anthropic via LiteLLM/Vertex, whose `openai-completions` route downgrades a
 *     disabled request to the lowest reasoning effort instead of turning thinking
 *     off). The keyword must have room to land after that preamble (issue #4355).
 *   - Anthropic-dialect proxies reject `max_tokens <= thinking.budget_tokens`. The
 *     pinned lowest effort maps to at least Anthropic's 1024-token minimum budget,
 *     so the cap MUST comfortably exceed 1024 or every call 400s with
 *     `max_tokens must be greater than thinking.budget_tokens` (issue #8610).
 * `maxTokens` is a hard cap — non-thinking completions still return in a handful
 * of tokens.
 */
export const JUDGMENT_CHAT_MAX_TOKENS = 4096;

export type ChatTextBackendOptions = Pick<SimpleStreamOptions, "apiKey" | "sessionId" | "metadata"> & {
	/** Receives every completed attempt (including transient failures) for usage accounting. */
	onAttempt?: (message: AssistantMessage) => void;
};

/** Chat completions with reasoning disabled, temperature 0, and transient-failure retry. */
export function chatTextBackend(model: Model<Api>, options: ChatTextBackendOptions): TextBackend {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		async complete(prompt: TextPrompt, judge: JudgeOptions): Promise<TextCompletion> {
			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						model,
						{
							systemPrompt: [prompt.system],
							messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
						},
						{
							apiKey: options.apiKey,
							sessionId: options.sessionId,
							metadata: options.metadata,
							maxTokens: JUDGMENT_CHAT_MAX_TOKENS,
							temperature: 0,
							disableReasoning: true,
							signal: judge.signal,
							onAttempt: options.onAttempt,
						},
					),
				{ signal: judge.signal, provider: model.provider },
			);
			if (response.stopReason === "aborted" || judge.signal?.aborted) {
				throw judge.signal?.reason instanceof Error
					? judge.signal.reason
					: new AIError.AbortError("judgment: completion aborted");
			}
			if (response.stopReason === "error") {
				throw new AIError.ProviderResponseError(response.errorMessage ?? "unknown error", {
					provider: model.provider,
				});
			}
			let text = "";
			for (const block of response.content) {
				if (block.type === "text") text += (text ? " " : "") + block.text;
			}
			return { text: text.trim(), usage: response.usage };
		},
	};
}
