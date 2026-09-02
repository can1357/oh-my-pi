import * as AIError from "../error";
import type { OAuthController, OAuthProvider } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID: OAuthProvider = "openllm";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8787/v1";
const DEFAULT_LOCAL_TOKEN = "openllm-local";
const INSTALL_COMMAND = "curl -fsSL https://www.openllm.sh/install | bash";
const PROBE_TIMEOUT_MS = 3_000;

function resolveBaseUrl(): string {
	return Bun.env.OPENLLM_BASE_URL?.trim() || DEFAULT_LOCAL_BASE_URL;
}

/** True when something answers at `${baseUrl}/models`; auth failures still count as reachable. */
async function probeDaemon(baseUrl: string, options: OAuthController): Promise<boolean> {
	const fetchImpl = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, { signal });
		return response.ok || response.status === 401 || response.status === 403;
	} catch {
		return false;
	}
}

/**
 * Login to the local OpenLLM gateway.
 *
 * The daemon carries its own upstream credentials, so an empty key stores a
 * local placeholder. When nothing answers at the daemon address the prompt
 * leads with the install command (the installer also onboards the user) but
 * still lets Enter store the placeholder, since the endpoint may be configured
 * in models.yml or the daemon started afterwards.
 */
export async function loginOpenllm(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_ID);
	}
	const baseUrl = resolveBaseUrl();
	options.onProgress?.(`Checking for the OpenLLM daemon at ${baseUrl}...`);
	const reachable = await probeDaemon(baseUrl, options);
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const message = reachable
		? "Press Enter to use the local OpenLLM daemon (no key needed), or paste an API key if your daemon requires auth"
		: `No OpenLLM daemon at ${baseUrl}. Install it with: ${INSTALL_COMMAND} (or set OPENLLM_BASE_URL). Press Enter to save the local placeholder anyway, or Esc to cancel`;
	const apiKey = await options.onPrompt({
		message,
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	return apiKey.trim() || DEFAULT_LOCAL_TOKEN;
}

export const openllmProvider = {
	id: "openllm",
	name: "OpenLLM (Local BYOK/subscription gateway)",
	login: loginOpenllm,
} as const satisfies ProviderDefinition;
