import * as fs from "node:fs";
import * as tls from "node:tls";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { $env, isEnoent } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Api, Model } from "../types";
import { isFoundryEnabled } from "../utils/foundry";
import type { AnthropicFetchOptions } from "./anthropic-client";
import { normalizeAnthropicBaseUrl, resolveDirectAnthropicBaseUrl } from "./anthropic-state";
import { resolveGitHubCopilotBaseUrl } from "./github-copilot-headers";
import { isAnthropicMessagesModel } from "./transform-messages";

const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

const foundryTlsOptionsCache = new Map<string, FoundryTlsOptions | undefined>();

function foundryTlsCacheKeyComponent(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	// For path-valued vars, fold the file mtime into the key so on-disk cert
	// rotation (common for short-lived corporate mTLS certs) invalidates the
	// cached TLS options instead of pinning the first read forever.
	if (trimmed && !trimmed.includes("-----BEGIN") && looksLikeFilePath(trimmed)) {
		try {
			return `${trimmed}@${fs.statSync(trimmed).mtimeMs}`;
		} catch {
			return trimmed;
		}
	}
	return value;
}

function foundryTlsOptionsCacheKey(): string {
	return JSON.stringify([
		foundryTlsCacheKeyComponent($env.NODE_EXTRA_CA_CERTS),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_CERT),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_KEY),
	]);
}

export function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.compat.firstPartyProvider) return resolveDirectAnthropicBaseUrl(model);
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new AIError.ValidationError(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (!model.compat.firstPartyProvider) return undefined;
	if (!isFoundryEnabled()) return undefined;

	const cacheKey = foundryTlsOptionsCacheKey();
	if (foundryTlsOptionsCache.has(cacheKey)) return foundryTlsOptionsCache.get(cacheKey);

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new AIError.ConfigurationError(
			"Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.",
		);
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	const resolved = Object.keys(options).length > 0 ? options : undefined;
	foundryTlsOptionsCache.set(cacheKey, resolved);
	return resolved;
}

export function buildClaudeCodeTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicFetchOptions | undefined {
	if (!model.compat.firstPartyProvider) return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(CLAUDE_CODE_TLS_CIPHERS ? { ciphers: CLAUDE_CODE_TLS_CIPHERS } : {}),
			...foundryTlsOptions,
		},
	};
}

/**
 * Warm-up target for a first-party `anthropic` model: the effective official
 * API URL plus the TLS options real requests use (sockets pool per TLS
 * configuration, so a warm-up made with other options is never reused).
 * `undefined` when requests resolve elsewhere — `ANTHROPIC_BASE_URL` or
 * Foundry gateways never receive unsolicited probes.
 */
export function resolveAnthropicPrewarmTarget(model: Model<Api>): { url: string; init: RequestInit } | undefined {
	if (!isAnthropicMessagesModel(model)) return undefined;
	const baseUrl = resolveAnthropicBaseUrl(model) ?? "https://api.anthropic.com";
	if (!isOfficialAnthropicApiUrl(baseUrl)) return undefined;
	return { url: baseUrl, init: { ...buildClaudeCodeTlsFetchOptions(model, baseUrl) } };
}
