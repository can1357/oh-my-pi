/** Provider-native AI Gateway prefix before the upstream route segment. */
export const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>";
/** Anthropic Messages passthrough endpoint. */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/anthropic`;
/** OpenAI Responses passthrough endpoint. */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/openai`;
/** OpenAI-compatible Workers AI endpoint. */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/compat`;
