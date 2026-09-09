import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";
import { fetchCodexModels } from "./codex";

export interface CodexAccountIdentity {
	credentialId: number;
	accountId?: string;
	email?: string;
}

/** Account identities, never bearer/refresh tokens, namespace persisted model capabilities. */
export function codexAccountCacheKey(account: CodexAccountIdentity): string {
	const identity = JSON.stringify([account.credentialId, account.accountId ?? "", account.email ?? ""]);
	return `openai-codex:account-v1:${new Bun.CryptoHasher("sha256").update(identity).digest("hex")}`;
}

export function codexAccountModelManagerOptions(config: {
	account: CodexAccountIdentity;
	resolveAccess: () => Promise<{ accessToken: string; accountId?: string } | undefined>;
	cacheDbPath?: string;
	fetch?: FetchImpl;
}): ModelManagerOptions<"openai-codex-responses"> {
	return {
		providerId: "openai-codex",
		cacheProviderId: codexAccountCacheKey(config.account),
		cacheDbPath: config.cacheDbPath,
		// A bundled model is not evidence that this account can use it.
		staticModels: [],
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async () => {
			const access = await config.resolveAccess();
			if (!access) return null;
			const result = await fetchCodexModels({
				...access,
				fetchFn: config.fetch,
				signal: AbortSignal.timeout(10_000),
			});
			return result?.models ?? null;
		},
	};
}
