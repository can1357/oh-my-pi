/**
 * Kiro auth flows behind `login "custom" hook="kiro-login"` /
 * `refresh hook="kiro-refresh"` (`rules/auth/kiro.kdl`).
 *
 * Five login methods: AWS IAM Identity Center device flow, Builder ID device
 * flow (no organization, so no profile is selected), Google and GitHub sign-in
 * through Kiro's own social device flow, and `ksk_…` API-key validation against
 * the management route. Reached through the lazy hook tables so the
 * OIDC/device polling graph stays out of eager startup. Uses only
 * `OAuthController` surface (`onPrompt` numbered lists — there is no `onSelect`
 * or login cache in the declarative registry).
 */
import type { KiroApiKeyBootstrapResult, KiroProfileSummary } from "@oh-my-pi/pi-catalog/discovery/kiro";
import {
	kiroManagementRequest,
	listKiroAvailableProfiles,
	probeKiroApiKeyBootstrap,
	sanitizeKiroModelCatalog,
} from "@oh-my-pi/pi-catalog/discovery/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	extractKiroProfileSegment,
	KIRO_API_KEY_PREFIX,
	KIRO_BOOTSTRAP_REGIONS,
	kiroRuntimeBaseUrl,
	parseKiroProfileArn,
	resolveKiroApiRegion,
	validateKiroApiRegion,
} from "@oh-my-pi/pi-catalog/wire/kiro";
import {
	type KiroCliAttempt,
	kiroCliOidcHeaders,
	KIRO_CLI_SOCIAL_CLIENT_ID,
	KIRO_CLI_SOCIAL_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/kiro-cli";
import type { KiroSocialLoginProvider } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { BoundedJsonReadError, readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import * as AIError from "../../error";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import kiroLoginMethodPrompt from "./prompts/kiro-login-method.md" with { type: "text" };
import kiroProfileSelectPrompt from "./prompts/kiro-profile-select.md" with { type: "text" };
import type { OAuthController, OAuthCredentials, OAuthPrompt } from "./types";

const PROVIDER = "kiro";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const KIRO_CLIENT_NAME = "Kiro CLI";
const KIRO_AUTH_MAX_ATTEMPTS = 3;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Kiro's own auth service, behind Google and GitHub sign-in. Unlike AWS SSO
 * OIDC it needs no client registration — any stable client id works, as long
 * as the poll repeats the one that started the flow — and it reports device
 * durations in milliseconds.
 */
const KIRO_SOCIAL_AUTH_BASE_URL = "https://prod.us-east-1.auth.desktop.kiro.dev";
const socialHeaders = (): Record<string, string> => ({ ...KIRO_CLI_SOCIAL_HEADERS });
/** Access-token lifetime assumed when a social token response names none. */
const KIRO_SOCIAL_DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;
/**
 * The profile the Kiro CLI assigns a social account that lists none of its own.
 * The runtime rejects a social bearer sent without a profile ARN.
 */
export const KIRO_SOCIAL_DEFAULT_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
const KIRO_SOCIAL_LABELS: Readonly<Record<KiroSocialLoginProvider, string>> = { Google: "Google", Github: "GitHub" };

export const KIRO_IDENTITY_CENTER_SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
] as const;

/**
 * Builder ID is the free-tier sign-in. It uses the same OIDC device grant as IAM
 * Identity Center, pinned to the public Builder portal and us-east-1, and carries
 * no organization — so no Start URL, region, or profile is selected and the
 * service infers the profile from the bearer.
 */
export const KIRO_BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_BUILDER_ID_REGION = "us-east-1";

export interface KiroRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	apiRegion?: string;
}

export interface KiroProfileSelectionOptions extends KiroRequestOptions {
	onPrompt?: OAuthController["onPrompt"];
}

export interface KiroDeviceConfig {
	region?: string;
	startUrl?: string;
	/**
	 * Builder ID has no organization to select a profile from. The runtime region
	 * is then taken from the login region instead of a profile ARN.
	 */
	skipProfileSelection?: boolean;
}

type JsonRecord = Record<string, unknown>;

/** A request whose headers are built per attempt, so retries carry their attempt number. */
type KiroRequestInit = Omit<RequestInit, "headers"> & { headers: (attempt: KiroCliAttempt) => Record<string, string> };

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError();
}

async function requirePrompt(
	onPrompt: OAuthController["onPrompt"],
	prompt: OAuthPrompt,
	field: string,
): Promise<string> {
	if (!onPrompt) throw new AIError.OnPromptRequiredError(field);
	return onPrompt(prompt);
}

function record(value: unknown, message: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER });
	}
	return value as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new AIError.OAuthError(`Kiro response missing ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return value;
}

function positiveNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new AIError.OAuthError(`Kiro response has invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return value;
}

