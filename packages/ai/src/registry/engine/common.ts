/**
 * Shared machinery for the declarative login engines: resolving KDL values
 * (env overrides, obfuscation, hooks), `{placeholder}` templating, token
 * endpoint requests and token-response → `OAuthCredentials` projection.
 */
import type {
	CompiledAuthValue,
	CompiledCredentialField,
	CompiledCredentialMap,
	CompiledOAuthRequest,
	CompiledUserinfo,
} from "@oh-my-pi/pi-catalog/compat/types";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { HOOKS } from "../hooks";
import type {
	AfterExchangeHook,
	ExchangeContext,
	HeadersHook,
	LoginHook,
	RefreshHook,
	ValueHook,
} from "../hooks/types";
import type { OAuthCredentials } from "../oauth/types";

/** Far-future epoch ms: credentials that never expire (durable minted keys, session JWTs). */
export const NEVER_EXPIRES = 8.64e15;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Substitution values available to `{placeholder}` templates in KDL params/URLs. */
export type TemplateVars = Record<string, string | undefined>;

function missingHook(kind: string, name: string): never {
	throw new AIError.ConfigurationError(`auth rules reference unknown ${kind} hook "${name}"`);
}

export async function loadLoginHook(name: string): Promise<LoginHook> {
	return (HOOKS.login[name] ?? missingHook("login", name))();
}

export async function loadRefreshHook(name: string): Promise<RefreshHook> {
	return (HOOKS.refresh[name] ?? missingHook("refresh", name))();
}

export async function loadAfterExchangeHook(name: string): Promise<AfterExchangeHook> {
	return (HOOKS.afterExchange[name] ?? missingHook("after-exchange", name))();
}

export async function loadHeadersHook(name: string): Promise<HeadersHook> {
	return (HOOKS.headers[name] ?? missingHook("headers", name))();
}

async function loadValueHook(name: string): Promise<ValueHook> {
	return (HOOKS.value[name] ?? missingHook("value", name))();
}

/** Resolves a KDL value node: env overrides first, then the (possibly encoded) literal or hook. */
export async function resolveValue(value: CompiledAuthValue, signal?: AbortSignal): Promise<string> {
	for (const name of value.env ?? []) {
		const fromEnv = $env[name]?.trim();
		if (fromEnv) return fromEnv;
	}
	if (value.hook) return (await loadValueHook(value.hook))(signal);
	const literal = value.value ?? "";
	return value.encoding === "base64" ? atob(literal) : literal;
}

/** Replaces `{name}` placeholders; unknown or undefined placeholders resolve to the empty string. */
export function template(text: string, vars: TemplateVars): string {
	return text.replace(/\{([a-z_]+)\}/g, (_, key: string) => vars[key] ?? "");
}

function templateMap(map: Record<string, string>, vars: TemplateVars): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key in map) out[key] = template(map[key], vars);
	return out;
}

/** Reads a dot path (`data.user.email`) from a parsed JSON body. */
export function jsonPath(body: unknown, path: string): unknown {
	let current: unknown = body;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Decodes a JWT payload without verification; `null` for malformed tokens. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		return decoded !== null && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Epoch ms of a JWT `exp` claim minus `skewMs`, or undefined when absent. */
export function jwtExpiryMs(token: string, skewMs: number): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 - skewMs : undefined;
}

function scalarString(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 0 ? value : undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function readField(field: CompiledCredentialField | undefined, body: unknown, claims: Record<string, unknown> | null) {
	if (!field) return undefined;
	if (field.path !== undefined) {
		const value = scalarString(jsonPath(body, field.path));
		if (value !== undefined) return value;
	}
	for (const claim of field.claim ?? []) {
		const value = scalarString(claims?.[claim]);
		if (value !== undefined) return value;
	}
	return field.literal;
}

/**
 * Projects a token response onto `OAuthCredentials` per the rule's
 * `credential` map. A missing refresh token keeps `previous.refresh` (refresh
 * grants that do not rotate) or falls back to the empty string.
 */
export function mapCredentials(
	map: CompiledCredentialMap,
	body: unknown,
	provider: string,
	previous?: OAuthCredentials,
): OAuthCredentials {
	const accessNoClaims = readField(map.access, body, null);
	const claims = accessNoClaims ? decodeJwtPayload(accessNoClaims) : null;
	const access = accessNoClaims ?? readField(map.access, body, claims);
	if (!access) {
		// Include the body: providers that wrap errors in a 200 envelope
		// (`{ code, msg, success }`) only explain the failure there.
		const excerpt = typeof body === "string" ? body : JSON.stringify(body);
		throw new AIError.OAuthError(
			`${provider} token response missing access token: ${(excerpt ?? "").slice(0, 500)}`,
			{ kind: "validation", provider },
		);
	}
	let expires: number;
	const expiry = map.expires;
	switch (expiry.mode) {
		case "never":
			expires = NEVER_EXPIRES;
			break;
		case "jwt":
			expires = jwtExpiryMs(access, expiry.skewMs) ?? Date.now() + (expiry.fallbackMs ?? 60 * 60 * 1000);
			break;
		case "seconds": {
			const seconds = jsonPath(body, expiry.path);
			if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
				throw new AIError.OAuthError(`${provider} token response missing ${expiry.path}`, {
					kind: "validation",
					provider,
				});
			}
			const from = expiry.fromPath ? jsonPath(body, expiry.fromPath) : undefined;
			const base = typeof from === "number" && Number.isFinite(from) ? from * 1000 : Date.now();
			expires = base + seconds * 1000 - expiry.skewMs;
			break;
		}
	}
	const credentials: OAuthCredentials = {
		access,
		refresh: readField(map.refresh, body, claims) ?? previous?.refresh ?? "",
		expires,
	};
	const optional = ["email", "accountId", "orgId", "orgName", "projectId", "apiEndpoint", "enterpriseUrl"] as const;
	for (const key of optional) {
		const value = readField(map[key], body, claims);
		if (value !== undefined) credentials[key] = value;
	}
	return credentials;
}

