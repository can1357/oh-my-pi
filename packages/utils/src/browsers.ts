/** Behavior-compatible reimplementation of @puppeteer/browsers' used surface. */

import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ArchiveLimits, extractArchive } from "./ar";

const CHROME_FOR_TESTING_BASE_URL = "https://storage.googleapis.com/chrome-for-testing-public";
const CHROME_METADATA_BASE_URL = "https://googlechromelabs.github.io/chrome-for-testing";

/**
 * Archive ceilings for the managed browser download. The default archive
 * limits (64 MiB per member / 256 MiB in memory) guard against attacker-
 * controlled archives, but the Chrome-for-Testing binary is a trusted
 * first-party download whose `chrome` executable already exceeds both
 * (~269 MB and growing), so extraction gets a ceiling sized for it.
 */
const BROWSER_ARCHIVE_LIMITS: Partial<ArchiveLimits> = {
	maxMemberSize: 1024 * 1024 * 1024,
	maxInMemorySize: 1024 * 1024 * 1024,
};

/** Supported browser products. */
export enum Browser {
	CHROME = "chrome",
	CHROMEHEADLESSSHELL = "chrome-headless-shell",
	CHROMIUM = "chromium",
	FIREFOX = "firefox",
	CHROMEDRIVER = "chromedriver",
}

/** Browser download platform identifiers. */
export enum BrowserPlatform {
	LINUX = "linux",
	LINUX_ARM = "linux_arm",
	MAC = "mac",
	MAC_ARM = "mac_arm",
	WIN32 = "win32",
	WIN64 = "win64",
}

const BROWSERS = [
	Browser.CHROME,
	Browser.CHROMEHEADLESSSHELL,
	Browser.CHROMIUM,
	Browser.FIREFOX,
	Browser.CHROMEDRIVER,
] as const;
const BROWSER_PLATFORMS = [
	BrowserPlatform.LINUX,
	BrowserPlatform.LINUX_ARM,
	BrowserPlatform.MAC,
	BrowserPlatform.MAC_ARM,
	BrowserPlatform.WIN32,
	BrowserPlatform.WIN64,
] as const;

/** Chrome-for-Testing release channel tags accepted by {@link resolveBuildId}. */
export enum BrowserTag {
	CANARY = "canary",
	NIGHTLY = "nightly",
	BETA = "beta",
	DEV = "dev",
	DEVEDITION = "devedition",
	STABLE = "stable",
	ESR = "esr",
	LATEST = "latest",
}

/** Download progress reported while a browser archive is streamed to disk. */
export interface BrowserDownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
}

/** Inputs used to locate an installed browser executable. */
export interface ComputeExecutablePathOptions {
	browser: Browser;
	buildId: string;
	cacheDir: string;
	platform?: BrowserPlatform;
}

/** Inputs used to download and install a browser. */
export interface InstallOptions extends ComputeExecutablePathOptions {
	baseUrl?: string;
	downloadProgressCallback?: (progress: BrowserDownloadProgress) => void;
}

/** Metadata for one browser installation found in a Puppeteer cache. */
export interface InstalledBrowser {
	browser: Browser;
	buildId: string;
	platform: BrowserPlatform;
	path: string;
	executablePath: string;
}

interface LastKnownGoodVersions {
	channels: Record<string, { version: string }>;
}

interface MilestoneVersions {
	milestones: Record<string, { version: string }>;
}

interface PatchVersions {
	builds: Record<string, { version: string }>;
}

/** Detect the current host's Puppeteer browser platform. */
export function detectBrowserPlatform(): BrowserPlatform | undefined {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === "darwin") return arch === "arm64" ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC;
	if (platform === "linux") return arch === "arm64" ? BrowserPlatform.LINUX_ARM : BrowserPlatform.LINUX;
	if (platform === "win32") return arch === "ia32" ? BrowserPlatform.WIN32 : BrowserPlatform.WIN64;
	return undefined;
}

