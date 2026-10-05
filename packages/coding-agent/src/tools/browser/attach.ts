import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { getBrowserProfilesDir, untilAborted } from "@oh-my-pi/pi-utils";
import type { Socket } from "bun";
import type { Browser, Page, Target } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

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

/** Status line plus body of a {@link probeCdpResponse} answer. */
export interface CdpProbeResponse {
	status: number;
	body: string;
}

interface RawGetOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Resolve after the body arrives (Content-Length or peer close) instead of on the status line. */
	readBody: boolean;
}

/**
 * Loopback HTTP/1.1 GET that never routes through a proxy. Resolves null when
 * the endpoint is unreachable, aborted, malformed, or slow past `timeoutMs`.
 *
 * Chrome's DevTools endpoint listens on loopback and speaks plain HTTP/1.1.
 * Both `fetch` and Bun's `node:http` honor `HTTP_PROXY`/`HTTPS_PROXY` and
 * forward even `127.0.0.1` requests to the proxy unless `NO_PROXY` covers them,
 * so a local proxy that 502s internal addresses makes a healthy daemon look
 * dead and the CDP readiness checks tear it down (issue #8567). Talking to the
 * socket over raw TCP sidesteps proxy env entirely.
 */
async function rawHttpGet(url: string, opts: RawGetOptions): Promise<CdpProbeResponse | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (opts.signal?.aborted) return null;
	const port = target.port ? Number(target.port) : 80;
	const requestPath = `${target.pathname}${target.search}` || "/";
	const { promise, resolve } = Promise.withResolvers<CdpProbeResponse | null>();
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const finish = (response: CdpProbeResponse | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		try {
			socket?.end();
		} catch {
			// socket already torn down
		}
		resolve(response);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	let buffered = "";
	let status: number | null = null;
	// Offset of the header/body separator once the header block is complete.
	let headerEnd = -1;
	let contentLength: number | null = null;
	const bodySoFar = () => buffered.slice(headerEnd + 4);
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
					if (status === null) {
						const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
						if (!match) return;
						status = Number(match[1]);
						if (!opts.readBody) {
							finish({ status, body: "" });
							return;
						}
					}
					if (headerEnd === -1) {
						headerEnd = buffered.indexOf("\r\n\r\n");
						if (headerEnd === -1) return;
						const lengthHeader = /\r\ncontent-length:\s*(\d+)/i.exec(buffered.slice(0, headerEnd));
						contentLength = lengthHeader ? Number(lengthHeader[1]) : null;
					}
					if (contentLength !== null && bodySoFar().length >= contentLength) {
						finish({ status, body: bodySoFar().slice(0, contentLength) });
					}
				},
				error() {
					finish(null);
				},
				close() {
					// Without Content-Length the peer's close delimits the body.
					finish(status !== null && headerEnd !== -1 ? { status, body: bodySoFar() } : null);
				},
			},
		});
	} catch {
		finish(null);
	}
	return promise;
}

/**
 * Proxy-proof loopback probe resolving to the response status code, or null
 * when the endpoint is unreachable, aborted, malformed, or slow past `timeoutMs`.
 */
