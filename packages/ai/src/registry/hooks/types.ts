/**
 * Hook contracts referenced by name from `rules/auth/*.kdl`. A hook is the
 * escape hatch for the part of a login flow that is not declarative
 * (identity lookups, project provisioning, key minting, bespoke polling).
 * Names are validated against the compiled rule tree by
 * `test/auth-hooks-registry.test.ts`.
 */
import type { FetchImpl } from "../../types";
import type { OAuthController, OAuthCredentials, OAuthPrompt } from "../oauth/types";

/** Whole-flow login implementation (`login "custom" hook=…`); rejects a bare controller at runtime when it needs prompts. */
export type LoginHook = (callbacks: OAuthController) => Promise<OAuthCredentials | string>;

/** Whole-flow refresh implementation (`refresh hook=…`). */
export type RefreshHook = (credentials: OAuthCredentials, signal?: AbortSignal) => Promise<OAuthCredentials>;

/** Runtime context handed to `after-exchange` / `after-refresh` hooks. */
export interface ExchangeContext {
	provider: string;
	phase: "login" | "refresh";
	/** Parsed JSON body of the token response. */
	raw: unknown;
	fetch: FetchImpl;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
	/** Credential being refreshed (refresh phase only). */
	stored?: OAuthCredentials;
}

/** Enrich or replace the engine-mapped credentials after a token exchange. */
export type AfterExchangeHook = (credentials: OAuthCredentials, context: ExchangeContext) => Promise<OAuthCredentials>;

/** Extra request headers (`headers-hook`); may throw a configuration error. */
export type HeadersHook = () => Record<string, string> | undefined;

/** Computed env-var fallback (`env hook=…`); must stay synchronous. */
export type EnvHook = () => string | undefined;

/** Runtime-resolved string setting (`url-hook=` / `hook=` on a value node). */
export type ValueHook = (signal?: AbortSignal) => Promise<string>;

/** Lazily loaded hook: keeps heavy flow modules out of the eager registry graph. */
export type Lazy<T> = () => Promise<T>;

export interface HookTables {
	env: Record<string, EnvHook>;
	headers: Record<string, Lazy<HeadersHook>>;
	value: Record<string, Lazy<ValueHook>>;
	login: Record<string, Lazy<LoginHook>>;
	refresh: Record<string, Lazy<RefreshHook>>;
	afterExchange: Record<string, Lazy<AfterExchangeHook>>;
}
