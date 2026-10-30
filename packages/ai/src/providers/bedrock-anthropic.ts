import { isRecord } from "@oh-my-pi/pi-utils";
import { extractClaudeMetadataSessionId } from "./anthropic-identity";
import { isBedrockRequestMetadataValue } from "./bedrock-request-metadata";

/**
 * Fit an Anthropic request body to Bedrock's Anthropic Messages API
 * (`compat.bedrockMessagesApi`): both `/anthropic` routes reject the tool
 * `strict` field, and bedrock-runtime rejects a `metadata.user_id` outside
 * Bedrock's request-metadata pattern. A user id that fits is kept, otherwise
 * its embedded session id, otherwise the metadata is dropped. Mutates and
 * returns `payload`.
 */
export function fitBedrockAnthropicPayload<T>(payload: T): T {
	if (!isRecord(payload)) return payload;
	const body: Record<string, unknown> = payload;
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (isRecord(tool)) delete tool.strict;
		}
	}
	if (body.metadata === undefined) return payload;
	const userId = isRecord(body.metadata) ? body.metadata.user_id : undefined;
	const fitted =
		typeof userId === "string" && isBedrockRequestMetadataValue(userId)
			? userId
			: extractClaudeMetadataSessionId(userId);
	if (fitted && isBedrockRequestMetadataValue(fitted)) body.metadata = { user_id: fitted };
	else delete body.metadata;
	return payload;
}
