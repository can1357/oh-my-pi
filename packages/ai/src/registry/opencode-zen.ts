import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const opencodeZenProvider = {
	id: "opencode-zen",
	name: "OpenCode Zen",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginOpenCode } = await import("./oauth/opencode");
		return loginOpenCode(cb, "OpenCode Zen");
	},
} as const satisfies ProviderDefinition;
