import type { TextGenerationPipeline } from "@huggingface/transformers";

const GENERATION_STATEMENT = /{%-?\s*(?:endgeneration|generation)\s*-?%}/g;

interface TextChatTemplateOptions {
	addGenerationPrompt: boolean;
	enableThinking: boolean;
}

/**
 * Render a text chat after removing generation-mask statements unsupported by
 * the Transformers.js CommonJS template parser.
 */
export function renderTextChatTemplate(
	tokenizer: TextGenerationPipeline["tokenizer"],
	messages: readonly { role: string; content: string }[],
	options: TextChatTemplateOptions,
): string {
	const source: unknown = tokenizer.get_chat_template();
	const chatTemplate = typeof source === "string" ? source.replace(GENERATION_STATEMENT, "") : undefined;
	const templateOptions: {
		chat_template?: string;
		add_generation_prompt: boolean;
		tokenize: false;
		enable_thinking: boolean;
	} = {
		...(chatTemplate === undefined ? {} : { chat_template: chatTemplate }),
		add_generation_prompt: options.addGenerationPrompt,
		tokenize: false,
		enable_thinking: options.enableThinking,
	};
	return tokenizer.apply_chat_template([...messages], templateOptions);
}
