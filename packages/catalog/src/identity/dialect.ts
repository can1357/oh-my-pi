import { modelFamilyToken } from "./family";

export type Dialect =
	| "glm"
	| "hermes"
	| "kimi"
	| "xml"
	| "anthropic"
	| "deepseek"
	| "harmony"
	| "pi"
	| "qwen3"
	| "gemini"
	| "gemma"
	| "minimax";

export const FALLBACK_DIALECT: Dialect = "xml";

export function preferredDialect(modelId: string): Dialect {
	switch (modelFamilyToken(modelId)) {
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
		case "openai":
		case "gpt-oss":
			return "harmony";
		default:
			return FALLBACK_DIALECT;
	}
}
