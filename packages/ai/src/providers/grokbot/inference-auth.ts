import * as fs from "node:fs/promises";
import {
	getAccessTokenExpiryMs,
	GROKBOT_INFERENCE_AUTHENTICATION_HEADER,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { ConfigurationError } from "../../error";
import type { GrokbotInferenceRequestContext, StreamOptions } from "../../types";
export {
	GROKBOT_INFERENCE_AUTHENTICATION_HEADER,
	grokbotMetadataHeaders,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";

export async function resolveGrokbotInferenceRequestContext(
	options: StreamOptions,
): Promise<GrokbotInferenceRequestContext | undefined> {
	const source = options.grokbotInferenceRequestContext;
	if (typeof source !== "function") return source;
	try {
		return await source();
	} catch {
		throw new ConfigurationError("Grok Bot inference context supplier failed");
	}
}

export function grokbotInferenceContextHeaders(
	context: GrokbotInferenceRequestContext | undefined,
): Record<string, string> {
	if (!context) return {};
	const headers: Record<string, string> = {
		"x-cursor-workload": context.workload,
		"x-cursor-workload-job-id": context.jobId,
		"x-cursor-workload-user": context.user,
	};
	if (context.trafficType) headers["x-cursor-traffic-type"] = context.trafficType;
	if (context.provider429RetryPolicy) headers["x-cursor-provider-429-retry-policy"] = context.provider429RetryPolicy;
	if (Object.values(headers).some(value => !value || /[\r\n\0]/.test(value))) {
		throw new ConfigurationError("Invalid Grok Bot inference workload context");
	}
	return headers;
}

async function consumeTokenFile(file: string): Promise<string> {
	// Atomic claim prevents two concurrent requests from reading the same secret.
	const claimed = `${file}.omp-attestation-${crypto.randomUUID()}`;
	try {
		await fs.rename(file, claimed);
	} catch {
		throw new ConfigurationError("Grok Bot inference attestation file is unavailable or already consumed");
	}
	try {
		return await Bun.file(claimed).text();
	} catch {
		throw new ConfigurationError("Could not read the Grok Bot inference attestation file");
	} finally {
		await fs.unlink(claimed);
	}
}

/** Resolve optional caller-issued workload authorization. Token reuse rules belong to its issuer. */
export async function takeGrokbotInferenceAuthenticationJwt(
	options: Pick<StreamOptions, "grokbotInferenceAuthenticationJwt" | "grokbotInferenceAuthenticationJwtFile">,
	headers: Record<string, string>,
	env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
	const source = options.grokbotInferenceAuthenticationJwt;
	let token: string | undefined;
	if (typeof source === "function") {
		try {
			token = await source();
		} catch {
			throw new ConfigurationError("Grok Bot inference attestation supplier failed");
		}
		if (!token?.trim()) throw new ConfigurationError("Grok Bot inference attestation supplier returned no token");
	} else if (typeof source === "string") {
		token = source;
	} else if (options.grokbotInferenceAuthenticationJwtFile) {
		token = await consumeTokenFile(options.grokbotInferenceAuthenticationJwtFile);
	} else if (source !== null && env.INFERENCE_PROXY_JWT) {
		token = env.INFERENCE_PROXY_JWT;
	} else if (source !== null && env.GROKBOT_INFERENCE_AUTHENTICATION_JWT_FILE) {
		token = await consumeTokenFile(env.GROKBOT_INFERENCE_AUTHENTICATION_JWT_FILE);
	} else {
		token = Object.entries(headers).find(
			([key]) => key.toLowerCase() === GROKBOT_INFERENCE_AUTHENTICATION_HEADER,
		)?.[1];
	}
	if (token === undefined) return undefined;
	token = token.trim();
	if (!token || /[\r\n\0]/.test(token)) throw new ConfigurationError("Invalid Grok Bot inference attestation token");
	const now = Date.now();
	const expiry = getAccessTokenExpiryMs(token);
	if (expiry !== null && expiry <= now) throw new ConfigurationError("Grok Bot inference attestation token expired");
	return token;
}
