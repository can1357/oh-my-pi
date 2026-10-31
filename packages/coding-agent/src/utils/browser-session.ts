import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { Browser } from "puppeteer-core";
import { gracefulKillTreeOnce } from "../tools/browser/attach";
import {
	DISABLE_AUTOMATION_CONTROLLED_ARG,
	ensureSignInChromiumExecutable,
	loadPuppeteer,
	removeUserDataDir,
	stealthIgnoreDefaultArgs,
} from "../tools/browser/launch";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Own an isolated sign-in browser; return one cookie value in preference order, never the cookie jar. */
export async function captureBrowserSession(
	request: OAuthBrowserSessionRequest,
	signal?: AbortSignal,
): Promise<string> {
	// One read of each field, and the value read is the value used. The request comes from an
	// OAuth provider, which may be an extension's: a `url` getter answering `https:` to the
	// check below and `http:` to the navigation would downgrade a sign-in past a check that
	// said it was safe. Validating one read and acting on another is the defect this whole
	// boundary exists to remove, and here it costs the transport an OAuth flow runs over.
	const url = String(request.url);
	const cookieNames = Array.from(request.cookieNames, String);

	if (signal?.aborted) throw new LoginCancelledError();
	if (new URL(url).protocol !== "https:") throw new Error("Browser sign-in requires an HTTPS URL.");

	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const closed = new AbortController();
	const waiting = AbortSignal.any([lifetime, closed.signal]);
	let browser: Browser | undefined;
	let userDataDir: string | undefined;
	try {
		const [puppeteer, executablePath] = await untilAborted(lifetime, () =>
			Promise.all([loadPuppeteer(), ensureSignInChromiumExecutable()]),
		);
		userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sso-profile-"));
		lifetime.throwIfAborted();
		// Do not race launch: retain ownership even if cancellation happens before it resolves.
		// Unlike general browser tooling, authentication keeps sandbox and TLS checks enabled.
		// Automation mode must stay off: Google sign-in rejects automation-controlled browsers.
		browser = await puppeteer.launch({
			executablePath,
			headless: false,
			defaultViewport: null,
			pipe: true,
			ignoreDefaultArgs: [
				...stealthIgnoreDefaultArgs(executablePath),
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--ignore-certificate-errors",
			],
			args: [DISABLE_AUTOMATION_CONTROLLED_ARG, `--user-data-dir=${userDataDir}`],
			signal: lifetime,
			timeout: 30_000,
		});
		lifetime.throwIfAborted();
		browser.once("disconnected", () => closed.abort());
		const context = await untilAborted(waiting, () => browser!.createBrowserContext());
		const page = await untilAborted(waiting, () => context.newPage());
		page.once("close", () => closed.abort());
		await untilAborted(waiting, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
		await untilAborted(waiting, () => page.bringToFront());
		const cdp = await untilAborted(waiting, () => page.createCDPSession());
		while (true) {
			// Chromium applies domain/path/secure matching, including HttpOnly cookies.
			const { cookies } = await untilAborted(waiting, () => cdp.send("Network.getCookies", { urls: [url] }));
			waiting.throwIfAborted();
			for (const name of cookieNames) {
				const session = cookies.find(cookie => cookie.name === name && cookie.value);
				if (session) return session.value;
			}
			await untilAborted(waiting, () => Bun.sleep(250));
		}
	} catch (error) {
		if (signal?.aborted) throw new LoginCancelledError();
		if (timeout.aborted) throw new Error("Browser sign-in timed out. Start login again.");
		if (closed.signal.aborted) throw new Error("Login window closed before sign-in completed.");
		throw error;
	} finally {
		try {
			if (browser) {
				const pid = browser.process()?.pid;
				try {
					await withTimeout(browser.close(), 5_000, "Timed out closing sign-in browser");
				} catch {
					logger.warn("Sign-in browser did not close cleanly", { pid });
					if (pid !== undefined) await gracefulKillTreeOnce(pid);
				}
			}
		} finally {
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	}
}
