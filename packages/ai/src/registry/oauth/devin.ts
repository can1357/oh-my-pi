import type { FetchImpl } from "../../types";
import * as AIError from "../../error";
import { devinUsageProvider } from "../../usage/devin";
import type { AfterExchangeHook } from "../hooks/types";

/** Resolve a Devin bearer to its user identity via the seat-status endpoint. */
export async function fetchDevinIdentity(
	access: string,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<{ accountId: string; email?: string } | null> {
	const report = await devinUsageProvider.fetchUsage(
		{ provider: "devin", credential: { type: "oauth", accessToken: access }, signal },
		{ fetch },
	);
	const accountId = report?.metadata?.accountId;
	if (typeof accountId !== "string" || !accountId.trim()) return null;
	const email = report?.metadata?.email;
	return {
		accountId,
		...(typeof email === "string" && email.trim() ? { email } : {}),
	};
}

/** Resolves the Devin user ID from the same seat-status endpoint used by `/usage`. */
export const devinIdentityHook: AfterExchangeHook = async (credentials, context) => {
	const identity = await fetchDevinIdentity(credentials.access, context.fetch, context.signal);
	if (!identity) {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError("Could not identify the Devin account. Please sign in again.", {
			kind: "validation",
			provider: "devin",
		});
	}
	return { ...credentials, ...identity };
};
