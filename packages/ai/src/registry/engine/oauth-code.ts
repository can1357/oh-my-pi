/**
 * `login "oauth-code"` engine: authorization-code grant (optionally PKCE)
 * through the configured callback transport, followed by the declared token
 * exchange, credential projection, userinfo enrichment and after-exchange hook.
 */
import type { CompiledAuthProvider, CompiledCallback, CompiledOAuthCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { validateApiKeyAgainstModelsEndpoint } from "../api-key-validation";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "../oauth/callback-server";
import { generatePKCE } from "../oauth/pkce";
import type { OAuthController, OAuthCredentials } from "../oauth/types";
import {
	applyAfterExchange,
	applyUserinfo,
	mapCredentials,
	NEVER_EXPIRES,
	postTokenRequest,
	resolveValue,
	template,
	type TemplateVars,
	throwIfCancelled,
} from "./common";

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Callback-server options for a rule. A `redirect-uri-env` override is
 * advertised verbatim with random-port fallback disabled; HTTP loopback
 * overrides also bind the listener to the URI's host/port/path.
 */
export async function resolveCallbackOptions(
	callback: CompiledCallback,
	provider: string,
	signal?: AbortSignal,
): Promise<OAuthCallbackFlowOptions> {
	const base: OAuthCallbackFlowOptions = {
		preferredPort: callback.port,
		callbackPath: callback.path,
		callbackHostname: callback.hostname,
		allowPortFallback: callback.portFallback,
		manualInputOnly: callback.manualOnly,
		nativeScheme: callback.nativeScheme,
	};
	if (!callback.redirectUri) return base;
	const redirectUri = await resolveValue(callback.redirectUri, signal);
	if (!redirectUri) return base;
	if (redirectUri === callback.redirectUri.value) {
		return { ...base, redirectUri };
	}
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		throw new AIError.OAuthError(`Invalid redirect URI override: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Redirect URI override must use http:// or https://, got: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	const loopback = isLoopbackHost(parsed.hostname);
	if (loopback && parsed.protocol !== "http:") {
		throw new AIError.OAuthError(`Loopback redirect URI overrides must use http://, got: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
	return {
		preferredPort: loopback ? port : 0,
		callbackPath: parsed.pathname || callback.path,
		callbackHostname: loopback ? parsed.hostname : callback.hostname,
		redirectUri,
		allowPortFallback: false,
		manualInputOnly: callback.manualOnly,
		nativeScheme: callback.nativeScheme,
	};
}

/** Generic authorization-code flow driven by one compiled rule. */
export class DeclarativeOAuthCodeFlow extends OAuthCallbackFlow {
	#rule: CompiledOAuthCodeLogin;
	#provider: string;
	#label: string;
	#fetch: FetchImpl;
	#verifier = "";
	#clientId?: string;
	#clientSecret?: string;

	constructor(
		ctrl: OAuthController,
		rule: CompiledOAuthCodeLogin,
		policy: CompiledAuthProvider,
		options: OAuthCallbackFlowOptions,
	) {
		super(ctrl, options);
		this.#rule = rule;
		this.#provider = policy.id;
		this.#label = policy.name;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	override generateState(): string {
		switch (this.#rule.state) {
			case "none":
				return "";
			case "uuid":
				return crypto.randomUUID();
			default:
				return super.generateState();
		}
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const rule = this.#rule;
		const signal = this.ctrl.signal;
		this.#clientId = rule.clientId ? await resolveValue(rule.clientId, signal) : undefined;
		this.#clientSecret = rule.clientSecret ? await resolveValue(rule.clientSecret, signal) : undefined;
		let challenge: string | undefined;
		if (rule.pkce) {
			const pkce = await generatePKCE();
			this.#verifier = pkce.verifier;
			challenge = pkce.challenge;
		}
		const scope = rule.scopes.length > 0 ? rule.scopes.join(rule.scopeSeparator) : undefined;
		const vars: TemplateVars = {
			client_id: this.#clientId,
			redirect_uri: redirectUri,
			scope,
			state,
			code_challenge: challenge,
		};
		const params = new URLSearchParams();
		if (rule.standardAuthorizeParams) {
			if (this.#clientId) params.set("client_id", this.#clientId);
			params.set("response_type", "code");
			params.set("redirect_uri", redirectUri);
			if (scope) params.set("scope", scope);
			if (challenge) {
				params.set("code_challenge", challenge);
				params.set("code_challenge_method", "S256");
			}
			if (state) params.set("state", state);
		}
		for (const key in rule.authorizeParams) params.set(key, template(rule.authorizeParams[key], vars));
		const authorizeUrl = await resolveValue(rule.authorizeUrl, signal);
		return { url: `${authorizeUrl}?${params.toString()}`, instructions: rule.instructions };
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		const rule = this.#rule;
		const signal = this.ctrl.signal;
		throwIfCancelled(signal);
		if (rule.pasteKey && code.startsWith(rule.pasteKey.prefix)) {
			// The manual-input race feeds pasted text through the code path; a
			// pasted API key short-circuits the exchange after validation.
			await validateApiKeyAgainstModelsEndpoint({
				provider: this.#label,
				apiKey: code,
				modelsUrl: rule.pasteKey.validateUrl,
				signal,
				fetch: this.ctrl.fetch,
			});
			return { access: code, refresh: "", expires: NEVER_EXPIRES };
		}
		// Providers may echo `code#state`; the fragment wins over the callback state.
		let exchangeCode = code;
		let exchangeState = state;
		const fragment = code.indexOf("#");
		if (fragment >= 0) {
			exchangeCode = code.slice(0, fragment);
			exchangeState = code.slice(fragment + 1) || state;
		}
		const vars: TemplateVars = {
			code: exchangeCode,
			state: exchangeState,
			redirect_uri: redirectUri,
			code_verifier: rule.pkce ? this.#verifier : undefined,
			client_id: this.#clientId,
			client_secret: this.#clientSecret,
		};
		const context = { provider: this.#provider, fetch: this.#fetch, signal };
		const { body } = await postTokenRequest(
			rule.token,
			{
				grant_type: "authorization_code",
				client_id: this.#clientId,
				client_secret: this.#clientSecret,
				code: exchangeCode,
				redirect_uri: redirectUri,
				code_verifier: rule.pkce ? this.#verifier : undefined,
			},
			vars,
			context,
			"token-exchange",
		);
		throwIfCancelled(signal);
		let credentials = mapCredentials(rule.credential, body, this.#provider);
		credentials = await applyUserinfo(rule.userinfo, credentials, context);
		throwIfCancelled(signal);
		return applyAfterExchange(rule.afterExchange, credentials, {
			provider: this.#provider,
			phase: "login",
			raw: body,
			fetch: this.#fetch,
			signal,
			onProgress: this.ctrl.onProgress,
			onPrompt: this.ctrl.onPrompt,
		});
	}
}

/** Builds the login function for one `login "oauth-code"` rule. */
export function createOAuthCodeLogin(
	rule: CompiledOAuthCodeLogin,
	policy: CompiledAuthProvider,
): (ctrl: OAuthController) => Promise<OAuthCredentials> {
	return async ctrl => {
		const options = await resolveCallbackOptions(rule.callback, policy.id, ctrl.signal);
		return new DeclarativeOAuthCodeFlow(ctrl, rule, policy, options).login();
	};
}
