/**
 * Kiro auth flows behind `login "custom" hook="kiro-login"` /
 * `refresh hook="kiro-refresh"` (`rules/auth/kiro.kdl`): AWS IAM Identity
 * Center and Builder ID (SSO-OIDC device grant), Google/GitHub (Kiro's own
 * social device flow), and `ksk_…` API keys.
 *
 * No Kiro sign-in returns an account claim, so each login mints a random
 * `accountId`; it survives refresh and keys the model cache and account pools.
 */
import {
	fetchKiroModels,
	type KiroProfile,
	listKiroProfiles,
	resolveKiroApiKeyRegion,
} from "@oh-my-pi/pi-catalog/discovery/kiro";
import {
	decodeKiroCredential,
	encodeKiroCredential,
	KIRO_API_KEY_PREFIX,
	KIRO_BOOTSTRAP_REGIONS,
	isKiroRegion,
	kiroProfileRegion,
} from "@oh-my-pi/pi-catalog/wire/kiro";
import {
	type KiroCliAttempt,
	KIRO_CLI_SOCIAL_CLIENT_ID,
	KIRO_CLI_SOCIAL_HEADERS,
	kiroCliOidcHeaders,
} from "@oh-my-pi/pi-catalog/wire/kiro-cli";
import { fetchWithRetry, isRecord, prompt } from "@oh-my-pi/pi-utils";
import { readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import * as AIError from "../../error";
import { throwIfCancelled } from "../engine/common";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import kiroLoginMethodPrompt from "./prompts/kiro-login-method.md" with { type: "text" };
import kiroProfileSelectPrompt from "./prompts/kiro-profile-select.md" with { type: "text" };
import type { OAuthController, OAuthCredentials, OAuthPrompt } from "./types";

const PROVIDER = "kiro";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_ATTEMPTS = 3;
/** Access-token lifetime assumed when a token response names none (the social service omits it). */
const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;
const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
/** Builder ID: the public Builder portal in us-east-1, with no organization and so no profile. */
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const BUILDER_ID_REGION = "us-east-1";
/** Kiro's auth service behind Google/GitHub sign-in; it needs no client registration. */
const SOCIAL_AUTH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev";
/** The profile the Kiro CLI assigns a social account that lists none; the runtime rejects a bearer without one. */
const SOCIAL_DEFAULT_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
/** AWS SSO-OIDC refresh errors (`error`, or the `__type` exception name) no retry can fix. */
const DEFINITIVE_OIDC_ERRORS: Record<string, true> = {
	invalid_grant: true,
	InvalidGrantException: true,
	expired_token: true,
	ExpiredTokenException: true,
	invalid_client: true,
	InvalidClientException: true,
};
const LOGIN_METHODS = ["idc", "builder", "api", "google", "github"] as const;

type RequestContext = Pick<OAuthController, "fetch" | "signal">;
type JsonResponse = { ok: boolean; status: number; data: unknown };

function oauthError(message: string, options: AIError.OAuthErrorOptions): AIError.OAuthError {
	return new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER, ...options });
}

const incompleteRefreshState = (): AIError.OAuthError =>
	oauthError("Kiro refresh state is incomplete; run /login kiro again", { kind: "configuration", definitive: true });

/**
 * POST a JSON body and read a bounded JSON reply (`data` is undefined when the
 * body is not JSON). Transport errors, 429 and 5xx retry; each attempt rebuilds
 * its headers so `amz-sdk-request` carries the attempt number.
 */
async function postJson(
	ctx: RequestContext,
	url: string,
	body: unknown,
	headers: (attempt: KiroCliAttempt) => Record<string, string>,
): Promise<JsonResponse> {
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
			? oauthError("Kiro request timed out", { kind: "timeout", cause })
			: oauthError("Kiro request failed", { kind: "http", cause });
	}
}

/** A device poll; a timed-out poll request is retried on the next interval rather than failing the login. */
async function pollJson(
	ctx: RequestContext,
	url: string,
	body: unknown,
	headers: (attempt: KiroCliAttempt) => Record<string, string>,
): Promise<JsonResponse | undefined> {
	try {
		return await postJson(ctx, url, body, headers);
	} catch (error) {
		if (error instanceof AIError.OAuthError && error.kind === "timeout") return undefined;
		throw error;
	}
}

const socialHeaders = (): Record<string, string> => ({ ...KIRO_CLI_SOCIAL_HEADERS });

function requireOk(response: JsonResponse, message: string): Record<string, unknown> {
	if (!response.ok)
		throw oauthError(`${message}: HTTP ${response.status}`, { kind: "device-auth", status: response.status });
	if (!isRecord(response.data)) throw oauthError("Kiro returned an invalid response", {});
	return response.data;
}

