import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";

/** Resolve the current account credential for a model without retaining it. */
export type ProviderFileCredentialResolver = (model: Model) => Promise<string | undefined>;

/** OAuth scope a provider's Files API needs of a subscription grant. */
const FILE_UPLOAD_SCOPES: Partial<Record<string, string>> = { anthropic: "user:file_upload" };

/**
 * The model's request credential when it may upload provider files. A stored
 * OAuth login whose recorded grant lacks the provider's file scope (Anthropic's
 * 1-year login has no `user:file_upload`) yields none, so its images take the
 * other backends without a doomed upload. Unrecorded scopes count as granted.
 */
export async function resolveProviderFileCredential(
	registry: {
		authStorage: AuthStorage;
		getApiKey(model: Model, sessionId?: string): Promise<string | undefined>;
	},
	model: Model,
	sessionId?: string,
): Promise<string | undefined> {
	const key = await registry.getApiKey(model, sessionId);
	const scope = FILE_UPLOAD_SCOPES[model.provider];
	if (!key || !scope) return key;
	for (const { credential } of registry.authStorage.credentials.list(model.provider)) {
		if (credential.type !== "oauth" || credential.access !== key) continue;
		return credential.scope === undefined || credential.scope.split(" ").includes(scope) ? key : undefined;
	}
	return key;
}
