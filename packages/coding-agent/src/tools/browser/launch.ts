import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getPuppeteerDir, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import type * as BrowsersNs from "@oh-my-pi/pi-utils/browsers";
import type { Browser, CDPSession, Page, default as Puppeteer, Target } from "puppeteer-core";
import stealthTamperingScript from "../puppeteer/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "../puppeteer/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "../puppeteer/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "../puppeteer/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "../puppeteer/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "../puppeteer/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "../puppeteer/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "../puppeteer/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "../puppeteer/08_stealth_audio.txt" with { type: "text" };
import stealthLocaleScript from "../puppeteer/09_stealth_locale.txt" with { type: "text" };
import stealthPluginsScript from "../puppeteer/10_stealth_plugins.txt" with { type: "text" };
import stealthHardwareScript from "../puppeteer/11_stealth_hardware.txt" with { type: "text" };
import stealthCodecsScript from "../puppeteer/12_stealth_codecs.txt" with { type: "text" };
import stealthWorkerScript from "../puppeteer/13_stealth_worker.txt" with { type: "text" };
import { ToolError } from "../tool-errors";

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

/**
 * Per-CDP-message timeout applied to every puppeteer launch/connect. Set above
 * `TOOL_TIMEOUTS.browser.max` (30s) so the agent-side wall-clock is the canonical
 * limit; this constant only catches genuinely stuck CDP sockets (renderer wedged,
 * connection dropped, etc.).
 */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
const ENABLE_AUTOMATION_FLAG = "--enable-automation";
// Automation-tell launch flags that puppeteer-core adds by default. We suppress
// them via `ignoreDefaultArgs` (the supported escape hatch) to mirror xxxx's
// chromiumSwitches patch. `--enable-automation` is the loudest: it normally sets
// navigator.webdriver=true and shows the "controlled by automated software" infobar.
// Edge is the launch-stability exception: it can exit before CDP opens when this
// default flag is stripped, so Edge keeps Puppeteer's flag while our explicit
// `--disable-blink-features=AutomationControlled` launch arg still handles
// navigator.webdriver.
// `ignoreDefaultArgs` does exact-string matching, so each entry must be a flag that
// puppeteer emits verbatim. The default `--disable-features=...` string can't be
// matched this way; it is neutralized in the puppeteer-core patch (ChromeLauncher).
const STEALTH_IGNORE_DEFAULT_ARGS = [
	ENABLE_AUTOMATION_FLAG,
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
	"--disable-popup-blocking",
	"--disable-client-side-phishing-detection",
	"--allow-pre-commit-input",
	"--disable-ipc-flooding-protection",
	"--metrics-recording-only",
];

function isMicrosoftEdgeExecutable(executablePath: string | undefined): boolean {
	if (!executablePath) return false;
	const normalizedPath = executablePath.replaceAll("\\", "/").toLowerCase();
	const executableName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	return (
		executableName === "msedge.exe" ||
		executableName === "microsoft edge" ||
		executableName.startsWith("microsoft-edge")
	);
}

function stealthIgnoreDefaultArgs(executablePath: string | undefined): string[] {
	if (!isMicrosoftEdgeExecutable(executablePath)) return [...STEALTH_IGNORE_DEFAULT_ARGS];
	return STEALTH_IGNORE_DEFAULT_ARGS.filter(arg => arg !== ENABLE_AUTOMATION_FLAG);
}

const STEALTH_ACCEPT_LANGUAGE = "en-US,en";

const USER_AGENT_TARGET_TIMEOUT_MS = 5_000;
const USER_AGENT_TARGET_TYPES = new Set(["page", "webview", "background_page"]);
const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";

/**
 * Lazy-import puppeteer while hiding the user's cwd from cosmiconfig. The
 * import must not change the filesystem cwd: it is awaited and callers
 * continue running on the main thread while it is pending.
 */