/** Resolve a Chrome-for-Testing channel, milestone, or build prefix to a full build ID. */
export async function resolveBuildId(
	browser: Browser,
	_platform: BrowserPlatform,
	tag: string | BrowserTag,
): Promise<string> {
	if (browser !== Browser.CHROME && browser !== Browser.CHROMEHEADLESSSHELL && browser !== Browser.CHROMEDRIVER) {
		return tag;
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(tag)) return tag;

	const channel = tag === BrowserTag.LATEST ? "Canary" : chromeChannelName(tag);
	if (channel) {
		const metadata = await fetchMetadata<LastKnownGoodVersions>("last-known-good-versions.json");
		const version = metadata.channels[channel]?.version;
		if (!version) throw new Error(`Chrome channel ${tag} was not found in Chrome-for-Testing metadata`);
		return version;
	}
	if (/^\d+$/.test(tag)) {
		const metadata = await fetchMetadata<MilestoneVersions>("latest-versions-per-milestone.json");
		return metadata.milestones[tag]?.version ?? tag;
	}
	if (/^\d+\.\d+\.\d+$/.test(tag)) {
		const metadata = await fetchMetadata<PatchVersions>("latest-patch-versions-per-build.json");
		return metadata.builds[tag]?.version ?? tag;
	}
	return tag;
}

/** Return the Chrome-for-Testing archive URL for a browser build. */
export function getDownloadUrl(
	browser: Browser,
	platform: BrowserPlatform,
	buildId: string,
	baseUrl = CHROME_FOR_TESTING_BASE_URL,
): URL {
	if (browser !== Browser.CHROME) throw new Error(`Unsupported browser download: ${browser}`);
	const archivePlatform = chromeArchivePlatform(platform);
	const root = baseUrl.replace(/\/$/, "");
	return new URL(`${root}/${buildId}/${archivePlatform}/chrome-${archivePlatform}.zip`);
}

/** Compute the executable path in Puppeteer's cache layout. */
export function computeExecutablePath(options: ComputeExecutablePathOptions): string {
	const platform = options.platform ?? detectBrowserPlatform();
	if (!platform) throw new Error("Cannot determine a browser platform for this host");
	if (options.browser !== Browser.CHROME) throw new Error(`Unsupported browser executable: ${options.browser}`);
	const installDir = installationDir(options.cacheDir, options.browser, platform, options.buildId);
	switch (platform) {
		case BrowserPlatform.LINUX:
		case BrowserPlatform.LINUX_ARM:
			return path.join(installDir, "chrome-linux64", "chrome");
		case BrowserPlatform.MAC:
			return path.join(
				installDir,
				"chrome-mac-x64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.MAC_ARM:
			return path.join(
				installDir,
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.WIN32:
			return path.join(installDir, "chrome-win32", "chrome.exe");
		case BrowserPlatform.WIN64:
			return path.join(installDir, "chrome-win64", "chrome.exe");
	}
}

/** Scan a Puppeteer cache for browser installation directories. */
export async function getInstalledBrowsers(options: { cacheDir: string }): Promise<InstalledBrowser[]> {
	const installed: InstalledBrowser[] = [];
	for (const browser of BROWSERS) {
		const browserDir = path.join(options.cacheDir, browser);
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(browserDir, { withFileTypes: true });
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const parsed = parseInstallationName(entry.name);
			if (!parsed) continue;
			const installPath = path.join(browserDir, entry.name);
			try {
				installed.push({
					browser,
					buildId: parsed.buildId,
					platform: parsed.platform,
					path: installPath,
					executablePath: computeExecutablePath({
						browser,
						buildId: parsed.buildId,
						cacheDir: options.cacheDir,
						platform: parsed.platform,
					}),
				});
			} catch {
				// Other browser products are not part of the surface used by OMP.
			}
		}
	}
	return installed;
}

/** Download and unpack Chrome into Puppeteer's existing cache layout. */
export async function install(options: InstallOptions): Promise<InstalledBrowser> {
	const platform = options.platform ?? detectBrowserPlatform();
	if (!platform) throw new Error("Cannot determine a browser platform for this host");
	const executablePath = computeExecutablePath({ ...options, platform });
	const installPath = installationDir(options.cacheDir, options.browser, platform, options.buildId);
	if (await pathExists(executablePath)) {
		return { browser: options.browser, buildId: options.buildId, platform, path: installPath, executablePath };
	}

	await fsp.mkdir(options.cacheDir, { recursive: true });
	const nonce = `${process.pid}-${crypto.randomUUID()}`;
	const archivePath = path.join(options.cacheDir, `.browser-${nonce}.zip`);
	const stagingPath = path.join(options.cacheDir, `.browser-${nonce}`);
	try {
		await downloadArchive(
			getDownloadUrl(options.browser, platform, options.buildId, options.baseUrl),
			archivePath,
			options.downloadProgressCallback,
		);
		await extractArchive(archivePath, stagingPath, { limits: BROWSER_ARCHIVE_LIMITS });
		await fsp.mkdir(path.dirname(installPath), { recursive: true });
		await fsp.rm(installPath, { recursive: true, force: true });
		await fsp.rename(stagingPath, installPath);
	} finally {
		await Promise.all([
			fsp.rm(archivePath, { force: true }).catch(() => {}),
			fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {}),
		]);
	}
	if (!(await pathExists(executablePath)))
		throw new Error(`Browser archive did not contain its expected executable: ${executablePath}`);
	return { browser: options.browser, buildId: options.buildId, platform, path: installPath, executablePath };
}

