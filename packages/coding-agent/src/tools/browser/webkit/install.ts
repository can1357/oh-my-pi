/**
 * Downloads omp's WebKit engine, ABKit, from Stencil's build service (product
 * `abkit`, the build {@link ABKIT_VERSION} names) into an engine directory,
 * normally `~/.o2/lib/abkit` ({@link webKitEngineToInstall}): when it holds no
 * engine, and to update one older than that version. An engine another app
 * manages (Tern: `cli/managed-install.ts`) is that app's to update; omp runs it
 * as it is.
 *
 * The answered archive (`abkit-<version>-<platform>.tar.gz`, `.zip` on
 * Windows) is checked against the answer's size and SHA-256 while it streams,
 * unpacked beside the engine directory, and must hold the engine as `abkit/`
 * with its host executable. Its version is recorded in the engine's
 * {@link ENGINE_VERSION_FILE}, and it then takes the directory's place by
 * rename, so a host still running from an older copy keeps its open files. An
 * OS lock makes concurrent omp processes install once.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeShell } from "@oh-my-pi/pi-natives";
import { compareVersions, getWebKitHostPath, isEnoent, logger, parseFlag, withFileLock } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { BROWSER_ARCHIVE_LIMITS } from "@oh-my-pi/pi-utils/browsers";
import {
	BUILD_DOWNLOAD_TIMEOUT_MS,
	type BuildProduct,
	currentBuildHost,
	downloadBuildFile,
	type Fetch,
	fetchBuild,
	isBuildVersion,
} from "../../../cli/build-service";
import { managedInstallName } from "../../../cli/managed-install";
import { withDownload } from "../../../downloads/activity";
import { hostExecutableAt, hostExecutableName, type ResolveWebKitKindOptions } from "./kind";

/**
 * The ABKit release this omp installs, and the oldest it runs from the default
 * engine directory: an older engine there is replaced by this one. Bump it with
 * each ABKit release (tag `v<version>` of stencil-hq/abkit) omp should move to,
 * so updating omp updates its engine.
 */
export const ABKIT_VERSION = "0.1.1";

/**
 * The file in an engine directory naming its version: the release version omp
 * installed, or `dev` from ABKit's `install-engine.sh` for a local build.
 */
export const ENGINE_VERSION_FILE = "VERSION";

/** ABKit's builds: `abkit-<version>-darwin-arm64.tar.gz`, `abkit-<version>-windows-x64.zip`, each holding the engine as `abkit/`. */
export const ABKIT_BUILD: BuildProduct = {
	id: "abkit",
	fileName: (host, version) => `abkit-${version}-${host.asset}.${host.windows ? "zip" : "tar.gz"}`,
};

/** The engine directory inside an unpacked ABKit archive. */
const ARCHIVE_ROOT = "abkit";

export interface InstallWebKitEngineOptions {
	/** Fetch for the build service and the download. */
	fetchImpl?: Fetch;
}

/** A default engine directory omp should install ABKit into ({@link webKitEngineToInstall}). */
export interface WebKitEngineInstall {
	engineDir: string;
	/**
	 * Whether an engine is there already, older than {@link ABKIT_VERSION}: an
	 * update replaces it, and it still runs when the update fails.
	 */
	outdated: boolean;
}

/**
 * The default engine directory (`~/.o2/lib/abkit`) when omp should install
 * ABKit there, or null: only while the backend is on (as `resolveWebKitKind`
 * decides) and neither `PI_BROWSER_WEBKIT_PATH` nor the `browser.webkitPath`
 * setting names another location (a configured engine is the user's to
 * install), and only when it holds no host executable or an outdated engine
 * ({@link engineOutdated}) no other app manages. An outdated managed engine is
 * logged once per process, naming its manager.
 *
 * Throws when the engine's {@link ENGINE_VERSION_FILE} exists but cannot be read.
 */
export async function webKitEngineToInstall(
	options?: ResolveWebKitKindOptions | null,
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<WebKitEngineInstall | null> {
	if (!parseFlag(env.PI_BROWSER_WEBKIT, options?.settingEnabled ?? true)) return null;
	if (env.PI_BROWSER_WEBKIT_PATH?.trim() || options?.settingPath?.trim()) return null;
	const engineDir = path.dirname(getWebKitHostPath(platform));
	if (hostExecutableAt(engineDir, platform) === null) return { engineDir, outdated: false };
	if (!(await engineOutdated(engineDir))) return null;
	const manager = await managedInstallName(engineDir);
	if (manager === undefined) return { engineDir, outdated: true };
	if (!reportedManagedEngines.has(engineDir)) {
		reportedManagedEngines.add(engineDir);
		logger.warn(`omp's WebKit engine is older than ABKit ${ABKIT_VERSION}; ${manager} manages it and updates it`, {
			engineDir,
		});
	}
	return null;
}

/** Managed engine directories whose age this process has logged ({@link webKitEngineToInstall}). */
const reportedManagedEngines = new Set<string>();

/**
 * Whether the installed engine in `engineDir` predates {@link ABKIT_VERSION}:
 * it names no version (installed before omp recorded one) or an older release.
 * A version that is not a release, such as a local build's `dev`, never is.
 */
async function engineOutdated(engineDir: string): Promise<boolean> {
	let version: string;
	try {
		version = (await fs.readFile(path.join(engineDir, ENGINE_VERSION_FILE), "utf8")).trim();
	} catch (error) {
		if (isEnoent(error)) return true;
		throw error;
	}
	return isBuildVersion(version) && compareVersions(version, ABKIT_VERSION) < 0;
}

/**
 * Process ids of what runs from `engineDir`: hosts started from it and the
 * helper processes the engine started beside them, whose command lines begin
 * with a path inside it (the shell's `pgrep`, on every platform).
 */
async function processesRunningFrom(engineDir: string): Promise<string[]> {
	const pattern = `^"?${engineDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`.replaceAll("'", "'\\''");
	let output = "";
	const result = await executeShell(
		{ command: `pgrep -f${process.platform === "win32" ? "i" : ""} '${pattern}'`, timeoutMs: 10_000 },
		(error, chunk) => {
			if (!error) output += chunk;
		},
	);
	if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
		throw new Error(`could not list the processes running from ${engineDir}`);
	}
	return output.split(/\s+/).filter(pid => pid !== "");
}