let puppeteerCwdFailed = false;
let puppeteerCwdFailure: unknown;
async function importPuppeteerWithSafeCwd(safeDir: string): Promise<typeof Puppeteer> {
	const cwdDescriptor = Object.getOwnPropertyDescriptor(process, "cwd");
	if (!cwdDescriptor || typeof cwdDescriptor.value !== "function") {
		throw new Error("Unable to safely override process.cwd for Puppeteer import");
	}

	try {
		Object.defineProperty(process, "cwd", { ...cwdDescriptor, value: () => safeDir });
	} catch (overrideFailure) {
		puppeteerCwdFailed = true;
		puppeteerCwdFailure = overrideFailure;
		throw overrideFailure;
	}
	let loaded: typeof Puppeteer | undefined;
	let importFailure: unknown;
	let importFailed = false;
	let restorationFailure: unknown;
	let restorationFailed = false;
	try {
		try {
			// Dynamic import is intentional: Puppeteer probes cwd during module initialization.
			loaded = (await import("puppeteer-core")).default;
		} catch (error) {
			importFailed = true;
			importFailure = error;
		}
	} finally {
		try {
			Object.defineProperty(process, "cwd", cwdDescriptor);
		} catch (error) {
			restorationFailed = true;
			restorationFailure = error;
		}
	}
	if (restorationFailed) {
		const failure = importFailed
			? new AggregateError([importFailure, restorationFailure], "Puppeteer import and cwd restoration failed")
			: restorationFailure;
		puppeteerCwdFailed = true;
		puppeteerCwdFailure = failure;
		throw failure;
	}
	if (importFailed) throw importFailure;
	return loaded!;
}

let puppeteerModule: typeof Puppeteer | undefined;
let puppeteerLoadPromise: Promise<typeof Puppeteer> | undefined;
async function loadPuppeteerImport(safeDir: string, prepareSafeDir: boolean): Promise<typeof Puppeteer> {
	if (puppeteerCwdFailed) throw puppeteerCwdFailure;
	let loading = puppeteerLoadPromise;
	if (!loading) {
		loading = (async () => {
			if (prepareSafeDir) await Bun.write(path.join(safeDir, "package.json"), "{}");
			return importPuppeteerWithSafeCwd(safeDir);
		})();
		puppeteerLoadPromise = loading;
	}
	try {
		return await loading;
	} finally {
		if (puppeteerLoadPromise === loading) puppeteerLoadPromise = undefined;
	}
}

export async function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return puppeteerModule;
	const loaded = await loadPuppeteerImport(getPuppeteerDir(), true);
	puppeteerModule = loaded;
	return loaded;
}

let puppeteerModuleWorker: typeof Puppeteer | undefined;
export async function loadPuppeteerInWorker(safeDir: string): Promise<typeof Puppeteer> {
	if (puppeteerModuleWorker) return puppeteerModuleWorker;
	const loaded = await loadPuppeteerImport(safeDir, false);
	puppeteerModuleWorker = loaded;
	return loaded;
}

let browsersModule: typeof BrowsersNs | undefined;
async function loadBrowsers(): Promise<typeof BrowsersNs> {
	if (!browsersModule) {
		browsersModule = await import("@oh-my-pi/pi-utils/browsers");
	}
	return browsersModule;
}

/**
 * Resolve the Chromium executable puppeteer will launch.
 *
 * `PUPPETEER_EXECUTABLE_PATH` always wins. On macOS the isolated Chrome for
 * Testing binary is preferred over a detected system Chrome: a headless
 * daemon launched from a system `Google Chrome.app` bundle shares its
 * LaunchServices bundle identity (`com.google.Chrome`), so macOS can deliver
 * the user's open-URL Apple Events to the daemon and silently swallow their
 * link clicks (#8673). Chrome for Testing uses a dedicated bundle id
 * (`com.google.chrome.for.testing`) that is never a user's default handler;
 * system Chrome is used on macOS only when Chrome for Testing cannot be
 * obtained. Other platforms keep the download-avoiding system Chrome
 * preference and fall back to Chrome for Testing. The managed browser is
 * cached under ~/.omp/puppeteer (getPuppeteerDir). Returns undefined when
 * platform detection fails (puppeteer default resolution takes over).
 * Exported so real-browser tests can probe launchability and skip on hosts
 * missing Chrome's system libraries.
 */
