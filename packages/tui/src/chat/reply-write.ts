/**
 * Replies: text the agent sends to a scheme whose writes are `reply`-scoped (`out://`)
 * is its mid-turn message to the user, drawn as assistant prose so it can answer
 * without ending its turn.
 * - A `write` call to a reply URL draws as {@link ReplyWriteComponent}, streaming as the
 *   call's arguments arrive, instead of a tool card.
 * - Text a tool's commands write there (`printf … > out://` in bash) arrives in the
 *   tool's result `details.replies` ({@link toolResultReplies}); transcripts draw each
 *   one as a prose block after the call ({@link replyDisplayMessage}).
 */
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ImageBudget } from "../components/image";
import { internalUrlSchemeSpec, internalUrlSchemeSpecs, splitUrlScheme } from "../tools/url-scheme-host";
import { AssistantMessageComponent } from "./assistant-message";
import type { ToolExecutionHandle, ToolResultFrame } from "./tool-execution";

/**
 * Whether a `toolName` call writes to a reply URL. `undefined` while streamed args cannot tell yet:
 * no path so far, or a path that could still grow into a reply URL (`ou`, `out:/`). Callers holding
 * final args treat `undefined` as `false`.
 */
export function isReplyWrite(toolName: string, args: unknown): boolean | undefined {
	if (toolName !== "write") return false;
	if (!isRecord(args)) return undefined;
	const target = typeof args.path === "string" ? args.path : args.file_path;
	if (typeof target !== "string") return undefined;
	const url = splitUrlScheme(target);
	if (url) return internalUrlSchemeSpec(url.scheme)?.write?.scope === "reply";
	const lower = target.toLowerCase();
	for (const [scheme, spec] of internalUrlSchemeSpecs()) {
		if (spec.write?.scope === "reply" && `${scheme}://`.startsWith(lower)) return undefined;
	}
	return false;
}

/** Display options of a reply block; the rest of its presentation follows the assistant prose defaults. */
export interface ReplyWriteOptions {
	/** Repaint request for figures and images that finish loading after a render. */
	readonly requestRender?: () => void;
	readonly imageBudget?: ImageBudget;
	/** Resolved local destinations of Markdown links, as for assistant text. */
	readonly linkTargets?: ReadonlyMap<string, string>;
}

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Replies a tool result carries in `details.replies` (text its commands wrote to a reply URL), oldest first. */
export function toolResultReplies(details: unknown): readonly string[] {
	if (!isRecord(details) || !Array.isArray(details.replies)) return [];
	return details.replies.filter((reply): reply is string => typeof reply === "string");
}

/** Assistant message drawing reply text. No provider turn backs it, so its identity fields stay empty. */
export function replyDisplayMessage(text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "",
		provider: "",
		model: "",
		usage: NO_USAGE,
		stopReason: errorMessage === undefined ? "stop" : "error",
		errorMessage,
		timestamp: 0,
	};
}

/**
 * A reply write ({@link isReplyWrite}) drawn as assistant prose. The call's lifecycle arrives
 * through {@link ToolExecutionHandle}: streamed args grow the text, final args settle it, and
 * the result seals the block, a failure showing its error under the text. It is a reply, not
 * tool activity, so hiding tool activity leaves it on screen.
 */
export class ReplyWriteComponent extends AssistantMessageComponent implements ToolExecutionHandle {
	#text = "";
	#argsComplete = false;

	constructor(options: ReplyWriteOptions = {}) {
		super(undefined, false, options.requestRender, [], options.imageBudget, true, options.linkTargets);
	}

	updateArgs(args: unknown): void {
		const text = isRecord(args) && typeof args.content === "string" ? args.content : "";
		if (text === this.#text || this.isTranscriptBlockFinalized()) return;
		this.#text = text;
		this.#draw();
	}

	setArgsComplete(): void {
		if (this.#argsComplete || this.isTranscriptBlockFinalized()) return;
		this.#argsComplete = true;
		this.#draw();
	}

	setExecutionStarted(): void {}

	updateResult(result: ToolResultFrame, isPartial = false): void {
		if (isPartial || this.isTranscriptBlockFinalized()) return;
		this.#argsComplete = true;
		const error = result.isError
			? result.content
					.filter(block => block.type === "text")
					.map(block => block.text ?? "")
					.join("\n")
			: undefined;
		this.updateContent(replyDisplayMessage(this.#text, error));
		this.markTranscriptBlockFinalized();
	}

	parkAsBackground(): void {}

	seal(): void {
		this.markTranscriptBlockFinalized();
	}

	#draw(): void {
		this.updateContent(replyDisplayMessage(this.#text), { transient: !this.#argsComplete });
	}
}
