/**
 * `refresh { … }` engine: refresh-token grant against the declared token
 * endpoint. Unrotated refresh tokens are preserved; identity fields the
 * response omits are left for the caller to merge from the stored row.
 */
import type { CompiledAuthProvider, CompiledRefresh } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import { claudeCodeAxiosVersion } from "../../providers/claude-code-fingerprint";
import type { OAuthRefreshReason } from "../../auth/types";
import type { OAuthCredentials } from "../oauth/types";
import {
	applyAfterExchange,
	applyUserinfo,
	loadHeadersHook,
	loadRefreshHook,
	mapCredentials,
	postTokenRequest,
	resolveValue,
	type TemplateVars,
	throwIfCancelled,
} from "./common";

type RequestRefresh = Extract<CompiledRefresh, { kind: "request" }>;
type Refresher = (
	credentials: OAuthCredentials,
	signal?: AbortSignal,
	reason?: OAuthRefreshReason,
) => Promise<OAuthCredentials>;

/**
 * The `{refresh_reason}` template value, in OpenAI AuthAPI vocabulary (codex-rs
 * `RefreshReason`, openai/codex#53991): a 401 recovery is `unauthorized_recovery`;
 * every other refresh here is driven by the access token nearing expiry.
 */
function refreshReasonParam(reason: OAuthRefreshReason | undefined): string {
	return reason === "auth-recovery" ? "unauthorized_recovery" : "proactive_expiry";
}

async function loginClient(policy: CompiledAuthProvider, signal?: AbortSignal) {
	const login = policy.login;
	if (login?.kind === "oauth-code") {
		return {
			clientId: login.clientId ? await resolveValue(login.clientId, signal) : undefined,
			clientSecret: login.clientSecret ? await resolveValue(login.clientSecret, signal) : undefined,
			redirectUri: login.callback.redirectUri
				? await resolveValue(login.callback.redirectUri, signal)
				: `http://${login.callback.hostname}:${login.callback.port}${login.callback.path}`,
			base: login.baseUrl ? (await resolveValue(login.baseUrl, signal)).replace(/\/+$/, "") : undefined,
			auth: login.authUrl ? (await resolveValue(login.authUrl, signal)).replace(/\/+$/, "") : undefined,
		};
	}
	if (login?.kind === "device-code") {
		return {
			clientId: await resolveValue(login.clientId, signal),
			clientSecret: undefined,
			redirectUri: undefined,
			base: login.baseUrl ? await resolveValue(login.baseUrl, signal) : undefined,
			auth: undefined,
		};
	}
	return { clientId: undefined, clientSecret: undefined, redirectUri: undefined, base: undefined, auth: undefined };
}

function createRequestRefresh(rule: RequestRefresh, policy: CompiledAuthProvider): Refresher {
	const provider = policy.id;
	const scope = rule.scopes?.join(" ");
	return async (credentials, signal, reason) => {
		for (const field of rule.require) {
			if (!credentials[field as keyof OAuthCredentials]) {
				throw new AIError.OAuthError(`${provider} credentials are missing ${field}; sign in again`, {
					kind: "configuration",
					provider,
				});
			}
		}
		throwIfCancelled(signal);
		const client = await loginClient(policy, signal);
		const hookHeaders = rule.headersHook ? (await loadHeadersHook(rule.headersHook))() : undefined;
		const context = { provider, fetch, signal, headers: hookHeaders, deadGrant: rule.deadGrant };
		const vars: TemplateVars = {
			refresh_token: credentials.refresh,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: client.redirectUri,
			base: client.base,
			auth: client.auth,
			claude_code_axios_version: claudeCodeAxiosVersion,
			refresh_reason: refreshReasonParam(reason),
		};
		const exchange = (requestedScope: string | undefined) =>
			postTokenRequest(
				rule.token,
				{
					grant_type: "refresh_token",
					refresh_token: credentials.refresh,
					client_id: client.clientId,
					client_secret: client.clientSecret,
					scope: requestedScope,
					organization_id: credentials.activeOrganizationId,
				},
				vars,
				context,
				"token-refresh",
			);
		let body: unknown;
		try {
			({ body } = await exchange(scope));
		} catch (error) {
			// A grant issued before a requested scope existed is refused whole;
			// omitting `scope` reissues the scopes it already holds (RFC 6749 §6).
			const scopeRefused =
				error instanceof AIError.OAuthError && error.status === 400 && error.code === "invalid_scope";
			if (scope === undefined || !scopeRefused) throw error;
			({ body } = await exchange(undefined));
		}
		throwIfCancelled(signal);
		let refreshed = mapCredentials(rule.credential, body, provider, credentials);
		refreshed = await applyUserinfo(rule.userinfo, refreshed, context);
		return applyAfterExchange(rule.afterRefresh, refreshed, {
			provider,
			phase: "refresh",
			raw: body,
			fetch,
			signal,
			stored: credentials,
		});
	};
}

/** The refresh function for a provider policy, or undefined when it never refreshes. */
export function createRefresh(policy: CompiledAuthProvider): Refresher | undefined {
	const rule = policy.refresh;
	if (!rule || rule.kind === "none") return undefined;
	if (rule.kind === "hook") {
		return async (credentials, signal) => (await loadRefreshHook(rule.hook))(credentials, signal);
	}
	return createRequestRefresh(rule, policy);
}
