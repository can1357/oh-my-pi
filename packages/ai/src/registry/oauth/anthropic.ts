/**
 * Anthropic (Claude Pro/Max) sign-in residue. The OAuth flow itself is
 * declared in `rules/auth/anthropic.kdl`; this module supplies the
 * `anthropic-identity` after-exchange hook that recovers account /
 * organization identity from `/api/claude_cli/bootstrap` when the token
 * response omits it.
 */

import * as AIError from "../../error";
import { claudeCodeVersion } from "../../providers/claude-code-fingerprint";
import type { FetchImpl } from "../../types";
import type { AfterExchangeHook } from "../hooks/types";
import type { OAuthCredentials } from "./types";

const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;

export { ANTHROPIC_OAUTH_GRANT_TTL_MS } from "./anthropic-constants";

interface AnthropicBootstrapResponse {
	oauth_account?: {
		account_uuid?: string;
		account_email?: string;
		organization_uuid?: string;
		organization_name?: string;
	};
}

/**
 * Account + organization identity slice resolved from the
 * `/api/claude_cli/bootstrap` endpoint. The organization is the subscription
 * workspace the token draws limits from — one account email can hold several
 * (e.g. a Team seat plus a personal Max plan).
 */
interface AnthropicIdentity {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Fetches the signed-in account/org identity Claude Code's CLI bootstrap reports. */
export async function fetchAnthropicBootstrapIdentity(
	accessToken: string,
	fetchImpl: FetchImpl,
): Promise<AnthropicIdentity> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	let data: AnthropicBootstrapResponse;
	try {
		data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
	} catch (error) {
		throw new AIError.OAuthError(`Anthropic bootstrap returned invalid JSON. url=${url}; body=${responseBody}`, {
			kind: "validation",
			provider: "anthropic",
			cause: error,
		});
	}
	return {
		accountId: nonEmpty(data.oauth_account?.account_uuid),
		email: nonEmpty(data.oauth_account?.account_email),
		orgId: nonEmpty(data.oauth_account?.organization_uuid),
		orgName: nonEmpty(data.oauth_account?.organization_name),
	};
}

/**
 * `anthropic-identity` hook: fills account (and, at login only, organization)
 * identity from the bootstrap endpoint when the token response left it
 * unset. The org an access token is scoped to is captured once at login and
 * deliberately never refreshed — rewriting identity during background
 * refreshes could silently re-key stored credentials.
 */
export const anthropicIdentityHook: AfterExchangeHook = async (credentials, context): Promise<OAuthCredentials> => {
	const includeOrg = context.phase === "login";
	const orgSatisfied = !includeOrg || credentials.orgId !== undefined;
	if (credentials.accountId && credentials.email && orgSatisfied) return credentials;
	try {
		const bootstrap = await fetchAnthropicBootstrapIdentity(credentials.access, context.fetch);
		return {
			...credentials,
			accountId: credentials.accountId ?? bootstrap.accountId,
			email: credentials.email ?? bootstrap.email,
			...(includeOrg
				? { orgId: credentials.orgId ?? bootstrap.orgId, orgName: credentials.orgName ?? bootstrap.orgName }
				: {}),
		};
	} catch {
		return credentials;
	}
};
