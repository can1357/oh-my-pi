/**
 * Wire contract of OpenAI "Sign in with ChatGPT" token sharing
 * (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
 *
 * A credential minted by that login is a bearer for the regular
 * `POST https://api.openai.com/v1/responses`, but the route admits only a
 * subset of the Responses API: nothing may be stored server-side, there is no
 * `previous_response_id` chaining, and a list of request fields is rejected.
 * The credential is recognised by the `scope` claim of the access token, so the
 * contract follows the key whatever model or base URL it is used with.
 */
import { decodeJwtPayload } from "../registry/engine/common";

/** Scope that lets a third-party agent spend the ChatGPT subscription directly. */
export const CHATGPT_TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";

/** Request fields the token-sharing route rejects (`subscription_sharing_unsupported_capability`). */
const UNSUPPORTED_PARAMS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"previous_response_id",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"stream_options",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
] as const;

/** Whether `apiKey` is an access token granted ChatGPT token sharing. */
export function isChatGPTTokenSharingKey(apiKey: string | undefined): boolean {
	if (!apiKey) return false;
	const scope = decodeJwtPayload(apiKey)?.scope;
	return typeof scope === "string" && scope.split(" ").includes(CHATGPT_TOKEN_SHARING_SCOPE);
}

/** Shapes a Responses request body to what the token-sharing route admits. */
export function applyChatGPTTokenSharingParams(params: object): void {
	for (const key of UNSUPPORTED_PARAMS) Reflect.deleteProperty(params, key);
	Reflect.set(params, "store", false);
	Reflect.set(params, "stream", true);
}
