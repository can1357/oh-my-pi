import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const gitlabDuoProvider = {
	id: "gitlab-duo",
	name: "GitLab Duo Non-Agentic",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginGitLabDuo } = await import("./oauth/gitlab-duo");
		return loginGitLabDuo(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshGitLabDuoToken } = await import("./oauth/gitlab-duo");
		return refreshGitLabDuoToken(credentials);
	},
	callbackPort: 8080,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
