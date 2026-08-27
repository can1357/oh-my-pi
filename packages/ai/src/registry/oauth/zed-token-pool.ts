import { ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "@oh-my-pi/pi-catalog/wire/zed";
import { ProviderHttpError } from "../../error/classes";
import { OAuthError } from "../../error/oauth";
import { ProviderResponseError } from "../../error/provider";
import type { FetchImpl } from "../../types";

interface CachedLlmToken {
	token: string;
	expiresAt: number;
}

const tokenCache = new Map<string, CachedLlmToken>();
const inFlightRequests = new Map<string, Promise<string>>();

const TOKEN_SAFETY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes safety margin
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour token lifetime

function getCacheKey(userId: string, masterAccessToken: string): string {
	return `${userId}:${masterAccessToken}`;
}

/**
 * Mint or retrieve a cached short-lived LLM API token from Zed Cloud.
 * Uses a single-flight mutex per credential pair to prevent redundant concurrent token minting.
 */
export async function getOrMintZedLlmToken(
	userId: string,
	masterAccessToken: string,
	signal?: AbortSignal,
	fetchImpl?: FetchImpl,
): Promise<string> {
	const key = getCacheKey(userId, masterAccessToken);
	const existing = tokenCache.get(key);

	if (existing && Date.now() < existing.expiresAt - TOKEN_SAFETY_WINDOW_MS) {
		return existing.token;
	}

	const inFlight = inFlightRequests.get(key);
	if (inFlight) {
		return inFlight;
	}

	const fetcher = fetchImpl ?? fetch;
	const mintPromise = (async () => {
		try {
			const response = await fetcher(`${ZED_CLOUD_URL}/client/llm_tokens`, {
				method: "POST",
				headers: {
					Authorization: `${userId} ${masterAccessToken}`,
					"Content-Type": "application/json",
					[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
				},
				body: JSON.stringify({ organization_id: null }),
				signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				if (response.status === 401) {
					throw new OAuthError(`Zed Cloud authentication failed (HTTP 401): invalid master credentials. ${body}`, {
						kind: "configuration",
						provider: "zed-agent",
					});
				}
				if (response.status === 402) {
					throw new ProviderHttpError(
						`Zed Pro subscription required or monthly quota exhausted (HTTP 402). ${body}`,
						402,
					);
				}
				throw new ProviderHttpError(
					`Failed to mint Zed LLM token: HTTP ${response.status} ${body}`,
					response.status,
				);
			}

			const data = (await response.json()) as { token?: string };
			if (!data?.token) {
				throw new ProviderResponseError("Zed Cloud returned missing or empty LLM token.", {
					kind: "envelope",
				});
			}

			tokenCache.set(key, {
				token: data.token,
				expiresAt: Date.now() + DEFAULT_TTL_MS,
			});

			return data.token;
		} finally {
			inFlightRequests.delete(key);
		}
	})();

	inFlightRequests.set(key, mintPromise);
	return mintPromise;
}

/**
 * Invalidate cached LLM token (invoked on 401 or x-zed-expired-token).
 */
export function invalidateZedLlmToken(userId: string, masterAccessToken: string): void {
	const key = getCacheKey(userId, masterAccessToken);
	tokenCache.delete(key);
	inFlightRequests.delete(key);
}
