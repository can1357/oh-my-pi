/**
 * Native AWS IAM Identity Center sign-in for a lapsed SSO session, the
 * equivalent of `aws sso login` for exactly the session that failed. The token
 * lands in `~/.aws/sso/cache` in the AWS CLI's format, so omp's own refresh and
 * the AWS CLI both pick it up.
 *
 * `sso-session` profiles sign in like AWS CLI v2: authorization code with PKCE
 * through a loopback redirect, or the device-code grant when the browser is on
 * another machine (SSH). Legacy `sso_start_url` profiles always take the
 * device-code grant without registration scopes, as the CLI does for them; the
 * service then issues no refresh token.
 */
import type * as AIError from "../error";
import {
	createJsonApi,
	type RequestHeaders,
	registerSsoOidcClient,
	type SsoOidcClient,
	ssoOidcDeviceGrant,
	ssoOidcEndpoint,
} from "../registry/oauth/aws-sso-oidc";
import { OAuthCallbackFlow } from "../registry/oauth/callback-server";
import { generatePKCE } from "../registry/oauth/pkce";
import type { OAuthController, OAuthCredentials } from "../registry/oauth/types";
import { persistSsoCachedToken, ssoCacheFileName, ssoCacheInstant } from "./aws-credentials";

/** Scopes the AWS CLI registers for an `sso-session` without `sso_registration_scopes`. */
const DEFAULT_REGISTRATION_SCOPES = ["sso:account:access"];
const CLIENT_NAME = "omp";
/** Registered redirect; AWS matches loopback redirects regardless of port (RFC 8252 §7.3). */
const REDIRECT_PATH = "/oauth/callback";
const REGISTERED_REDIRECT_URI = `http://127.0.0.1${REDIRECT_PATH}`;

const api = createJsonApi("amazon-bedrock", "AWS SSO");
const headers: RequestHeaders = () => ({ "content-type": "application/json" });

export interface AwsSsoLoginOptions {
	/** The user's browser runs on another machine (an SSH session), so no loopback redirect can reach omp. */
	remote?: boolean;
}

/** The token reply of a completed sign-in plus the client that obtained it. */
interface SignIn {
	client: SsoOidcClient;
	token: Record<string, unknown>;
}

/**
 * Sign `sso` in again and write the token to the AWS CLI's SSO cache. The
 * verification URL reaches the user through `ctrl.onAuth`; `ctrl.signal`
 * cancels the sign-in.
 */
export async function loginAwsSso(
	sso: AIError.AwsSsoSession,
	ctrl: OAuthController,
	options: AwsSsoLoginOptions = {},
): Promise<void> {
	const scopes = sso.sessionName ? (sso.registrationScopes ?? DEFAULT_REGISTRATION_SCOPES) : undefined;
	const signIn =
		scopes && !options.remote ? await authCodeSignIn(sso, ctrl, scopes) : await deviceSignIn(sso, ctrl, scopes);
	const { client, token } = signIn;
	const now = Date.now();
	const refreshToken = token.refreshToken;
	await persistSsoCachedToken(await ssoCacheFileName(sso), {
		startUrl: sso.startUrl,
		region: sso.region,
		accessToken: api.field(token, "accessToken"),
		expiresAt: ssoCacheInstant(now + api.positive(token, "expiresIn") * 1000),
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		...(client.expiresAt ? { registrationExpiresAt: ssoCacheInstant(client.expiresAt) } : {}),
		...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
	});
}

async function deviceSignIn(
	sso: AIError.AwsSsoSession,
	ctrl: OAuthController,
	scopes: string[] | undefined,
): Promise<SignIn> {
	const client = await registerSsoOidcClient(
		api,
		ctrl,
		sso.region,
		{ clientName: CLIENT_NAME, ...(scopes ? { scopes } : {}) },
		headers,
	);
	return { client, token: await ssoOidcDeviceGrant(api, ctrl, sso.region, client, sso.startUrl, headers) };
}

async function authCodeSignIn(sso: AIError.AwsSsoSession, ctrl: OAuthController, scopes: string[]): Promise<SignIn> {
	const flow = new AwsSsoAuthCodeFlow(ctrl, sso, scopes);
	await flow.login();
	if (!flow.signIn) throw api.error("AWS SSO sign-in finished without a token");
	return flow.signIn;
}

/** Authorization code with PKCE; the client is registered once the loopback port is known. */
class AwsSsoAuthCodeFlow extends OAuthCallbackFlow {
	readonly #sso: AIError.AwsSsoSession;
	readonly #scopes: string[];
	#client: SsoOidcClient | undefined;
	#verifier = "";
	signIn: SignIn | undefined;

	constructor(ctrl: OAuthController, sso: AIError.AwsSsoSession, scopes: string[]) {
		super(ctrl, { preferredPort: 0, callbackHostname: "127.0.0.1", callbackPath: REDIRECT_PATH });
		this.#sso = sso;
		this.#scopes = scopes;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions: string }> {
		this.#client = await registerSsoOidcClient(
			api,
			this.ctrl,
			this.#sso.region,
			{
				clientName: CLIENT_NAME,
				scopes: this.#scopes,
				grantTypes: ["authorization_code", "refresh_token"],
				redirectUris: [REGISTERED_REDIRECT_URI],
				issuerUrl: this.#sso.startUrl,
			},
			headers,
		);
		const { verifier, challenge } = await generatePKCE();
		this.#verifier = verifier;
		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.#client.clientId,
			redirect_uri: redirectUri,
			state,
			code_challenge_method: "S256",
			scopes: this.#scopes.join(" "),
			code_challenge: challenge,
		});
		return {
			url: `${ssoOidcEndpoint(this.#sso.region)}/authorize?${params}`,
			instructions: `Sign in to ${this.#sso.startUrl} in the browser and allow access`,
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const client = this.#client;
		if (!client) throw api.error("AWS SSO client was not registered");
		const token = api.requireOk(
			await api.post(
				this.ctrl,
				`${ssoOidcEndpoint(this.#sso.region)}/token`,
				{
					clientId: client.clientId,
					clientSecret: client.clientSecret,
					grantType: "authorization_code",
					code,
					redirectUri,
					codeVerifier: this.#verifier,
				},
				headers,
			),
			"AWS SSO token exchange failed",
		);
		this.signIn = { client, token };
		const refresh = token.refreshToken;
		return {
			access: api.field(token, "accessToken"),
			refresh: typeof refresh === "string" ? refresh : "",
			expires: Date.now() + api.positive(token, "expiresIn") * 1000,
		};
	}
}