export interface RequestContext {
	provider: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
	/** Extra headers merged under the rule's declared headers. */
	headers?: Record<string, string>;
}

/**
 * Performs one declared token-style POST. `standardParams` are the grant's
 * baseline (included when the rule keeps `standard=#true`), `params` the
 * rule's declared extras; both are templated with `vars`.
 */
export async function postTokenRequest(
	request: CompiledOAuthRequest,
	standardParams: Record<string, string | undefined>,
	vars: TemplateVars,
	context: RequestContext,
	errorKind: "token-exchange" | "token-refresh" | "device-auth",
): Promise<{ body: unknown; response: Response }> {
	const url = template(await resolveValue(request.url, context.signal), vars);
	const params: Record<string, string> = {};
	if (request.standard) {
		for (const key in standardParams) {
			const value = standardParams[key];
			if (value !== undefined) params[key] = value;
		}
	}
	Object.assign(params, templateMap(request.params, vars));
	const headers: Record<string, string> = {
		...context.headers,
		...templateMap(request.headers, vars),
		"Content-Type": request.body === "json" ? "application/json" : "application/x-www-form-urlencoded",
	};
	const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await context.fetch(url, {
			method: "POST",
			headers,
			body: request.body === "json" ? JSON.stringify(params) : new URLSearchParams(params).toString(),
			signal,
		});
	} catch (cause) {
		if (context.signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(context.signal.reason)}`);
		}
		if (timeoutSignal.aborted) {
			throw new AIError.OAuthError(`Timed out waiting for ${url}`, { kind: "timeout", provider: context.provider });
		}
		throw new AIError.OAuthError(`${context.provider} request to ${url} failed: ${describeError(cause)}`, {
			kind: errorKind,
			provider: context.provider,
			cause,
		});
	}
	const text = await response.text();
	let body: unknown = undefined;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
	}
	if (!response.ok && errorKind !== "device-auth") {
		throw new AIError.OAuthError(
			`${context.provider} ${errorKind === "token-refresh" ? "token refresh" : "token exchange"} failed: ${response.status} ${text.slice(0, 500)}`,
			{ kind: errorKind, provider: context.provider, status: response.status },
		);
	}
	return { body: body ?? text, response };
}

/** Bearer GET declared by `userinfo`; failures leave identity fields unset. */
export async function applyUserinfo(
	userinfo: CompiledUserinfo | undefined,
	credentials: OAuthCredentials,
	context: RequestContext,
): Promise<OAuthCredentials> {
	if (!userinfo) return credentials;
	try {
		const response = await context.fetch(userinfo.url, {
			headers: { ...context.headers, Authorization: `Bearer ${credentials.access}` },
			signal: context.signal,
		});
		if (!response.ok) return credentials;
		const body: unknown = await response.json();
		const email = userinfo.email ? scalarString(jsonPath(body, userinfo.email)) : undefined;
		const accountId = userinfo.accountId ? scalarString(jsonPath(body, userinfo.accountId)) : undefined;
		return {
			...credentials,
			...(email !== undefined ? { email } : {}),
			...(accountId !== undefined ? { accountId } : {}),
		};
	} catch {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError();
		return credentials;
	}
}

/** Runs the rule's after-exchange / after-refresh hook, if declared. */
export async function applyAfterExchange(
	hook: string | undefined,
	credentials: OAuthCredentials,
	context: ExchangeContext,
): Promise<OAuthCredentials> {
	if (!hook) return credentials;
	return (await loadAfterExchangeHook(hook))(credentials, context);
}

export function describeError(error: unknown): string {
	if (error instanceof Error)
		return error.cause ? `${error.message} (cause: ${describeError(error.cause)})` : error.message;
	return String(error);
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
}
