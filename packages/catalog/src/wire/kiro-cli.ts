/**
 * The official Kiro CLI's wire identity, captured from kiro-cli 3.2.0. Every
 * Kiro request omp sends — runtime chat, model/profile management, AWS SSO-OIDC
 * login, and the Kiro social auth service — takes its headers from here, so
 * the identity lives in one place. Credential-free: callers pass the bearer.
 */

const KIRO_CLI_APP_VERSION = "3.2.0";
const AWS_SDK_RUST_UA = "aws-sdk-rust/1.6.0 ua/2.1";
const RUST_LANG = "lang/rust/1.94.1";
const KIRO_CLI_APP = "app/AmazonQ-For-CLI";

/**
 * Content-sharing opt-out. The CLI sends `false` because its "share content
 * with AWS" setting defaults to on; omp opts out. This is the one intentional
 * deviation from the CLI's headers.
 */
const KIRO_CODEWHISPERER_OPTOUT = "true";

/** Social auth service (`prod.us-east-1.auth.desktop.kiro.dev`) client id, sent in device-flow bodies. */
export const KIRO_CLI_SOCIAL_CLIENT_ID = "Kiro-CLI";

/** Headers the CLI sends to the Kiro social auth service (device flow, refresh). */
export const KIRO_CLI_SOCIAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	"content-type": "application/json",
	"user-agent": "Kiro-CLI",
	accept: "*/*",
	"accept-encoding": "gzip",
});

/** The AWS JSON 1.0 operations omp calls, each as the CLI's SDK client issues it. */
export type KiroCliOperation =
	| "GenerateAssistantResponse"
	| "ListAvailableModels"
	| "ListAvailableProfiles"
	| "GetUsageLimits";

interface SdkClient {
	/** `api/<service>/<version>` segment. */
	api: string;
	/** `m/<features>` business-metric segment of `x-amz-user-agent`. */
	features: string;
	/** Whether `user-agent` carries `md/appVersion-<cli version>`. */
	appVersion: boolean;
}

const OPERATIONS: Readonly<Record<KiroCliOperation, SdkClient & { target: string }>> = {
	GenerateAssistantResponse: {
		target: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		api: "api/codewhispererstreaming/0.1.19636",
		features: "F",
		appVersion: true,
	},
	ListAvailableModels: {
		target: "KiroControlPlaneBearerService.ListAvailableModels",
		api: "api/kirocontrolplanebearer/0.1.0",
		features: "F,C",
		appVersion: true,
	},
	ListAvailableProfiles: {
		target: "AmazonCodeWhispererService.ListAvailableProfiles",
		api: "api/codewhispererruntime/0.1.19636",
		features: "F",
		appVersion: true,
	},
	GetUsageLimits: {
		target: "AmazonCodeWhispererService.GetUsageLimits",
		api: "api/codewhispererruntime/0.1.19636",
		features: "F",
		appVersion: true,
	},
};

const SSO_OIDC_CLIENT: SdkClient = { api: "api/ssooidc/1.100.0", features: "E,N", appVersion: false };

/** The `os/<family>` token the AWS Rust SDK derives from the host platform. */
export function kiroCliOsFamily(platform: string = process.platform): string {
	switch (platform) {
		case "linux":
			return "linux";
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "other";
	}
}

/** One request's position in its retry budget: `attempt` is 1-based. */
export interface KiroCliAttempt {
	attempt: number;
	maxAttempts: number;
}

function userAgents(client: SdkClient): { "user-agent": string; "x-amz-user-agent": string } {
	const base = `${AWS_SDK_RUST_UA} ${client.api} os/${kiroCliOsFamily()} ${RUST_LANG}`;
	return {
		"user-agent": client.appVersion
			? `${base} md/appVersion-${KIRO_CLI_APP_VERSION} ${KIRO_CLI_APP}`
			: `${base} m/${client.features} ${KIRO_CLI_APP}`,
		"x-amz-user-agent": `${base} m/${client.features} ${KIRO_CLI_APP}`,
	};
}

function sdkRequest(attempt: KiroCliAttempt): Record<string, string> {
	return {
		"amz-sdk-request": `attempt=${attempt.attempt}; max=${attempt.maxAttempts}`,
		"amz-sdk-invocation-id": crypto.randomUUID(),
		accept: "*/*",
		"accept-encoding": "gzip",
	};
}

/**
 * Headers for one attempt of a bearer-authenticated AWS JSON 1.0 call, in the
 * CLI's order. Each attempt gets a fresh invocation id.
 */
export function kiroCliServiceHeaders(
	operation: KiroCliOperation,
	token: string,
	attempt: KiroCliAttempt,
): Record<string, string> {
	const client = OPERATIONS[operation];
	return {
		"content-type": "application/x-amz-json-1.0",
		"x-amz-target": client.target,
		...userAgents(client),
		"x-amzn-codewhisperer-optout": KIRO_CODEWHISPERER_OPTOUT,
		...(operation === "GenerateAssistantResponse"
			? {
					"x-amzn-kiro-attempt": `${attempt.attempt};max=${attempt.maxAttempts}`,
					// omp never falls back to another model.
					"x-amzn-kiro-fallback": "0;max=0",
				}
			: {}),
		authorization: `Bearer ${token}`,
		...sdkRequest(attempt),
	};
}

/** Headers for one attempt of an AWS SSO-OIDC call (`client/register`, `device_authorization`, `token`). */
export function kiroCliOidcHeaders(attempt: KiroCliAttempt): Record<string, string> {
	return {
		"content-type": "application/json",
		...userAgents(SSO_OIDC_CLIENT),
		...sdkRequest(attempt),
	};
}
