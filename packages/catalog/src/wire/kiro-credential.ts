/**
 * The Kiro credential codec: the single producer and consumer of the `apiKey`
 * string that auth hands to Kiro discovery, the model cache and the stream.
 *
 * Every reader decodes through {@link decodeKiroCredential}, so routing
 * (`profileArn`, `apiEndpoint`, `KIRO_API_REGION`) and the model-cache scope
 * resolve the same way whichever path produced the string — a peek of an
 * unexpired row, a refresh, a `/login` API key, or a raw `KIRO_API_KEY`.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	KIRO_API_KEY_PREFIX,
	kiroRuntimeBaseUrl,
	parseKiroEndpoint,
	parseKiroProfileArn,
	validateKiroApiRegion,
} from "./kiro";

export type KiroCredential =
	/**
	 * IAM Identity Center or Builder ID device login. `loginId` is stamped at
	 * login and survives token refresh; Builder ID logins carry no profile ARN.
	 */
	| { kind: "oauth"; token: string; apiEndpoint: string; loginId: string; profileArn?: string }
	/** `ksk_…` API key; the endpoint is absent for an env key with no `KIRO_API_REGION`. */
	| { kind: "api_key"; token: string; apiEndpoint?: string };

/** Environment consulted by {@link decodeKiroCredential}; only `KIRO_API_REGION` is read. */
export type KiroCredentialEnv = Readonly<Record<string, string | undefined>>;

/** The fields of a stored Kiro OAuth row that the encoded credential carries. */
export interface KiroOAuthRow {
	access: string;
	apiEndpoint?: string;
	/** IAM Identity Center profile ARN; absent for Builder ID. */
	orgId?: string;
	kiroLoginId?: string;
}

/** A Kiro credential string that cannot be decoded, or a row that cannot be encoded. */
export class KiroCredentialError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "KiroCredentialError";
	}
}

/** A field that, when present, must be a non-empty string. */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new KiroCredentialError(`Kiro credential has an invalid ${key}`);
	}
	return value;
}

function runtimeEndpoint(value: string): string {
	const endpoint = parseKiroEndpoint(value);
	if (endpoint?.kind !== "runtime") throw new KiroCredentialError("Kiro credential has an invalid runtime endpoint");
	return endpoint.baseUrl;
}

function profileArn(value: string): string {
	const profile = parseKiroProfileArn(value);
	if (!profile) throw new KiroCredentialError("Kiro credential has an invalid profile ARN");
	return profile.profileArn;
}

function apiKeyToken(value: string): string {
	if (!value.startsWith(KIRO_API_KEY_PREFIX)) {
		throw new KiroCredentialError("Kiro API keys must use the ksk_… format");
	}
	return value;
}

/** Encode a Kiro credential into the `apiKey` string. The only producer of that string. */
export function encodeKiroCredential(credential: KiroCredential): string {
	if (credential.kind === "oauth") {
		return JSON.stringify({
			kind: "oauth",
			token: credential.token,
			apiEndpoint: credential.apiEndpoint,
			loginId: credential.loginId,
			...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
		});
	}
	return JSON.stringify({
		kind: "api_key",
		token: credential.token,
		...(credential.apiEndpoint ? { apiEndpoint: credential.apiEndpoint } : {}),
	});
}

/**
 * Encode a stored Kiro OAuth row. Peek (`KeyCascade`) and refresh
 * (`getOAuthApiKey`) both go through here, so an expired and a fresh token for
 * the same row decode to the same route and cache scope.
 */
export function encodeKiroOAuthRow(row: KiroOAuthRow): string {
	if (!row.apiEndpoint || !row.kiroLoginId) {
		throw new KiroCredentialError("Kiro login is incomplete; run /login kiro again");
	}
	return encodeKiroCredential({
		kind: "oauth",
		token: row.access,
		apiEndpoint: row.apiEndpoint,
		loginId: row.kiroLoginId,
		...(row.orgId ? { profileArn: row.orgId } : {}),
	});
}

function decodeEncoded(value: string): KiroCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new KiroCredentialError("Kiro credential is not valid JSON", { cause });
	}
	if (!isRecord(parsed)) throw new KiroCredentialError("Kiro credential is not an object");
	const record = parsed;
	const token = optionalString(record, "token");
	if (!token) throw new KiroCredentialError("Kiro credential has no token");
	const endpoint = optionalString(record, "apiEndpoint");
	if (record.kind === "oauth") {
		const loginId = optionalString(record, "loginId");
		if (!endpoint || !loginId)
			throw new KiroCredentialError("Kiro OAuth credential is missing its endpoint or login id");
		const arn = optionalString(record, "profileArn");
		return {
			kind: "oauth",
			token,
			apiEndpoint: runtimeEndpoint(endpoint),
			loginId,
			...(arn ? { profileArn: profileArn(arn) } : {}),
		};
	}
	if (record.kind === "api_key") {
		return {
			kind: "api_key",
			token: apiKeyToken(token),
			...(endpoint ? { apiEndpoint: runtimeEndpoint(endpoint) } : {}),
		};
	}
	throw new KiroCredentialError("Kiro credential has an unknown kind");
}

/**
 * Decode the `apiKey` string. The only consumer of that string.
 *
 * Accepts the {@link encodeKiroCredential} form or a raw `ksk_…` key. An API
 * key without an endpoint takes `KIRO_API_REGION` when it is set, so discovery
 * and streaming route an env key to the same region; an invalid region throws
 * rather than silently falling back.
 */
export function decodeKiroCredential(value: string, env: KiroCredentialEnv = Bun.env): KiroCredential {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new KiroCredentialError("Kiro credential is missing");
	const credential: KiroCredential = trimmed.startsWith("{")
		? decodeEncoded(trimmed)
		: { kind: "api_key", token: apiKeyToken(trimmed) };
	if (credential.kind === "api_key" && !credential.apiEndpoint && env.KIRO_API_REGION !== undefined) {
		const region = validateKiroApiRegion(env.KIRO_API_REGION);
		if (!region) throw new KiroCredentialError("KIRO_API_REGION is not a valid AWS region");
		return { ...credential, apiEndpoint: kiroRuntimeBaseUrl(region) };
	}
	return credential;
}

/**
 * The model-cache scope of one credential. An OAuth login is scoped by its
 * `loginId` — IAM Identity Center profiles are shared org-wide and Builder ID
 * logins have none, so neither the profile nor the endpoint identifies one
 * account. An API key is scoped by a hash of the key plus its endpoint.
 */
export function kiroCredentialCacheScope(credential: KiroCredential): string {
	if (credential.kind === "oauth") return `oauth:${credential.loginId}`;
	return `api_key:${Bun.hash(`${credential.token}\u0000${credential.apiEndpoint ?? ""}`).toString(36)}`;
}
