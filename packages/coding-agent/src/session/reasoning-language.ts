/**
 * Visible-reasoning language injection.
 *
 * OpenAI-compatible providers that replay raw chain of thought (DeepSeek, Kimi,
 * GLM, …) stream their actual reasoning back, so the language of OMP's thinking
 * blocks is whatever the model chose to think in — and the default prompt is
 * English. Asking for another language from the stable system prompt is a weak
 * anchor: the instruction sits far from the turn, and once a turn's *first*
 * reasoning segment lands in English the rest of the turn usually follows it.
 *
 * This module injects a small `<reasoning-language>` block into the user turn at
 * request time instead — never stored in the session, never in the system prompt
 * or tool schemas. The shape mirrors Reasonix's `[agent] reasoning_language`
 * setting: the block lands the first reasoning segment in the preferred
 * language, and earlier turns keep their own blocks as the conversation grows.
 *
 * Injections are append-only. A user turn keeps the block it was first sent
 * with; a later request never rewrites an earlier turn, because mutating those
 * bytes would invalidate the provider's cached prefix from that message onwards
 * (#7404). The block text and the `auto` decision are pure functions of the
 * turn's own text, so this holds without threading state through the loop.
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import reasoningLanguageEnTemplate from "../prompts/system/reasoning-language-en.md" with { type: "text" };
import reasoningLanguageZhTemplate from "../prompts/system/reasoning-language-zh.md" with { type: "text" };

/** `off` injects nothing; `auto` follows a clearly Chinese user turn. */
export type ReasoningLanguage = "auto" | "off" | "zh" | "en";

const BLOCK_OPEN_TAG = "<reasoning-language>";

/**
 * Renders the transient block for a concrete language.
 *
 * The Chinese wording is imperative on purpose. Measured against softer
 * "prefer Chinese" phrasing, only the imperative form holds the first reasoning
 * segment on Chinese prompts that embed English logs or code — the wording and
 * the conclusion come from Reasonix, whose implementation reached the same
 * result.
 */
export function renderReasoningLanguageBlock(language: "zh" | "en"): string {
	return prompt.render(language === "zh" ? reasoningLanguageZhTemplate : reasoningLanguageEnTemplate).trim();
}

/** Two-Han-character turn stems that still identify a Chinese request. */
const CHINESE_REASONING_CUES = [
	"你好",
	"请",
	"帮我",
	"帮忙",
	"看看",
	"看下",
	"解释",
	"说明",
	"总结",
	"分析",
	"修复",
	"实现",
	"优化",
	"排查",
	"处理",
	"继续",
	"为什么",
	"怎么",
	"是否",
	"能否",
	"支持",
	"设置",
	"中文",
	"思考",
	"问题",
	"报错",
	"代码",
	"文件",
	"这个",
	"那个",
];

/**
 * `auto` follows the language of the user's own turn. Conservative on purpose: a
 * handful of Han characters is a clear signal, CJK punctuation lowers the bar,
 * and everything else — English, code, pasted logs, ambiguous input — leaves the
 * provider default alone rather than guessing.
 */
export function inferReasoningLanguage(source: string): "zh" | undefined {
	let han = 0;
	let cjkPunctuation = 0;
	for (let index = 0; index < source.length;) {
		const code = source.codePointAt(index)!;
		index += code > 0xffff ? 2 : 1;
		// Fast reject: ASCII, Latin, and Greek/Cyrillic blocks can never match.
		if (code < 0x3000) continue;
		if (
			(code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
			(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
			(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
			(code >= 0x20000 && code <= 0x2fa1f) // Extensions B–F and the compatibility supplement
		) {
			if (++han >= 4) return "zh";
		} else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
			cjkPunctuation++;
		}
	}
	// Short turns ("继续", "看下这个") are common follow-ups, so a cue word is an
	// explicit signal rather than a substring heuristic on arbitrary Han input.
	if (han < 2) return undefined;
	if (cjkPunctuation > 0) return "zh";
	return CHINESE_REASONING_CUES.some(cue => source.includes(cue)) ? "zh" : undefined;
}

/**
 * Keeps one reasoning-language block per user turn, append-only.
 *
 * Injected variants are keyed by identity, not by position or content: the agent
 * loop's `convertToLlm` memo hands back the same `Message` objects for settled
 * history, so an earlier turn rebuilds to byte-identical bytes on every
 * subsequent request while the newest turn still gets its own block.
 */
export class ReasoningLanguageInjector {
	#injections = new Map<Message, Message>();

	/** Apply the configured language to the newest user turn without disturbing earlier ones. */
	transform(context: Context, language: ReasoningLanguage): Context {
		if (language === "off") return context;
		const messages = context.messages;
		let target: UserMessage | undefined;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "user") {
				target = message;
				break;
			}
		}
		// Synthetic turns (auto-continue and friends) carry no user-authored
		// language, and a turn that already leads with the block keeps it as sent.
		if (target && !target.synthetic && !this.#injections.has(target)) {
			const content = target.content;
			let leadingText: string;
			let turnText = "";
			if (typeof content === "string") {
				leadingText = content;
				turnText = content;
			} else {
				leadingText = content[0]?.type === "text" ? content[0].text : "";
				for (const part of content) if (part.type === "text") turnText += part.text;
			}
			const concrete = language === "auto" ? inferReasoningLanguage(turnText) : language;
			if (!leadingText.startsWith(BLOCK_OPEN_TAG) && concrete) {
				const block = renderReasoningLanguageBlock(concrete);
				this.#injections.set(target, {
					...target,
					// Ahead of any image or referenced-file parts, so the language
					// instruction is the first thing the model reads.
					content:
						typeof content === "string" ? `${block}\n\n${content}` : [{ type: "text", text: block }, ...content],
				});
			}
		}
		if (this.#injections.size === 0) return context;

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const injected = this.#injections.get(message);
			if (injected) changed = true;
			out.push(injected ?? message);
		}
		return changed ? { ...context, messages: out } : context;
	}
}
