import * as net from "node:net";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Socket } from "bun";
import type { Browser, Page } from "puppeteer-core";
import { ToolError, throwIfAborted } from "../tool-errors";

const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

/**
 * Allocate an unused TCP port on 127.0.0.1 by binding to port 0 and reading
 * back the kernel-assigned port. There's a small race between close and the
 * subsequent bind in the launched app, but Chromium's listener will retry.
 */
export async function findFreeCdpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		if (addr && typeof addr === "object" && typeof addr.port === "number") {
			const port = addr.port;
			server.close(closeErr => (closeErr ? reject(closeErr) : resolve(port)));
		} else {
			server.close();
			reject(new Error("Failed to allocate ephemeral CDP port"));
		}
	});
	return promise;
}

/**
 * Loopback HTTP/1.1 GET that never routes through a proxy, resolving to the
 * response status code (or null when the endpoint is unreachable, aborted,
 * malformed, or slow past `timeoutMs`).
 *
 * Chrome's DevTools endpoint listens on loopback and speaks plain HTTP/1.1.
 * Both `fetch` and Bun's `node:http` honor `HTTP_PROXY`/`HTTPS_PROXY` and
 * forward even `127.0.0.1` requests to the proxy unless `NO_PROXY` covers them,
 * so a local proxy that 502s internal addresses makes a healthy daemon look
 * dead and the CDP readiness checks tear it down (issue #8567). Talking to the
 * socket over raw TCP sidesteps proxy env entirely.
 */
