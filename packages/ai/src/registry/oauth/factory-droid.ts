import { factoryDroidApiBaseUrl, resolveFactoryDroidInferenceRegion } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { OAuthCredentials } from "../oauth/types";
import type { AfterExchangeHook } from "../hooks/types";

/** Resolve canonical Factory identity; residency chooses the host, inference scope chooses eligible routes. */
export const attachFactoryDroidRegion: AfterExchangeHook = async (credentials, context) => {
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	if (!isRecord(context.raw) || typeof context.raw.refresh_token !== "string" || !credentials.refresh) {
		throw new AIError.OAuthError("Factory token response missing refresh token", { kind: "validation" });
	}
	const selectedOrg =
		typeof context.raw.organization_id === "string"
			? context.raw.organization_id
			: context.stored?.activeOrganizationId;
	// The token's Factory org claim belongs to the new bearer: a different
	// claim is an org change even when the WorkOS selection is unchanged.
	const factoryOrgChanged = Boolean(
		credentials.orgId && context.stored?.orgId && credentials.orgId !== context.stored.orgId,
	);
	const sameOrg =
		!factoryOrgChanged &&
		(!selectedOrg || !context.stored?.activeOrganizationId || selectedOrg === context.stored.activeOrganizationId);
	const identity = {
		...credentials,
		activeOrganizationId: selectedOrg,
		orgId: credentials.orgId ?? (sameOrg ? context.stored?.orgId : undefined),
		region: sameOrg ? context.stored?.region : undefined,
		inferenceRegion: sameOrg ? context.stored?.inferenceRegion : undefined,
	};
	const timeout = AbortSignal.timeout(15_000);
	const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
	let whoamiStatus: number | undefined;
	let whoamiDetail: string | undefined;
	let resolved: OAuthCredentials | undefined;
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
			headers: {
				Authorization: `Bearer ${credentials.access}`,
				Accept: "application/json",
				...(identity.orgId ? { "X-Factory-Org-Id": identity.orgId } : {}),
			},
			signal,
		});
		if (response.ok) {
			const body: unknown = await response.json();
			if (isRecord(body)) {
				const orgId = typeof body.orgId === "string" && body.orgId ? body.orgId : identity.orgId;
				// A different organization must not inherit the stored scope.
				const carried = !orgId || !identity.orgId || orgId === identity.orgId ? identity : undefined;
				const region = body.region === "eu" || body.region === "global" ? body.region : carried?.region;
				const inferenceRegion =
					body.inferenceRegion === "global" || body.inferenceRegion === "eu" || body.inferenceRegion === "us"
						? body.inferenceRegion
						: resolveFactoryDroidInferenceRegion({ region, inferenceRegion: carried?.inferenceRegion });
				resolved = { ...identity, orgId, region, inferenceRegion };
			}
		} else {
			whoamiStatus = response.status;
			try {
				const body: unknown = await response.json();
				if (isRecord(body) && typeof body.detail === "string") whoamiDetail = body.detail;
			} catch {
				// Non-JSON error body; the status alone is reported below.
			}
		}
	} catch {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		// Preserve identity only when this is still the same selected organization.
	}
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	// A fresh login that ends without an organization binding is unusable: every
	// Factory endpoint rejects org-less tokens with 401, so failing here surfaces
	// the server's reason instead of storing a credential that 401s on each turn.
	if (context.phase === "login" && (resolved ?? identity).orgId === undefined) {
		const reason =
			whoamiDetail ??
			(whoamiStatus !== undefined
				? `whoami returned HTTP ${whoamiStatus}`
				: "whoami did not return an organization");
		throw new AIError.OAuthError(
			`Factory Droid login did not resolve an organization: ${reason}. ` +
				`The WorkOS token carries no external_org_id claim, and Factory's API requires an organization-bound token. ` +
				`Sign in with an account that belongs to a Factory organization, or retry once the token exchange returns one.`,
			{ kind: "validation", status: whoamiStatus },
		);
	}
	return resolved ?? identity;
};