function registeredClientExpiry(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new AIError.OAuthError("Kiro response has invalid clientSecretExpiresAt", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return value === 0 ? 0 : (value as number) * 1000;
}

class KiroTransportError extends Error {
	readonly originalCause: unknown;

	constructor(cause: unknown) {
		super("Kiro request failed");
		this.name = "KiroTransportError";
		this.originalCause = cause;
	}
}

function retryableHttpStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

function retryableRequestError(error: unknown): boolean {
	return error instanceof KiroTransportError || (error instanceof AIError.OAuthError && error.kind === "timeout");
}

async function requestOnce(
	url: string,
	init: KiroRequestInit,
	attempt: KiroCliAttempt,
	options: KiroRequestOptions,
	bodyPolicy: "strict-json" | "allow-non-json-error" = "strict-json",
): Promise<{ response: Response; body: unknown }> {
	throwIfCancelled(options.signal);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await (options.fetch ?? fetch)(url, { ...init, headers: init.headers(attempt), signal });
		throwIfCancelled(options.signal);
		if (retryableHttpStatus(response.status)) {
			await response.body?.cancel();
			return { response, body: undefined };
		}
		if (!response.ok && bodyPolicy === "allow-non-json-error") {
			await response.body?.cancel();
			return { response, body: undefined };
		}
		const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
		return { response, body };
	} catch (cause) {
		throwIfCancelled(options.signal);
		if (timeout.aborted) {
			throw new AIError.OAuthError("Kiro request timed out", { kind: "timeout", provider: PROVIDER, cause });
		}
		if (cause instanceof BoundedJsonReadError) {
			const message =
				cause.kind === "size"
					? "Kiro response exceeded size limit"
					: cause.kind === "missing-body"
						? "Kiro response has no body"
						: "Kiro returned invalid JSON";
			throw new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER, cause });
		}
		if (cause instanceof AIError.OAuthError) throw cause;
		throw new KiroTransportError(cause);
	}
}

async function request(
	url: string,
	init: KiroRequestInit,
	options: KiroRequestOptions,
	kind: "http" | "token-exchange" | "token-refresh" | "device-auth" | "polling" = "http",
	bodyPolicy: "strict-json" | "allow-non-json-error" = "strict-json",
): Promise<{ response: Response; body: unknown }> {
	for (let attempt = 0; attempt < KIRO_AUTH_MAX_ATTEMPTS; attempt += 1) {
		throwIfCancelled(options.signal);
		try {
			const sdkAttempt = { attempt: attempt + 1, maxAttempts: KIRO_AUTH_MAX_ATTEMPTS };
			const result = await requestOnce(url, init, sdkAttempt, options, bodyPolicy);
			if (!retryableHttpStatus(result.response.status) || attempt === KIRO_AUTH_MAX_ATTEMPTS - 1) {
				return result;
			}
		} catch (cause) {
			throwIfCancelled(options.signal);
			if (!retryableRequestError(cause) || attempt === KIRO_AUTH_MAX_ATTEMPTS - 1) {
				if (cause instanceof KiroTransportError) {
					throw new AIError.OAuthError("Kiro request failed", {
						kind,
						provider: PROVIDER,
						cause: cause.originalCause,
					});
				}
				throw cause;
			}
		}
	}
	throw new AIError.OAuthError("Kiro request failed", { kind, provider: PROVIDER });
}

function credentials(body: unknown, fallbackRefresh?: string): OAuthCredentials {
	const data = record(body, "Kiro returned invalid token data");
	const access = requiredString(data.accessToken, "accessToken");
	const refresh =
		data.refreshToken === undefined
			? requiredString(fallbackRefresh, "refreshToken")
			: requiredString(data.refreshToken, "refreshToken");
	const expiresIn = positiveNumber(data.expiresIn, "expiresIn");
	return { access, refresh, expires: Date.now() + expiresIn * 1000 };
}

