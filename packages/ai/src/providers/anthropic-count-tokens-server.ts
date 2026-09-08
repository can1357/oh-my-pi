/**
 * Anthropic Messages count_tokens handler for the auth-gateway.
 *
 * Token counts are a documented character estimate
 * (`ceil(JSON.stringify(payload).length / 4)`), not tiktoken or Anthropic's
 * tokenizer. Unknown models 404; invalid JSON / malformed `messages` 400.
 *
 * @see https://docs.anthropic.com/en/api/messages-count-tokens
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { json } from "../auth-gateway/http";

/**
 * Estimate input tokens from serialized Anthropic input fields.
 * Character/4 ceiling — not tiktoken.
 */
function estimateInputTokens(payload: unknown): number {
	const serialized = JSON.stringify(payload) ?? "";
	return Math.ceil(serialized.length / 4);
}

export async function handleCountTokens(
	req: Request,
	resolveModel: (id: string) => { contextWindow?: number | null } | undefined,
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

	if (!("messages" in parsed) || !Array.isArray(parsed.messages)) {
		return json(400, { error: "messages must be an array" });
	}

	const estimatePayload: Record<string, unknown> = { messages: parsed.messages };
	if ("system" in parsed) estimatePayload.system = parsed.system;
	if ("tools" in parsed) estimatePayload.tools = parsed.tools;
	if ("tool_choice" in parsed) estimatePayload.tool_choice = parsed.tool_choice;

	return json(200, { input_tokens: estimateInputTokens(estimatePayload) });
}
