import { PROVIDER_REGISTRY } from "./registry";

/**
 * Providers whose OAuth flow needs a pasted code/redirect URL rather than a
 * local callback server. Consumed by the coding-agent login UX.
 */
export const PASTE_CODE_LOGIN_PROVIDERS: ReadonlySet<string> = new Set(
	PROVIDER_REGISTRY.filter(p => p.pasteCodeFlow).map(p => p.id),
);