function field(data: Record<string, unknown>, key: string): string {
	const value = data[key];
	if (typeof value !== "string" || value.length === 0) throw oauthError(`Kiro response missing ${key}`, {});
	return value;
}

function positive(data: Record<string, unknown>, key: string): number {
	const value = data[key];
	if (typeof value !== "number" || !(value > 0)) throw oauthError(`Kiro response has invalid ${key}`, {});
	return value;
}

/**
 * Tokens from an OIDC or social token response. Refresh replies may omit the
 * refresh token (it is kept) and the social service may omit the lifetime
 * (`expiresIn` seconds, else ISO `expiresAt`, else the default).
 */
function parseTokens(data: unknown, currentRefresh?: string): OAuthCredentials {
	if (!isRecord(data)) throw oauthError("Kiro returned invalid token data", {});
	const access = field(data, "accessToken");
	const refresh = typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : currentRefresh;
	if (!refresh) throw oauthError("Kiro response missing refreshToken", {});
	const now = Date.now();
	const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
	const expires =
		typeof data.expiresIn === "number" && data.expiresIn > 0
			? now + data.expiresIn * 1000
			: expiresAt > now
				? expiresAt
				: now + DEFAULT_TOKEN_LIFETIME_MS;
	return { access, refresh, expires };
}

async function ask(ctrl: OAuthController, request: OAuthPrompt, field: string): Promise<string> {
	if (!ctrl.onPrompt) throw new AIError.OnPromptRequiredError(field);
	const answer = await ctrl.onPrompt(request);
	throwIfCancelled(ctrl.signal);
	return answer;
}

function showCode(ctrl: OAuthController, url: string, instructions: string): void {
	if (!ctrl.onAuth) throw new AIError.OnPromptRequiredError("Kiro browser authorization");
	ctrl.onAuth({ url, instructions });
	ctrl.onProgress?.("Waiting for device authorization...");
}

/**
 * The ARN embeds the AWS account id, so a profile is labelled by its name, else
 * `fallback`, else the ARN's trailing segment.
 */
function profileLabel(profile: KiroProfile, fallback?: string): string {
	return sanitizeText(profile.name ?? "").trim() || fallback || profile.arn.slice(profile.arn.lastIndexOf("/") + 1);
}

function profileRow(profileArn: string, orgName: string): Partial<OAuthCredentials> {
	return { kiroProfileArn: profileArn, region: kiroProfileRegion(profileArn), orgName };
}

/**
 * Profiles the bearer sees across the bootstrap regions, deduplicated by ARN.
 * An empty result is trusted only when every region answered: a failed
 * region may hold the account's only profile.
 */
async function listBootstrapProfiles(ctx: RequestContext, token: string): Promise<KiroProfile[]> {
	const results = await Promise.allSettled(
		KIRO_BOOTSTRAP_REGIONS.map(region => listKiroProfiles({ region, token, fetch: ctx.fetch, signal: ctx.signal })),
	);
	throwIfCancelled(ctx.signal);
	const profiles = results.flatMap(result => (result.status === "fulfilled" ? result.value : []));
	const failure = results.find(result => result.status === "rejected");
	if (profiles.length === 0 && failure) {
		throw oauthError("Unable to discover Kiro profiles", { kind: "discovery", cause: failure.reason });
	}
	return [...new Map(profiles.map(profile => [profile.arn, profile])).values()];
}

async function pickProfile(
	ctrl: OAuthController,
	profiles: KiroProfile[],
	fallbackLabel?: string,
): Promise<Partial<OAuthCredentials>> {
	let profile = profiles[0]!;
	if (profiles.length > 1) {
		const entries = profiles.map((entry, index) => ({ number: index + 1, label: profileLabel(entry) }));
		const message = prompt.render(kiroProfileSelectPrompt, { profiles: entries });
		const answer = await ask(ctrl, { message, placeholder: "1" }, "Kiro profile selection");
		const selected = profiles[Number(answer) - 1];
		if (!selected) throw oauthError("Invalid Kiro profile selection", {});
		profile = selected;
	}
	return profileRow(profile.arn, profileLabel(profile, fallbackLabel));
}

