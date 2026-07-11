import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const gitLabDuoWorkflowProvider = {
	id: "gitlab-duo-agent",
	name: "GitLab Duo Agent",
	envKeys: "GITLAB_TOKEN",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginGitLabDuoWorkflow } = await import("./oauth/gitlab-duo-workflow");
		return loginGitLabDuoWorkflow(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshGitLabDuoWorkflowToken } = await import("./oauth/gitlab-duo-workflow");
		return refreshGitLabDuoWorkflowToken(credentials);
	},
	callbackPort: 8080,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
