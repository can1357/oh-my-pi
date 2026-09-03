import type { FetchImpl } from "../../types";
import type { OAuthProviderUnion } from "../registry";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
	apiEndpoint?: string;
	/**
	 * Organization/workspace the token is scoped to (e.g. an Anthropic org
	 * UUID or a ChatGPT workspace id). Captured once at login; token refreshes
	 * never rewrite it. Lets one account email hold credentials for multiple
	 * subscriptions.
	 */
	orgId?: string;
	/** Human-readable organization name for display (may embed the email). */
	orgName?: string;
	/**
	 * Epoch ms of the interactive login that minted this grant. Set by
	 * `AuthStorage.login`; token refreshes preserve it. Providers with an
	 * absolute grant lifetime (Anthropic expires the whole refresh-token
	 * family ~30 days after authorization regardless of rotation) use it to
	 * surface re-login deadlines before the grant dies.
	 */
	authorizedAt?: number;
};

export type OAuthProvider = OAuthProviderUnion;

export type OAuthProviderId = OAuthProvider | (string & {});

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	/**
	 * Full authorization URL. Suitable for direct browser launch, OSC 8
	 * hyperlinks, and clipboard when the target UI can guarantee the full
	 * string reaches the user unmodified.
	 */
	url: string;
	/**
	 * Short loopback URL that 302-redirects to {@link url}. Provided by flows
	 * that host the redirect on the same callback server they already run
	 * ({@link OAuthCallbackFlow}). UIs SHOULD prefer this as the copy target
	 * so viewport truncation cannot corrupt OAuth query parameters. Undefined
	 * for flows without a loopback callback server (device code, paste-code
	 * providers with fixed non-loopback redirects, etc.).
	 */
	launchUrl?: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
	/**
	 * Provider id the login stores credentials under, when it differs from `id`
	 * (e.g. `openai-codex-device` ⇒ `openai-codex`). Lets callers map a login
	 * entry back to the model provider it authenticates.
	 */
	storeCredentialsAs?: string;
}

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
	/** Refresh a stored grant; the signal bounds provider network work to refresh ownership. */
	refreshToken?(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;
	/** Store resulting OAuth credentials under a different provider id. */
	readonly storeCredentialsAs?: string;
}
