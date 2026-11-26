/**
 * AWS IAM Identity Center sign-in over SSO-OIDC, shared by Kiro's Identity
 * Center / Builder ID login (`kiro.ts`) and the Bedrock SSO renewal
 * (`providers/aws-sso-login.ts`): bounded JSON calls, client registration, and
 * the device-code grant.
 */
import { fetchWithRetry, isRecord } from "@oh-my-pi/pi-utils";
import { readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import * as AIError from "../../error";
import { throwIfCancelled } from "../engine/common";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_ATTEMPTS = 3;

export type RequestContext = Pick<OAuthController, "fetch" | "signal">;
/** `data` is undefined when the body is not JSON. */
export type JsonResponse = { ok: boolean; status: number; data: unknown };
export interface RequestAttempt {
	attempt: number;
	maxAttempts: number;
}
/** Headers for one attempt; rebuilt per attempt so a header may carry the attempt number. */
export type RequestHeaders = (attempt: RequestAttempt) => Record<string, string>;

/** JSON-over-HTTPS calls whose errors name {@link label} and carry {@link provider}. */
export interface JsonApi {
	readonly provider: string;
	readonly label: string;
	error(message: string, options?: AIError.OAuthErrorOptions): AIError.OAuthError;
	/** POST `body` and read a bounded JSON reply. Transport errors, 429 and 5xx retry. */
	post(ctx: RequestContext, url: string, body: unknown, headers: RequestHeaders): Promise<JsonResponse>;
	/** A device poll; a timed-out request yields `undefined` so the next interval retries it. */
	poll(ctx: RequestContext, url: string, body: unknown, headers: RequestHeaders): Promise<JsonResponse | undefined>;
	requireOk(response: JsonResponse, message: string): Record<string, unknown>;
	field(data: Record<string, unknown>, key: string): string;
	positive(data: Record<string, unknown>, key: string): number;
	/** Hand the verification URL to the UI and report that the device grant is waiting. */
	showCode(ctrl: OAuthController, url: string, instructions: string): void;
}

export function createJsonApi(provider: string, label: string): JsonApi {
	const error = (message: string, options: AIError.OAuthErrorOptions = {}): AIError.OAuthError =>
		new AIError.OAuthError(message, { kind: "validation", provider, ...options });
	const post = async (
		ctx: RequestContext,
		url: string,
		body: unknown,
		headers: RequestHeaders,
	): Promise<JsonResponse> => {
		throwIfCancelled(ctx.signal);
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		try {
			const response = await fetchWithRetry(url, {
				method: "POST",
				body: JSON.stringify(body),
				signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
				fetch: ctx.fetch,
				maxAttempts: MAX_ATTEMPTS,
				prepareInit: attempt => ({ headers: headers({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS }) }),
			});
			const data = await readBoundedJson(response, MAX_RESPONSE_BYTES).catch(() => undefined);
			return { ok: response.ok, status: response.status, data };
		} catch (cause) {
			throwIfCancelled(ctx.signal);
			throw timeout.aborted
				? error(`${label} request timed out`, { kind: "timeout", cause })
				: error(`${label} request failed`, { kind: "http", cause });
		}
	};
	return {
		provider,
		label,
		error,
		post,
		poll: async (ctx, url, body, headers) => {
			try {
				return await post(ctx, url, body, headers);
			} catch (cause) {
				if (cause instanceof AIError.OAuthError && cause.kind === "timeout") return undefined;
				throw cause;
			}
		},
		requireOk: (response, message) => {
			if (!response.ok)
				throw error(`${message}: HTTP ${response.status}`, { kind: "device-auth", status: response.status });
			if (!isRecord(response.data)) throw error(`${label} returned an invalid response`);
			return response.data;
		},
		field: (data, key) => {
			const value = data[key];
			if (typeof value !== "string" || value.length === 0) throw error(`${label} response missing ${key}`);
			return value;
		},
		positive: (data, key) => {
			const value = data[key];
			if (typeof value !== "number" || !(value > 0)) throw error(`${label} response has invalid ${key}`);
			return value;
		},
		showCode: (ctrl, url, instructions) => {
			if (!ctrl.onAuth) throw new AIError.OnPromptRequiredError(`${label} browser authorization`);
			ctrl.onAuth({ url, instructions });
			ctrl.onProgress?.("Waiting for device authorization...");
		},
	};
}

export function ssoOidcEndpoint(region: string): string {
	return `https://oidc.${region}.amazonaws.com`;
}

/** A registered public OIDC client. */
export interface SsoOidcClient {
	clientId: string;
	clientSecret: string;
	/** `Date.now()`-style instant the registration lapses; absent when the service names none. */
	expiresAt?: number;
}

/** `POST /client/register` for a public client; `registration` adds `clientName`, `scopes`, grant types, …. */
export async function registerSsoOidcClient(
	api: JsonApi,
	ctx: RequestContext,
	region: string,
	registration: Record<string, unknown>,
	headers: RequestHeaders,
): Promise<SsoOidcClient> {
	const client = api.requireOk(
		await api.post(
			ctx,
			`${ssoOidcEndpoint(region)}/client/register`,
			{ clientType: "public", ...registration },
			headers,
		),
		`${api.label} client registration failed`,
	);
	const expiresAt = client.clientSecretExpiresAt;
	return {
		clientId: api.field(client, "clientId"),
		clientSecret: api.field(client, "clientSecret"),
		...(typeof expiresAt === "number" && expiresAt > 0 ? { expiresAt: expiresAt * 1000 } : {}),
	};
}

/**
 * The device-code grant for `startUrl`: shows the verification URL and code
 * through `onAuth`, polls `/token` until the user approves, and returns the
 * token reply (`accessToken`, `expiresIn`, and `refreshToken` when the client
 * registered scopes).
 */
export async function ssoOidcDeviceGrant(
	api: JsonApi,
	ctrl: OAuthController,
	region: string,
	client: SsoOidcClient,
	startUrl: string,
	headers: RequestHeaders,
): Promise<Record<string, unknown>> {
	const endpoint = ssoOidcEndpoint(region);
	const { clientId, clientSecret } = client;
	const device = api.requireOk(
		await api.post(ctrl, `${endpoint}/device_authorization`, { clientId, clientSecret, startUrl }, headers),
		`${api.label} device authorization failed`,
	);
	const deviceCode = api.field(device, "deviceCode");
	api.showCode(
		ctrl,
		api.field(device, "verificationUriComplete"),
		`Confirm code ${api.field(device, "userCode")} in the browser`,
	);
	return pollOAuthDeviceCodeFlow<Record<string, unknown>>({
		poll: async () => {
			const grant = {
				clientId,
				clientSecret,
				deviceCode,
				grantType: "urn:ietf:params:oauth:grant-type:device_code",
			};
			const response = await api.poll(ctrl, `${endpoint}/token`, grant, headers);
			if (!response) return { status: "pending" };
			const error = isRecord(response.data) ? response.data.error : undefined;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			return { status: "complete", value: api.requireOk(response, `${api.label} device authorization rejected`) };
		},
		intervalSeconds: api.positive(device, "interval"),
		expiresInSeconds: api.positive(device, "expiresIn"),
		signal: ctrl.signal,
	});
}