function normalizeApiKey(input: string): string {
	const withoutControls = input.replace(/[\x00-\x1f\x7f]/g, "").trim();
	const first = withoutControls[0];
	const token =
		(first === '"' || first === "'" || first === "`") && withoutControls.at(-1) === first
			? withoutControls.slice(1, -1).trim()
			: withoutControls;
	if (!new RegExp(`^${KIRO_API_KEY_PREFIX}[A-Za-z0-9._~+/-]+$`).test(token)) {
		throw new AIError.OAuthError("Kiro API keys must use the ksk_… format", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return token;
}

/**
 * Reject a key whose first `ListAvailableModels` page offers no usable model
 * and no further page: such a key would sign in and then list nothing.
 */
function assertKiroKeyCatalog(payload: unknown): void {
	const catalog = sanitizeKiroModelCatalog(payload);
	if (catalog.models.length === 0 && catalog.nextToken === undefined) {
		throw new Error("ListAvailableModels returned no usable models");
	}
}

export async function validateKiroApiKey(
	apiKey: string,
	options: KiroRequestOptions = {},
): Promise<{ type: "api_key"; key: string; apiEndpoint: string }> {
	const token = normalizeApiKey(apiKey);
	const explicitRegion = options.apiRegion === undefined ? undefined : validateKiroApiRegion(options.apiRegion);
	if (options.apiRegion !== undefined && !explicitRegion) {
		throw new AIError.OAuthError("KIRO_API_REGION is not a valid AWS region", {
			kind: "configuration",
			provider: PROVIDER,
		});
	}
	if (explicitRegion) {
		try {
			const payload = await kiroManagementRequest({
				apiRegion: explicitRegion,
				token,
				target: "ListAvailableModels",
				body: { origin: "KIRO_CLI" },
				fetch: options.fetch,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
			throwIfCancelled(options.signal);
			assertKiroKeyCatalog(payload);
			return { type: "api_key", key: token, apiEndpoint: kiroRuntimeBaseUrl(explicitRegion) };
		} catch (cause) {
			throwIfCancelled(options.signal);
			throw new AIError.OAuthError(`Kiro API key is not valid in ${explicitRegion}`, {
				kind: "discovery",
				provider: PROVIDER,
				cause,
			});
		}
	}

	let result: KiroApiKeyBootstrapResult | null;
	try {
		result = await probeKiroApiKeyBootstrap({ token, fetch: options.fetch, signal: options.signal });
		throwIfCancelled(options.signal);
	} catch (cause) {
		throwIfCancelled(options.signal);
		throw new AIError.OAuthError("Kiro API-key route discovery failed", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	if (!result) {
		throw new AIError.OAuthError(
			"Kiro API key did not resolve to exactly one route; set KIRO_API_REGION to the key's AWS region",
			{ kind: "discovery", provider: PROVIDER },
		);
	}
	try {
		assertKiroKeyCatalog(result.payload);
	} catch (cause) {
		throw new AIError.OAuthError("Kiro returned an invalid model catalog while validating the API key", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	return { type: "api_key", key: token, apiEndpoint: result.route.runtimeBaseUrl };
}

/**
 * Label a profile for the selection prompt without echoing its ARN: the ARN
 * embeds the AWS account id, which must never reach the terminal or logs.
 */
function profileLabel(profile: KiroProfileSummary): string {
	const profileName = sanitizeText(profile.profileName ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 128);
	if (profileName) return profileName;
	const region = parseKiroProfileArn(profile.arn)?.apiRegion;
	return region ? `Profile in ${region}` : "Unnamed profile";
}

async function chooseKiroProfile(
	profiles: KiroProfileSummary[],
	signal: AbortSignal | undefined,
	options: KiroProfileSelectionOptions,
): Promise<{ profileArn: string; profileName: string | undefined }> {
	if (profiles.length === 0) {
		throw new AIError.OAuthError("No Kiro profiles are available", { kind: "discovery", provider: PROVIDER });
	}
	let selected = profiles[0]!;
	if (profiles.length > 1) {
		const entries = profiles.map((profile, index) => ({ number: index + 1, label: profileLabel(profile) }));
		const answer = await requirePrompt(
			options.onPrompt,
			{ message: prompt.render(kiroProfileSelectPrompt, { profiles: entries }), placeholder: "1" },
			"Kiro profile selection",
		);
		throwIfCancelled(signal);
		const index = Number.parseInt(answer.trim(), 10) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= profiles.length) {
			throw new AIError.OAuthError("Invalid Kiro profile selection", { kind: "validation", provider: PROVIDER });
		}
		selected = profiles[index]!;
	}
	return { profileArn: selected.arn, profileName: selected.profileName };
}

export async function selectKiroProfile(
	token: string,
	apiRegion: string,
	options: KiroProfileSelectionOptions = {},
): Promise<{ profileArn: string; profileName: string | undefined }> {
	let profiles: KiroProfileSummary[];
	try {
		profiles = await listKiroAvailableProfiles({ apiRegion, token, fetch: options.fetch, signal: options.signal });
		throwIfCancelled(options.signal);
	} catch (cause) {
		throwIfCancelled(options.signal);
		throw new AIError.OAuthError("Unable to discover Kiro profiles", {
			kind: "discovery",
			provider: PROVIDER,
			cause,
		});
	}
	return chooseKiroProfile(profiles, options.signal, options);
}

/**
 * Every profile the bearer can see across the bootstrap regions, deduplicated
 * by ARN. One region failing does not hide the profiles another region
 * returned, but an empty result is only trusted when every region answered:
 * otherwise the listing failure is surfaced, since a failed region may hold
 * the account's only profile.
 */
async function listKiroBootstrapProfiles(token: string, options: KiroRequestOptions): Promise<KiroProfileSummary[]> {
	const profiles: KiroProfileSummary[] = [];
	let lastError: unknown;
	for (const apiRegion of KIRO_BOOTSTRAP_REGIONS) {
		try {
			profiles.push(
				...(await listKiroAvailableProfiles({
					apiRegion,
					token,
					fetch: options.fetch,
					signal: options.signal,
				})),
			);
		} catch (cause) {
			throwIfCancelled(options.signal);
			lastError = cause;
		}
	}
	if (profiles.length === 0 && lastError) {
		throw new AIError.OAuthError("Unable to discover Kiro profiles", {
			kind: "discovery",
			provider: PROVIDER,
			cause: lastError,
		});
	}
	return [...new Map(profiles.map(profile => [profile.arn, profile])).values()];
}

function validateStartUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new AIError.OAuthError("Invalid AWS access portal URL", { kind: "validation", provider: PROVIDER });
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.port !== "" ||
		(parsed.hostname !== "view.awsapps.com" && !parsed.hostname.endsWith(".awsapps.com")) ||
		parsed.pathname !== "/start" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError("Invalid AWS access portal URL", { kind: "validation", provider: PROVIDER });
	}
	return parsed.toString();
}

function validateOidcEndpoint(value: unknown, region: string, field: string): string {
	const endpoint = requiredString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch (cause) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	}
	const authority = endpoint.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== `oidc.${region}.amazonaws.com` ||
		parsed.port !== "" ||
		authority.includes(":") ||
		parsed.pathname !== "/token" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return endpoint;
}

function canonicalKiroTokenEndpoint(region: string): string {
	return validateOidcEndpoint(`https://oidc.${region}.amazonaws.com/token`, region, "tokenEndpoint");
}

function resolveKiroTokenEndpoint(value: unknown, region: string): string {
	if (value === undefined || value === null) {
		return canonicalKiroTokenEndpoint(region);
	}
	return validateOidcEndpoint(value, region, "tokenEndpoint");
}

function validateVerificationUri(value: unknown, field: string): string {
	const uri = requiredString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch (cause) {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	}
	if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
		throw new AIError.OAuthError(`Kiro returned an invalid ${field}`, { kind: "validation", provider: PROVIDER });
	}
	return uri;
}

function requiredUserCode(value: unknown): string {
	const userCode = requiredString(value, "userCode");
	if (userCode.length > 128 || /[\x00-\x1f\x7f]/.test(userCode)) {
		throw new AIError.OAuthError("Kiro returned an invalid userCode", { kind: "validation", provider: PROVIDER });
	}
	return userCode;
}

interface KiroRegisteredClient {
	clientId: string;
	clientSecret: string;
	clientSecretExpiresAt: number;
	tokenEndpoint: string;
}

function parseRegisteredClient(body: unknown, region: string): KiroRegisteredClient {
	const registration = record(body, "Invalid Kiro client registration");
	return {
		clientId: requiredString(registration.clientId, "clientId"),
		clientSecret: requiredString(registration.clientSecret, "clientSecret"),
		clientSecretExpiresAt: registeredClientExpiry(registration.clientSecretExpiresAt),
		tokenEndpoint: resolveKiroTokenEndpoint(registration.tokenEndpoint, region),
	};
}

async function registerKiroClient(options: KiroRequestOptions, region: string): Promise<KiroRegisteredClient> {
	const registered = await request(
		`https://oidc.${region}.amazonaws.com/client/register`,
		{
			method: "POST",
			headers: kiroCliOidcHeaders,
			body: JSON.stringify({
				clientName: KIRO_CLIENT_NAME,
				clientType: "public",
				scopes: KIRO_IDENTITY_CENTER_SCOPES,
			}),
		},
		{ fetch: options.fetch, signal: options.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!registered.response.ok) {
		throw new AIError.OAuthError(`Kiro client registration failed: HTTP ${registered.response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: registered.response.status,
		});
	}
	return parseRegisteredClient(registered.body, region);
}

async function resolveDeviceInputs(
	ctrl: OAuthController,
	config: KiroDeviceConfig,
): Promise<{ startUrl: string; region: string }> {
	const startUrlInput =
		config.startUrl ?? (await requirePrompt(ctrl.onPrompt, { message: "Enter Start URL" }, "Start URL"));
	const startUrl = validateStartUrl(startUrlInput.trim());

	const regionInput = config.region ?? (await requirePrompt(ctrl.onPrompt, { message: "Enter Region" }, "Region"));
	const region = validateKiroApiRegion(regionInput.trim());
	if (!region) {
		throw new AIError.OAuthError("Invalid AWS Identity Center Region", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return { startUrl, region };
}

interface KiroDeviceAuthorization {
	client: KiroRegisteredClient;
	region: string;
	startUrl: string;
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

async function startDeviceAuthorization(
	options: KiroRequestOptions,
	client: KiroRegisteredClient,
	region: string,
	startUrl: string,
): Promise<KiroDeviceAuthorization> {
	const authorized = await request(
		`https://oidc.${region}.amazonaws.com/device_authorization`,
		{
			method: "POST",
			headers: kiroCliOidcHeaders,
			body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl }),
		},
		{ fetch: options.fetch, signal: options.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!authorized.response.ok) {
		throw new AIError.OAuthError(`Kiro device authorization failed: HTTP ${authorized.response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: authorized.response.status,
		});
	}
	const device = record(authorized.body, "Invalid Kiro device authorization response");
	return {
		client,
		region,
		startUrl,
		deviceCode: requiredString(device.deviceCode, "deviceCode"),
		userCode: requiredUserCode(device.userCode),
		verificationUri: validateVerificationUri(device.verificationUri, "verificationUri"),
		verificationUriComplete: validateVerificationUri(device.verificationUriComplete, "verificationUriComplete"),
		expiresIn: positiveNumber(device.expiresIn, "expiresIn"),
		interval: positiveNumber(device.interval, "interval"),
	};
}

/**
 * The identity of one Kiro login. No Kiro sign-in returns an account claim
 * (device-grant and social tokens are opaque, and profiles are shared
 * org-wide or by every social user), so a random id minted here is the
 * account. It survives token refresh and keys the model cache, and as
 * `accountId` it is the identity account pools and account policies name.
 * It never embeds the AWS account number the profile ARN carries.
 */
function kiroLoginIdentity(): { kiroLoginId: string; accountId: string } {
	const id = crypto.randomUUID();
	return { kiroLoginId: id, accountId: id };
}

export async function loginKiroDevice(ctrl: OAuthController, config: KiroDeviceConfig = {}): Promise<OAuthCredentials> {
	const { startUrl, region } = await resolveDeviceInputs(ctrl, config);
	throwIfCancelled(ctrl.signal);
	const client = await registerKiroClient({ fetch: ctrl.fetch, signal: ctrl.signal }, region);
	const authorization = await startDeviceAuthorization(
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		client,
		region,
		startUrl,
	);
	if (!ctrl.onAuth) throw new AIError.OnPromptRequiredError("Kiro browser authorization");
	ctrl.onAuth({
		url: authorization.verificationUriComplete,
		instructions: `Confirm code ${authorization.userCode} in the browser`,
	});
	throwIfCancelled(ctrl.signal);
	ctrl.onProgress?.("Waiting for device authorization...");
	const completed = await pollOAuthDeviceCodeFlow<OAuthCredentials>({
		poll: async () => {
			let polled: { response: Response; body: unknown };
			try {
				polled = await request(
					authorization.client.tokenEndpoint,
					{
						method: "POST",
						headers: kiroCliOidcHeaders,
						body: JSON.stringify({
							clientId: authorization.client.clientId,
							clientSecret: authorization.client.clientSecret,
							deviceCode: authorization.deviceCode,
							grantType: DEVICE_CODE_GRANT,
						}),
					},
					{ fetch: ctrl.fetch, signal: ctrl.signal },
					"polling",
				);
			} catch (cause) {
				if (cause instanceof AIError.OAuthError && cause.kind === "timeout") {
					return { status: "pending" as const };
				}
				throw cause;
			}
			const pollBody = record(polled.body, "Invalid Kiro polling response");
			if (pollBody.error === "authorization_pending") return { status: "pending" as const };
			if (pollBody.error === "slow_down") return { status: "slow_down" as const };
			if (!polled.response.ok) {
				throw new AIError.OAuthError("Kiro device authorization rejected", {
					kind: "device-auth",
					provider: PROVIDER,
					status: polled.response.status,
				});
			}
			if (pollBody.error !== undefined) {
				throw new AIError.OAuthError("Kiro device authorization rejected", {
					kind: "device-auth",
					provider: PROVIDER,
					status: polled.response.status,
				});
			}
			return { status: "complete" as const, value: credentials(pollBody) };
		},
		intervalSeconds: authorization.interval,
		expiresInSeconds: authorization.expiresIn,
		signal: ctrl.signal,
	});
	throwIfCancelled(ctrl.signal);
	// Both sign-in shapes persist the same OIDC registration state; only the
	// profile-derived fields differ.
	const registration = {
		kiroClientId: client.clientId,
		kiroClientSecret: client.clientSecret,
		kiroClientSecretExpiresAt: client.clientSecretExpiresAt,
		kiroTokenEndpoint: client.tokenEndpoint,
		kiroOidcRegion: region,
		...kiroLoginIdentity(),
	};

	// Builder ID signs in without an organization, so there is no profile to pick
	// and the service infers it from the bearer. Everything else about the device
	// grant is identical to IAM Identity Center.
	if (config.skipProfileSelection) {
		return {
			...completed,
			...registration,
			apiEndpoint: kiroRuntimeBaseUrl(resolveKiroApiRegion(region)),
		};
	}

	const selected = await chooseKiroProfile(
		await listKiroBootstrapProfiles(completed.access, { fetch: ctrl.fetch, signal: ctrl.signal }),
		ctrl.signal,
		{ onPrompt: ctrl.onPrompt },
	);
	throwIfCancelled(ctrl.signal);
	const parsedProfile = parseKiroProfileArn(selected.profileArn);
	if (!parsedProfile) {
		throw new AIError.OAuthError("Kiro profile routing is invalid", { kind: "validation", provider: PROVIDER });
	}
	return {
		...completed,
		...registration,
		apiEndpoint: kiroRuntimeBaseUrl(parsedProfile.apiRegion),
		kiroProfileArn: selected.profileArn,
		// `orgName` is the account label every login surface renders. The raw ARN
		// embeds the AWS account id, so fall back to its trailing segment instead
		// of exposing it when a profile carries no display name.
		orgName: selected.profileName ?? extractKiroProfileSegment(selected.profileArn),
	};
}

/**
 * Tokens from a Kiro social poll or refresh response. The service has been seen
 * omitting the lifetime, so `expiresIn` (seconds) or an ISO `expiresAt` is used
 * when present and the default access-token lifetime otherwise.
 */
function socialTokens(data: JsonRecord, fallbackRefresh?: string): OAuthCredentials {
	const access = requiredString(data.accessToken, "accessToken");
	const refresh =
		data.refreshToken === undefined || data.refreshToken === null
			? requiredString(fallbackRefresh, "refreshToken")
			: requiredString(data.refreshToken, "refreshToken");
	const now = Date.now();
	const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
	const expires =
		data.expiresIn !== undefined && data.expiresIn !== null
			? now + positiveNumber(data.expiresIn, "expiresIn") * 1000
			: Number.isFinite(expiresAt) && expiresAt > now
				? expiresAt
				: now + KIRO_SOCIAL_DEFAULT_TOKEN_LIFETIME_MS;
	return { access, refresh, expires };
}

interface KiroSocialDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}

async function startSocialDeviceAuthorization(
	ctrl: OAuthController,
	loginProvider: KiroSocialLoginProvider,
): Promise<KiroSocialDeviceAuthorization> {
	const authorized = await request(
		`${KIRO_SOCIAL_AUTH_BASE_URL}/oauth/device/authorization`,
		{
			method: "POST",
			headers: socialHeaders,
			body: JSON.stringify({ clientId: KIRO_CLI_SOCIAL_CLIENT_ID, loginProvider }),
		},
		{ fetch: ctrl.fetch, signal: ctrl.signal },
		"device-auth",
		"allow-non-json-error",
	);
	if (!authorized.response.ok) {
		throw new AIError.OAuthError(`Kiro device authorization failed: HTTP ${authorized.response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: authorized.response.status,
		});
	}
	const device = record(authorized.body, "Invalid Kiro device authorization response");
	return {
		deviceCode: requiredString(device.deviceCode, "deviceCode"),
		userCode: requiredUserCode(device.userCode),
		verificationUriComplete: validateVerificationUri(device.verificationUriComplete, "verificationUriComplete"),
		expiresInMs: positiveNumber(device.expiresInMilliseconds, "expiresInMilliseconds"),
		intervalMs: positiveNumber(device.intervalInMilliseconds, "intervalInMilliseconds"),
	};
}

/**
 * Google or GitHub sign-in through Kiro's social device flow: the user approves
 * a code on app.kiro.dev, so no loopback server is needed and the flow works
 * over SSH. The poll always answers HTTP 200 and reports its state in
 * `status`; only a response carrying an access token completes the flow.
 *
 * A social bearer is useless without a profile ARN. The poll's own ARN wins;
 * otherwise the account's listed profiles are offered, and an account that
 * lists none takes the profile the Kiro CLI assigns social users.
 */
export async function loginKiroSocial(
	ctrl: OAuthController,
	loginProvider: KiroSocialLoginProvider,
): Promise<OAuthCredentials> {
	const label = KIRO_SOCIAL_LABELS[loginProvider];
	const authorization = await startSocialDeviceAuthorization(ctrl, loginProvider);
	if (!ctrl.onAuth) throw new AIError.OnPromptRequiredError("Kiro browser authorization");
	ctrl.onAuth({
		url: authorization.verificationUriComplete,
		instructions: `Confirm code ${authorization.userCode} in the browser and sign in with ${label}`,
	});
	throwIfCancelled(ctrl.signal);
	ctrl.onProgress?.("Waiting for device authorization...");
	const completed = await pollOAuthDeviceCodeFlow<{ tokens: OAuthCredentials; profileArn: string | undefined }>({
		poll: async () => {
			let polled: { response: Response; body: unknown };
			try {
				polled = await request(
					`${KIRO_SOCIAL_AUTH_BASE_URL}/oauth/device/poll`,
					{
						method: "POST",
						headers: socialHeaders,
						body: JSON.stringify({ deviceCode: authorization.deviceCode, clientId: KIRO_CLI_SOCIAL_CLIENT_ID }),
					},
					{ fetch: ctrl.fetch, signal: ctrl.signal },
					"polling",
					"allow-non-json-error",
				);
			} catch (cause) {
				if (cause instanceof AIError.OAuthError && cause.kind === "timeout") {
					return { status: "pending" as const };
				}
				throw cause;
			}
			if (!polled.response.ok) {
				throw new AIError.OAuthError(`Kiro device poll failed: HTTP ${polled.response.status}`, {
					kind: "device-auth",
					provider: PROVIDER,
					status: polled.response.status,
				});
			}
			const pollBody = record(polled.body, "Invalid Kiro polling response");
			if (pollBody.status === "authorization_pending") return { status: "pending" as const };
			if (pollBody.status === "slow_down") return { status: "slow_down" as const };
			if (typeof pollBody.accessToken !== "string" || pollBody.accessToken.length === 0) {
				// `invalid_token` (unknown or expired code), a denial, or an unknown
				// state. The status is a server enum, never echoed when it is not one.
				const status =
					typeof pollBody.status === "string" && /^[a-z_]{1,64}$/.test(pollBody.status)
						? ` (${pollBody.status})`
						: "";
				throw new AIError.OAuthError(`Kiro ${label} sign-in was not completed${status}`, {
					kind: "device-auth",
					provider: PROVIDER,
				});
			}
			return {
				status: "complete" as const,
				value: {
					tokens: socialTokens(pollBody),
					profileArn:
						typeof pollBody.profileArn === "string"
							? parseKiroProfileArn(pollBody.profileArn)?.profileArn
							: undefined,
				},
			};
		},
		intervalSeconds: authorization.intervalMs / 1000,
		expiresInSeconds: authorization.expiresInMs / 1000,
		signal: ctrl.signal,
	});
	throwIfCancelled(ctrl.signal);

	let profileArn = completed.profileArn;
	let profileName: string | undefined;
	if (!profileArn) {
		const profiles = await listKiroBootstrapProfiles(completed.tokens.access, {
			fetch: ctrl.fetch,
			signal: ctrl.signal,
		});
		throwIfCancelled(ctrl.signal);
		if (profiles.length > 0) {
			({ profileArn, profileName } = await chooseKiroProfile(profiles, ctrl.signal, { onPrompt: ctrl.onPrompt }));
		} else {
			profileArn = KIRO_SOCIAL_DEFAULT_PROFILE_ARN;
		}
	}
	const parsedProfile = parseKiroProfileArn(profileArn);
	if (!parsedProfile) {
		throw new AIError.OAuthError("Kiro profile routing is invalid", { kind: "validation", provider: PROVIDER });
	}
	return {
		...completed.tokens,
		apiEndpoint: kiroRuntimeBaseUrl(parsedProfile.apiRegion),
		kiroProfileArn: parsedProfile.profileArn,
		orgName: profileName ?? label,
		kiroLoginProvider: loginProvider,
		...kiroLoginIdentity(),
	};
}

/**
 * Refresh a Google/GitHub sign-in against the Kiro auth service. A 400 or 401
 * (`Bad credentials`) means the refresh token is dead: the error is definitive,
 * so the row is disabled with a re-login hint. Rate limits, 5xx, and transport
 * failures stay transient.
 */
async function refreshKiroSocialToken(
	current: OAuthCredentials,
	loginProvider: KiroSocialLoginProvider,
	options: KiroRequestOptions,
): Promise<OAuthCredentials> {
	if (!current.refresh || !current.kiroLoginId) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			definitive: true,
		});
	}
	const response = await request(
		`${KIRO_SOCIAL_AUTH_BASE_URL}/refreshToken`,
		{ method: "POST", headers: socialHeaders, body: JSON.stringify({ refreshToken: current.refresh }) },
		options,
		"token-refresh",
		"allow-non-json-error",
	);
	if (!response.response.ok) {
		const status = response.response.status;
		const definitive = status === 400 || status === 401;
		throw new AIError.OAuthError(
			definitive
				? `Kiro ${KIRO_SOCIAL_LABELS[loginProvider]} sign-in expired (HTTP ${status}); run /login kiro again`
				: `Kiro refresh failed: HTTP ${status}`,
			{ kind: "token-refresh", provider: PROVIDER, status, definitive },
		);
	}
	const data = record(response.body, "Kiro returned invalid token data");
	// A refresh may move the account to another profile; an absent or
	// unparseable ARN is not routing information, so the stored one stays.
	const profileArn =
		(typeof data.profileArn === "string" ? parseKiroProfileArn(data.profileArn)?.profileArn : undefined) ??
		current.kiroProfileArn;
	const parsedProfile = parseKiroProfileArn(profileArn);
	if (!parsedProfile) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			definitive: true,
		});
	}
	return {
		...current,
		...socialTokens(data, current.refresh),
		apiEndpoint: kiroRuntimeBaseUrl(parsedProfile.apiRegion),
		kiroProfileArn: parsedProfile.profileArn,
		kiroLoginProvider: loginProvider,
		kiroLoginId: current.kiroLoginId,
		accountId: current.kiroLoginId,
	};
}

