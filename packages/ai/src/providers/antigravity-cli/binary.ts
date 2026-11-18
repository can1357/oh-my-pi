/** agy binary selection and managed release installation, without running Google's shell-profile installer. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	$env,
	$which,
	compareVersions,
	formatBytes,
	getAntigravityCliDir,
	isEnoent,
	logger,
	ptree,
	WhichCachePolicy,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../../types";

const MANIFEST_BASE_URL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Releases run to hundreds of MB, so only silence aborts a download; a total deadline would exclude slow links. */
const DOWNLOAD_STALL_MS = 60_000;
const MINIMUM_AGY_VERSION = "1.5.9";
const AGY_VERSION =
	/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=\s|$)/u;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const operations = new Map<string, Promise<string>>();
const versionChecks = new Map<string, Promise<boolean>>();

interface ReleaseManifest {
	version: string;
	url: string;
	sha512: string;
}

interface InstallRecord {
	version: string;
	checkedAt: number;
}

/** agy's isolated configuration/conversation root; account subdirectories are selected by the transport. */
export function agyGeminiDir(): string {
	return path.join(getAntigravityCliDir(), "gemini");
}

/** Overrides for installed-CLI discovery and the managed install directory. */
export interface ResolveAgyOptions {
	which?: (command: string) => string | null;
	probe?: (binary: string) => Promise<string | undefined>;
	directory?: string;
}

/** Resolves PI_AGY_PATH, a compatible agy on PATH, or the managed release. */
export async function resolveAgyBinary(fetchImpl: FetchImpl = fetch, options: ResolveAgyOptions = {}): Promise<string> {
	const override = $env.PI_AGY_PATH;
	if (override) return override;
	const installed = (
		options.which ?? (command => $which(command, { cache: WhichCachePolicy.Bypass, requireAbsolutePaths: true }))
	)("agy");
	if (installed && (await installedAgyCompatible(installed, options.probe))) return installed;
	return ensureAgyInstalled(options.directory ?? path.join(getAntigravityCliDir(), "bin"), fetchImpl);
}

function installedAgyCompatible(
	binary: string,
	probe: ((binary: string) => Promise<string | undefined>) | undefined,
): Promise<boolean> {
	if (probe) return probe(binary).then(compatibleAgyVersion, () => false);
	let check = versionChecks.get(binary);
	if (!check) {
		check = probeAgyVersion(binary)
			.then(compatibleAgyVersion, () => false)
			.finally(() => versionChecks.delete(binary));
		versionChecks.set(binary, check);
	}
	return check;
}

function compatibleAgyVersion(version: string | undefined): boolean {
	const match = AGY_VERSION.exec(version ?? "");
	if (match === null || match[2] !== undefined) return false;
	return compareVersions(match[1]!, MINIMUM_AGY_VERSION) >= 0;
}

async function probeAgyVersion(binary: string): Promise<string | undefined> {
	const result = await ptree.exec([binary, "acp", "--version"], {
		env: { ...Bun.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
		timeout: VERSION_PROBE_TIMEOUT_MS,
		allowNonZero: true,
		allowAbort: true,
	});
	if (!result.ok || result.exitError?.aborted) return undefined;
	const version = result.stdout.trim().split(/\r?\n/u)[0]?.trim();
	return version || undefined;
}

/** Installs a verified release into `directory`; versioned paths keep running processes valid during updates. */
export async function ensureAgyInstalled(directory: string, fetchImpl: FetchImpl = fetch): Promise<string> {
	const record = await readRecord(directory);
	const installed = record ? releasePath(directory, record.version) : undefined;
	if (installed && (await Bun.file(installed).exists())) {
		if (Date.now() - record!.checkedAt >= UPDATE_INTERVAL_MS && !operations.has(directory)) {
			void updateAgyBinary(directory, fetchImpl).catch(error => {
				logger.warn("Antigravity CLI update failed; retaining installed version", { error: String(error) });
			});
		}
		return installed;
	}
	return updateAgyBinary(directory, fetchImpl);
}

/** Google's manifest platform key, including Alpine's musl userland. */
export async function agyPlatformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): Promise<string> {
	const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
	if (!cpu) throw new Error(`Antigravity CLI has no release for ${platform}/${arch}`);
	switch (platform) {
		case "darwin":
			return `darwin_${cpu}`;
		case "win32":
			return `windows_${cpu}`;
		case "android":
			return `android_${cpu}`;
		case "linux": {
			const loader = `/lib/libc.musl-${cpu === "amd64" ? "x86_64" : "aarch64"}.so.1`;
			return `linux_${cpu}${(await Bun.file(loader).exists()) ? "_musl" : ""}`;
		}
		default:
			throw new Error(`Antigravity CLI has no release for ${platform}/${arch}`);
	}
}

function releasePath(directory: string, version: string): string {
	return path.join(directory, version, process.platform === "win32" ? "agy.exe" : "agy");
}

