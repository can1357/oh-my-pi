import { usageReportMetadataValue } from "../../auth/usage-report";
import * as AIError from "../../error";
import { devinUsageProvider } from "../../usage/devin";
import type { AfterExchangeHook } from "../hooks/types";

/**
 * Stores who a Devin login belongs to: email, user id, and the organization the
 * token is scoped to, read from the seat-status call `/usage` makes. One user can
 * sign in to several organizations, each with its own plan and quota.
 */
export const devinIdentityHook: AfterExchangeHook = async (credentials, context) => {
	// Bounded like the token exchange: a stalled read must not hold back the login it only labels.
	const timeout = AbortSignal.timeout(30_000);
	const report = await devinUsageProvider.fetchUsage(
		{
			provider: "devin",
			credential: { type: "oauth", accessToken: credentials.access },
			signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
		},
		{ fetch: context.fetch },
	);
	if (context.signal?.aborted) throw new AIError.LoginCancelledError();
	// Unidentified, the login is stored the way it was before identity capture.
	if (!report) return credentials;
	const identity = {
		email: usageReportMetadataValue(report, "email"),
		accountId: usageReportMetadataValue(report, "accountId"),
		orgId: usageReportMetadataValue(report, "orgId"),
		orgName: usageReportMetadataValue(report, "orgName"),
	};
	return {
		...credentials,
		...Object.fromEntries(Object.entries(identity).filter(([, value]) => value)),
	};
};
