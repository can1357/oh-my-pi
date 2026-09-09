import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../usage";

const OLLAMA_PROVIDER = "ollama";
const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

async function fetchOllamaUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_PROVIDER && params.provider !== OLLAMA_CLOUD_PROVIDER) {
		return null;
	}

	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.projectId) metadata.projectId = params.credential.projectId;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [],
		notes: [
			"Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests.",
		],
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

/** Registers Ollama accounts with usage views even though no quota endpoint is exposed. */
export const ollamaUsageProvider: UsageProvider = {
	id: OLLAMA_PROVIDER,
	fetchUsage: fetchOllamaUsage,
	supports: params => params.provider === OLLAMA_PROVIDER,
	validatesCredentials: false,
};

/** Registers Ollama Cloud accounts with usage views until a quota endpoint is available. */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaUsage,
	supports: params => params.provider === OLLAMA_CLOUD_PROVIDER,
	validatesCredentials: false,
};
