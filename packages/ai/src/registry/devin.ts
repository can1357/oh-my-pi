import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const devinProvider = {
	id: "devin",
	name: "Devin",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep OAuth flow modules out of the eager registry graph.
		const { loginDevin } = await import("./oauth/devin");
		const credentials = await loginDevin(cb);
		return credentials.access;
	},
	callbackPort: 59653,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
