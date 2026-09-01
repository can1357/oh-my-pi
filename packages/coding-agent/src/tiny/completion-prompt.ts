import type { TextGenerationPipeline } from "@huggingface/transformers";

export function buildCompletionPrompt(
	tokenizer: TextGenerationPipeline["tokenizer"],
	promptText: string,
	systemPrompt?: string,
): string {
	const userMessage = { role: "user", content: promptText };
	const chat = systemPrompt?.trim() ? [{ role: "system", content: systemPrompt.trim() }, userMessage] : [userMessage];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${tokenizer.apply_chat_template(chat, chatTemplateOptions)}`;
}
