import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getBrowserRelayInstallRegistryFile,
	isEnoent,
	isRecord,
	logger,
	VERSION,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../../../utils/atomic-file";
import {
	defaultRelayExtensionDir,
	extensionIdForPath,
	loadRelayExtension,
	writeRelayExtension,
} from "./extension-files";
import { discoverRelayEndpoints } from "./discovery";
import { refreshRelayNativeHost } from "./native-host-manifest";
import {
	isOlderOmpVersion,
	type PanelInstall,
	RELAY_RECHECK_PATH,
} from "./protocol";

/** The files this omp writes: its version and extension build. A source checkout changes the build, not the version. */
async function installStamp(): Promise<string> {
	return `${VERSION}+${(await loadRelayExtension()).build}`;
}

/** Managed extension directory and the last asset version omp wrote there. */
export interface RelayInstall {
	dir: string;
	ompVersion: string | null;
	writtenAt: number;
}

/** Shared install records plus the version that last synchronized the registry. */
export interface RelayInstallRegistry {
	installs: RelayInstall[];
	/** `<omp version>+<extension build>` of the last complete sync; startup syncs again when it differs. */
	lastSynced?: string;
}

/** Outcome for one directory during a sync, including directories left intact. */
export type RelayInstallSyncResult = { dir: string } & (
	| { status: "written" | "up to date"; ompVersion: string }
	| { status: "missing" }
	| { status: "failed"; error: string }
);

/** Overrides for an isolated install registry. */
export interface RelayInstallLocations {
	registryFile?: string;
	defaultDir?: string;
	/**
	 * Relay asked to reload connected extensions after their files change: the default relay unless the registry is
	 * overridden; null asks none.
	 */
	relayUrl?: string | null;
}

function installKey(dir: string): string {
	return process.platform === "win32" ? dir.toLowerCase() : dir;
}

function resolveLocations(
	options: RelayInstallLocations,
): Required<RelayInstallLocations> {
	return {
		registryFile: options.registryFile ?? getBrowserRelayInstallRegistryFile(),
		defaultDir:
			options.defaultDir ??
			(options.registryFile
				? path.join(path.dirname(options.registryFile), "extension")
				: defaultRelayExtensionDir()),
		relayUrl:
			options.relayUrl !== undefined
				? options.relayUrl
				: options.registryFile
					? null
					: discoverRelayEndpoints()[0] ?? null,
	};
}

/**
 * Tell a running relay that install folders changed, so each connected extension reloads into its folder once idle
 * (see `RelayBridge.recheckExtensions`). No relay listening, or one too old for the endpoint, is fine: the next
 * extension hello runs the same check.
 */
async function recheckRelay(relayUrl: string | null): Promise<void> {
	if (relayUrl === null) return;
	await fetch(`${relayUrl.replace(/\/+$/, "")}${RELAY_RECHECK_PATH}`, {
		method: "POST",
		signal: AbortSignal.timeout(1_000),
	}).catch(() => {});
}

/** Read the shared registry without creating it, consolidating duplicate canonical paths. */
export async function readRelayInstallRegistry(
	file = getBrowserRelayInstallRegistryFile(),
): Promise<RelayInstallRegistry> {
	let data: unknown;
	try {
		data = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return { installs: [] };
		throw error;
	}
	if (!isRecord(data) || !Array.isArray(data.installs))
		throw new Error(`Invalid browser relay install registry: ${file}`);
	const installs = new Map<string, RelayInstall>();
	for (const row of data.installs) {
		if (
			!isRecord(row) ||
			typeof row.dir !== "string" ||
			!path.isAbsolute(row.dir) ||
			(row.ompVersion !== null && typeof row.ompVersion !== "string") ||
			typeof row.writtenAt !== "number"
		) {
			continue;
		}
		const dir = path.normalize(row.dir);
		const key = installKey(dir);
		const existing = installs.get(key);
		if (!existing || row.writtenAt >= existing.writtenAt) {
			installs.set(key, {
				dir,
				ompVersion: row.ompVersion,
				writtenAt: row.writtenAt,
			});
		}
	}
	return {
		installs: [...installs.values()],
		lastSynced:
			typeof data.lastSynced === "string" ? data.lastSynced : undefined,
	};
}

/** The omp version stamped in an install's manifest: null when the file is absent, "" when unstamped or unparsable. */
async function readManifestVersion(file: string): Promise<string | null> {
	try {
		const data: unknown = await Bun.file(file).json();
		if (isRecord(data) && typeof data.version_name === "string")
			return data.version_name;
	} catch (error) {
		if (isEnoent(error)) return null;
		if (!(error instanceof SyntaxError)) throw error;
	}
	return "";
}

