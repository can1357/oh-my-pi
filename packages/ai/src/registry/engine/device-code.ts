/**
 * `login "device-code"` engine: RFC 8628 device authorization — request a
 * user code, show the verification URL, poll the token endpoint until the
 * grant completes, then project / enrich the credentials.
 */
import type { CompiledDeviceCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "../oauth/device-code";
import type { OAuthController, OAuthCredentials } from "../oauth/types";
import {
	applyAfterExchange,
	applyUserinfo,
	jsonPath,
	loadHeadersHook,
	mapCredentials,
	postTokenRequest,
	resolveValue,
	template,
	type TemplateVars,
	throwIfCancelled,
} from "./common";

function stringAt(body: unknown, path: string | undefined): string | undefined {
	if (!path) return undefined;
	const value = jsonPath(body, path);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(body: unknown, path: string | undefined): number | undefined {
	if (!path) return undefined;
	const value = jsonPath(body, path);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Builds the login function for one `login "device-code"` rule. */
export function createDeviceCodeLogin(
	rule: CompiledDeviceCodeLogin,
	provider: string,
): (ctrl: OAuthController) => Promise<OAuthCredentials> {
	return async ctrl => {
		const signal = ctrl.signal;
		const fetchImpl = ctrl.fetch ?? fetch;
		throwIfCancelled(signal);
		const clientId = await resolveValue(rule.clientId, signal);
		const base = rule.baseUrl ? await resolveValue(rule.baseUrl, signal) : undefined;
		const scope = rule.scopes.length > 0 ? rule.scopes.join(rule.scopeSeparator) : undefined;
		const hookHeaders = rule.headersHook ? (await loadHeadersHook(rule.headersHook))() : undefined;
		const context = { provider, fetch: fetchImpl, signal, headers: hookHeaders };
		const vars: TemplateVars = { client_id: clientId, scope, base };

		ctrl.onProgress?.("Requesting device authorization...");
		const device = await postTokenRequest(rule.device, { client_id: clientId, scope }, vars, context, "device-auth");
		if (!device.response.ok) {
			throw new AIError.OAuthError(
				`${provider} device authorization failed: ${device.response.status} ${typeof device.body === "string" ? device.body : JSON.stringify(device.body)}`,
				{ kind: "device-auth", provider, status: device.response.status },
			);
		}
		const response = rule.response;
		const userCode = stringAt(device.body, response.userCode);
		const deviceCode = stringAt(device.body, response.deviceCode);
		const verificationUri = stringAt(device.body, response.verificationUri);
		const verificationUriComplete = stringAt(device.body, response.verificationUriComplete);
		if (!userCode || !deviceCode || !verificationUri) {
			throw new AIError.OAuthError(`${provider} device authorization response missing required fields`, {
				kind: "validation",
				provider,
			});
		}
		ctrl.onAuth?.({
			url: verificationUriComplete ?? verificationUri,
			instructions: template(rule.instructions, { user_code: userCode }),
		});
		ctrl.onProgress?.("Waiting for device authorization...");

		const pollVars: TemplateVars = { ...vars, device_code: deviceCode };
		// Resolve the token endpoint once (it may come from OIDC discovery) rather than per poll.
		const tokenRequest = { ...rule.token, url: { value: await resolveValue(rule.token.url, signal) } };
		const body = await pollOAuthDeviceCodeFlow<unknown>({
			intervalSeconds: numberAt(device.body, response.interval),
			expiresInSeconds: numberAt(device.body, response.expiresIn),
			signal,
			poll: async (): Promise<OAuthDeviceCodePollResult<unknown>> => {
				const result = await postTokenRequest(
					tokenRequest,
					{
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: clientId,
						device_code: deviceCode,
					},
					pollVars,
					context,
					"device-auth",
				);
				const error = jsonPath(result.body, "error");
				if (result.response.ok && error === undefined) return { status: "complete", value: result.body };
				switch (error) {
					case "authorization_pending":
						return { status: "pending" };
					case "slow_down":
						return { status: "slow_down" };
					case "expired_token":
						return { status: "failed", message: `${provider} device code expired; restart the login` };
					case "access_denied":
						return { status: "failed", message: `${provider} device authorization was denied` };
					default: {
						const description = jsonPath(result.body, "error_description");
						return {
							status: "failed",
							message:
								`${provider} device token request failed: ${result.response.status} ${typeof description === "string" ? description : typeof error === "string" ? error : ""}`.trim(),
						};
					}
				}
			},
		});
		throwIfCancelled(signal);
		let credentials = mapCredentials(rule.credential, body, provider);
		credentials = await applyUserinfo(rule.userinfo, credentials, context);
		throwIfCancelled(signal);
		return applyAfterExchange(rule.afterExchange, credentials, {
			provider,
			phase: "login",
			raw: body,
			fetch: fetchImpl,
			signal,
			onProgress: ctrl.onProgress,
			onPrompt: ctrl.onPrompt,
		});
	};
}
