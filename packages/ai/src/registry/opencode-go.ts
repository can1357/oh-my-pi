import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const opencodeGoProvider = {
	id: "opencode-go",
	name: "OpenCode Go",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginOpenCode } = await import("./oauth/opencode");
		return loginOpenCode(cb, "OpenCode Go");
	},
} as const satisfies ProviderDefinition;
