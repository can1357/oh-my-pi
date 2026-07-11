/**
 * MiniMax Token Plan login flow.
 *
 * MiniMax Token Plan is a subscription service that provides access to
 * MiniMax models (M2 and newer) through an OpenAI-compatible API.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to the matching regional MiniMax subscription page
 * 2. User subscribes and copies their API key
 * 3. User pastes the API key back into the CLI
 *
 * International: https://api.minimax.io/v1
 * China: https://api.minimaxi.com/v1
 */

import { createApiKeyLogin } from "../api-key-login";

const AUTH_URL_INTL = "https://platform.minimax.io/subscribe/token-plan";
const AUTH_URL_CN = "https://platform.minimaxi.com/subscribe/token-plan";
const API_BASE_URL_INTL = "https://api.minimax.io/v1";
const API_BASE_URL_CN = "https://api.minimaxi.com/v1";
const VALIDATION_MODEL = "MiniMax-M3";

function createMiniMaxLogin(authUrl: string, baseUrl: string, provider: string) {
	return createApiKeyLogin({
		providerLabel: "MiniMax Token Plan",
		authUrl,
		instructions: "Subscribe to Token Plan and copy your API key",
		promptMessage: "Paste your MiniMax Token Plan API key",
		placeholder: "sk-...",
		validation: {
			kind: "chat-completions",
			provider,
			baseUrl,
			model: VALIDATION_MODEL,
		},
	});
}

/**
 * Login to MiniMax Token Plan (international).
 *
 * Opens browser to subscription page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginMiniMaxCode = createMiniMaxLogin(AUTH_URL_INTL, API_BASE_URL_INTL, "MiniMax Token Plan");

/**
 * Login to MiniMax Token Plan (China).
 *
 * Same flow as international but uses China endpoint.
 */
export const loginMiniMaxCodeCn = createMiniMaxLogin(AUTH_URL_CN, API_BASE_URL_CN, "MiniMax Token Plan (China)");
