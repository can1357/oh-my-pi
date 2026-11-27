/**
 * Typed accessors over the compiled auth stratum (`rules/auth/*.kdl`): per
 * provider display metadata, env-var fallbacks and the declarative login /
 * refresh flow that `@oh-my-pi/pi-ai`'s registry engines interpret.
 */
import rules from "./rules.json";
import type { CompiledAuthProvider } from "./types";

const providers = rules.auth.providers as readonly CompiledAuthProvider[];
const byId: Record<string, CompiledAuthProvider> = Object.fromEntries(providers.map(p => [p.id, p]));

/** Every compiled auth provider in `/login` display order. */
export function authProviders(): readonly CompiledAuthProvider[] {
	return providers;
}

/** The compiled auth policy for one provider id, if declared. */
export function authPolicyFor(provider: string): CompiledAuthProvider | undefined {
	return byId[provider];
}

/** Why `provider` is turned off (`disabled "<reason>"`): it offers no login and no credential reaches it. */
export function providerDisabledReason(provider: string): string | undefined {
	return byId[provider]?.disabled;
}

/** Whether `provider`'s logins hinge on a key only this machine holds (`device-bound #true`), so no auth broker stores them. */
export function providerDeviceBound(provider: string): boolean {
	return byId[provider]?.deviceBound === true;
}

/** The account risk a new login must accept first (`login-warning "<text>"`), if declared. */
export function providerLoginWarning(provider: string): string | undefined {
	return byId[provider]?.loginWarning;
}

/** What surfaces call `provider` once an account is linked (`connected-name "<text>"`), if declared. */
export function providerConnectedName(provider: string): string | undefined {
	return byId[provider]?.connectedName;
}

/** The transcript line shown when a session starts using a `provider` model (`active-notice "<text>"`), if declared. */
export function providerActiveNotice(provider: string): string | undefined {
	return byId[provider]?.activeNotice;
}

/** Every hook name referenced anywhere in the auth stratum, for registry completeness checks. */
export function authHookNames(): Record<string, string[]> {
	const names: Record<string, string[]> = {};
	const add = (kind: string, name: string | undefined) => {
		if (!name) return;
		(names[kind] ??= []).push(name);
	};
	for (const p of providers) {
		if (p.env && "hook" in p.env) add("env", p.env.hook);
		const login = p.login;
		if (login?.kind === "custom") add("login", login.hook);
		if (login?.kind === "api-key" && login.validate?.kind === "models-endpoint") {
			add("headers", login.validate.headersHook);
		}
		if (login?.kind === "oauth-code") {
			add("after-exchange", login.afterExchange);
			add("value", login.clientId?.hook);
			add("value", login.authorizeUrl.hook);
			add("value", login.token.url.hook);
		}
		if (login?.kind === "device-code") {
			add("after-exchange", login.afterExchange);
			add("headers", login.headersHook);
			add("value", login.clientId.hook);
			add("value", login.baseUrl?.hook);
			add("value", login.device.url.hook);
			add("value", login.token.url.hook);
		}
		add("sign-out", p.signOut?.hook);
		const refresh = p.refresh;
		if (refresh?.kind === "hook") add("refresh", refresh.hook);
		if (refresh?.kind === "request") {
			add("after-exchange", refresh.afterRefresh);
			add("headers", refresh.headersHook);
			add("value", refresh.token.url.hook);
		}
	}
	return names;
}
