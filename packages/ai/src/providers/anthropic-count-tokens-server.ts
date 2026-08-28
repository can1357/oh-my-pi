/**
 * Anthropic Messages count_tokens handler for the auth-gateway.
 *
 * Token counts are a documented character estimate
 * (`ceil(JSON.stringify(messages).length / 4)`), not tiktoken or Anthropic's
 * tokenizer. Unknown models 404; invalid JSON 400.
 *
 * @see https://docs.anthropic.com/en/api/messages-count-tokens
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { json } from "../auth-gateway/http";

/**
 * Estimate input tokens from the serialized `messages` payload.
 * Character/4 ceiling — not tiktoken.
 */
function estimateInputTokens(messages: unknown): number {
	const serialized = JSON.stringify(messages) ?? "";
	return Math.ceil(serialized.length / 4);
}

export async function handleCountTokens(
	req: Request,
	resolveModel: (id: string) => { contextWindow?: number } | undefined,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await req.text());
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}

	if (!isRecord(parsed)) {
		return json(400, { error: "Invalid JSON body: expected an object" });
	}

	const modelId = typeof parsed.model === "string" ? parsed.model : "";
	if (resolveModel(modelId) === undefined) {
		return json(404, { error: `Unknown model: ${modelId}` });
	}

	return json(200, { input_tokens: estimateInputTokens(parsed.messages) });
}
