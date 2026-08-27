import {
	buildZedNativeAppSignInUrl,
	decryptZedAccessToken,
	generateZedAuthKeypair,
	parseZedCredentials,
	type RsaAuthKeypair,
	ZED_APP_VERSION,
	ZED_CLOUD_URL,
	ZED_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/zed";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { type CallbackResult, OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_CALLBACK_PORT = 48921;

/**
 * Validate Zed user credentials and fetch account profile.
 */
async function validateZedUser(
	userId: string,
	accessToken: string,
	fetchOverride?: FetchImpl,
	signal?: AbortSignal,
): Promise<{ id: number; github_login?: string; email?: string } | null> {
	if (signal?.aborted) return null;
	const fetchImpl = fetchOverride ?? fetch;
	const timeoutSignal = AbortSignal.timeout(10_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const response = await fetchImpl(`${ZED_CLOUD_URL}/client/users/me`, {
			method: "GET",
			headers: {
				Authorization: `${userId} ${accessToken}`,
				"Content-Type": "application/json",
				[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
			},
			signal: requestSignal,
		});

		if (!response.ok) return null;
		const data = (await response.json()) as { id?: number; github_login?: string; email?: string };
		if (signal?.aborted) return null;
		if (data?.id) {
			return { id: data.id, github_login: data.github_login, email: data.email };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Attempt to auto-import existing Zed Editor credentials from the system keyring.
 */
export async function tryImportLocalZedKeychain(
	ctrl?: Pick<OAuthController, "fetch" | "signal">,
): Promise<OAuthCredentials | null> {
	if (ctrl?.signal?.aborted) return null;
	try {
		if (process.platform === "linux") {
			const timeoutSignal = AbortSignal.timeout(3000);
			const keychainSignal = ctrl?.signal ? AbortSignal.any([ctrl.signal, timeoutSignal]) : timeoutSignal;
			const proc = Bun.spawn(["secret-tool", "lookup", "url", "https://zed.dev"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				signal: keychainSignal,
			});
			const [stdout, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) return null;
			const secret = stdout.trim();
			if (secret) {
				// Secret tool returns either "userId accessToken" or just accessToken
				const parsed = parseZedCredentials(secret);
				if (parsed.userId && parsed.accessToken) {
					const user = await validateZedUser(parsed.userId, parsed.accessToken, ctrl?.fetch, ctrl?.signal);
					if (ctrl?.signal?.aborted) return null;
					if (user) {
						return {
							access: `${user.id} ${parsed.accessToken}`,
							refresh: `${user.id} ${parsed.accessToken}`,
							accountId: String(user.id),
							email: user.github_login ?? user.email,
							expires: Date.now() + 30 * 24 * 3600 * 1000,
						};
					}
				}
			}
		}
	} catch {
		// Secret-tool unavailable or no credentials found
	}

	return null;
}

export class ZedOAuthFlow extends OAuthCallbackFlow {
	readonly #keypair: RsaAuthKeypair;

	constructor(ctrl: OAuthController, keypair?: RsaAuthKeypair) {
		super(ctrl, {
			preferredPort: DEFAULT_CALLBACK_PORT,
			callbackPath: "/",
			callbackHostname: "127.0.0.1",
		});
		this.#keypair = keypair ?? generateZedAuthKeypair();
	}

	/**
	 * Zed native app sign-in uses an RSA-2048 key exchange handshake and doesn't
	 * return an OAuth state query parameter.
	 */
	override generateState(): string {
		return "";
	}

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const port = Number(new URL(redirectUri).port) || DEFAULT_CALLBACK_PORT;
		const url = buildZedNativeAppSignInUrl(port, this.#keypair.publicKeyDerBase64Url);
		return {
			url,
			instructions: "Complete the sign-in flow in your browser to link your Zed account.",
		};
	}

	protected override parseCallbackParams(
		url: URL,
		_expectedState: string,
	): { ok: true; result: CallbackResult } | { ok: false; error: string } | null {
		const error = url.searchParams.get("error");
		if (error) {
			const errorDescription = url.searchParams.get("error_description") || error;
			return { ok: false, error: `Authorization failed: ${errorDescription}` };
		}

		const userId = url.searchParams.get("user_id");
		const encryptedToken = url.searchParams.get("access_token");
		if (!userId || !encryptedToken) {
			return null;
		}

		try {
			const accessToken = decryptZedAccessToken(encryptedToken, this.#keypair.privateKeyPem);
			if (!accessToken) return null;
			return {
				ok: true,
				result: {
					code: accessToken,
					state: userId,
				},
			};
		} catch {
			// Foreign or malformed encrypted token on the loopback port must not terminate the active login
			return null;
		}
	}

	override async exchangeToken(accessToken: string, userId: string): Promise<OAuthCredentials> {
		if (this.ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal.reason}`);
		}

		const user = await validateZedUser(userId, accessToken, this.ctrl.fetch, this.ctrl.signal);
		if (this.ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal.reason}`);
		}

		const accountId = user ? String(user.id) : userId;
		return {
			access: `${accountId} ${accessToken}`,
			refresh: `${accountId} ${accessToken}`,
			accountId,
			email: user?.github_login ?? user?.email,
			expires: Date.now() + 30 * 24 * 3600 * 1000,
		};
	}
}

/**
 * Run interactive Zed OAuth sign-in flow via browser and RSA key exchange.
 */
export async function loginZed(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (ctrl.signal?.aborted) {
		throw new AIError.AbortError("Zed authentication was aborted.");
	}

	// 1. Try local keychain import first if available
	const localCreds = await tryImportLocalZedKeychain(ctrl);
	if (ctrl.signal?.aborted) {
		throw new AIError.AbortError("Zed authentication was aborted.");
	}
	if (localCreds) {
		ctrl.onProgress?.("Imported existing Zed credentials from local system keychain.");
		return localCreds;
	}

	// 2. Browser sign-in flow via centralized OAuth callback infrastructure
	const flow = new ZedOAuthFlow(ctrl);
	return flow.login();
}

/**
 * Refresh Zed token credentials.
 */
export async function refreshZedToken(refreshToken: string): Promise<OAuthCredentials> {
	const parsed = parseZedCredentials(refreshToken);
	return {
		access: refreshToken,
		refresh: refreshToken,
		accountId: parsed.userId || undefined,
		expires: Date.now() + 30 * 24 * 3600 * 1000,
	};
}