/** IAM Identity Center or Builder ID: register an OIDC client, run the device grant, then pick a profile. */
async function loginDevice(ctrl: OAuthController, startUrl: string, oidcRegion: string): Promise<OAuthCredentials> {
	const oidc = `https://oidc.${oidcRegion}.amazonaws.com`;
	const registration = { clientName: "Kiro CLI", clientType: "public", scopes: SCOPES };
	const client = requireOk(
		await postJson(ctrl, `${oidc}/client/register`, registration, kiroCliOidcHeaders),
		"Kiro client registration failed",
	);
	const clientId = field(client, "clientId");
	const clientSecret = field(client, "clientSecret");
	const device = requireOk(
		await postJson(ctrl, `${oidc}/device_authorization`, { clientId, clientSecret, startUrl }, kiroCliOidcHeaders),
		"Kiro device authorization failed",
	);
	const deviceCode = field(device, "deviceCode");
	showCode(ctrl, field(device, "verificationUriComplete"), `Confirm code ${field(device, "userCode")} in the browser`);
	const tokens = await pollOAuthDeviceCodeFlow<OAuthCredentials>({
		poll: async () => {
			const grant = {
				clientId,
				clientSecret,
				deviceCode,
				grantType: "urn:ietf:params:oauth:grant-type:device_code",
			};
			const response = await pollJson(ctrl, `${oidc}/token`, grant, kiroCliOidcHeaders);
			if (!response) return { status: "pending" };
			const error = isRecord(response.data) ? response.data.error : undefined;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			return { status: "complete", value: parseTokens(requireOk(response, "Kiro device authorization rejected")) };
		},
		intervalSeconds: positive(device, "interval"),
		expiresInSeconds: positive(device, "expiresIn"),
		signal: ctrl.signal,
	});
	const login: OAuthCredentials = {
		...tokens,
		accountId: crypto.randomUUID(),
		kiroClientId: clientId,
		kiroClientSecret: clientSecret,
		kiroOidcRegion: oidcRegion,
	};
	if (startUrl === BUILDER_ID_START_URL) return { ...login, region: BUILDER_ID_REGION };
	const profiles = await listBootstrapProfiles(ctrl, tokens.access);
	if (profiles.length === 0) throw oauthError("No Kiro profiles are available", { kind: "discovery" });
	return { ...login, ...(await pickProfile(ctrl, profiles)) };
}

/**
 * Google/GitHub through Kiro's social device flow. The poll answers HTTP 200
 * with its state in `status`. The poll's profile ARN wins; otherwise a listed
 * profile is picked, and only an account that lists none (every region
 * answered) takes the profile the Kiro CLI assigns social users.
 */
async function loginSocial(ctrl: OAuthController, loginProvider: "Google" | "Github"): Promise<OAuthCredentials> {
	const label = loginProvider === "Github" ? "GitHub" : loginProvider;
	const device = requireOk(
		await postJson(
			ctrl,
			`${SOCIAL_AUTH_URL}/oauth/device/authorization`,
			{ clientId: KIRO_CLI_SOCIAL_CLIENT_ID, loginProvider },
			socialHeaders,
		),
		"Kiro device authorization failed",
	);
	const deviceCode = field(device, "deviceCode");
	const userCode = field(device, "userCode");
	showCode(
		ctrl,
		field(device, "verificationUriComplete"),
		`Confirm code ${userCode} in the browser and sign in with ${label}`,
	);
	const completed = await pollOAuthDeviceCodeFlow<Record<string, unknown>>({
		poll: async () => {
			const response = await pollJson(
				ctrl,
				`${SOCIAL_AUTH_URL}/oauth/device/poll`,
				{ deviceCode, clientId: KIRO_CLI_SOCIAL_CLIENT_ID },
				socialHeaders,
			);
			if (!response) return { status: "pending" };
			const data = requireOk(response, "Kiro device poll failed");
			if (data.status === "authorization_pending") return { status: "pending" };
			if (data.status === "slow_down") return { status: "slow_down" };
			if (!data.accessToken) throw oauthError(`Kiro ${label} sign-in was not completed`, { kind: "device-auth" });
			return { status: "complete", value: data };
		},
		intervalSeconds: positive(device, "intervalInMilliseconds") / 1000,
		expiresInSeconds: positive(device, "expiresInMilliseconds") / 1000,
		signal: ctrl.signal,
	});
	const login = { ...parseTokens(completed), accountId: crypto.randomUUID() };
	if (kiroProfileRegion(completed.profileArn))
		return { ...login, ...profileRow(completed.profileArn as string, label) };
	const profiles = await listBootstrapProfiles(ctrl, login.access);
	const profile =
		profiles.length > 0 ? await pickProfile(ctrl, profiles, label) : profileRow(SOCIAL_DEFAULT_PROFILE_ARN, label);
	return { ...login, ...profile };
}