/**
 * The re-login message for an OIDC refresh rejection that no retry can fix, or
 * `undefined` for any other failure. AWS SSO OIDC reports the code as `error`
 * (`invalid_grant`, `expired_token`) or as an exception `__type`.
 */
function permanentKiroRefreshFailure(body: unknown): string | undefined {
	if (!isRecord(body)) return undefined;
	const raw =
		typeof body.error === "string"
			? body.error
			: typeof body.__type === "string"
				? body.__type.slice(body.__type.lastIndexOf("#") + 1)
				: undefined;
	switch (raw) {
		case "invalid_grant":
		case "InvalidGrantException":
			return "Kiro refresh token was rejected (invalid_grant); run /login kiro again";
		case "expired_token":
		case "ExpiredTokenException":
			return "Kiro refresh token expired (expired_token); run /login kiro again";
		default:
			return undefined;
	}
}

/**
 * Refresh a Kiro grant unconditionally. `OAuthRefresher` decides when a token
 * is due; a forced or auth-recovery refresh of a still-unexpired token must
 * reach the token endpoint, so this never short-circuits on `expires`.
 *
 * Persisted state that no retry can repair (missing or mismatched client
 * binding, an expired registered client, a dead grant) fails `definitive`, so
 * the credential is disabled with a re-login hint instead of retried forever.
 */
