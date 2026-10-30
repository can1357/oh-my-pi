import { factoryDroidApiBaseUrl, resolveFactoryDroidInferenceRegion } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { AfterExchangeHook, ExchangeContext } from "../hooks/types";
import { refreshOAuthToken } from "./index";
import type { OAuthCredentials } from "./types";

/**
 * WorkOS organization a bearer without an org claim belongs to, from `/api/cli/org`.
 * These ids scope the WorkOS refresh grant; they are never Factory org ids.
 */
async function lookupWorkOSOrganization(
	credentials: OAuthCredentials,
	region: string | undefined,
	context: ExchangeContext,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(region)}/api/cli/org`, {
			headers: { Authorization: `Bearer ${credentials.access}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.workosOrgIds)) return undefined;
		const [orgId] = body.workosOrgIds;
		return typeof orgId === "string" && orgId ? orgId : undefined;
	} catch {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		return undefined;
	}
}

/**
 * Read `/api/cli/whoami` for `identity`'s bearer. `accepted` is true only when
 * Factory answered for this bearer with an organization. A login that whoami
 * leaves without an organization comes back with the error to report.
 */
async function readWhoami(
	identity: OAuthCredentials,
	context: ExchangeContext,
	signal: AbortSignal,
): Promise<{ identity: OAuthCredentials; accepted: boolean; failure?: AIError.OAuthError }> {
	const unresolved = () =>
		context.phase === "login" && !identity.orgId
			? new AIError.OAuthError("Factory login did not resolve an organization", {
					kind: "validation",
					provider: context.provider,
				})
			: undefined;
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(identity.region)}/api/cli/whoami`, {
			headers: {
				Authorization: `Bearer ${identity.access}`,
				Accept: "application/json",
				...(identity.orgId ? { "X-Factory-Org-Id": identity.orgId } : {}),
			},
			signal,
		});
		if (!response.ok && context.phase === "login") {
			const failure = new AIError.OAuthError(
				`Factory identity check failed (${response.status}): ${await response.text()}`,
				{ kind: "validation", provider: context.provider, status: response.status },
			);
			return { identity, accepted: false, failure };
		}
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
				const resolved = { ...identity, orgId, region, inferenceRegion };
				return { identity: resolved, accepted: Boolean(orgId), failure: orgId ? undefined : unresolved() };
			}
		}
	} catch (error) {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		if (context.phase === "login") throw error;
		// Preserve identity only when this is still the same selected organization.
	}
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	return { identity, accepted: false, failure: unresolved() };
}

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
	// Each Factory request gets its own 15 s deadline, so earlier slow calls do not eat into later ones.
	const requestSignal = () => {
		const timeout = AbortSignal.timeout(15_000);
		return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
	};
	const whoami = await readWhoami(identity, context, requestSignal());
	// Factory rejects a bearer without an org claim. When neither the new
	// bearer's claim nor whoami names an organization (a stored org says nothing
	// about this bearer) and no WorkOS organization is selected yet, scope the
	// grant to the account's one. The scoped refresh re-enters this hook with
	// that organization selected, so it never repeats.
	if (!credentials.orgId && !whoami.accepted && !selectedOrg) {
		const workosOrg = await lookupWorkOSOrganization(credentials, identity.region, context, requestSignal());
		if (workosOrg) {
			let scoped: OAuthCredentials | undefined;
			try {
				scoped = await refreshOAuthToken(
					"factory-droid",
					{ ...identity, activeOrganizationId: workosOrg },
					context.signal,
				);
			} catch {
				// Fall through: the identity check reports why the bearer is unusable.
				if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
			}
			if (scoped) {
				// The scoped grant rotated the refresh token, so a refresh keeps it either way.
				if (context.phase === "refresh") return scoped;
				// The nested refresh checked whoami leniently; a login must see Factory accept the bearer.
				const confirmed = await readWhoami(scoped, context, requestSignal());
				if (confirmed.failure) throw confirmed.failure;
				// The scoped grant may omit the user; keep the identity the login captured.
				return {
					...confirmed.identity,
					email: confirmed.identity.email ?? credentials.email,
					accountId: confirmed.identity.accountId ?? credentials.accountId,
				};
			}
		}
	}
	if (whoami.failure) throw whoami.failure;
	return whoami.identity;
};