/** Pin a `ksk_` key to its region (`KIRO_API_REGION`, else the one bootstrap region that accepts it) and probe its models. */
async function loginApiKey(ctrl: OAuthController): Promise<string> {
	const input = await ask(
		ctrl,
		{ message: "Paste your Kiro API key", placeholder: "ksk_...", secret: true },
		"Kiro API key",
	);
	const token = input.trim();
	if (!token.startsWith(KIRO_API_KEY_PREFIX)) throw oauthError("Kiro API keys must use the ksk_… format", {});
	const pinned = decodeKiroCredential(token).region;
	const region = pinned ?? (await resolveKiroApiKeyRegion({ token, fetch: ctrl.fetch, signal: ctrl.signal }));
	throwIfCancelled(ctrl.signal);
	if (!region) {
		throw oauthError("Kiro API key did not resolve to one region; set KIRO_API_REGION to the key's AWS region", {
			kind: "discovery",
		});
	}
	const credential = { kind: "api_key" as const, token, region };
	const models = await fetchKiroModels({ credential, fetch: ctrl.fetch, signal: ctrl.signal });
	throwIfCancelled(ctrl.signal);
	if (!models) throw oauthError(`Kiro API key lists no models in ${region}`, { kind: "discovery" });
	return encodeKiroCredential(credential);
}

/** `login "custom" hook="kiro-login"`: Identity Center / Builder ID / API key / Google / GitHub. */
export async function loginKiroHook(ctrl: OAuthController): Promise<OAuthCredentials | string> {
	const answer = (
		await ask(ctrl, { message: prompt.render(kiroLoginMethodPrompt), placeholder: "1" }, "Kiro login method")
	)
		.trim()
		.toLowerCase();
	const method = LOGIN_METHODS[Number(answer) - 1] ?? LOGIN_METHODS.find(name => name === answer);
	switch (method) {
		case "idc": {
			const startUrl = (await ask(ctrl, { message: "Enter Start URL" }, "Start URL")).trim();
			if (!URL.canParse(startUrl) || new URL(startUrl).protocol !== "https:") {
				throw oauthError("Invalid AWS access portal URL", {});
			}
			const region = (await ask(ctrl, { message: "Enter Region" }, "Region")).trim();
			if (!isKiroRegion(region)) throw oauthError("Invalid AWS Identity Center Region", {});
			return loginDevice(ctrl, startUrl, region);
		}
		case "builder":
			return loginDevice(ctrl, BUILDER_ID_START_URL, BUILDER_ID_REGION);
		case "api":
			return loginApiKey(ctrl);
		case "google":
			return loginSocial(ctrl, "Google");
		case "github":
			return loginSocial(ctrl, "Github");
		default:
			throw oauthError("Invalid Kiro authentication selection", {});
	}
}

/**
 * `refresh hook="kiro-refresh"`. A row with an OIDC client refreshes against
 * `oidc.{kiroOidcRegion}`; one without is a social login refreshed by the Kiro
 * auth service, which may move it to another profile. Failures no retry can
 * repair fail `definitive`, so the row is disabled with a re-login hint.
 */
export async function refreshKiroHook(current: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (!current.refresh) throw incompleteRefreshState();
	if (!current.kiroClientId) {
		const response = await postJson(
			{ signal },
			`${SOCIAL_AUTH_URL}/refreshToken`,
			{ refreshToken: current.refresh },
			socialHeaders,
		);
		if (!response.ok) {
			const definitive = response.status === 400 || response.status === 401;
			const message = definitive
				? `Kiro sign-in expired (HTTP ${response.status}); run /login kiro again`
				: `Kiro refresh failed: HTTP ${response.status}`;
			throw oauthError(message, { kind: "token-refresh", status: response.status, definitive });
		}
		const moved = isRecord(response.data) ? response.data.profileArn : undefined;
		const profileArn = kiroProfileRegion(moved) ? (moved as string) : current.kiroProfileArn;
		const region = kiroProfileRegion(profileArn);
		if (!region) throw incompleteRefreshState();
		return { ...current, ...parseTokens(response.data, current.refresh), kiroProfileArn: profileArn, region };
	}
	if (!current.kiroClientSecret || !current.kiroOidcRegion) throw incompleteRefreshState();
	const response = await postJson(
		{ signal },
		`https://oidc.${current.kiroOidcRegion}.amazonaws.com/token`,
		{
			grantType: "refresh_token",
			refreshToken: current.refresh,
			clientId: current.kiroClientId,
			clientSecret: current.kiroClientSecret,
		},
		kiroCliOidcHeaders,
	);
	if (!response.ok) {
		const data = isRecord(response.data) ? response.data : {};
		const code =
			String(data.error ?? data.__type ?? "")
				.split("#")
				.at(-1) ?? "";
		const definitive = DEFINITIVE_OIDC_ERRORS[code] === true;
		const message = definitive
			? `Kiro refresh was rejected (${code}); run /login kiro again`
			: `Kiro refresh failed: HTTP ${response.status}`;
		throw oauthError(message, { kind: "token-refresh", status: response.status, definitive });
	}
	return { ...current, ...parseTokens(response.data, current.refresh) };
}
