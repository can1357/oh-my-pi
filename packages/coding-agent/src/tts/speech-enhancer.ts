/**
 * Enhanced speech rewriting (`speech.enhanced`): turn assistant markdown into
 * natural spoken prose with the tiny/smol model before synthesis.
 *
 * Two pieces:
 * - {@link BlockAccumulator} — fence-aware paragraph splitter over the raw
 *   streaming deltas. Blocks are blank-line-delimited; a fenced code block
 *   never splits, and an idle-time {@link BlockAccumulator.flushPartial} while
 *   inside a fence stays silent so half a code block is never sent to the
 *   rewriter.
 * - {@link SpeechEnhancer} — the per-session rewrite service the event
 *   controller hands to the vocalizer. Resolves the tiny/smol role (same chain
 *   as the auto-thinking classifier), sends one bounded completion per block,
 *   and returns null on any failure or timeout so the caller falls back to the
 *   mechanical {@link SpeakableStream} cleanup — speech never blocks on the
 *   model.
 */
import { type AssistantMessage, completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import speechRewritePrompt from "../prompts/system/speech-rewrite.md" with { type: "text" };

const SYSTEM_PROMPT = prompt.render(speechRewritePrompt);
// Rewrite budget: a paragraph in, a spoken paragraph (usually shorter) out.
// Always reserve enough room to survive backends that ignore `disableReasoning`
// (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` but still emitting
// thinking). `maxTokens` is a hard cap — non-thinking completions still return
// in a normal spoken-paragraph budget (issue #4355).
const ANSWER_MAX_TOKENS = 1536;
/** Per-block completion deadline before falling back to mechanical cleanup. */
const REWRITE_TIMEOUT_MS = 6000;
/** Bound block characters sent to the model (huge diffs/code dumps get elided). */
const MAX_BLOCK_CHARS = 4000;

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

	/**
	 * Rewrite `block` for speech. Returns the spoken text (empty string when
	 * the model judged the block unspeakable — pure code/markup), or null when
	 * the rewrite failed, timed out, or no model/key resolved; the caller then
	 * falls back to mechanical normalization.
	 */
	async rewrite(block: string, signal?: AbortSignal): Promise<string | null> {
		try {
			const { settings, registry, sessionId } = this.#deps;
			// `@tiny` expands a configured `modelRoles.tiny` and otherwise falls
			// through tiny's alias to the smol priority chain — unlike bare role
			// lookup, this resolves even with no roles configured.
			const model = resolveModelRoleValue("@tiny", registry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model;
			if (!model) return null;
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) return null;
			// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
			const metadata = this.#deps.metadataResolver?.(model.provider);
			const response = await retryTransientCompletion(
				() => {
					const timeout = AbortSignal.timeout(REWRITE_TIMEOUT_MS);
					return completeSimple(
						model,
						{
							systemPrompt: [SYSTEM_PROMPT],
							messages: [{ role: "user", content: boundBlock(block), timestamp: Date.now() }],
						},
						{
							apiKey: registry.resolver(model, sessionId),
							maxTokens: ANSWER_MAX_TOKENS,
							disableReasoning: true,
							metadata,
							signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
						},
					);
				},
				{ signal },
			);
			if (response.stopReason === "error") {
				logger.debug("speech-enhancer: rewrite errored", { error: response.errorMessage });
				return null;
			}
			return extractText(response.content);
		} catch (error) {
			if (!signal?.aborted) {
				logger.debug("speech-enhancer: rewrite failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return null;
		}
	}
}

/** Elide the middle of an oversized block so the prompt stays bounded. */
function boundBlock(block: string): string {
	if (block.length <= MAX_BLOCK_CHARS) return block;
	const half = MAX_BLOCK_CHARS / 2;
	return `${block.slice(0, half)}\n… (elided) …\n${block.slice(-half)}`;
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
