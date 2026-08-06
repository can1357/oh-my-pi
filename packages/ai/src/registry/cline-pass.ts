import { loginCline, refreshClineToken } from "./cline";
import type { ProviderDefinition } from "./types";

/** ClinePass uses the same Cline account device flow with a subscription-scoped model catalog. */
export const clinePassProvider = {
	id: "cline-pass",
	name: "ClinePass",
	login: loginCline,
	refreshToken: refreshClineToken,
	getApiKey: credentials => {
		return credentials.access.startsWith("workos:") ? credentials.access : `workos:${credentials.access}`;
	},
} as const satisfies ProviderDefinition;
