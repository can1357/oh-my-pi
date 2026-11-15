/**
 * Downloads omp's WebKit engine, ABKit, from Stencil's build service (product
 * `abkit`, its newest {@link ABKIT_CHANNEL} build) into an engine directory,
 * normally `~/.o2/lib/abkit` ({@link webKitEngineToInstall}): when it holds no
 * engine, and to update one older than that build, asked once per process. An
 * engine another app manages (Tern: `cli/managed-install.ts`) is that app's to
 * update, and a local build is its builder's; omp runs them as they are.
 *
 * The answered archive (`abkit-<version>-<platform>.tar.gz`, `.zip` on
 * Windows) is checked against the answer's size and SHA-256 while it streams,
 * unpacked beside the engine directory, and must hold the engine as `abkit/`
 * with its host executable. Its version is recorded in the engine's
 * {@link ENGINE_VERSION_FILE} and it is kept as `<engine dir>-versions/<version>`;
 * the engine directory is a link to the version in use (a junction on
 * Windows), replaced by rename. A host runs from its version's real path and
 * finds its helpers there, so an update never waits for running hosts; a
 * version nothing runs from any more is deleted at a later check. An OS lock
 * makes concurrent omp processes install once.
 *
 * @example
 * // ~/.o2/lib/abkit -> ~/.o2/lib/abkit-versions/0.1.2
 * await installWebKitEngine(path.join(os.homedir(), ".o2/lib/abkit"));
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeShell } from "@oh-my-pi/pi-natives";
import { compareVersions, getWebKitHostPath, isEnoent, logger, parseFlag, withFileLock } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { BROWSER_ARCHIVE_LIMITS } from "@oh-my-pi/pi-utils/browsers";
import {
	BUILD_DOWNLOAD_TIMEOUT_MS,
	type BuildAnswer,
	type BuildProduct,
	currentBuildHost,
	downloadBuildFile,
	type Fetch,
	fetchBuild,
	isBuildVersion,
	type UpdateChannel,
} from "../../../cli/build-service";
import { managedInstallName } from "../../../cli/managed-install";
import { withDownload } from "../../../downloads/activity";
import { hostExecutableAt, hostExecutableName, type ResolveWebKitKindOptions } from "./kind";

/**
 * The ABKit channel omp follows: it installs that channel's newest build
 * (each `v<version>` tag of stencil-hq/abkit publishes one) and updates an
 * older engine to it.
 */
const ABKIT_CHANNEL: UpdateChannel = "stable";

/** How long the update check of an installed engine waits for the build service before the open runs that engine. */
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

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
	 * Whether an engine is there already: {@link installWebKitEngine} replaces
	 * it only when a newer build is out, and it still runs when that fails.
	 */
	installed: boolean;
}

/**
 * The default engine directory (`~/.o2/lib/abkit`) when omp should install or
 * update ABKit there, or null: only while the backend is on (as
 * `resolveWebKitKind` decides) and neither `PI_BROWSER_WEBKIT_PATH` nor the
 * `browser.webkitPath` setting names another location (a configured engine is
 * the user's to install), and only when it holds no host executable, or a
 * release (or an engine naming no version) that no other app manages. Asks
 * the build service nothing.
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
	if (hostExecutableAt(engineDir, platform) === null) return { engineDir, installed: false };
	if (isLocalBuild(await engineVersion(engineDir))) return null;
	if ((await managedInstallName(engineDir)) !== undefined) return null;
	return { engineDir, installed: true };
}

/**
 * The version the engine in `engineDir` names in its {@link ENGINE_VERSION_FILE},
 * or undefined when it names none (installed before omp recorded one).
 *
 * Throws when the file exists but cannot be read.
 */