export async function probeCdpStatus(
	url: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<number | null> {
	const response = await rawHttpGet(url, { ...opts, readBody: false });
	return response?.status ?? null;
}

/**
 * Proxy-proof loopback probe that also reads the response body (for endpoints
 * whose non-2xx answer carries state, like the relay's 503). Null on the same
 * conditions as {@link probeCdpStatus}.
 */
export function probeCdpResponse(
	url: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CdpProbeResponse | null> {
	return rawHttpGet(url, { ...opts, readBody: true });
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

/**
 * Executable basenames of Chromium-family browsers (release channels and
 * vendor suffixes included), as opposed to Electron apps that also speak CDP.
 * Matched against the basename without `.exe`.
 */
const CHROMIUM_BROWSER_BASENAME =
	/^(?:google[ -]chrome|chrome|chromium|microsoft[ -]edge|msedge|brave|vivaldi|opera|thorium|ungoogled[ -]chromium)(?:[ -](?:beta|dev|canary|unstable|stable|nightly|snapshot|browser|gx|for[ -]testing))*$/i;
const CHROMIUM_FLATPAK_IDS: Record<string, true> = {
	"com.google.Chrome": true,
	"org.chromium.Chromium": true,
	"io.github.ungoogled_software.ungoogled_chromium": true,
};

/**
 * Launch argv for a spawned executable. Chrome 136+ silently ignores
 * `--remote-debugging-port` when the default user-data-dir is in use: the
 * browser opens as usual, nothing listens, and attach waits out its timeout.
 * Chromium-family browsers therefore get a stable omp-owned profile under
 * `~/.omp/browser-profiles/<exe slug>` unless the caller already picked one.
 * That profile is also what lets a second instance start beside the user's
 * running default-profile browser instead of handing off to it. Electron apps
 * are left untouched: `--user-data-dir` would relocate their app data.
 *
 * An omp-owned profile also bypasses the OS keystore (`--use-mock-keychain`,
 * `--password-store=basic`, the same pair puppeteer's launcher sets): Chromium
 * otherwise derives its cookie-encryption key from the login keychain and
 * macOS blocks on a "wants to use your confidential information" dialog for
 * every fresh binary. A caller-supplied profile keeps the real keystore; its
 * existing cookies are encrypted with that key and a mock one would corrupt them.
 */
export function resolveSpawnArgs(exe: string, appArgs: string[] | undefined, cwd = process.cwd()): string[] {
	const args = appArgs ?? [];
	const base = path.basename(exe).replace(/\.exe$/i, "");
	if (!CHROMIUM_BROWSER_BASENAME.test(base) && !Object.hasOwn(CHROMIUM_FLATPAK_IDS, base)) return args;
	const requestedProfile = findUserDataDirInArgs(args);
	if (requestedProfile !== null) {
		// Chromium accepts switch values as --name=value, not a separate argv
		// item. Canonicalize both spellings so reuse and process launch agree.
		const launchArgs: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--user-data-dir") {
				if (args[index + 1] && !args[index + 1]!.startsWith("--")) index++;
			} else if (!arg.startsWith("--user-data-dir=")) {
				launchArgs.push(arg);
			}
		}
		launchArgs.push(`--user-data-dir=${path.resolve(cwd, requestedProfile)}`);
		return launchArgs;
	}
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const hash = Bun.hash.wyhash(exe).toString(16).padStart(16, "0");
	const launchArgs = [...args];
	// A fresh profile otherwise opens the welcome tour and default-browser
	// prompt as extra page targets, which attach may adopt instead of ours.
	for (const flag of ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"]) {
		if (!args.includes(flag)) launchArgs.push(flag);
	}
	if (!args.some(arg => arg.startsWith("--password-store"))) launchArgs.push("--password-store=basic");
	launchArgs.push(`--user-data-dir=${path.join(getBrowserProfilesDir(), `${slug}-${hash}`)}`);
	return launchArgs;
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
 * Resolve a distro wrapper script to its exec target (e.g.
 * /opt/google/chrome/google-chrome is bash ending in
 * `exec -a "$0" "$HERE/chrome" "$@"` with $HERE = dirname of the wrapper).
 * Scans line-by-line for the final `exec ... $HERE/...` command so helper
 * invocations are never mistaken for the application. Returns null for
 * binaries and wrappers without an exec command. Size-guarded so real
 * binaries are never read into memory.
 */
async function resolveWrapperTarget(wrapperPath: string): Promise<string | null> {
	if (process.platform !== "linux") return null;
	const stat = await fs.stat(wrapperPath).catch(() => null);
	if (!stat || !stat.isFile() || stat.size > 65_536) return null;
	const content = await Bun.file(wrapperPath)
		.text()
		.catch(() => null);
	if (!content || content.charCodeAt(0) === 0x7f) return null;
	let target: string | null = null;
	const execRegex = /^\s*exec\s+(?:-a\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?["']?\$(?:HERE|\{HERE\})\/([^\s"'`;}]+)/;
	for (const line of content.split("\n")) {
		const match = execRegex.exec(line);
		if (match?.[1]) target = match[1];
	}
	if (!target) return null;
	const joined = path.join(path.dirname(wrapperPath), target);
	return fs.realpath(joined).catch(() => joined);
}

/**
 * Normalize candidate argv for kernels that serve /proc/<pid>/cmdline
 * space-joined instead of NUL-separated. A glued first word (the whole
 * command line in argv[0]) would otherwise hide --user-data-dir and
 * --remote-debugging-port from the matchers below.
 */
function normalizeCandidateArgs(args: string[]): string[] {
	if (args.length !== 1 || !args[0]!.includes(" --")) return args;
	const word = args[0]!;
	const split = word.trim().split(/\s+/);
	if (split.length <= 1) return args;

	// Invariant: ungluing is only safe when splitting preserves exact argument
	// boundaries without corrupting switch values (e.g. splitting a profile path
	// containing spaces into multiple argv elements, which risks cross-profile reuse).
	// Every --user-data-dir flag must re-parse to the identical value.
	const flagRegex = /(?:^|\s)--user-data-dir(?:=(.*?)|(?:\s+(.*?))?)(?=\s--|$)/g;
	const rawMatches = [...word.trim().replace(/\s+/g, " ").matchAll(flagRegex)];
	if (rawMatches.length > 0) {
		let matchIndex = 0;
		for (let i = 0; i < split.length; i++) {
			const arg = split[i]!;
			if (arg.startsWith("--user-data-dir=")) {
				const expected = rawMatches[matchIndex]?.[1] ?? rawMatches[matchIndex]?.[2] ?? "";
				const actual = findUserDataDirInArgs(split.slice(i, i + 1));
				if (actual !== expected) return args;
				matchIndex++;
			} else if (arg === "--user-data-dir") {
				const expected = rawMatches[matchIndex]?.[1] ?? rawMatches[matchIndex]?.[2] ?? "";
				const actual = findUserDataDirInArgs(split.slice(i, i + 2));
				if (actual !== expected) return args;
				matchIndex++;
				i++;
			}
		}
		if (matchIndex !== rawMatches.length) return args;
	}

	return split;
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
	const requestedUserDataDir = findUserDataDirInArgs(options.appArgs);
	const normalizedRequestedUserDataDir =
		requestedUserDataDir !== null && path.isAbsolute(requestedUserDataDir)
			? normalizeUserDataDir(requestedUserDataDir)
			: null;
	// Process paths use the executable real path, not its launcher symlink. A distro
	// wrapper script defeats realpath, so resolve through the wrapper exec target
	// for Chromium-family browsers on Linux.
	const executablePath = await fs.realpath(exe).catch(() => exe);
	const base = path.basename(exe).replace(/\.exe$/i, "");
	const isChromium = CHROMIUM_BROWSER_BASENAME.test(base) || Object.hasOwn(CHROMIUM_FLATPAK_IDS, base);
	const wrapperTarget = process.platform === "linux" && isChromium ? await resolveWrapperTarget(executablePath) : null;
	const candidates = Process.fromPath(wrapperTarget ?? executablePath).filter(
		candidate => candidate.status() === ProcessStatus.Running,
	);
	const candidateArgs: string[][] = [];
	let hasUnreadableCandidate = false;
	for (const process of candidates) {
		let args: string[];
		try {
			args = normalizeCandidateArgs(process.args());
		} catch {
			hasUnreadableCandidate = true;
			continue;
		}
		candidateArgs.push(args);
		const candidateProfile = findUserDataDirInArgs(args);
		if (
			requestedUserDataDir !== null &&
			(normalizedRequestedUserDataDir === null ||
				candidateProfile === null ||
				!path.isAbsolute(candidateProfile) ||
				normalizeUserDataDir(candidateProfile) !== normalizedRequestedUserDataDir)
		) {
			continue;
		}
		const port = findCdpPortInArgs(args);
		if (port === null) continue;
		if (await probeCdpAt(port, options.signal)) {
			return { cdpUrl: `http://127.0.0.1:${port}`, pid: process.pid };
		}
	}
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

export interface PickTargetOptions {
	matcher?: string;
	preferVisible?: boolean;
	/** Relay /json endpoint (e.g. http://127.0.0.1:9224); enables metadata-first target selection. */
	relayJson?: string;
	signal?: AbortSignal;
}

const PAGE_ATTACH_TIMEOUT_MS = 10_000;
const FRAME_READY_TIMEOUT_MS = 8_000;
const FRAME_READY_POLL_MS = 120;
const RELAY_JSON_TIMEOUT_MS = 3_000;
const RELAY_VISIBILITY_TIMEOUT_MS = 1_000;

async function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
	try {
		return await untilAborted(signal, operation);
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	}
}

interface RelayJsonEntry {
	id: string;
	type: string;
	title: string;
	url: string;
	active?: string;
	discarded?: string;
}

/** Attach to one target under a deadline; unresponsive targets resolve to null. */
export async function attachPageWithTimeout(
	target: Target,
	timeoutMs = PAGE_ATTACH_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<Page | null> {
	throwIfAborted(signal);
	const timeout = Promise.withResolvers<Page | null>();
	const timer = setTimeout(() => timeout.resolve(null), timeoutMs);
	try {
		return await untilAborted(signal, () => {
			const page = Promise.resolve()
				.then(() => target.page())
				.then(value => value ?? null)
				.catch(() => null);
			return Promise.race([page, timeout.promise]);
		});
	} catch {
		throwIfAborted(signal);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Puppeteer throws "Requesting main frame too early!" when a Page's
 * frameTree has not arrived yet — common right after adopting a relay tab
 * whose CDP session was synthesized. Poll until mainFrame serves or the
 * deadline passes.
 */
export async function waitForMainFrame(
	page: Page,
	timeoutMs = FRAME_READY_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		throwIfAborted(signal);
		try {
			page.url();
			return true;
		} catch (err) {
			if (!/too early/i.test(err instanceof Error ? err.message : String(err))) return false;
		}
		if (Date.now() >= deadline) return false;
		try {
			await untilAborted(signal, () => Bun.sleep(FRAME_READY_POLL_MS));
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
	}
}
async function fetchRelayEntries(relayJson: string, signal?: AbortSignal): Promise<RelayJsonEntry[] | null> {
	try {
		const res = await probeCdpResponse(`${relayJson.replace(/\/$/, "")}/json`, {
			timeoutMs: RELAY_JSON_TIMEOUT_MS,
			signal,
		});
		if (!res || res.status < 200 || res.status >= 300) return null;
		const body: unknown = JSON.parse(Buffer.from(res.body, "latin1").toString("utf8"));
		return Array.isArray(body) ? (body as RelayJsonEntry[]) : null;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

function selectRelayEntry(entries: RelayJsonEntry[], options: PickTargetOptions): RelayJsonEntry | null {
	const needle = options.matcher?.toLowerCase();
	if (needle) {
		const hits = entries.filter(e => e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle));
		const live = hits.filter(e => e.discarded !== "true");
		if (live.length > 0) return live[0]!;
		if (hits.length > 0) {
			throw new ToolError(
				`The tab matching ${JSON.stringify(options.matcher)} was discarded by Chrome. Click it to reload, then retry.`,
			);
		}
		const summary = entries.map(e => `- ${e.title || "(untitled)"}  ${e.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(options.matcher)}. Available pages:\n${summary}`);
	}
	const usable = entries.filter(
		e =>
			e.discarded !== "true" && !ATTACH_TARGET_SKIP_PATTERN.test(e.url) && !ATTACH_TARGET_SKIP_PATTERN.test(e.title),
	);
	return usable.find(e => e.active === "true") ?? usable[0] ?? null;
}

/** Select relay pages from /json metadata before probing pages; enumerate targets when metadata offers no selection. */
export async function pickElectronTarget(browser: Browser, options: PickTargetOptions = {}): Promise<Page> {
	throwIfAborted(options.signal);
	if (options.relayJson) {
		const entries = await fetchRelayEntries(options.relayJson, options.signal);
		if (entries) {
			const pageEntries = entries.filter(e => e.type === "page");
			const selected = pageEntries.length > 0 ? selectRelayEntry(pageEntries, options) : null;
			const targets = browser.targets();
			if (options.preferVisible && !options.matcher) {
				const active = pageEntries.filter(
					e =>
						e.active === "true" &&
						e.discarded !== "true" &&
						!ATTACH_TARGET_SKIP_PATTERN.test(e.url) &&
						!ATTACH_TARGET_SKIP_PATTERN.test(e.title),
				);
				if (active.length > 1) {
					let firstPage: Page | null = null;
					let unreadableActive = false;
					for (const entry of active) {
						const target = targets.find(t => (t as Target & { _targetId?: string })._targetId === entry.id);
						if (!target) {
							unreadableActive = true;
							continue;
						}
						const page = await attachPageWithTimeout(target, PAGE_ATTACH_TIMEOUT_MS, options.signal);
						if (!page || !(await waitForMainFrame(page, FRAME_READY_TIMEOUT_MS, options.signal))) {
							unreadableActive = true;
							continue;
						}
						firstPage ??= page;
						const visible = await abortable(options.signal, () =>
							Promise.race([
								page.evaluate(() => document.visibilityState === "visible").catch(() => false),
								Bun.sleep(RELAY_VISIBILITY_TIMEOUT_MS).then(() => false),
							]),
						);
						if (visible) return page;
					}
					if (unreadableActive) throw new ToolError("An active tab is not ready; retry after it loads");
					if (firstPage) return firstPage;
				}
			}
			if (selected) {
				const target = targets.find(t => (t as Target & { _targetId?: string })._targetId === selected.id);
				if (!target) throw new ToolError("Selected tab is no longer available");
				const page = await attachPageWithTimeout(target, PAGE_ATTACH_TIMEOUT_MS, options.signal);
				if (!page || !(await waitForMainFrame(page, FRAME_READY_TIMEOUT_MS, options.signal)))
					throw new ToolError("Selected tab is not ready; retry after it loads");
				return page;
			}
		}
	}

	let hasUnreadablePage = false;
	const discoveredPages = await Promise.all(
		browser.targets().map(async target => {
			if (String(target.type()) !== "page") return null;
			const page = await attachPageWithTimeout(target, PAGE_ATTACH_TIMEOUT_MS, options.signal);
			if (!page || !(await waitForMainFrame(page, FRAME_READY_TIMEOUT_MS, options.signal))) {
				hasUnreadablePage = true;
				return null;
			}
			return page;
		}),
	);
	const usablePages = discoveredPages.filter((page): page is Page => page !== null);
	if (hasUnreadablePage && (options.preferVisible || options.matcher)) {
		if (options.preferVisible && !options.matcher) {
			const visible = await firstVisiblePage(usablePages, options.signal);
			if (visible) return visible;
		}
		throw new ToolError("A browser tab is not ready; retry after it loads to avoid selecting a different tab");
	}
	if (usablePages.length > 0) return pickPageFromList(usablePages, options);

	const fallbackPages = await abortable(options.signal, () => browser.pages());
	if (!fallbackPages.length) {
		throw new ToolError("No page targets available on the attached browser");
	}
	return pickPageFromList(fallbackPages, options);
}

async function enrichPages(
	pages: Page[],
	signal?: AbortSignal,
): Promise<Array<{ page: Page; url: string; title: string }>> {
	return await Promise.all(
		pages.map(async page => {
			await waitForMainFrame(page, FRAME_READY_TIMEOUT_MS, signal);
			let url = "";
			try {
				url = page.url();
			} catch {
				url = "";
			}
			const title = ((await abortable(signal, () => page.title().catch(() => ""))) ?? "").trim();
			return { page, url, title };
		}),
	);
}

async function firstVisiblePage(pages: Page[], signal?: AbortSignal): Promise<Page | null> {
	const visibility = await Promise.all(
		pages.map(
			async page =>
				await abortable(signal, () =>
					Promise.race([
						page.evaluate(() => document.visibilityState === "visible").catch(() => false),
						Bun.sleep(RELAY_VISIBILITY_TIMEOUT_MS).then(() => false),
					]),
				),
		),
	);
	const foreground = visibility.indexOf(true);
	return foreground >= 0 ? pages[foreground]! : null;
}

async function pickPageFromList(pages: Page[], options: PickTargetOptions): Promise<Page> {
	const enriched = await enrichPages(pages, options.signal);
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
		const foreground = await firstVisiblePage(
			usable.map(entry => entry.page),
			options.signal,
		);
		if (foreground) return foreground;
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
