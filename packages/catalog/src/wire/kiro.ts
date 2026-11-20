/**
 * Kiro routing and the credential codec. The `apiKey` string auth hands to Kiro
 * discovery, usage and the stream is produced and read only here, so every
 * consumer routes a credential to the same region and cache scope.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** Kiro API keys are `ksk_…`; the prefix tells a raw key from an encoded credential. */
export const KIRO_API_KEY_PREFIX = "ksk_";

/** Commercial regions probed when a region is unknown: an unpinned API key, or a social login's profile listing. */
export const KIRO_BOOTSTRAP_REGIONS = ["us-east-1", "eu-central-1"] as const;
/** Kiro profile regions in AWS GovCloud (US), whose Identity Center tokens only those regions accept. */
const KIRO_GOVCLOUD_REGIONS = ["us-gov-west-1", "us-gov-east-1"] as const;

const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const PROFILE_ARN = /^arn:aws(?:-us-gov)?:codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-\d+):\d+:profile\/[A-Za-z0-9_-]+$/;

/**
 * Profile regions an Identity Center login in `oidcRegion` can hold: a token
 * never crosses the AWS partition it was issued in.
 */
export function kiroProfileRegions(oidcRegion: string): readonly string[] {
	return oidcRegion.startsWith("us-gov-") ? KIRO_GOVCLOUD_REGIONS : KIRO_BOOTSTRAP_REGIONS;
}

/** Whether `value` is an AWS region id, safe to place in a Kiro host name. */
export function isKiroRegion(value: unknown): value is string {
	return typeof value === "string" && REGION.test(value);
}

/** The region a Kiro profile ARN routes to, or `undefined` when the value is not a profile ARN. */
export function kiroProfileRegion(profileArn: unknown): string | undefined {
	return typeof profileArn === "string" ? PROFILE_ARN.exec(profileArn)?.[1] : undefined;
}

export function kiroRuntimeBaseUrl(region: string): string {
	return `https://runtime.${region}.kiro.dev/`;
}

export function kiroManagementBaseUrl(region: string): string {
	return `https://management.${region}.kiro.dev/`;
}

export type KiroCredential =
	/**
	 * A device or social login. `loginId` is minted at login and survives refresh;
	 * Builder ID logins have no profile ARN and route by region alone.
	 */
	| { kind: "oauth"; token: string; region: string; loginId: string; profileArn?: string }
	/** A `ksk_…` key; `region` is absent for an env key with no `KIRO_API_REGION`. */
	| { kind: "api_key"; token: string; region?: string };

/** A Kiro credential string that cannot be decoded, or a stored row that cannot be encoded. */
class KiroCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KiroCredentialError";
	}
}

export function encodeKiroCredential(credential: KiroCredential): string {
	return JSON.stringify(credential);
}

/** The stored OAuth row fields a Kiro request key carries. */
export interface KiroOAuthRow {
	access: string;
	/** Kiro API region: the profile's region, or `us-east-1` for Builder ID. */
	region?: string;
	/** The login id minted at sign-in. */
	accountId?: string;
	kiroProfileArn?: string;
}

/** The request key for a stored Kiro OAuth row (`ProviderDefinition.getApiKey`). */
export function encodeKiroOAuthRow(row: KiroOAuthRow): string {
	if (!isKiroRegion(row.region) || !row.accountId) {
		throw new KiroCredentialError("Kiro login is incomplete; run /login kiro again");
	}
	return encodeKiroCredential({
		kind: "oauth",
		token: row.access,
		region: row.region,
		loginId: row.accountId,
		...(row.kiroProfileArn ? { profileArn: row.kiroProfileArn } : {}),
	});
}

function decodeEncoded(value: string): KiroCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new KiroCredentialError("Kiro credential is not valid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token.length === 0) {
		throw new KiroCredentialError("Kiro credential has no token");
	}
	const { token, region, profileArn } = parsed;
	if (region !== undefined && !isKiroRegion(region))
		throw new KiroCredentialError("Kiro credential has an invalid region");
	if (parsed.kind === "api_key") {
		if (!token.startsWith(KIRO_API_KEY_PREFIX))
			throw new KiroCredentialError("Kiro API keys must use the ksk_… format");
		return { kind: "api_key", token, ...(region ? { region } : {}) };
	}
	if (parsed.kind !== "oauth") throw new KiroCredentialError("Kiro credential has an unknown kind");
	if (!region || typeof parsed.loginId !== "string" || parsed.loginId.length === 0) {
		throw new KiroCredentialError("Kiro login is incomplete; run /login kiro again");
	}
	if (profileArn !== undefined && kiroProfileRegion(profileArn) === undefined) {
		throw new KiroCredentialError("Kiro credential has an invalid profile ARN");
	}
	return {
		kind: "oauth",
		token,
		region,
		loginId: parsed.loginId,
		...(profileArn ? { profileArn: profileArn as string } : {}),
	};
}

/**
 * Decode the `apiKey` string: the {@link encodeKiroCredential} form or a raw
 * `ksk_…` key. A key with no region takes `KIRO_API_REGION` when set, so
 * discovery and streaming route an env key alike; an invalid pin throws.
 */
export function decodeKiroCredential(
	value: string,
	env: Readonly<Record<string, string | undefined>> = Bun.env,
): KiroCredential {
	const trimmed = value.trim();
	if (!trimmed) throw new KiroCredentialError("Kiro credential is missing");
	if (!trimmed.startsWith("{") && !trimmed.startsWith(KIRO_API_KEY_PREFIX)) {
		throw new KiroCredentialError("Kiro API keys must use the ksk_… format");
	}
	const credential: KiroCredential = trimmed.startsWith("{")
		? decodeEncoded(trimmed)
		: { kind: "api_key", token: trimmed };
	if (credential.kind === "api_key" && !credential.region && env.KIRO_API_REGION !== undefined) {
		if (!isKiroRegion(env.KIRO_API_REGION))
			throw new KiroCredentialError("KIRO_API_REGION is not a valid AWS region");
		return { ...credential, region: env.KIRO_API_REGION };
	}
	return credential;
}

/**
 * Model-cache scope of one credential. A login is scoped by its login id plus
 * its route: profiles are shared org-wide (or by every social user without one),
 * and a refresh can move a login to another profile whose catalog differs. An
 * API key is scoped by a hash of the key and its region.
 */
export function kiroCredentialCacheScope(credential: KiroCredential): string {
	if (credential.kind === "oauth") {
		return `oauth:${credential.loginId}\u0000${credential.profileArn ?? ""}\u0000${credential.region}`;
	}
	return `api_key:${Bun.hash(`${credential.token}\u0000${credential.region ?? ""}`).toString(36)}`;
}