const installs = new Map<string, Promise<string>>();

/**
 * Install ABKit {@link ABKIT_VERSION} as `engineDir` and resolve to its host
 * executable; concurrent calls for one directory share one install, and one
 * that finds a current engine already installed (by another omp) downloads
 * nothing.
 *
 * Throws when an outdated engine there is in use (a running host would start
 * the new version's helpers beside its old library: the update waits for a
 * process that finds it idle), the build service publishes no such ABKit
 * build for this host (the message names the version and target), the
 * download fails or does not match the answer, or the archive holds no
 * `abkit/` host executable. Nothing is left beside `engineDir` then, and a
 * directory already there stays.
 */
export function installWebKitEngine(engineDir: string, options: InstallWebKitEngineOptions = {}): Promise<string> {
	let pending = installs.get(engineDir);
	if (!pending) {
		pending = install(engineDir, options).finally(() => installs.delete(engineDir));
		installs.set(engineDir, pending);
	}
	return pending;
}

async function install(engineDir: string, options: InstallWebKitEngineOptions): Promise<string> {
	const parent = path.dirname(engineDir);
	await fs.mkdir(parent, { recursive: true });
	return withFileLock(
		`${engineDir}.install`,
		async () => {
			// Another omp may have installed or updated it while this one waited for the lock,
			// or an app may have taken it over: that app updates it.
			const installed = hostExecutableAt(engineDir, process.platform);
			if (
				installed !== null &&
				(!(await engineOutdated(engineDir)) || (await managedInstallName(engineDir)) !== undefined)
			) {
				return installed;
			}
			if (installed !== null) {
				const running = await processesRunningFrom(engineDir);
				if (running.length > 0) {
					throw new Error(`${engineDir} is in use (process ${running.join(", ")}); it is updated once idle`);
				}
			}

			const build = await fetchBuild(
				{ version: ABKIT_VERSION },
				{ product: ABKIT_BUILD, host: await currentBuildHost(), fetchImpl: options.fetchImpl },
			);
			const nonce = `${process.pid}-${crypto.randomUUID()}`;
			const archivePath = path.join(parent, `.abkit-${nonce}-${build.file.name}`);
			const stagingPath = path.join(parent, `.abkit-${nonce}`);
			const retiredPath = path.join(parent, `.abkit-${nonce}-retired`);
			logger.warn(installed === null ? "Downloading omp's WebKit engine" : "Updating omp's WebKit engine", {
				version: build.version,
				file: build.file.name,
				engineDir,
			});
			try {
				await withDownload(`ABKit ${build.version}`, async tracker => {
					await downloadBuildFile({
						url: build.download,
						targetPath: archivePath,
						size: build.file.size,
						sha256: build.file.sha256,
						fetchImpl: options.fetchImpl,
						onProgress: loaded => tracker.update({ loaded, total: build.file.size }),
					});
					tracker.update({ detail: "extracting" });
					await extractArchive(archivePath, stagingPath, { limits: BROWSER_ARCHIVE_LIMITS });
				});
				const unpacked = path.join(stagingPath, ARCHIVE_ROOT);
				if (hostExecutableAt(unpacked, process.platform) === null) {
					throw new Error(
						`${build.file.name} holds no ${ARCHIVE_ROOT}/${hostExecutableName(process.platform)} executable`,
					);
				}
				await Bun.write(path.join(unpacked, ENGINE_VERSION_FILE), `${build.version}\n`);
				// The directory there (an outdated engine, or a partial copy) is moved aside rather
				// than deleted in place, so whatever still runs from it keeps its open files.
				try {
					await fs.rename(engineDir, retiredPath);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				await fs.rename(unpacked, engineDir);
				return path.join(engineDir, hostExecutableName(process.platform));
			} finally {
				await Promise.all(
					[archivePath, stagingPath, retiredPath].map(leftover =>
						fs.rm(leftover, { recursive: true, force: true }).catch(() => {}),
					),
				);
			}
		},
		{ retries: Math.ceil(BUILD_DOWNLOAD_TIMEOUT_MS / 100) + 1, retryDelayMs: 100 },
	);
}
