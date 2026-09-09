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
