import { classifyModel } from "../compat/taxonomy";

export type Dialect =
	| "glm"
	| "hermes"
	| "kimi"
	| "xml"
	| "anthropic"
	| "deepseek"
	| "harmony"
	| "qwen3"
	| "gemini"
	| "gemma"
	| "minimax"
	| "minicpm5";

export const FALLBACK_DIALECT: Dialect = "xml";

export function preferredDialect(modelId: string): Dialect {
	switch (classifyModel("", modelId, { lenient: true }).class) {
		case "anthropic":
			return "anthropic";
		case "glm":
			return "glm";
		case "gemini":
			return "gemini";
		case "gemma":
			return "gemma";
		case "kimi":
			return "kimi";
		case "qwen":
			return "qwen3";
		case "deepseek":
			return "deepseek";
		case "minimax":
			return "minimax";
		case "minicpm5":
			return "minicpm5";
		case "openai":
		case "gpt-oss":
			return "harmony";
		default:
			return FALLBACK_DIALECT;
	}
}