let chromiumExecutablePromise: Promise<string | undefined> | undefined;
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	// macOS: never route a background daemon through the user's GUI Chrome
	// bundle; prefer the isolated Chrome for Testing binary instead (#8673).
	const preferManagedChromium = process.platform === "darwin";
	if (!preferManagedChromium) {
		const sysChrome = await resolveSystemChromium();
		if (sysChrome) return sysChrome;
	}

	chromiumExecutablePromise ??= (async () => {
		const browsers = await loadBrowsers();
		const platform = browsers.detectBrowserPlatform();
		if (!platform) {
			logger.warn("Could not detect browser platform; relying on puppeteer default resolution");
			return undefined;
		}
		const cacheDir = getPuppeteerDir();
		const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
		const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
		const executablePath = browsers.computeExecutablePath({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
		});
		if (fs.existsSync(executablePath)) return executablePath;

		logger.warn("Downloading Chromium for puppeteer (first browser use)", {
			buildId,
			platform,
			cacheDir,
		});
		let lastReportedPercent = -1;
		await browsers.install({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
			downloadProgressCallback: ({ downloadedBytes, totalBytes }) => {
				if (totalBytes <= 0) return;
				const pct = Math.floor((downloadedBytes / totalBytes) * 100);
				if (pct >= lastReportedPercent + 10 || downloadedBytes === totalBytes) {
					lastReportedPercent = pct;
					logger.debug(
						`Chromium download: ${pct}% (${Math.round(downloadedBytes / 1_000_000)} / ${Math.round(totalBytes / 1_000_000)} MB)`,
					);
				}
			},
		});
		return executablePath;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		throw new ToolError(
			`Failed to install Chromium for puppeteer: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});

	try {
		return await chromiumExecutablePromise;
	} catch (err) {
		if (!preferManagedChromium) throw err;
		// Chrome for Testing could not be obtained on macOS; degrade to the
		// system Chrome bundle rather than leaving the browser tool unusable.
		const sysChrome = await resolveSystemChromium();
		if (!sysChrome) throw err;
		logger.warn(
			"Chrome for Testing unavailable; falling back to the system Chrome bundle. On macOS this can let the " +
				"headless browser daemon capture your link clicks (#8673). Set PUPPETEER_EXECUTABLE_PATH to a " +
				"dedicated Chromium to avoid this.",
			{ path: sysChrome, error: (err as Error).message },
		);
		return sysChrome;
	}
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isChromiumExecutable(p: string): Promise<boolean> {
	if (!isExecutableFile(p)) return false;
	// The version probe below launches the candidate. It exists to reject
	// non-Chromium `chrome`/`chromium` wrapper scripts that appear on a Linux
	// PATH (ecb22957, "validate Linux browser executables"). On Windows and
	// macOS the candidates are fixed GUI application paths, not PATH wrappers,
	// and executing them is harmful: a GUI `chrome.exe --version` does not print
	// to a detached stdout and can hand off to the user's running instance,
	// opening/activating a normal browser window (#8445). Confine the probe to
	// Linux and trust the executable-file check elsewhere.
	if (process.platform !== "linux") return true;
	try {
		const probeTimeoutMs = 3000;
		const proc = Bun.spawn([p, "--version"], {
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(probeTimeoutMs),
			killSignal: "SIGKILL",
		});
		const stdout = await Promise.race([
			new Response(proc.stdout).text(),
			Bun.sleep(probeTimeoutMs + 500).then(() => null),
		]);
		if (stdout === null) return false;
		await proc.exited;
		return proc.exitCode === 0 && /Chrom|Edg/i.test(stdout);
	} catch {
		return false;
	}
}

/** Flatpak application id published by the Ungoogled Chromium project. */
const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

function systemChromiumCandidates(
	platform: NodeJS.Platform = process.platform,
	home = os.homedir(),
	which: (name: string) => string | null | undefined = $which,
): string[] {
	const candidates: string[] = [];
	switch (platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			for (const name of ["ungoogled-chromium", "ungoogled-chromium-browser"]) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				// Ungoogled Chromium. Distro and AUR packages that keep the plain
				// `chromium` name are already covered above; these are the paths
				// unique to it, including the system and per-user Flatpak shims.
				"/usr/bin/ungoogled-chromium",
				"/usr/bin/ungoogled-chromium-browser",
				`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`,
				path.join(home, ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
			);
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

async function resolveSystemChromium(): Promise<string | undefined> {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (await isChromiumExecutable(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

/** Options shared by headless Chromium consumers. */
export interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	/** Additional Chromium arguments merged with the centralized launch defaults. */
	args?: readonly string[];
	/** Additional exact Puppeteer default arguments to suppress. */
	ignoreDefaultArgs?: readonly string[];
}

/** Result of a headless Chromium launch. */
export interface LaunchHeadlessResult {
	browser: Browser;
	/**
	 * OMP-owned temporary Chromium profile directory to remove after the browser
	 * process tree exits, or `undefined` when the caller supplied its own
	 * `--user-data-dir` (which OMP must not delete).
	 */
	userDataDir?: string;
}

/**
 * Base Chromium argv shared by process-local puppeteer launches and the
 * broker-owned shared browser: sandbox/stealth flags, window size, and
 * PUPPETEER_PROXY* env-derived proxy flags.
 */
export function buildHeadlessLaunchArgs(viewport: { width: number; height: number }): string[] {
	const launchArgs = [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-blink-features=AutomationControlled",
		`--window-size=${viewport.width},${viewport.height}`,
	];
	const proxy = process.env.PUPPETEER_PROXY;
	if (proxy) {
		launchArgs.push(`--proxy-server=${proxy}`);
		// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
		// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
		const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}
	return launchArgs;
}

export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<LaunchHeadlessResult> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const initialViewport = {
		width: vp.width,
		height: vp.height,
		deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	};
	const puppeteer = await loadPuppeteer();
	const launchArgs = buildHeadlessLaunchArgs(initialViewport);
	for (const arg of opts.args ?? []) {
		if (!launchArgs.includes(arg)) launchArgs.push(arg);
	}
	// Own the Chromium profile directory instead of letting puppeteer-core create
	// (and delete) a temporary one. Passing `--user-data-dir` makes puppeteer
	// treat the profile as non-temporary, so `ChromeLauncher.cleanUserDataDir`
	// becomes a no-op and can no longer reject its eager process-exit hook with an
	// unhandled EBUSY when Chromium still holds the profile lock on Windows
	// (issue #7058). `removeUserDataDir` cleans it up on our terms instead.
	let userDataDir: string | undefined;
	if (!launchArgs.some(arg => arg.startsWith("--user-data-dir"))) {
		userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-"));
		launchArgs.push(`--user-data-dir=${userDataDir}`);
	}
	try {
		const executablePath = await ensureChromiumExecutable();
		const browser = await puppeteer.launch({
			headless: opts.headless,
			defaultViewport: opts.headless ? initialViewport : null,
			executablePath,
			args: launchArgs,
			ignoreDefaultArgs: [
				...new Set([...stealthIgnoreDefaultArgs(executablePath), ...(opts.ignoreDefaultArgs ?? [])]),
			],
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return { browser, userDataDir };
	} catch (error) {
		if (userDataDir) await removeUserDataDir(userDataDir);
		throw error;
	}
}

/** Fully resolved executable and argv for a broker-spawned shared Chromium. */
export interface SharedBrowserLaunchSpec {
	executablePath: string;
	args: string[];
}

/**
 * Resolve the executable and complete argv for a shared Chromium the daemon
 * broker spawns directly (no puppeteer inside the broker). Mirrors
 * `launchHeadlessBrowser` flag assembly — puppeteer's default args minus the
 * stealth-suppressed set — suppresses Puppeteer's unowned startup window, and
 * exposes CDP on an ephemeral port. Returns null when no executable resolves;
 * callers fall back to a process-local launch.
 */
export async function resolveSharedBrowserLaunchSpec(opts: {
	headless: boolean;
	userDataDir: string;
	viewport?: { width: number; height: number };
}): Promise<SharedBrowserLaunchSpec | null> {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) return null;
	const puppeteer = await loadPuppeteer();
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const ignored = new Set(stealthIgnoreDefaultArgs(executablePath));
	const defaults = await puppeteer.defaultArgs({
		headless: opts.headless,
		args: buildHeadlessLaunchArgs(vp),
		userDataDir: opts.userDataDir,
	});
	return {
		executablePath,
		args: [...defaults.filter(arg => !ignored.has(arg)), "--no-startup-window", "--remote-debugging-port=0"],
	};
}

/**
 * Remove an OMP-owned headless Chromium profile directory, tolerating the brief
 * window on Windows in which Chromium (or an orphaned browser subprocess) still
 * holds the profile lock. The shared temp remover centralizes retry handling
 * for EBUSY/EPERM/ENOTEMPTY; if the directory is still busy afterwards we warn
 * and leave it for a later cleanup pass rather than throwing — a shutdown cleanup
 * failure must never crash the process (issue #7058).
 */
export async function removeUserDataDir(dir: string): Promise<void> {
	try {
		await removeWithRetries(dir);
	} catch (error) {
		logger.warn("Left Chromium profile directory in place after cleanup failure", {
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	if (!viewport) {
		await page.setViewport(DEFAULT_VIEWPORT);
		return;
	}
	await page.setViewport({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	});
}

// =====================================================================
// Stealth patches
// =====================================================================

interface PuppeteerCdpClient {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export interface UserAgentOverride {
	userAgent: string;
	platform: string;
	acceptLanguage: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersion: string;
		fullVersionList: Array<{ brand: string; version: string }>;
		platform: string;
		platformVersion: string;
		architecture: string;
		bitness: string;
		model: string;
		mobile: boolean;
	};
}

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

const patchedClients = new WeakSet<object>();

function patchSourceUrl(page: Page): void {
	const client = resolvePageClient(page);
	if (!client) return;
	const clientKey = client as object;
	if (patchedClients.has(clientKey)) return;
	patchedClients.add(clientKey);
	const originalSend = client.send.bind(client);
	client.send = async (method: string, params?: Record<string, unknown>) => {
		const next = async (payload?: Record<string, unknown>) => {
			try {
				return await originalSend(method, payload);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes(
						"Protocol error (Network.getResponseBody): No resource with given identifier found",
					)
				) {
					return undefined;
				}
				throw error;
			}
		};
		if (!method || !params) {
			return next(params);
		}
		const key =
			method === "Runtime.evaluate"
				? "expression"
				: method === "Runtime.callFunctionOn"
					? "functionDeclaration"
					: null;
		if (!key) {
			return next(params);
		}
		const value = params[key];
		if (typeof value !== "string" || !value.includes(PUPPETEER_SOURCE_URL_SUFFIX)) {
			return next(params);
		}
		const patchedParams = { ...params, [key]: value.replace(PUPPETEER_SOURCE_URL_SUFFIX, "") };
		return next(patchedParams);
	};
}

async function resolveMacOsProductVersion(): Promise<string> {
	if (os.platform() !== "darwin") return "";
	try {
		const plist = await Bun.file("/System/Library/CoreServices/SystemVersion.plist").text();
		return plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
	} catch {
		return "";
	}
}

function resolveHostArchitecture(): string {
	if (os.arch() === "arm64") return "arm";
	if (os.arch().includes("64")) return "x86";
	return "";
}

function resolveHostBitness(): string {
	return os.arch().includes("64") ? "64" : "";
}

async function resolveUserAgentOverride(page: Page): Promise<UserAgentOverride> {
	const rawUserAgent = await page.browser().userAgent();
	let userAgent = rawUserAgent.replace("HeadlessChrome/", "Chrome/");
	if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
		userAgent = userAgent.replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
	}

	const uaVersionMatch = userAgent.match(/Chrome\/([\d|.]+)/);
	const browserVersionMatch = (await page.browser().version()).match(/\/([\d|.]+)/);
	const legacyVersion = uaVersionMatch?.[1] ?? browserVersionMatch?.[1] ?? "0";
	const fullVersion = browserVersionMatch?.[1] ?? legacyVersion;
	const majorVersion = Number.parseInt(legacyVersion.split(".")[0] ?? "0", 10) || 0;
	const isAndroid = userAgent.includes("Android");
	const isMac = userAgent.includes("Mac OS X");
	const isWindows = userAgent.includes("Windows");
	const platform = isMac ? "MacIntel" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Win32";
	const platformFull = isMac ? "macOS" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Windows";
	const platformVersion = isMac
		? await resolveMacOsProductVersion()
		: userAgent.includes("Android ")
			? (userAgent.match(/Android ([^;]+)/)?.[1] ?? "")
			: isWindows
				? (userAgent.match(/Windows NT ([\d.]+)/)?.[1] ?? "")
				: "";
	const architecture = isAndroid ? "" : resolveHostArchitecture();
	const bitness = isAndroid ? "" : resolveHostBitness();
	const model = isAndroid ? (userAgent.match(/Android.*?;\s([^)]+)/)?.[1] ?? "") : "";

	const brandOrders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0]!;
	const escapedChars = [" ", " ", ";"];
	const greaseyBrand = `${escapedChars[order[0]!]}Not${escapedChars[order[1]!]}A${escapedChars[order[2]!]}Brand`;
	const brands: { brand: string; version: string }[] = [];
	brands[order[0]!] = { brand: greaseyBrand, version: "99" };
	brands[order[1]!] = { brand: "Chromium", version: String(majorVersion) };
	brands[order[2]!] = { brand: "Google Chrome", version: String(majorVersion) };
	const fullVersionList = brands.map(({ brand }) => ({
		brand,
		version: brand === greaseyBrand ? "99.0.0.0" : fullVersion,
	}));

	return {
		userAgent,
		platform,
		acceptLanguage: STEALTH_ACCEPT_LANGUAGE,
		userAgentMetadata: {
			brands,
			fullVersion,
			fullVersionList,
			platform: platformFull,
			platformVersion,
			architecture,
			bitness,
			model,
			mobile: isAndroid,
		},
	};
}

function wrapSession(session: CDPSession): PuppeteerCdpClient {
	return {
		send: async (method, params) => session.send(method as never, params as never),
	};
}

async function sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
	try {
		await client.send("Network.enable");
	} catch {}
	try {
		await client.send("Network.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Network user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		await client.send("Emulation.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Emulation user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface UserAgentSession {
	override: UserAgentOverride;
	browserSession: CDPSession | null;
}

/** Configure UA override on the browser + auto-attach to new targets. */
async function configureUserAgentTargets(
	browser: Browser,
	state: { browserSession: CDPSession | null; override: UserAgentOverride },
	targetTimeoutMs = USER_AGENT_TARGET_TIMEOUT_MS,
): Promise<void> {
	if (!state.browserSession) {
		state.browserSession = await browser.target().createCDPSession();
		await state.browserSession.send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		state.browserSession.on(
			"Target.attachedToTarget",
			async (event: { sessionId: string; targetInfo?: { type?: string } }) => {
				if (!targetInfoSupportsUserAgentOverride(event.targetInfo)) return;
				const connection = state.browserSession?.connection();
				const session = connection?.session(event.sessionId);
				if (!session) return;
				await withSoftTimeout(
					sendUserAgentOverride(wrapSession(session), state.override),
					targetTimeoutMs,
					"new target user-agent override",
				);
			},
		);
	}

	const targets = browser.targets().filter(targetSupportsUserAgentOverride);
	await Promise.all(
		targets.map(async target => {
			await withSoftTimeout(
				applyTargetUserAgentOverride(target, state.override),
				targetTimeoutMs,
				"target user-agent override",
			);
		}),
	);
}

function targetSupportsUserAgentOverride(target: Target): boolean {
	return targetInfoSupportsUserAgentOverride({ type: target.type() });
}

function targetInfoSupportsUserAgentOverride(targetInfo: { type?: string } | undefined): boolean {
	return Boolean(targetInfo?.type && USER_AGENT_TARGET_TYPES.has(targetInfo.type));
}

async function applyTargetUserAgentOverride(target: Target, override: UserAgentOverride): Promise<void> {
	const session = await target.createCDPSession();
	try {
		await sendUserAgentOverride(wrapSession(session), override);
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<undefined>(resolve => {
		timeout = setTimeout(() => {
			logger.debug(`Timed out applying ${label}`);
			resolve(undefined);
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			promise.catch(error => {
				logger.debug(`Failed to apply ${label}`, { error: error instanceof Error ? error.message : String(error) });
				return undefined;
			}),
			timeoutPromise,
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const STEALTH_PATCH_SCRIPTS = [
	stealthTamperingScript,
	stealthActivityScript,
	stealthHairlineScript,
	stealthBotdScript,
	stealthIframeScript,
	stealthWebglScript,
	stealthScreenScript,
	stealthFontsScript,
	stealthAudioScript,
	stealthLocaleScript,
	stealthPluginsScript,
	stealthHardwareScript,
	stealthCodecsScript,
	stealthWorkerScript,
];

function buildStealthInjectionScript(scripts: readonly string[] = STEALTH_PATCH_SCRIPTS): string {
	const joint = scripts
		.map(
			script => `
		try {
			${script};
		} catch (e) {}
	`,
		)
		.join(";\n");

	return `(() => {
				const Page_Function_toString = Function.prototype.toString;
				const Page_FunctionToStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
				const Page_Proxy = Proxy;
				const Page_WeakMap = WeakMap;
				const Page_WeakMap_get = Page_WeakMap.prototype.get;
				const Page_WeakMap_set = Page_WeakMap.prototype.set;
				// Native function cache - captured before any tampering.
				// A same-origin iframe yields natives uncontaminated by page-level
				// tampering, but at document-start (when this preload runs) there is
				// no documentElement to attach it to. In that case the page itself
				// hasn't executed yet, so window's own natives are still pristine —
				// fall back to window instead of bailing, otherwise none of the
				// fingerprint patches below would ever run.
				let iframe = null;
				const container = document.head ?? document.documentElement;
				if (container) {
					iframe = document.createElement("iframe");
					iframe.style.display = "none";
					container.appendChild(iframe);
					if (!iframe.contentWindow) iframe = null;
				}
				try {
					const nativeWindow = iframe ? iframe.contentWindow : window;

					// Cache pristine native functions
					const Function_toString = nativeWindow.Function.prototype.toString;
					const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
					const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
					const Object_defineProperty = nativeWindow.Object.defineProperty;
					const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_create = nativeWindow.Object.create;
					const Object_keys = nativeWindow.Object.keys;
					const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
					const Object_entries = nativeWindow.Object.entries;
					const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
					const Object_assign = nativeWindow.Object.assign;
					const Window_setTimeout = nativeWindow.setTimeout;
					const Math_random = nativeWindow.Math.random;
					const Math_floor = nativeWindow.Math.floor;
					const Math_max = nativeWindow.Math.max;
					const Math_min = nativeWindow.Math.min;
					const Window_Event = nativeWindow.Event;
					const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
					const Window_Blob = nativeWindow.Blob;
					const Window_Proxy = nativeWindow.Proxy;
					const Reflect_get = nativeWindow.Reflect.get;
					const Reflect_set = nativeWindow.Reflect.set;
					const Reflect_apply = nativeWindow.Reflect.apply;
					const Reflect_construct = nativeWindow.Reflect.construct;
					const Reflect_defineProperty = nativeWindow.Reflect.defineProperty;
					const Reflect_deleteProperty = nativeWindow.Reflect.deleteProperty;
					const Reflect_getOwnPropertyDescriptor = nativeWindow.Reflect.getOwnPropertyDescriptor;
					const Reflect_getPrototypeOf = nativeWindow.Reflect.getPrototypeOf;
					const Reflect_has = nativeWindow.Reflect.has;
					const Reflect_isExtensible = nativeWindow.Reflect.isExtensible;
					const Reflect_ownKeys = nativeWindow.Reflect.ownKeys;
					const Reflect_preventExtensions = nativeWindow.Reflect.preventExtensions;
					const Reflect_setPrototypeOf = nativeWindow.Reflect.setPrototypeOf;
					const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
					const Date_constructor = nativeWindow.Date;

					const nativeFunctionSources = new Page_WeakMap();
					const makeNativeString = (name) => "function " + (name || "") + "() { [native code] }";
					const registerNativeSource = (fn, source) => {
						if (typeof fn === "function") Reflect_apply(Page_WeakMap_set, nativeFunctionSources, [fn, source]);
						return fn;
					};
					const patchToString = (fn, name) => registerNativeSource(fn, makeNativeString(name));
					if (${scripts.length > 0 ? "true" : "false"}) {
						const functionToStringProxy = new Page_Proxy(Page_Function_toString, {
							apply(target, thisArg, args) {
								const source = Reflect_apply(Page_WeakMap_get, nativeFunctionSources, [thisArg]);
								if (source) return source;
								return Reflect_apply(target, thisArg, args || []);
							},
							get(target, key, receiver) {
								return Reflect_get(target, key, receiver);
							},
						});
						registerNativeSource(functionToStringProxy, makeNativeString("toString"));
						Object_defineProperty(Function.prototype, "toString", {
							...(Page_FunctionToStringDescriptor || {
								writable: true,
								configurable: true,
								enumerable: false,
							}),
							value: functionToStringProxy,
						});
					}

					${joint}
				} finally {
					if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
				}})();`;
}

async function injectStealthScripts(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(buildStealthInjectionScript());
}

/** Builds the browser-page stealth bootstrap source for regression tests. */
export function buildStealthInjectionScriptForTest(scripts: readonly string[] = STEALTH_PATCH_SCRIPTS): string {
	return buildStealthInjectionScript(scripts);
}

/** Apply stealth patches + UA override to a headless page. Idempotent within a tab. */
export async function applyStealthPatches(
	browser: Browser,
	page: Page,
	state: { browserSession: CDPSession | null; override: UserAgentOverride | null },
): Promise<void> {
	patchSourceUrl(page);
	if (!state.override) {
		state.override = await resolveUserAgentOverride(page);
	}
	const client = resolvePageClient(page);
	if (client) {
		await sendUserAgentOverride(client, state.override);
	}
	const targetState = { browserSession: state.browserSession, override: state.override };
	await configureUserAgentTargets(browser, targetState);
	state.browserSession = targetState.browserSession;
	await injectStealthScripts(page);
}

/** Exposes executable candidates for detection tests. */
export function systemChromiumCandidatesForTest(
	platform: NodeJS.Platform = process.platform,
	home?: string,
	which?: (name: string) => string | null | undefined,
): string[] {
	return systemChromiumCandidates(platform, home, which);
}

export async function chromiumExecutableProbeForTest(executablePath: string): Promise<boolean> {
	return isChromiumExecutable(executablePath);
}

export function stealthIgnoreDefaultArgsForTest(executablePath: string | undefined): string[] {
	return stealthIgnoreDefaultArgs(executablePath);
}

export function targetSupportsUserAgentOverrideForTest(target: Target): boolean {
	return targetSupportsUserAgentOverride(target);
}
export async function configureUserAgentTargetsForTest(
	browser: Browser,
	state: { browserSession: CDPSession | null; override: UserAgentOverride },
	targetTimeoutMs?: number,
): Promise<void> {
	await configureUserAgentTargets(browser, state, targetTimeoutMs);
}