export async function probeCdpStatus(
	url: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<number | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (opts.signal?.aborted) return null;
	const port = target.port ? Number(target.port) : 80;
	const requestPath = `${target.pathname}${target.search}` || "/";
	const { promise, resolve } = Promise.withResolvers<number | null>();
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const finish = (status: number | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		try {
			socket?.end();
		} catch {
			// socket already torn down
		}
		resolve(status);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	let buffered = "";
	try {
		socket = await Bun.connect({
			hostname: target.hostname,
			port,
			socket: {
				open(s) {
					s.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\nConnection: close\r\n\r\n`);
				},
				data(_s, chunk) {
					buffered += chunk.toString("latin1");
					const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
					if (match) finish(Number(match[1]));
				},
				error() {
					finish(null);
				},
				close() {
					finish(null);
				},
			},
		});
	} catch {
		finish(null);
	}
	return promise;
}

/** Poll `${cdpUrl}/json/version` until it responds with 200, with abort + timeout support. */
export async function waitForCdp(cdpUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const probeUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
	let lastStatus: number | null = null;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const status = await probeCdpStatus(probeUrl, { timeoutMs: 2000, signal });
		if (status !== null && status >= 200 && status < 300) return;
		lastStatus = status;
		await Bun.sleep(150);
	}
	throwIfAborted(signal);
	throw new ToolError(
		`Timed out waiting for CDP endpoint ${cdpUrl}${lastStatus !== null ? `: HTTP ${lastStatus}` : ""}`,
	);
}

/**
 * Pull a `--remote-debugging-port=<n>` value out of an argv array (Chromium
 * accepts both `--flag=value` and `--flag value`). Returns null if absent or
 * malformed.
 */
function findCdpPortInArgs(args: string[]): number | null {
	for (const arg of args) {
		const m = /^--remote-debugging-port=(\d+)$/.exec(arg);
		if (m) {
			const port = Number.parseInt(m[1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--remote-debugging-port") {
			const port = Number.parseInt(args[i + 1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	return null;
}

function findUserDataDirInArgs(args: string[] | undefined): string | null {
	if (!args) return null;
	let result: string | null = null;
	const inlinePrefix = "--user-data-dir=";
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg.startsWith(inlinePrefix)) {
			result = arg.length > inlinePrefix.length ? arg.slice(inlinePrefix.length) : null;
			continue;
		}
		if (arg !== "--user-data-dir") continue;
		const value = args[index + 1];
		result = value !== undefined && value.length > 0 && !value.startsWith("--") ? value : null;
		if (result !== null) index++;
	}
	return result;
}

function normalizeUserDataDir(userDataDir: string): string {
	const normalized = path.resolve(userDataDir);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** One-shot probe: returns true when `/json/version` answers 200 within the timeout. */
async function probeCdpAt(port: number, signal?: AbortSignal): Promise<boolean> {
	const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500, signal });
	return status !== null && status >= 200 && status < 300;
}

/**
 * Return a reusable CDP endpoint for `exe`, or null when no instance is
 * running. Refuse to replace an occupied instance unless the caller can
 * launch an isolated profile.
 */
export async function findReusableCdp(
	exe: string,
	options: { signal?: AbortSignal; appArgs?: string[] } = {},
): Promise<{ cdpUrl: string; pid: number } | null> {
	const candidates = Process.fromPath(exe).filter(process => process.status() === ProcessStatus.Running);
	const candidateArgs: string[][] = [];
	let hasUnreadableCandidate = false;
	for (const process of candidates) {
		let args: string[];
		try {
			args = process.args();
		} catch {
			hasUnreadableCandidate = true;
			continue;
		}
		candidateArgs.push(args);
		const port = findCdpPortInArgs(args);
		if (port === null) continue;
		if (await probeCdpAt(port, options.signal)) {
			return { cdpUrl: `http://127.0.0.1:${port}`, pid: process.pid };
		}
	}
	const requestedUserDataDir = findUserDataDirInArgs(options.appArgs);
	const normalizedRequestedUserDataDir =
		requestedUserDataDir !== null && path.isAbsolute(requestedUserDataDir)
			? normalizeUserDataDir(requestedUserDataDir)
			: null;
	const canLaunchIsolatedProfile =
		normalizedRequestedUserDataDir !== null &&
		!hasUnreadableCandidate &&
		candidateArgs.every(args => {
			const existingUserDataDir = findUserDataDirInArgs(args);
			return (
				existingUserDataDir === null ||
				(path.isAbsolute(existingUserDataDir) &&
					normalizeUserDataDir(existingUserDataDir) !== normalizedRequestedUserDataDir)
			);
		});
	if (!canLaunchIsolatedProfile && candidates.length > 0) {
		const name = path.basename(exe);
		throw new ToolError(
			`Cannot launch ${name} because it is already running without a reusable CDP endpoint. Close ${name}, relaunch it with --remote-debugging-port, or pass app.cdp_url for an existing endpoint.`,
		);
	}
	return null;
}

export function shouldPreserveConnectedBrowserFocus(target?: string): boolean {
	return !target;
}

/**
 * Pick the best page target on an attached browser. Prefer discoverable page
 * targets first so Chromium/Edge attach flows that hide pages from
 * `browser.pages()` can still return a usable tab.
 *
 * `preferVisible` is for attaching to a browser a human is using: among equally
 * usable tabs, take the one that is actually foregrounded rather than whichever
 * target CDP happens to enumerate first.
 */
export async function pickElectronTarget(
	browser: Browser,
	options: { matcher?: string; preferVisible?: boolean } = {},
): Promise<Page> {
	const discoveredPages = await Promise.all(
		browser.targets().map(async target => {
			if (String(target.type()) !== "page") return null;
			return await target.page().catch(() => null);
		}),
	);
	const usablePages = discoveredPages.filter((page): page is Page => page !== null);
	if (usablePages.length > 0) {
		return pickPageFromList(usablePages, options);
	}

	const fallbackPages = await browser.pages();
	if (!fallbackPages.length) {
		throw new ToolError("No page targets available on the attached browser");
	}
	return pickPageFromList(fallbackPages, options);
}

async function enrichPages(pages: Page[]): Promise<Array<{ page: Page; url: string; title: string }>> {
	return await Promise.all(
		pages.map(async page => ({
			page,
			url: page.url(),
			title: ((await page.title().catch(() => "")) ?? "").trim(),
		})),
	);
}

async function pickPageFromList(pages: Page[], options: { matcher?: string; preferVisible?: boolean }): Promise<Page> {
	const enriched = await enrichPages(pages);
	if (options.matcher) {
		const needle = options.matcher.toLowerCase();
		const hit = enriched.find(p => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (hit) return hit.page;
		const summary = enriched.map(p => `- ${p.title || "(untitled)"}  ${p.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(options.matcher)}. Available pages:\n${summary}`);
	}
	const usable = enriched.filter(
		p => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title),
	);
	if (options.preferVisible && usable.length > 1) {
		// Best-effort foreground probe; a tab that cannot answer counts as hidden.
		const visibility = await Promise.all(
			usable.map(async p => {
				try {
					return (await p.page.evaluate(() => document.visibilityState === "visible")) === true;
				} catch {
					return false;
				}
			}),
		);
		const foreground = visibility.indexOf(true);
		if (foreground >= 0) return usable[foreground]!.page;
	}
	return usable[0]?.page ?? enriched[0]!.page;
}

/**
 * SIGTERM the process tree, wait briefly, then SIGKILL anything still alive.
 * Single-process variant for our own spawned children.
 */
export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2000): Promise<void> {
	const process = Process.fromPid(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}