async function adoptDefaultInstall(
	registry: RelayInstallRegistry,
	defaultDir: string,
): Promise<boolean> {
	try {
		const dir = await fs.realpath(defaultDir);
		if (
			registry.installs.some((row) => installKey(row.dir) === installKey(dir))
		)
			return false;
		const manifest = await fs.stat(path.join(dir, "manifest.json"));
		if (!manifest.isFile()) return false;
		registry.installs.push({
			dir,
			ompVersion: null,
			writtenAt: manifest.mtimeMs,
		});
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Report known install folders and their recorded versions for the panel diagnostics. */
export async function readRelayInstalls(
	options: RelayInstallLocations = {},
): Promise<PanelInstall[]> {
	const { registryFile, defaultDir } = resolveLocations(options);
	const registry = await readRelayInstallRegistry(registryFile);
	await adoptDefaultInstall(registry, defaultDir);
	return Promise.all(
		registry.installs.map(async ({ dir, ompVersion }) => ({
			dir,
			version: ompVersion,
			missing: !(await Bun.file(path.join(dir, "manifest.json")).exists()),
		})),
	);
}

/**
 * The Chrome ids of every registered install (the default folder included once it exists): the origins the native
 * messaging host admits and the extensions a relay may rewrite and reload. Registry dirs are canonical, so each id is
 * the one Chrome derived when the folder was loaded unpacked.
 */
export async function registeredRelayExtensionIds(
	options: RelayInstallLocations = {},
): Promise<string[]> {
	const { registryFile, defaultDir } = resolveLocations(options);
	const registry = await readRelayInstallRegistry(registryFile);
	await adoptDefaultInstall(registry, defaultDir);
	return registry.installs.map((row) => extensionIdForPath(row.dir));
}

/** Install the requested copy, recording its real directory and preserving any existing default installation. */
export async function installRelayExtension(
	dir: string,
	options: RelayInstallLocations = {},
): Promise<string> {
	const { registryFile, defaultDir, relayUrl } = resolveLocations(options);
	await fs.mkdir(path.dirname(registryFile), { recursive: true });
	let written = false;
	const canonical = await withFileLock(registryFile, async () => {
		const registry = await readRelayInstallRegistry(registryFile);
		await fs.mkdir(dir, { recursive: true });
		const canonical = await fs.realpath(dir);
		written = await writeRelayExtension(canonical, VERSION);
		const current = registry.installs.find(
			(row) => installKey(row.dir) === installKey(canonical),
		);
		const updated = !current || written || current.ompVersion !== VERSION;
		if (!current) {
			registry.installs.push({
				dir: canonical,
				ompVersion: VERSION,
				writtenAt: Date.now(),
			});
		} else if (updated) {
			current.ompVersion = VERSION;
			current.writtenAt = Date.now();
		}
		const adopted = await adoptDefaultInstall(registry, defaultDir);
		if (updated || adopted)
			await writeFileAtomically(
				registryFile,
				`${JSON.stringify(registry, null, 2)}\n`,
			);
		return canonical;
	});
	if (written) await recheckRelay(relayUrl);
	return canonical;
}

/** Install sync modes: explicit replacement, version-change backstop, or older-relay protection. */
export interface RelayInstallSyncOptions extends RelayInstallLocations {
	mode?: "explicit" | "startup" | "relay";
}

/** Reconcile every known install with this omp's assets without recreating missing directories. */
export async function syncRelayInstalls(
	options: RelayInstallSyncOptions = {},
): Promise<RelayInstallSyncResult[]> {
	const { registryFile, defaultDir, relayUrl } = resolveLocations(options);
	const initial = await readRelayInstallRegistry(registryFile);
	if (
		initial.installs.length === 0 &&
		!(await Bun.file(path.join(defaultDir, "manifest.json")).exists())
	)
		return [];
	// Nothing to write without the extension: a source checkout that never generated it fails here, not per folder.
	const stamp = await installStamp();
	if (options.mode === "startup" && initial.lastSynced === stamp) return [];
	await fs.mkdir(path.dirname(registryFile), { recursive: true });
	const synced = await withFileLock(registryFile, async () => {
		const registry = await readRelayInstallRegistry(registryFile);
		if (options.mode === "startup" && registry.lastSynced === stamp)
			return [];
		let changed = await adoptDefaultInstall(registry, defaultDir);
		const results: RelayInstallSyncResult[] = [];
		for (const row of registry.installs) {
			const { dir } = row;
			try {
				if (!(await fs.lstat(dir)).isDirectory()) {
					results.push({ dir, status: "missing" });
					continue;
				}
				const installed = await readManifestVersion(
					path.join(dir, "manifest.json"),
				);
				if (
					options.mode === "relay" &&
					installed !== null &&
					isOlderOmpVersion(VERSION, installed)
				) {
					results.push({ dir, status: "up to date", ompVersion: installed });
					continue;
				}
				const written = await writeRelayExtension(dir, VERSION);
				if (written || row.ompVersion !== VERSION) {
					row.ompVersion = VERSION;
					row.writtenAt = Date.now();
					changed = true;
				}
				results.push({
					dir,
					status: written ? "written" : "up to date",
					ompVersion: VERSION,
				});
			} catch (error) {
				results.push(
					isEnoent(error)
						? { dir, status: "missing" }
						: {
								dir,
								status: "failed",
								error: error instanceof Error ? error.message : String(error),
							},
				);
			}
		}
		if (options.mode !== "relay") {
			try {
				await refreshRelayNativeHost(
					registry.installs.map((row) => extensionIdForPath(row.dir)),
					{ dir: path.dirname(registryFile) },
				);
				if (
					registry.lastSynced !== stamp &&
					!results.some((result) => result.status === "failed")
				) {
					registry.lastSynced = stamp;
					changed = true;
				}
			} catch (error) {
				logger.warn("browser relay native host refresh failed", {
					error: String(error),
				});
			}
		}
		if (changed)
			await writeFileAtomically(
				registryFile,
				`${JSON.stringify(registry, null, 2)}\n`,
			);
		return results;
	});
	// The relay's own sync already reloads the extension it ran for.
	if (
		options.mode !== "relay" &&
		synced.some((result) => result.status === "written")
	)
		await recheckRelay(relayUrl);
	return synced;
}

/** Catch up installs on a normal startup after a version change without delaying the session. */
export function syncRelayInstallsOnStartup(): void {
	void syncRelayInstalls({ mode: "startup" })
		.then((results) => {
			for (const result of results) {
				if (result.status === "failed")
					logger.warn("browser relay install sync failed", result);
			}
		})
		.catch((error) =>
			logger.warn("browser relay install sync failed", {
				error: String(error),
			}),
		);
}