export async function refreshKiroToken(
	current: OAuthCredentials,
	options: KiroRequestOptions = {},
): Promise<OAuthCredentials> {
	if (current.kiroLoginProvider) return refreshKiroSocialToken(current, current.kiroLoginProvider, options);
	if (!current.kiroTokenEndpoint || !current.kiroClientId || !current.kiroClientSecret) {
		throw new AIError.OAuthError("Kiro refresh state is incomplete; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			definitive: true,
		});
	}
	if (!current.refresh) {
		throw new AIError.OAuthError("Kiro refresh requires a refresh token; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			definitive: true,
		});
	}
	if (
		current.kiroClientSecretExpiresAt !== undefined &&
		current.kiroClientSecretExpiresAt !== 0 &&
		current.kiroClientSecretExpiresAt <= Date.now()
	) {
		throw new AIError.OAuthError("Kiro registered client expired; run /login kiro again", {
			kind: "token-refresh",
			provider: PROVIDER,
			definitive: true,
		});
	}
	let parsed: URL;
	try {
		parsed = new URL(current.kiroTokenEndpoint);
	} catch (cause) {
		throw new AIError.OAuthError("Invalid Kiro refresh endpoint; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			cause,
			definitive: true,
		});
	}
	if (
		parsed.protocol !== "https:" ||
		!/^oidc\.[a-z]{2}(?:-[a-z0-9]+)+-\d+\.amazonaws\.com$/.test(parsed.hostname) ||
		parsed.pathname !== "/token" ||
		parsed.port !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new AIError.OAuthError("Invalid Kiro refresh endpoint; run /login kiro again", {
			kind: "configuration",
			provider: PROVIDER,
			definitive: true,
		});
	}
	if (current.kiroOidcRegion && parsed.hostname !== `oidc.${current.kiroOidcRegion}.amazonaws.com`) {
		throw new AIError.OAuthError(
			"Kiro refresh endpoint does not match the credential Region; run /login kiro again",
			{
				kind: "configuration",
				provider: PROVIDER,
				definitive: true,
			},
		);
	}
	const response = await request(
		current.kiroTokenEndpoint,
		{
			method: "POST",
			headers: kiroCliOidcHeaders,
			body: JSON.stringify({
				grantType: "refresh_token",
				refreshToken: current.refresh,
				clientId: current.kiroClientId,
				clientSecret: current.kiroClientSecret,
			}),
		},
		options,
		"token-refresh",
	);
	if (!response.response.ok) {
		// A dead grant names itself in the OIDC error body and fails definitive,
		// so the row is disabled with a re-login hint; any other failure stays
		// transient and the row is retried.
		const permanent = permanentKiroRefreshFailure(response.body);
		throw new AIError.OAuthError(permanent ?? `Kiro refresh failed: HTTP ${response.response.status}`, {
			kind: "token-refresh",
			provider: PROVIDER,
			status: response.response.status,
			definitive: permanent !== undefined,
		});
	}
	return {
		...current,
		...credentials(response.body, current.refresh),
		kiroClientId: current.kiroClientId,
		kiroClientSecret: current.kiroClientSecret,
		kiroClientSecretExpiresAt: current.kiroClientSecretExpiresAt,
		kiroTokenEndpoint: current.kiroTokenEndpoint,
		kiroOidcRegion: current.kiroOidcRegion,
		kiroLoginId: current.kiroLoginId,
		accountId: current.kiroLoginId,
	};
}

