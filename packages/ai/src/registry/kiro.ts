import { encodeKiroOAuthRow } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import type { ProviderTransport } from "./build";

/**
 * Kiro requests route by the login's endpoint, profile, and login id, so the
 * request key is the Kiro credential codec's encoding of the stored row; a
 * row missing those fields throws `KiroCredentialError`.
 */
export const kiroTransport: ProviderTransport = {
	getApiKey: encodeKiroOAuthRow,
};