function chromeChannelName(tag: string): string | undefined {
	switch (tag) {
		case BrowserTag.STABLE:
			return "Stable";
		case BrowserTag.BETA:
			return "Beta";
		case BrowserTag.DEV:
			return "Dev";
		case BrowserTag.CANARY:
			return "Canary";
		default:
			return undefined;
	}
}

async function fetchMetadata<T>(filename: string): Promise<T> {
	const response = await fetch(`${CHROME_METADATA_BASE_URL}/${filename}`);
	if (!response.ok)
		throw new Error(`Failed to fetch Chrome-for-Testing metadata (${response.status} ${response.statusText})`);
	return (await response.json()) as T;
}

function chromeArchivePlatform(platform: BrowserPlatform): string {
	switch (platform) {
		case BrowserPlatform.LINUX:
		case BrowserPlatform.LINUX_ARM:
			return "linux64";
		case BrowserPlatform.MAC:
			return "mac-x64";
		case BrowserPlatform.MAC_ARM:
			return "mac-arm64";
		case BrowserPlatform.WIN32:
			return "win32";
		case BrowserPlatform.WIN64:
			return "win64";
	}
}

function installationDir(cacheDir: string, browser: Browser, platform: BrowserPlatform, buildId: string): string {
	return path.join(cacheDir, browser, `${platform}-${buildId}`);
}

function parseInstallationName(name: string): { platform: BrowserPlatform; buildId: string } | undefined {
	for (const platform of BROWSER_PLATFORMS) {
		const prefix = `${platform}-`;
		if (name.startsWith(prefix) && name.length > prefix.length)
			return { platform, buildId: name.slice(prefix.length) };
	}
	return undefined;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

async function downloadArchive(
	url: URL,
	destination: string,
	onProgress: ((progress: BrowserDownloadProgress) => void) | undefined,
): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Browser download failed (${response.status} ${response.statusText}) from ${url}`);
	}
	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	const file = await fsp.open(destination, "wx");
	let downloadedBytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const write = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
				if (write.bytesWritten === 0) throw new Error(`Browser download stalled while writing ${destination}`);
				offset += write.bytesWritten;
			}
			downloadedBytes += chunk.value.byteLength;
			onProgress?.({ downloadedBytes, totalBytes });
		}
	} finally {
		await file.close();
	}
}
