/**
 * Kimi Code runs two independent regional deployments: mainland China on
 * kimi.com and global on kimi.ai. Accounts and OAuth tokens are scoped to the
 * deployment that issued them, so each region is its own provider. Endpoints
 * mirror the official client's region profiles
 * (MoonshotAI/kimi-code `packages/oauth/src/region.ts`).
 */
export type KimiCodeProvider = "kimi-code" | "kimi-code-global";

/** Managed `/coding/v1` API base per regional provider (chat, models, usages, search). */
export const KIMI_CODE_BASE_URLS: Readonly<Record<KimiCodeProvider, string>> = {
	"kimi-code": "https://api.kimi.com/coding/v1",
	"kimi-code-global": "https://api.kimi.ai/coding/v1",
};

export function isKimiCodeProvider(provider: string): provider is KimiCodeProvider {
	return Object.hasOwn(KIMI_CODE_BASE_URLS, provider);
}
