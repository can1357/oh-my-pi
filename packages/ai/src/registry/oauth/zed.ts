import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
	buildZedNativeAppSignInUrl,
	decryptZedAccessToken,
	generateZedAuthKeypair,
	parseZedCredentials,
	ZED_APP_VERSION,
	ZED_CLOUD_URL,
	ZED_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/zed";
import * as AIError from "../../error";
import templateHtml from "./oauth.html" with { type: "text" };
import type { OAuthController, OAuthCredentials } from "./types";

function renderOauthPage(resultState: { ok: boolean; provider: string; error?: string }): string {
	return (templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(resultState));
}

const execFileAsync = promisify(execFile);
const DEFAULT_CALLBACK_PORT = 48921;

/**
 * Validate Zed user credentials and fetch account profile.
 */
async function validateZedUser(
	userId: string,
	accessToken: string,
): Promise<{ id: number; github_login?: string; email?: string } | null> {
	try {
		const response = await fetch(`${ZED_CLOUD_URL}/client/users/me`, {
			method: "GET",
			headers: {
				Authorization: `${userId} ${accessToken}`,
				"Content-Type": "application/json",
				[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
			},
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) return null;
		const data = (await response.json()) as { id?: number; github_login?: string; email?: string };
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
export async function tryImportLocalZedKeychain(): Promise<OAuthCredentials | null> {
	try {
		if (process.platform === "linux") {
			const { stdout } = await execFileAsync("secret-tool", ["lookup", "url", "https://zed.dev"], {
				timeout: 3000,
			});
			const secret = stdout.trim();
			if (secret) {
				// Secret tool returns either "userId accessToken" or just accessToken
				const parsed = parseZedCredentials(secret);
				if (parsed.userId && parsed.accessToken) {
					const user = await validateZedUser(parsed.userId, parsed.accessToken);
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

/**
 * Run interactive Zed OAuth sign-in flow via browser and RSA key exchange.
 */
export async function loginZed(ctrl: OAuthController): Promise<OAuthCredentials> {
	// 1. Try local keychain import first if available
	const localCreds = await tryImportLocalZedKeychain();
	if (localCreds) {
		ctrl.onProgress?.("Imported existing Zed credentials from local system keychain.");
		return localCreds;
	}

	// 2. Browser sign-in flow with RSA-2048 key exchange
	const { publicKeyDerBase64Url, privateKeyPem } = generateZedAuthKeypair();
	const { promise, resolve, reject } = Promise.withResolvers<OAuthCredentials>();
	let isResolved = false;

	const timeoutId = setTimeout(() => {
		if (!isResolved) {
			isResolved = true;
			server.close();
			reject(
				new AIError.OAuthError("Zed authentication timed out after 5 minutes.", {
					kind: "configuration",
					provider: "zed-agent",
				}),
			);
		}
	}, 300_000);

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}`);
			const userId = url.searchParams.get("user_id");
			const encryptedToken = url.searchParams.get("access_token");

			if (!userId || !encryptedToken) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderOauthPage({ ok: false, provider: "Zed Agent", error: "Missing authentication parameters." }));
				return;
			}

			const accessToken = decryptZedAccessToken(encryptedToken, privateKeyPem);

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderOauthPage({ ok: true, provider: "Zed Agent" }));
			if (!isResolved) {
				isResolved = true;
				clearTimeout(timeoutId);
				server.close();
				resolve({
					access: `${userId} ${accessToken}`,
					refresh: `${userId} ${accessToken}`,
					accountId: userId,
					expires: Date.now() + 30 * 24 * 3600 * 1000,
				});
			}
		} catch (err) {
			res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderOauthPage({ ok: false, provider: "Zed Agent", error: String(err) }));
			if (!isResolved) {
				isResolved = true;
				clearTimeout(timeoutId);
				server.close();
				reject(new AIError.OAuthError(`Failed to decrypt Zed access token: ${String(err)}`));
			}
		}
	});

	server.on("listening", () => {
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : DEFAULT_CALLBACK_PORT;
		const authUrl = buildZedNativeAppSignInUrl(port, publicKeyDerBase64Url);

		ctrl.onAuth?.({
			url: authUrl,
			instructions: "Complete the sign-in flow in your browser to link your Zed account.",
		});
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			// Fallback to random dynamic port
			server.listen(0, "127.0.0.1");
		} else if (!isResolved) {
			isResolved = true;
			clearTimeout(timeoutId);
			reject(new AIError.OAuthError(`Zed callback server failed: ${err.message}`));
		}
	});

	server.listen(DEFAULT_CALLBACK_PORT, "127.0.0.1");

	ctrl.signal?.addEventListener("abort", () => {
		if (!isResolved) {
			isResolved = true;
			clearTimeout(timeoutId);
			server.close();
			reject(new AIError.AbortError("Zed authentication was aborted."));
		}
	});

	return promise;
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
