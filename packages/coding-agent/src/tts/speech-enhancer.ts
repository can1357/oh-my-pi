/**
 * Enhanced speech rewriting and end-of-turn digests use a tiny/smol model.
 *
 * - {@link BlockAccumulator} groups streaming deltas into markdown paragraphs
 *   for natural read-aloud.
 * - {@link SpeechEnhancer} rewrites those blocks or summarizes a completed
 *   reply. Both paths use bounded completions and return null on failure so
 *   callers can fall back to mechanical cleanup or the original reply.
 */
import { type AssistantMessage, completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { roleCandidatePool } from "../config/model-roles";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import speechDigestPrompt from "../prompts/system/speech-digest.md" with { type: "text" };
import speechRewritePrompt from "../prompts/system/speech-rewrite.md" with { type: "text" };

const SYSTEM_PROMPT = prompt.render(speechRewritePrompt);
const DIGEST_SYSTEM_PROMPT = prompt.render(speechDigestPrompt);
const ANSWER_MAX_TOKENS = 1536;
const DIGEST_MAX_TOKENS = 128;
/** Per-completion deadline before falling back to the unmodified response. */
const REWRITE_TIMEOUT_MS = 6000;
const DIGEST_TIMEOUT_MS = 6000;
/** Bound prompt sizes; long texts retain both their opening and conclusion. */
const MAX_BLOCK_CHARS = 4000;
const MAX_DIGEST_CHARS = 12000;

/** Session-scoped dependencies; mirrors the auto-thinking classifier's deps. */
export interface SpeechEnhancerDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}

/**
 * Rewrites one markdown block into spoken prose via the tiny/smol role.
 * Constructed per session by the event controller and handed to the vocalizer.
 */
export class SpeechEnhancer {
	#deps: SpeechEnhancerDeps;

	constructor(deps: SpeechEnhancerDeps) {
		this.#deps = deps;
	}

	/** Rewrite one markdown block into spoken prose. Null means mechanical TTS cleanup. */
	rewrite(block: string, signal?: AbortSignal): Promise<string | null> {
		return this.#complete(
			block,
			SYSTEM_PROMPT,
			ANSWER_MAX_TOKENS,
			REWRITE_TIMEOUT_MS,
			MAX_BLOCK_CHARS,
			"rewrite",
			signal,
		);
	}

	/** Condense a completed assistant reply for read-aloud. Null means speak the original reply. */
	async summarize(text: string, signal?: AbortSignal): Promise<string | null> {
		const summary = await this.#complete(
			text,
			DIGEST_SYSTEM_PROMPT,
			DIGEST_MAX_TOKENS,
			DIGEST_TIMEOUT_MS,
			MAX_DIGEST_CHARS,
			"digest",
			signal,
		);
		return summary?.trim() ?? null;
	}

	async #complete(
		text: string,
		systemPrompt: string,
		maxTokens: number,
		timeoutMs: number,
		maxInputChars: number,
		operation: "rewrite" | "digest",
		signal?: AbortSignal,
	): Promise<string | null> {
		try {
			const { settings, registry, sessionId } = this.#deps;
			const model = resolveModelRoleValue("@tiny", roleCandidatePool("tiny", settings, registry), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model;
			if (!model) return null;
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) return null;
			// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
			const metadata = this.#deps.metadataResolver?.(model.provider);
			const timeout = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						model,
						{
							systemPrompt: [systemPrompt],
							messages: [{ role: "user", content: boundText(text, maxInputChars), timestamp: Date.now() }],
						},
						{
							apiKey: registry.resolver(model, sessionId),
							sessionId,
							maxTokens,
							disableReasoning: true,
							metadata,
							signal: requestSignal,
						},
					),
				{ signal: requestSignal, provider: model.provider },
			);
			if (response.stopReason === "error") {
				logger.debug(`speech-enhancer: ${operation} errored`, { error: response.errorMessage });
				return null;
			}
			return extractText(response.content);
		} catch (error) {
			if (!signal?.aborted) {
				logger.debug(`speech-enhancer: ${operation} failed`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return null;
		}
	}
}

/** Elide the middle of oversized input while preserving its opening and conclusion. */
function boundText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.floor((maxChars - 20) / 2);
	return `${text.slice(0, half)}\n… (middle elided) …\n${text.slice(-half)}`;
}

/**
 * Fence-aware paragraph accumulator over raw streaming deltas. One instance
 * per utterance.
 */
export class BlockAccumulator {
	/** Complete lines of the block being accumulated. */
	#lines: string[] = [];
	/** Trailing characters of the current, still-incomplete line. */
	#partial = "";
	/** Opening fence chars while inside a code block, else null. */
	#fence: string | null = null;
	/** Index into {@link #lines} where the open fence started (drop point for a truncated fence). */
	#fenceStart = 0;

	/** Feed a delta; returns the blocks it completed, in order. */
	push(delta: string): string[] {
		const out: string[] = [];
		let text = this.#partial + delta;
		for (;;) {
			const nl = text.indexOf("\n");
			if (nl === -1) break;
			const line = text.slice(0, nl);
			text = text.slice(nl + 1);
			this.#consumeLine(line, out);
		}
		this.#partial = text;
		return out;
	}

	/**
	 * Message end: drain everything. An unterminated code fence is dropped from
	 * its opening line onward (a truncated block is never worth speaking); the
	 * prose before it still comes out.
	 */
	flush(): string | null {
		if (this.#partial.length > 0) {
			this.#lines.push(this.#partial);
			this.#partial = "";
		}
		if (this.#fence !== null) {
			this.#lines.length = this.#fenceStart;
			this.#fence = null;
		}
		return this.#take();
	}

	/**
	 * Generation stalled: drain the pending partial block — unless we are
	 * inside a code fence, where the only thing buffered is code and speaking
	 * or rewriting half a fence would re-introduce vocalized code. Fence state
	 * is preserved so the eventual closing fence still matches.
	 */
	flushPartial(): string | null {
		if (this.#fence !== null) return null;
		if (this.#partial.length > 0) {
			this.#lines.push(this.#partial);
			this.#partial = "";
		}
		return this.#take();
	}

	#consumeLine(line: string, out: string[]): void {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (this.#fence === null && fence !== undefined) {
			this.#fence = fence.slice(0, 3);
			this.#fenceStart = this.#lines.length;
		} else if (this.#fence !== null && fence?.startsWith(this.#fence)) {
			this.#fence = null;
		}
		if (this.#fence === null && fence === undefined && line.trim().length === 0) {
			const block = this.#take();
			if (block !== null) out.push(block);
			return;
		}
		this.#lines.push(line);
	}

	#take(): string | null {
		if (this.#lines.length === 0) return null;
		const block = this.#lines.join("\n");
		this.#lines = [];
		return block;
	}
}
