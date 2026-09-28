import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { Browser } from "puppeteer-core";
import { gracefulKillTreeOnce } from "../tools/browser/attach";
import { ensureChromiumExecutable, loadPuppeteer, removeUserDataDir } from "../tools/browser/launch";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Own an isolated sign-in browser; return one cookie value in preference order, never the cookie jar. */
export async function captureBrowserSession(
	request: OAuthBrowserSessionRequest,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new LoginCancelledError();
	if (new URL(request.url).protocol !== "https:") throw new Error("Browser sign-in requires an HTTPS URL.");

	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const closed = new AbortController();
	const waiting = AbortSignal.any([lifetime, closed.signal]);
	let browser: Browser | undefined;
	let userDataDir: string | undefined;
	try {
		const [puppeteer, executablePath] = await untilAborted(lifetime, () =>
			Promise.all([loadPuppeteer(), ensureChromiumExecutable()]),
		);
		userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sso-profile-"));
		lifetime.throwIfAborted();
		// Do not race launch: retain ownership even if cancellation happens before it resolves.
		// Unlike general browser tooling, authentication keeps sandbox and TLS checks enabled.
		browser = await puppeteer.launch({
			executablePath,
			headless: false,
			defaultViewport: null,
			pipe: true,
			ignoreDefaultArgs: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
			args: [`--user-data-dir=${userDataDir}`],
			signal: lifetime,
			timeout: 30_000,
		});
		lifetime.throwIfAborted();
		browser.once("disconnected", () => closed.abort());
		const context = await untilAborted(waiting, () => browser!.createBrowserContext());
		const page = await untilAborted(waiting, () => context.newPage());
		page.once("close", () => closed.abort());
		await untilAborted(waiting, () => page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
		await untilAborted(waiting, () => page.bringToFront());
		const cdp = await untilAborted(waiting, () => page.createCDPSession());
		while (true) {
			// Chromium applies domain/path/secure matching, including HttpOnly cookies.
			const { cookies } = await untilAborted(waiting, () => cdp.send("Network.getCookies", { urls: [request.url] }));
			waiting.throwIfAborted();
			for (const name of request.cookieNames) {
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
