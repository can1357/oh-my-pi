/** `/login` runs agy's own sign-in, then exports its isolated consumer grant. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import * as AIError from "../../error";
import { agyGeminiDir, resolveAgyBinary } from "../../providers/antigravity-cli/binary";
import {
	AGY_OAUTH_CLIENT_ID,
	agyCredentialEnv,
	exportAgyCredentials,
	refreshAgyCredentials,
} from "../../providers/antigravity-cli/credentials";
import type { OAuthController, OAuthCredentials } from "./types";

const PROVIDER = "antigravity-cli";
const START_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FINISH_TIMEOUT_MS = 60_000;

/** Per-stream buffering: a URL is complete only at a delimiter or EOF. */
export class AgyAuthUrlParser {
	#pending = "";

	push(chunk: string, end = false): string | undefined {
		this.#pending += chunk;
		if (this.#pending.length > 64 * 1024) {
			throw new AIError.OAuthError("Antigravity CLI sign-in output exceeded its limit", {
				kind: "validation",
				provider: PROVIDER,
			});
		}
		const match = /https:\/\/accounts\.google\.com\/[^\s\x1b]+(?=[\s\x1b])/.exec(this.#pending + (end ? "\n" : ""));
		if (match) {
			let url: URL;
			try {
				url = new URL(match[0]);
			} catch {
				throw new AIError.OAuthError("Antigravity CLI returned an invalid authorization URL", {
					kind: "validation",
					provider: PROVIDER,
				});
			}
			if (url.searchParams.get("client_id") !== AGY_OAUTH_CLIENT_ID) {
				throw new AIError.OAuthError("Antigravity CLI returned an unexpected OAuth client", {
					kind: "validation",
					provider: PROVIDER,
				});
			}
			return url.href;
		}
		// Discard complete non-URL lines, retaining partial URLs across chunks.
		const newline = this.#pending.lastIndexOf("\n");
		if (newline >= 0) this.#pending = this.#pending.slice(newline + 1);
		return undefined;
	}
}

export function agyAuthorizationCode(input: string): string {
	let code = input.trim();
	if (/^https?:\/\//i.test(code)) {
		try {
			code = new URL(code).searchParams.get("code") ?? "";
		} catch {
			code = "";
		}
	}
	if (!code || /[\r\n]/.test(code)) {
		throw new AIError.OAuthError("Paste the authorization code or a callback URL containing a code", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return code;
}

/** Bounds even callbacks that do not implement cancellation themselves. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
	const stopped = Promise.withResolvers<never>();
	const onAbort = () => stopped.reject(new AIError.LoginCancelledError("Antigravity CLI sign-in cancelled"));
	const timer = setTimeout(() => {
		stopped.reject(
			new AIError.OAuthError("Antigravity CLI sign-in timed out", { kind: "timeout", provider: PROVIDER }),
		);
	}, milliseconds);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		return await Promise.race([work, stopped.promise]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

export async function loginAntigravityCli(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt && !ctrl.onManualCodeInput) throw new AIError.OnPromptRequiredError("Antigravity CLI");
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError("Antigravity CLI sign-in cancelled");
	const deadline = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, deadline]) : deadline;
	ctrl.onProgress?.("Preparing the Antigravity CLI...");
	const binary = await bounded(resolveAgyBinary(ctrl.fetch ?? fetch), signal, START_TIMEOUT_MS);
	const root = path.join(agyGeminiDir(), "logins");
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await fs.mkdtemp(path.join(root, "login-"));
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let signedIn = false;
	let exported = false;
	try {
		if (signal.aborted) throw new AIError.LoginCancelledError("Antigravity CLI sign-in cancelled");
		const process = Bun.spawn(
			[
				binary,
				"acp",
				"--login",
				"--gemini-dir",
				directory,
				"--app-data-dir",
				path.join(directory, "antigravity-cli"),
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...Bun.env, ...agyCredentialEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
			},
		);
		child = process;
		const onAbort = () => process.kill("SIGKILL");
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const authUrl = Promise.withResolvers<string>();
			let foundUrl = false;
			const collect = async (stream: ReadableStream<Uint8Array>) => {
				const decoder = new TextDecoder();
				const parser = new AgyAuthUrlParser();
				for await (const chunk of stream) {
					if (foundUrl) continue;
					const url = parser.push(decoder.decode(chunk, { stream: true }));
					if (url) {
						foundUrl = true;
						authUrl.resolve(url);
					}
				}
				if (!foundUrl) {
					const url = parser.push(decoder.decode(), true);
					if (url) {
						foundUrl = true;
						authUrl.resolve(url);
					}
				}
			};
			const drained = Promise.all([collect(process.stdout), collect(process.stderr)]);
			void drained.then(
				() =>
					authUrl.reject(
						new AIError.OAuthError("Antigravity CLI sign-in did not produce an authorization URL", {
							kind: "validation",
							provider: PROVIDER,
						}),
					),
				error => authUrl.reject(error),
			);
			ctrl.onAuth?.({
				url: await bounded(authUrl.promise, signal, START_TIMEOUT_MS),
				instructions: "Sign in with Google, then paste the authorization code or the callback URL.",
			});
			const input = ctrl.onManualCodeInput
				? ctrl.onManualCodeInput(signal)
				: ctrl.onPrompt!({ message: "Paste the authorization code (or callback URL)", secret: true });
			const code = agyAuthorizationCode(await bounded(input, signal, LOGIN_TIMEOUT_MS));
			process.stdin.write(`${code}\n`);
			await bounded(Promise.resolve(process.stdin.end()), signal, FINISH_TIMEOUT_MS);
			const exitCode = await bounded(process.exited, signal, FINISH_TIMEOUT_MS);
			await bounded(drained, signal, FINISH_TIMEOUT_MS);
			if (exitCode !== 0) {
				throw new AIError.OAuthError("Antigravity CLI sign-in failed; try signing in again", {
					kind: "validation",
					provider: PROVIDER,
				});
			}
			signedIn = true;
			const credentials = await exportAgyCredentials(directory);
			if (!credentials.accountId && !credentials.email) {
				throw new AIError.OAuthError(
					"Antigravity CLI did not export account identity; private login state retained",
					{
						kind: "validation",
						provider: PROVIDER,
					},
				);
			}
			exported = true;
			return credentials;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	} catch (error) {
		if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError("Antigravity CLI sign-in cancelled");
		if (deadline.aborted) {
			throw new AIError.OAuthError("Antigravity CLI sign-in timed out", { kind: "timeout", provider: PROVIDER });
		}
		if (error instanceof AIError.OAuthError || error instanceof AIError.LoginCancelledError) throw error;
		// Native output and callback/process errors may contain codes or tokens.
		throw new AIError.OAuthError("Antigravity CLI sign-in failed; try signing in again", {
			kind: "validation",
			provider: PROVIDER,
		});
	} finally {
		child?.kill("SIGKILL");
		if (child) await Promise.race([child.exited.catch(() => {}), Bun.sleep(1000)]);
		// Do not destroy a completed grant if a future agy format change makes
		// export fail. It remains private and recoverable without another login.
		if (!signedIn || exported) await fs.rm(directory, { recursive: true, force: true });
	}
}

export const refreshAntigravityCli = refreshAgyCredentials;
