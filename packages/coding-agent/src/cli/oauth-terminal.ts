/**
 * Terminal (readline) OAuth login primitives shared by `omp login` and
 * `omp auth-broker login`: a cancellable line prompt, a numbered provider
 * picker, and the stdout-driven OAuth flow itself.
 *
 * Callers own ONE `readline.Interface` for the whole command and pass it to
 * every step: readline buffers whole input chunks, so a second interface on
 * piped stdin never sees lines the first one already consumed.
 */
import * as readline from "node:readline";
import {
	type AuthStorage,
	type OAuthLoginIdentity,
	type OAuthProviderId,
	type OAuthProviderInfo,
	PASTE_CODE_LOGIN_PROVIDERS,
} from "@oh-my-pi/pi-ai";
import { openPath } from "../utils/open";

/**
 * Interactive `readline` prompt that cleanly tears down on Ctrl-C / Escape so
 * cancelling a half-finished login flow doesn't leave the terminal in raw mode.
 *
 * Rejects with "Login cancelled" on Ctrl-C / Escape or when stdin closes
 * before an answer, or with the signal's reason when `signal` aborts.
 */
export function promptLine(rl: readline.Interface, question: string, signal?: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		rl.off("close", cancel);
		signal?.removeEventListener("abort", onAbort);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("Login cancelled")));
	};

	const onSigint = () => {
		cancel();
	};

	const onAbort = () => {
		finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Login input cancelled")));
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.once("close", cancel);
	try {
		if (signal?.aborted) {
			onAbort();
		} else if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			rl.question(question, { signal }, answer => {
				finish(() => resolve(answer));
			});
		} else {
			rl.question(question, answer => {
				finish(() => resolve(answer));
			});
		}
	} catch {
		// `rl.question` throws ERR_USE_AFTER_CLOSE once piped stdin hit EOF.
		finish(() => reject(new Error("Login cancelled: stdin closed")));
	}
	return promise;
}

/**
 * Numbered stdin picker over `labels`; resolves with the chosen index.
 *
 * @throws when the answer is not a listed number, or the prompt is cancelled.
 */
export async function pickIndex(rl: readline.Interface, title: string, labels: readonly string[]): Promise<number> {
	process.stdout.write(`${title}\n\n`);
	for (let i = 0; i < labels.length; i++) {
		process.stdout.write(`  ${i + 1}. ${labels[i]}\n`);
	}
	process.stdout.write("\n");
	const choice = await promptLine(rl, `Enter number (1-${labels.length}): `);
	const index = Number.parseInt(choice, 10) - 1;
	if (Number.isNaN(index) || index < 0 || index >= labels.length) {
		throw new Error(`Invalid selection: ${choice}`);
	}
	return index;
}

/**
 * Numbered picker over OAuth providers; resolves with the chosen provider id.
 *
 * @throws when `providers` is empty or the selection is invalid/cancelled.
 */
export async function pickOAuthProvider(
	rl: readline.Interface,
	providers: readonly OAuthProviderInfo[],
): Promise<string> {
	if (providers.length === 0) {
		throw new Error("No OAuth providers registered");
	}
	const index = await pickIndex(
		rl,
		"Select a provider:",
		providers.map(p => p.name),
	);
	return providers[index].id;
}

/**
 * Run `provider`'s OAuth flow against `storage`, printing the auth URL and
 * progress to stdout and reading prompts from stdin. Resolves with the stored
 * identity (`undefined` when the flow stored nothing).
 *
 * `openBrowser` additionally opens the auth URL in the local default browser
 * (best-effort) — off for broker-host logins, which usually run headless.
 *
 * @throws when the provider flow fails or the user cancels a prompt.
 */
export async function runTerminalOAuthLogin(
	rl: readline.Interface,
	storage: AuthStorage,
	provider: OAuthProviderId,
	options: { openBrowser?: boolean } = {},
): Promise<OAuthLoginIdentity | undefined> {
	const ask = (msg: string, signal?: AbortSignal) => promptLine(rl, `${msg} `, signal);
	// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
	// Agent's vscode:// URI) get the manual paste fallback. An explicit
	// `onManualCodeInput` is honored for ANY provider (the storage escape hatch),
	// so for loopback providers we do not pass it: an eager readline prompt adds
	// noise to a flow that normally completes through HTTP. `AuthStorage.oauth.login`
	// independently refuses to synthesize the default prompt
	// for non-paste-code providers, so this is defense-in-depth on the same gate.
	const usesManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider);
	return storage.oauth.login(provider, {
		onAuth({ url, launchUrl, instructions }) {
			process.stdout.write("\nOpen this URL in your browser:\n");
			// Full URL first so the CLI works from any machine, including SSH
			// sessions where a `launchUrl` (loopback `/launch` on the OMP
			// host) would resolve against the caller's browser and fail.
			// Headless capture is unaffected: it reads the first URL line.
			process.stdout.write(`${url}\n`);
			if (launchUrl && launchUrl !== url) {
				// Local shortcut for the machine running OMP. Terminals or
				// screen-scrapers narrower than the full URL still get an
				// unbroken copy target here.
				process.stdout.write(`Local shortcut (this machine only): ${launchUrl}\n`);
			}
			if (instructions) process.stdout.write(`${instructions}\n`);
			process.stdout.write("\n");
			if (options.openBrowser) openPath(url);
		},
		onProgress(message) {
			process.stdout.write(`${message}\n`);
		},
		onPrompt(p) {
			return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
		},
		...(usesManualInput
			? {
					onManualCodeInput(signal) {
						return ask("Paste the authorization code (or full redirect URL):", signal);
					},
				}
			: undefined),
	});
}

/**
 * Human label for the account a login stored — `email (org)`, `email`, or
 * `org` — so a login landing on an unintended account/subscription is visible.
 * `undefined` for API-key logins and identity-less credentials.
 */
export function formatLoginIdentity(identity: OAuthLoginIdentity | undefined): string | undefined {
	if (identity?.type !== "oauth") return undefined;
	const base = identity.email ?? identity.accountId;
	const org = identity.orgName ?? identity.orgId;
	if (base) return org ? `${base} (${org})` : base;
	return org;
}
