/**
 * Downloads omp's WebKit engine, ABKit, from Stencil's build service (product
 * `abkit`, the newest stable build) into an engine directory, normally
 * `~/.o2/lib/abkit` (`webKitEngineToInstall` in `kind.ts`).
 *
 * The answered archive (`abkit-<version>-<platform>.tar.gz`, `.zip` on
 * Windows) is checked against the answer's size and SHA-256 while it streams,
 * unpacked beside the engine directory, and must hold the engine as `abkit/`
 * with its host executable. It then takes the directory's place by rename, so
 * a host still running from an older copy keeps its files. An OS lock makes
 * concurrent omp processes install once.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { BROWSER_ARCHIVE_LIMITS } from "@oh-my-pi/pi-utils/browsers";
import {
	BUILD_DOWNLOAD_TIMEOUT_MS,
	type BuildProduct,
	currentBuildHost,
	downloadBuildFile,
	type Fetch,
	fetchBuild,
} from "../../../cli/build-service";
import { withDownload } from "../../../downloads/activity";
import { hostExecutableAt, hostExecutableName } from "./kind";

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

const installs = new Map<string, Promise<string>>();

/**
 * Install the newest stable ABKit as `engineDir` and resolve to its host
 * executable; concurrent calls for one directory share one install, and one
 * that finds the engine already installed (by another omp) downloads nothing.
 *
 * Throws when the build service publishes no ABKit build for this host (the
 * message names the target), the download fails or does not match the
 * answer, or the archive holds no `abkit/` host executable. Nothing is left
 * beside `engineDir` then, and a directory already there stays.
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
			// Another omp may have installed it while this one waited for the lock.
			const installed = hostExecutableAt(engineDir, process.platform);
			if (installed !== null) return installed;

			const build = await fetchBuild(
				{ channel: "stable" },
				{ product: ABKIT_BUILD, host: await currentBuildHost(), fetchImpl: options.fetchImpl },
			);
			const nonce = `${process.pid}-${crypto.randomUUID()}`;
			const archivePath = path.join(parent, `.abkit-${nonce}-${build.file.name}`);
			const stagingPath = path.join(parent, `.abkit-${nonce}`);
			const retiredPath = path.join(parent, `.abkit-${nonce}-retired`);
			logger.warn("Downloading omp's WebKit engine (first browser use)", {
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
				// A directory without a host executable (a partial copy) is moved aside rather than
				// deleted in place, so whatever still runs from it keeps its files.
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