/**
 * The sign-in methods, named by account type. "AWS" was ambiguous here because
 * Builder ID is also an AWS account, so the menu says which kind of account each
 * option signs into. Every label is also accepted as a typed answer. Google and
 * GitHub follow API key so the numbers of the older methods stay stable.
 */
const KIRO_LOGIN_METHOD_PROMPT = prompt.render(kiroLoginMethodPrompt);

async function selectKiroLoginMethod(
	ctrl: OAuthController,
): Promise<"aws" | "builder" | "api" | KiroSocialLoginProvider> {
	const answer = await requirePrompt(
		ctrl.onPrompt,
		{ message: KIRO_LOGIN_METHOD_PROMPT, placeholder: "1" },
		"Kiro login method",
	);
	throwIfCancelled(ctrl.signal);
	switch (answer.trim().toLowerCase()) {
		case "":
			throw new AIError.OnPromptRequiredError("Kiro login method");
		case "aws":
		case "idc":
		case "identity center":
		case "identity-center":
		case "1":
			return "aws";
		case "builder":
		case "builder id":
		case "builder-id":
		case "2":
			return "builder";
		case "api":
		case "api key":
		case "api-key":
		case "apikey":
		case "3":
			return "api";
		case "google":
		case "4":
			return "Google";
		case "github":
		case "5":
			return "Github";
		default:
			throw new AIError.OAuthError("Invalid Kiro authentication selection", {
				kind: "validation",
				provider: PROVIDER,
			});
	}
}

