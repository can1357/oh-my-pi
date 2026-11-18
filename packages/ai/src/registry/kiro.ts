import { encodeKiroOAuthRow } from "@oh-my-pi/pi-catalog/wire/kiro";
import type { ProviderTransport } from "./build";

/** Kiro requests route by the login's region, profile and login id, so the request key is the codec's encoding of the row. */
export const kiroTransport: ProviderTransport = {
	getApiKey: encodeKiroOAuthRow,
};