/** Refreshes an expired installation check, coalescing callers and retaining old releases on failure. */
export function updateAgyBinary(directory: string, fetchImpl: FetchImpl = fetch): Promise<string> {
	const running = operations.get(directory);
	if (running) return running;
	const operation = install(directory, fetchImpl).finally(() => operations.delete(directory));
	operations.set(directory, operation);
	return operation;
}

async function install(directory: string, fetchImpl: FetchImpl): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	return withFileLock(
		path.join(directory, "install"),
		async () => {
			const previous = await readRecord(directory);
			if (previous && Date.now() - previous.checkedAt < UPDATE_INTERVAL_MS) {
				const binary = releasePath(directory, previous.version);
				if (await Bun.file(binary).exists()) return binary;
			}
			const platform = await agyPlatformKey();
			const response = await fetchImpl(`${MANIFEST_BASE_URL}/${platform}.json`, {
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`Antigravity CLI manifest request failed: HTTP ${response.status}`);
			const value: unknown = await response.json();
			if (!isManifest(value)) throw new Error("Malformed Antigravity CLI release manifest");
			const url = new URL(value.url);
			if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com") {
				throw new Error("Antigravity CLI manifest did not reference Google's HTTPS release storage");
			}
			const binary = releasePath(directory, value.version);
			if (!(await Bun.file(binary).exists())) {
				const payload = await download(url, value.sha512, fetchImpl);
				const staging = `${binary}.${crypto.randomUUID()}.tmp`;
				try {
					if (url.pathname.endsWith(".tar.gz")) {
						const files = await new Bun.Archive(payload).files();
						const executable = files.get("antigravity");
						if (!executable) throw new Error("Antigravity CLI archive has no antigravity executable");
						await Bun.write(staging, executable);
					} else {
						await Bun.write(staging, payload);
					}
					await fs.chmod(staging, 0o755);
					await fs.rename(staging, binary);
				} finally {
					await fs.rm(staging, { force: true });
				}
			}
			const record: InstallRecord = { version: value.version, checkedAt: Date.now() };
			const stagedRecord = path.join(directory, `install.${crypto.randomUUID()}.json`);
			try {
				await Bun.write(stagedRecord, JSON.stringify(record));
				await fs.rename(stagedRecord, path.join(directory, "install.json"));
			} finally {
				await fs.rm(stagedRecord, { force: true });
			}
			return binary;
		},
		{ retries: 1800, retryDelayMs: 100 },
	);
}

/** Fetches and SHA-512-verifies a release, aborting when no bytes arrive for `DOWNLOAD_STALL_MS`. */
async function download(url: URL, sha512: string, fetchImpl: FetchImpl): Promise<Uint8Array> {
	const stall = new AbortController();
	const timer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_MS);
	let received = 0;
	let total = 0;
	try {
		const response = await fetchImpl(url, { signal: stall.signal });
		if (!response.ok) throw new Error(`Antigravity CLI download failed: HTTP ${response.status}`);
		if (!response.body) throw new Error("Antigravity CLI download returned no body");
		total = Number(response.headers.get("content-length")) || 0;
		const hasher = new Bun.CryptoHasher("sha512");
		const chunks: Uint8Array[] = [];
		for await (const chunk of response.body) {
			timer.refresh();
			hasher.update(chunk);
			chunks.push(chunk);
			received += chunk.byteLength;
		}
		if (hasher.digest("hex") !== sha512.toLowerCase())
			throw new Error("Antigravity CLI download failed its SHA-512 check");
		return Bun.concatArrayBuffers(chunks, Infinity, true);
	} catch (error) {
		if (!stall.signal.aborted) throw error;
		const progress = total ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received);
		throw new Error(`Antigravity CLI download stalled: no data for ${DOWNLOAD_STALL_MS / 1000}s after ${progress}`);
	} finally {
		clearTimeout(timer);
	}
}

async function readRecord(directory: string): Promise<InstallRecord | undefined> {
	try {
		const value: unknown = await Bun.file(path.join(directory, "install.json")).json();
		if (
			value &&
			typeof value === "object" &&
			"version" in value &&
			typeof value.version === "string" &&
			/^[0-9][a-zA-Z0-9._-]*$/.test(value.version) &&
			"checkedAt" in value &&
			typeof value.checkedAt === "number"
		) {
			return { version: value.version, checkedAt: value.checkedAt };
		}
		return undefined;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function isManifest(value: unknown): value is ReleaseManifest {
	return (
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		typeof value.version === "string" &&
		/^[0-9][a-zA-Z0-9._-]*$/.test(value.version) &&
		"url" in value &&
		typeof value.url === "string" &&
		"sha512" in value &&
		typeof value.sha512 === "string" &&
		/^[a-fA-F0-9]{128}$/.test(value.sha512)
	);
}