async function engineVersion(engineDir: string): Promise<string | undefined> {
	try {
		return (await fs.readFile(path.join(engineDir, ENGINE_VERSION_FILE), "utf8")).trim();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Whether an engine's version is not a release, such as a local build's `dev`: omp never replaces it. */
function isLocalBuild(version: string | undefined): boolean {
	return version !== undefined && !isBuildVersion(version);
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

/** Engine directories this process brought up to date: later calls ask the build service nothing. */
const current = new Set<string>();

/**
 * Bring `engineDir` to ABKit's newest {@link ABKIT_CHANNEL} build and resolve
 * to its host executable: download it when the directory holds no engine, or
 * an engine naming no version or an older release, and point `engineDir` at
 * it; keep a current or newer one (another omp's update), a local build, or
 * an engine another app manages. Each directory is checked once per process;
 * concurrent calls share the check. The check of an installed engine waits
 * {@link UPDATE_CHECK_TIMEOUT_MS} for the build service.
 *
 * Throws when the build service does not answer or publishes no ABKit build
 * for this host (the message names the target), an outdated plain engine
 * folder (installed before omp kept versions) is in use (its hosts find their
 * helpers through that very path: it is replaced by a process that finds it
 * idle), the download fails or does not match the answer, or the archive
 * holds no `abkit/` host executable. Nothing is left beside `engineDir` then,
 * and the engine already there stays.
 */
export function installWebKitEngine(engineDir: string, options: InstallWebKitEngineOptions = {}): Promise<string> {
	if (current.has(engineDir)) {
		const host = hostExecutableAt(engineDir, process.platform);
		if (host !== null) return Promise.resolve(host);
		current.delete(engineDir);
	}
	let pending = installs.get(engineDir);
	if (!pending) {
		pending = install(engineDir, options)
			.then(host => {
				current.add(engineDir);
				return host;
			})
			.finally(() => installs.delete(engineDir));
		installs.set(engineDir, pending);
	}
	return pending;
}

async function install(engineDir: string, options: InstallWebKitEngineOptions): Promise<string> {
	const parent = path.dirname(engineDir);
	const versionsDir = `${engineDir}-versions`;
	await fs.mkdir(parent, { recursive: true });
	return withFileLock(
		`${engineDir}.install`,
		async () => {
			// An app may have taken it over while this one waited for the lock: that app updates it.
			const installed = hostExecutableAt(engineDir, process.platform);
			if (installed !== null && (await managedInstallName(engineDir)) !== undefined) return installed;
			const version = installed === null ? undefined : await engineVersion(engineDir);
			if (installed !== null && isLocalBuild(version)) return installed;

			const build = await fetchBuild(
				{ channel: ABKIT_CHANNEL },
				{
					product: ABKIT_BUILD,
					host: await currentBuildHost(),
					fetchImpl: options.fetchImpl,
					timeoutMs: installed === null ? undefined : UPDATE_CHECK_TIMEOUT_MS,
				},
			);
			const linkedTo = await linkTarget(engineDir);
			if (installed !== null) {
				// Current, or newer: another omp may have updated it while this one waited for the lock.
				if (version !== undefined && compareVersions(version, build.version) >= 0) {
					if (linkedTo !== undefined) await sweepVersions(versionsDir, linkedTo);
					return installed;
				}
				if (linkedTo === undefined) {
					const running = await processesRunningFrom(engineDir);
					if (running.length > 0) {
						throw new Error(`${engineDir} is in use (process ${running.join(", ")}); it is updated once idle`);
					}
				}
			}
			const target = path.join(versionsDir, build.version);
			if (hostExecutableAt(target, process.platform) === null) {
				logger.warn(installed === null ? "Downloading omp's WebKit engine" : "Updating omp's WebKit engine", {
					version: build.version,
					file: build.file.name,
					engineDir,
				});
				await download(build, target, options);
			}
			await pointLink(engineDir, target);
			await sweepVersions(versionsDir, target);
			return path.join(engineDir, hostExecutableName(process.platform));
		},
		{ retries: Math.ceil(BUILD_DOWNLOAD_TIMEOUT_MS / 100) + 1, retryDelayMs: 100 },
	);
}

/**
 * Download `build`, check it, and unpack its engine as the version folder
 * `target` (a partial folder there is replaced). Nothing is left beside
 * `target` when it fails.
 */
async function download(build: BuildAnswer, target: string, options: InstallWebKitEngineOptions): Promise<void> {
	const versionsDir = path.dirname(target);
	await fs.mkdir(versionsDir, { recursive: true });
	const nonce = `${process.pid}-${crypto.randomUUID()}`;
	const archivePath = path.join(versionsDir, `.${nonce}-${build.file.name}`);
	const stagingPath = path.join(versionsDir, `.${nonce}`);
	const partialPath = path.join(versionsDir, `.${nonce}-gone`);
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
		// A partial folder there has no host, so nothing runs from it.
		try {
			await fs.rename(target, partialPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await fs.rename(unpacked, target);
	} finally {
		await Promise.all(
			[archivePath, stagingPath, partialPath].map(leftover =>
				fs.rm(leftover, { recursive: true, force: true }).catch(() => {}),
			),
		);
	}
}

/** Where the link `engineDir` points, absolute; undefined when it is no link (a plain folder) or absent. */
async function linkTarget(engineDir: string): Promise<string | undefined> {
	try {
		if (!(await fs.lstat(engineDir)).isSymbolicLink()) return undefined;
		return path.resolve(path.dirname(engineDir), await fs.readlink(engineDir));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Point the link `engineDir` at the version folder `target`: a new link made
 * beside it and renamed over the old one, so a reader finds one engine or the
 * other. A junction cannot be renamed over another (Windows): the old one is
 * removed first. A plain folder there (an engine installed before omp kept
 * versions, idle, or a partial copy) is moved aside and deleted once the link
 * is in; it is put back when the link cannot be.
 */
async function pointLink(engineDir: string, target: string): Promise<void> {
	const parent = path.dirname(engineDir);
	const base = path.basename(engineDir);
	const nonce = `${process.pid}-${crypto.randomUUID()}`;
	const staged = path.join(parent, `.${base}-${nonce}-link`);
	const retired = path.join(parent, `.${base}-${nonce}-retired`);
	const windows = process.platform === "win32";
	await fs.symlink(target, staged, windows ? "junction" : "dir");
	let moved = false;
	try {
		const existing = await fs.lstat(engineDir).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (existing?.isSymbolicLink()) {
			if (windows) await fs.rmdir(engineDir);
		} else if (existing !== undefined) {
			await fs.rename(engineDir, retired);
			moved = true;
		}
		await fs.rename(staged, engineDir);
	} catch (error) {
		await fs.rm(staged, { force: true }).catch(() => {});
		if (moved) await fs.rename(retired, engineDir).catch(() => {});
		throw error;
	}
	if (moved) await fs.rm(retired, { recursive: true, force: true }).catch(() => {});
}

/**
 * Delete the version folders in `versionsDir` other than `keep` that nothing
 * runs from, each renamed first so it goes whole or not at all. A folder it
 * cannot judge or delete stays for a later check.
 */
async function sweepVersions(versionsDir: string, keep: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(versionsDir);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	for (const name of names) {
		const folder = path.join(versionsDir, name);
		if (folder === keep) continue;
		try {
			// Leftovers of an install that died midway hold no host anything runs from.
			if (!name.startsWith(".") && (await processesRunningFrom(folder)).length > 0) continue;
			const gone = name.startsWith(".") ? folder : path.join(versionsDir, `.${name}-${crypto.randomUUID()}-gone`);
			if (gone !== folder) await fs.rename(folder, gone);
			await fs.rm(gone, { recursive: true, force: true });
		} catch (error) {
			logger.debug("Could not delete an old WebKit engine version", { folder, error: String(error) });
		}
	}
}
