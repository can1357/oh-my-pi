import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { ProviderTransport } from "./build";

// Catalog rows carry this origin until prepareRequest swaps in the account URL. It must
// parse (models.json invariant), and `.invalid` (RFC 6761) never resolves, so an
// unrewritten request fails before reaching any host.
const SNOWFLAKE_ACCOUNT_ORIGIN_PLACEHOLDER = "https://snowflake-account.invalid";

const INVALID_ACCOUNT_MESSAGE = __ompTranslate(
	"Paste your Snowflake account identifier (orgname-accountname) or account URL",
);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// AWS region IDs such as us-east-1 or us-gov-west-1; Azure/GCP region segments contain dots and already fail DNS_LABEL.
const LEGACY_SNOWSIGHT_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;

function isDnsLabel(label: string): boolean {
	return label.length <= 63 && DNS_LABEL.test(label);
}

/** Normalize account identifiers and Snowsight links without accepting arbitrary credential-receiving hosts. */
export function normalizeSnowflakeAccountUrl(input: string): string {
	const value = input.trim();
	if (!value) {
		throw new AIError.ConfigurationError(
			__ompTranslate("Snowflake account is required: run /login snowflake or set SNOWFLAKE_ACCOUNT"),
		);
	}
	// Only `<scheme>://` is a scheme; `host:443` is a schemeless authority.
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
	if (scheme && scheme[1].toLowerCase() !== "https") {
		throw new AIError.ConfigurationError(__ompTranslate("Snowflake account URL must use https"));
	}
	if (value.includes("\\")) throw new AIError.ConfigurationError(INVALID_ACCOUNT_MESSAGE);

	let host: string;
	if (scheme) {
		const url = /^https:\/\/([^/?#]+)(.*)$/i.exec(value);
		if (!url) throw new AIError.ConfigurationError(INVALID_ACCOUNT_MESSAGE);
		// Validate the raw authority: URL parsing otherwise repairs some malformed inputs.
		host = url[1].toLowerCase().replaceAll("_", "-");
		if (host.endsWith(":443")) host = host.slice(0, -4);
		if (host === "app.snowflake.com") {
			const segments = url[2].split(/[?#]/, 1)[0].split("/");
			const org = segments[1]?.toLowerCase().replaceAll("_", "-") ?? "";
			const account = segments[2]?.toLowerCase().replaceAll("_", "-") ?? "";
			if (!isDnsLabel(org) || !isDnsLabel(account)) {
				throw new AIError.ConfigurationError(INVALID_ACCOUNT_MESSAGE);
			}
			// Legacy links are /<cloud-region>/<locator>; their host mapping is region-specific.
			if (LEGACY_SNOWSIGHT_REGION.test(org)) {
				throw new AIError.ConfigurationError(
					__ompTranslate(
						"Legacy Snowsight links don't identify the account host; paste your account identifier (orgname-accountname) or account URL",
					),
				);
			}
			host = `${org}-${account}.snowflakecomputing.com`;
		}
	} else {
		if (/[/?#]/.test(value)) throw new AIError.ConfigurationError(INVALID_ACCOUNT_MESSAGE);
		host = value.toLowerCase().replaceAll("_", "-");
		if (host.endsWith(":443")) host = host.slice(0, -4);
		if (!host.endsWith(".snowflakecomputing.com") && !host.endsWith(".snowflakecomputing.cn")) {
			host += ".snowflakecomputing.com";
		}
	}

	if (host.endsWith(".snowflakecomputing.cn")) {
		throw new AIError.ConfigurationError(
			__ompTranslate("Snowflake Cortex REST API is not available in China-region accounts (.snowflakecomputing.cn)"),
		);
	}
	const suffix = ".snowflakecomputing.com";
	if (!host.endsWith(suffix) || host.length === suffix.length || !host.split(".").every(isDnsLabel)) {
		throw new AIError.ConfigurationError(INVALID_ACCOUNT_MESSAGE);
	}
	return `https://${host}`;
}

interface SnowflakeCredential {
	token: string;
	accountUrl?: string;
}

const INVALID_CREDENTIAL_MESSAGE = __ompTranslate("Invalid Snowflake credential; run /login snowflake again");

/** Decode the registry's structured OAuth key; malformed JSON must never become a bearer token. */
function parseSnowflakeCredential(value: string): SnowflakeCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	let credential: unknown;
	try {
		credential = JSON.parse(trimmed);
	} catch {
		throw new AIError.ConfigurationError(INVALID_CREDENTIAL_MESSAGE);
	}
	if (
		!credential ||
		typeof credential !== "object" ||
		!("token" in credential) ||
		typeof credential.token !== "string" ||
		!credential.token.trim() ||
		// Structured keys are OAuth bearers; without their account they must not get PAT routing.
		!("enterpriseUrl" in credential) ||
		typeof credential.enterpriseUrl !== "string" ||
		!credential.enterpriseUrl.trim()
	) {
		throw new AIError.ConfigurationError(INVALID_CREDENTIAL_MESSAGE);
	}
	let accountUrl: string;
	try {
		accountUrl = normalizeSnowflakeAccountUrl(credential.enterpriseUrl);
	} catch (error) {
		// Keep the specific account reason (e.g. China-region) visible for stored credentials.
		const reason = error instanceof Error ? error.message : String(error);
		throw new AIError.ConfigurationError(
			__ompTranslate("Invalid Snowflake credential account: {0}; run /login snowflake again", `${reason}`),
		);
	}
	return { token: credential.token.trim(), accountUrl };
}

export const snowflakeTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		// Match stream.ts: an empty apiKey falls through to the environment.
		const credential = parseSnowflakeCredential(options.apiKey?.trim() || $env.SNOWFLAKE_PAT || "");
		if (!credential) return { model, options };
		let baseUrl = model.baseUrl;
		if (
			baseUrl === SNOWFLAKE_ACCOUNT_ORIGIN_PLACEHOLDER ||
			baseUrl.startsWith(`${SNOWFLAKE_ACCOUNT_ORIGIN_PLACEHOLDER}/`)
		) {
			const accountUrl = credential.accountUrl ?? normalizeSnowflakeAccountUrl($env.SNOWFLAKE_ACCOUNT ?? "");
			baseUrl = accountUrl + baseUrl.slice(SNOWFLAKE_ACCOUNT_ORIGIN_PLACEHOLDER.length);
		} else if (credential.accountUrl) {
			let origin: string | undefined;
			try {
				origin = new URL(baseUrl).origin;
			} catch {
				// Invalid endpoints cannot match a validated OAuth account.
			}
			if (origin !== credential.accountUrl) {
				throw new AIError.ConfigurationError(
					__ompTranslate("Snowflake OAuth account does not match the model endpoint"),
				);
			}
		}
		return {
			model: baseUrl === model.baseUrl ? model : { ...model, baseUrl },
			options: { ...options, apiKey: credential.token },
		};
	},
};
