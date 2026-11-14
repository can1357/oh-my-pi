/** Managed agy releases, installed from Google's manifest without running its shell-profile installer. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env, getAntigravityCliDir, isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../../types";

const MANIFEST_BASE_URL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const operations = new Map<string, Promise<string>>();

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

/** Resolves an existing override or installs agy; subsequent calls check for updates at most daily. */
export async function resolveAgyBinary(fetchImpl: FetchImpl = fetch): Promise<string> {
	const override = $env.PI_AGY_PATH;
	if (override) return override;
	return ensureAgyInstalled(path.join(getAntigravityCliDir(), "bin"), fetchImpl);
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
				const download = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
				if (!download.ok) throw new Error(`Antigravity CLI download failed: HTTP ${download.status}`);
				const payload = new Uint8Array(await download.arrayBuffer());
				const digest = new Bun.CryptoHasher("sha512").update(payload).digest("hex");
				if (digest !== value.sha512.toLowerCase())
					throw new Error("Antigravity CLI download failed its SHA-512 check");
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