/** `login "custom" hook="kiro-login"`: dispatcher (Identity Center / Builder ID / API key / Google / GitHub). */
export async function loginKiroHook(ctrl: OAuthController): Promise<OAuthCredentials | string> {
	const method = await selectKiroLoginMethod(ctrl);
	if (method === "aws") {
		const result = await loginKiroDevice(ctrl);
		throwIfCancelled(ctrl.signal);
		return result;
	}
	if (method === "builder") {
		// Same device grant as AWS, pinned to the Builder portal and us-east-1.
		const result = await loginKiroDevice(ctrl, {
			startUrl: KIRO_BUILDER_ID_START_URL,
			region: KIRO_BUILDER_ID_REGION,
			skipProfileSelection: true,
		});
		throwIfCancelled(ctrl.signal);
		return result;
	}
	if (method !== "api") {
		const result = await loginKiroSocial(ctrl, method);
		throwIfCancelled(ctrl.signal);
		return result;
	}
	const apiKey = await requirePrompt(
		ctrl.onPrompt,
		{ message: "Paste your Kiro API key", placeholder: "ksk_...", secret: true },
		"Kiro API key",
	);
	throwIfCancelled(ctrl.signal);
	const result = await validateKiroApiKey(apiKey, {
		fetch: ctrl.fetch,
		signal: ctrl.signal,
		apiRegion: typeof Bun.env.KIRO_API_REGION === "string" ? Bun.env.KIRO_API_REGION : undefined,
	});
	throwIfCancelled(ctrl.signal);
	return encodeKiroCredential({ kind: "api_key", token: result.key, apiEndpoint: result.apiEndpoint });
}

/** `refresh hook="kiro-refresh"`: per-region OIDC refresh-token grant, or the Kiro auth service for social sign-in. */
export async function refreshKiroHook(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	return refreshKiroToken(credentials, { signal });
}
