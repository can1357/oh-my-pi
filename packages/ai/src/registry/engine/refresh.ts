/**
 * `refresh { … }` engine: refresh-token grant against the declared token
 * endpoint. Unrotated refresh tokens are preserved; identity fields the
 * response omits are left for the caller to merge from the stored row.
 */
import type { CompiledAuthProvider, CompiledRefresh } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import { claudeCodeSdkVersion } from "../../providers/claude-code-fingerprint";
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
type Refresher = (credentials: OAuthCredentials, signal?: AbortSignal) => Promise<OAuthCredentials>;

async function loginClient(policy: CompiledAuthProvider, signal?: AbortSignal) {
	const login = policy.login;
	if (login?.kind === "oauth-code") {
		return {
			clientId: login.clientId ? await resolveValue(login.clientId, signal) : undefined,
			clientSecret: login.clientSecret ? await resolveValue(login.clientSecret, signal) : undefined,
			redirectUri: login.callback.redirectUri
				? await resolveValue(login.callback.redirectUri, signal)
				: `http://${login.callback.hostname}:${login.callback.port}${login.callback.path}`,
			base: undefined,
		};
	}
	if (login?.kind === "device-code") {
		return {
			clientId: await resolveValue(login.clientId, signal),
			clientSecret: undefined,
			redirectUri: undefined,
			base: login.baseUrl ? await resolveValue(login.baseUrl, signal) : undefined,
		};
	}
	return { clientId: undefined, clientSecret: undefined, redirectUri: undefined, base: undefined };
}

function createRequestRefresh(rule: RequestRefresh, policy: CompiledAuthProvider): Refresher {
	const provider = policy.id;
	return async (credentials, signal) => {
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
		const context = { provider, fetch, signal, headers: hookHeaders };
		const vars: TemplateVars = {
			refresh_token: credentials.refresh,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: client.redirectUri,
			base: client.base,
			claude_code_sdk_version: claudeCodeSdkVersion,
		};
		const { body } = await postTokenRequest(
			rule.token,
			{
				grant_type: "refresh_token",
				client_id: client.clientId,
				client_secret: client.clientSecret,
				refresh_token: credentials.refresh,
			},
			vars,
			context,
			"token-refresh",
		);
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
