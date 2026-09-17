/**
 * OpenCode Console OAuth (RFC 8628 device flow) credential handling.
 *
 * The Console device flow (`opencode-cli` at `opencode.ai/console`) issues a
 * console session token (`st_…`), not a Zen API key. Two separate lanes exist:
 *
 * - `https://opencode.ai/zen/v1` — the key lane OMP's catalog targets. It
 *   rejects `st_…` outright (`401 Invalid API key.`).
 * - `https://opencode.ai/inference/openai/v1` — the console lane the OpenCode
 *   binary itself uses once signed in. It accepts `st_…` but requires the
 *   workspace header `x-opencode-org-id`, and inherits the same OpenCode
 *   client-identity gate (`User-Agent: opencode/*` + a well-formed
 *   `x-opencode-session`).
 *
 * Because the bare bearer alone is not a usable credential, the exchange
 * resolves the account's workspace and stores a structured credential that
 * `opencodeZenTransport` unpacks per request. Plain Zen API keys (`sk-…`) do
 * not parse as that shape and pass through untouched.
 */
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { AfterExchangeHook, ExchangeContext } from "../hooks/types";
import type { OAuthCredentials } from "./types";

const PROVIDER = "opencode-zen";
/** Console origin the device flow authenticates against. */
const CONSOLE_ORIGIN = "https://opencode.ai/console";
/** Console inference lane; `/zen/v1` does not accept console session tokens. */
export const OPENCODE_CONSOLE_INFERENCE_BASE_URL = "https://opencode.ai/inference/openai/v1";
/** Header the console lane uses to pick the billing workspace. */
export const OPENCODE_CONSOLE_ORG_HEADER = "x-opencode-org-id";
const REQUEST_TIMEOUT_MS = 20_000;

const organizationSchema = type({ id: "string", name: "string" });
const organizationListSchema = organizationSchema.array();

const configSchema = type({
	config: type({
		provider: type({
			opencode: type({
				"api?": "string",
				"options?": type({
					"headers?": { "[string]": "string" },
				}),
			}),
		}),
	}),
});

/**
 * Structured credential stored in `credentials.access` for a Console OAuth
 * login. `baseUrl` is captured from `/api/config` so a server-side lane move
 * does not require an OMP release.
 */
const openCodeZenCredentialSchema = type({
	token: "string",
	orgId: "string",
	"orgName?": "string",
	"baseUrl?": "string",
});
export type OpenCodeZenOAuthCredential = typeof openCodeZenCredentialSchema.infer;

/**
 * Decode a stored OAuth credential. Returns `undefined` for anything that is
 * not the structured shape — notably a plain `sk-…` Zen API key, which keeps
 * the key lane working unchanged.
 */
export function parseOpenCodeZenCredential(value: string | undefined): OpenCodeZenOAuthCredential | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const parsed = openCodeZenCredentialSchema(payload);
	if (parsed instanceof type.errors || !parsed.token.trim() || !parsed.orgId.trim()) return undefined;
	return parsed;
}

export function encodeOpenCodeZenCredential(credential: OpenCodeZenOAuthCredential): string {
	return JSON.stringify(credential);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(url: string, accessToken: string, context: ExchangeContext, orgId?: string): Promise<unknown> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": "opencode/1.18.31",
	};
	if (orgId) headers[OPENCODE_CONSOLE_ORG_HEADER] = orgId;
	const response = await context.fetch(url, { headers, signal: requestSignal(context.signal) });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new AIError.OAuthError(
			`OpenCode Console ${url} returned ${response.status}${text.trim() ? `: ${text.slice(0, 300).trim()}` : ""}`,
			{ kind: "token-exchange", provider: PROVIDER, status: response.status },
		);
	}
	return response.json();
}

/**
 * Resolve the workspace an OAuth login is scoped to and the console lane's
 * base URL, then re-encode `access` as the structured credential.
 *
 * Workspace choice mirrors the OpenCode binary: prefer the workspace already
 * stored on the credential (a refresh keeps its binding), otherwise take the
 * first entry of `/api/orgs` sorted by name then id.
 */
export const openCodeZenOrgHook: AfterExchangeHook = async (
	credentials: OAuthCredentials,
	context: ExchangeContext,
): Promise<OAuthCredentials> => {
	const existing = parseOpenCodeZenCredential(credentials.access);
	const accessToken = existing?.token ?? credentials.access;
	const requestContext = { ...context, fetch: context.fetch as FetchImpl };

	const rawOrgs = await getJson(`${CONSOLE_ORIGIN}/api/orgs`, accessToken, requestContext);
	const parsedOrgs = organizationListSchema(rawOrgs);
	if (parsedOrgs instanceof type.errors || parsedOrgs.length === 0) {
		throw new AIError.OAuthError("OpenCode Console account has no workspace available", {
			kind: "entitlement",
			provider: PROVIDER,
		});
	}
	const pinned = credentials.orgId ?? existing?.orgId;
	const selected =
		(pinned ? parsedOrgs.find(org => org.id === pinned) : undefined) ??
		parsedOrgs
			.slice()
			.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0];

	const rawConfig = await getJson(`${CONSOLE_ORIGIN}/api/config`, accessToken, requestContext, selected.id);
	const parsedConfig = configSchema(rawConfig);
	if (parsedConfig instanceof type.errors) {
		throw new AIError.OAuthError("OpenCode Console returned an unrecognized provider config", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const providerConfig = parsedConfig.config.provider.opencode;
	const baseUrl = providerConfig.api?.trim() || OPENCODE_CONSOLE_INFERENCE_BASE_URL;

	return {
		...credentials,
		access: encodeOpenCodeZenCredential({
			token: accessToken,
			orgId: selected.id,
			orgName: selected.name,
			baseUrl,
		}),
		accountId: credentials.accountId ?? selected.id,
		orgId: selected.id,
		orgName: selected.name,
	};
};
