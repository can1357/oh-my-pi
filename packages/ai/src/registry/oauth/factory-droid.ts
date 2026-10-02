import { factoryDroidApiBaseUrl, resolveFactoryDroidInferenceRegion } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
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
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
			headers: {
				Authorization: `Bearer ${credentials.access}`,
				Accept: "application/json",
				...(identity.orgId ? { "X-Factory-Org-Id": identity.orgId } : {}),
			},
			signal,
		});
		if (!response.ok && context.phase === "login") {
			throw new AIError.OAuthError(`Factory identity check failed (${response.status}): ${await response.text()}`, {
				kind: "validation",
				provider: context.provider,
				status: response.status,
			});
		}
		if (response.ok) {
			const body: unknown = await response.json();
			if (isRecord(body)) {
				const orgId = typeof body.orgId === "string" && body.orgId ? body.orgId : identity.orgId;
				if (context.phase === "login" && !orgId) {
					throw new AIError.OAuthError("Factory login did not resolve an organization", {
						kind: "validation",
						provider: context.provider,
					});
				}
				// A different organization must not inherit the stored scope.
				const carried = !orgId || !identity.orgId || orgId === identity.orgId ? identity : undefined;
				const region = body.region === "eu" || body.region === "global" ? body.region : carried?.region;
				const inferenceRegion =
					body.inferenceRegion === "global" || body.inferenceRegion === "eu" || body.inferenceRegion === "us"
						? body.inferenceRegion
						: resolveFactoryDroidInferenceRegion({ region, inferenceRegion: carried?.inferenceRegion });
				return { ...identity, orgId, region, inferenceRegion };
			}
		}
	} catch (error) {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		if (context.phase === "login") throw error;
		// Preserve identity only when this is still the same selected organization.
	}
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	if (context.phase === "login" && !identity.orgId) {
		throw new AIError.OAuthError("Factory login did not resolve an organization", {
			kind: "validation",
			provider: context.provider,
		});
	}
	return identity;
};
