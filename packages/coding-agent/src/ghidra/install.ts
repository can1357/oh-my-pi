import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	$env,
	getGhidraDir,
	isEnoent,
	isEnotdir,
	isRecord,
	logger,
	USER_AGENT,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { $ } from "bun";
import { DisasmUnavailableError } from "../disasm/backend";
import { type DownloadTracker, trackDownload, withDownload } from "../downloads/activity";
import { ensureManagedVenv } from "../eval/py/venv";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { downloadFile } from "../utils/tools-manager";
import { ghidraHostSupported, ghidraNativesPlatform } from "./platform";

/** Pinned release whose PyGhidra and Java APIs are supported by the worker. */
export const GHIDRA_RELEASE = {
	version: "12.2",
	tag: "Ghidra_12.2_build",
	asset: "ghidra_12.2_PUBLIC_20261016.zip",
	sha256: "2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67",
	dirName: "ghidra_12.2_PUBLIC",
} as const;

const READY_MARKER = ".omp-ready";
const INSTALL_LOCK_OPTIONS = { retries: 3600, retryDelayMs: 1000 };
const ARCHIVE_OPTIONS = { limits: { maxMemberSize: 512 * 1024 * 1024 } };
let status: string | undefined;
let nativesAttempted = false;

/** Current first-use provisioning phase, including waits for another process's install lock. */
export function ghidraInstallStatus(): string | undefined {
	return status;
}

function unavailable(label: string, error: unknown): DisasmUnavailableError {
	if (error instanceof DisasmUnavailableError) return error;
	return new DisasmUnavailableError(
		`${label} installation failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}

async function optionalText(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return undefined;
		throw error;
	}
}

/** Whether a directory is a Ghidra 12+ installation with PyGhidra support. */
export async function isGhidraInstall(dir: string): Promise<boolean> {
	const properties = await optionalText(path.join(dir, "Ghidra", "application.properties"));
	const version = properties?.match(/^application\.version\s*=\s*(\d+)(?:\.|\s|$)/m);
	return (
		!!version &&
		Number(version[1]) >= 12 &&
		Bun.file(path.join(dir, "Ghidra", "Features", "PyGhidra", "lib", "PyGhidra.jar")).exists()
	);
}

/** Whether the current host's decompiler executable is shipped or locally built in an install. */
export async function hasDecompilerNatives(installDir: string): Promise<boolean> {
	const platform = ghidraNativesPlatform();
	const executable = process.platform === "win32" ? "decompile.exe" : "decompile";
	const moduleDir = path.join(installDir, "Ghidra", "Features", "Decompiler");
	return (
		(await Bun.file(path.join(moduleDir, "os", platform, executable)).exists()) ||
		Bun.file(path.join(moduleDir, "build", "os", platform, executable)).exists()
	);
}

async function verifyChecksum(file: string, expected: string, label: string): Promise<void> {
	status = `verifying ${label} download`;
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	if (hasher.digest("hex") !== expected.toLowerCase()) {
		await fs.rm(file, { force: true });
		throw new DisasmUnavailableError(`${label} download checksum mismatch`);
	}
}

function downloadProgress(
	label: string,
	tracker: DownloadTracker,
): (loaded: number, total: number | undefined) => void {
	return (loaded, total) => {
		tracker.update({ loaded, total });
		const received = (loaded / 1_000_000).toFixed(0);
		status =
			total === undefined
				? `downloading ${label}: ${received} MB`
				: `downloading ${label}: ${received}/${(total / 1_000_000).toFixed(0)} MB`;
	};
}

async function installManagedGhidra(root: string, installDir: string): Promise<void> {
	const archive = path.join(root, `${GHIDRA_RELEASE.asset}.part`);
	let temporary: string | undefined;
	try {
		await withDownload(`Ghidra ${GHIDRA_RELEASE.version}`, async tracker => {
			status = `downloading Ghidra ${GHIDRA_RELEASE.version}`;
			await downloadFile(
				`https://github.com/NationalSecurityAgency/ghidra/releases/download/${GHIDRA_RELEASE.tag}/${GHIDRA_RELEASE.asset}`,
				archive,
				{ timeoutMs: 30 * 60_000, onProgress: downloadProgress(`Ghidra ${GHIDRA_RELEASE.version}`, tracker) },
			);
			tracker.update({ detail: "verifying checksum" });
			await verifyChecksum(archive, GHIDRA_RELEASE.sha256, "Ghidra");
			status = "extracting Ghidra";
			tracker.update({ detail: "extracting" });
			temporary = await fs.mkdtemp(path.join(root, ".extract-"));
			await extractArchive({ path: archive, format: "zip" }, temporary, ARCHIVE_OPTIONS);
			const extracted = path.join(temporary, GHIDRA_RELEASE.dirName);
			if (!(await isGhidraInstall(extracted)))
				throw new DisasmUnavailableError("Ghidra archive has no Ghidra 12+ install with PyGhidra");
			await fs.rm(installDir, { recursive: true, force: true });
			await fs.rename(extracted, installDir);
			await Bun.write(path.join(installDir, READY_MARKER), `${GHIDRA_RELEASE.version}\n`);
		});
	} finally {
		await fs.rm(archive, { force: true });
		if (temporary) await fs.rm(temporary, { recursive: true, force: true });
	}
}

/** Build missing natives only in the managed install, once per process, while its install lock is held. */
async function ensureManagedNatives(installDir: string, javaHome: string, root: string): Promise<void> {
	if (nativesAttempted || (await hasDecompilerNatives(installDir))) return;
	nativesAttempted = true;
	status = "building Ghidra natives";
	const tracker = trackDownload("Ghidra natives", { detail: "building" });
	let exitCode: number | undefined;
	let stderr = "";
	try {
		const result = await $`${path.join(installDir, "support", "gradle", "gradlew")} --no-daemon buildNatives`
			.cwd(path.join(installDir, "support", "gradle"))
			.env(workerEnvFromParent({ JAVA_HOME: javaHome, GRADLE_USER_HOME: path.join(root, "gradle") }))
			.quiet()
			.nothrow();
		exitCode = result.exitCode;
		stderr = result.stderr.toString().slice(-2000);
		if (exitCode !== 0 || !(await hasDecompilerNatives(installDir))) {
			throw new Error(`Ghidra natives build did not produce a decompiler (exit ${exitCode})`);
		}
		tracker.done();
	} catch (error) {
		logger.warn("Ghidra natives build failed; pseudocode falls back to disassembly", {
			exitCode,
			stderr,
			error,
		});
		tracker.fail(error);
	}
}

/**
 * Resolve an explicit, environment, or Homebrew installation, otherwise provision the pinned release.
 * Only managed installs are modified or have their missing native decompiler built.
 */
export async function ensureGhidraInstall(configured: string | undefined, javaHome: string): Promise<string> {
	status = "locating Ghidra";
	try {
		const explicit = configured?.trim();
		if (explicit) {
			const dir = path.resolve(explicit);
			if (await isGhidraInstall(dir)) return dir;
			throw new DisasmUnavailableError(`ghidra.installDir ${dir} is not a Ghidra 12+ install with PyGhidra`);
		}
		const environment = $env.GHIDRA_INSTALL_DIR?.trim();
		if (environment && (await isGhidraInstall(environment))) return path.resolve(environment);
		for (const prefix of ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"]) {
			const dir = path.join(prefix, "opt", "ghidra", "libexec");
			if (await isGhidraInstall(dir)) return dir;
		}
		if (!ghidraHostSupported())
			throw new DisasmUnavailableError(`Ghidra does not support ${process.platform}/${process.arch}`);
		const root = getGhidraDir();
		const installDir = path.join(root, GHIDRA_RELEASE.dirName);
		await fs.mkdir(root, { recursive: true });
		status = "waiting for Ghidra installation lock";
		return await withFileLock(
			path.join(root, "install"),
			async () => {
				if (
					!(await Bun.file(path.join(installDir, READY_MARKER)).exists()) ||
					!(await isGhidraInstall(installDir))
				) {
					await installManagedGhidra(root, installDir);
				}
				await ensureManagedNatives(installDir, javaHome, root);
				return installDir;
			},
			INSTALL_LOCK_OPTIONS,
		);
	} catch (error) {
		throw unavailable("Ghidra", error);
	} finally {
		status = undefined;
	}
}

function jdkHome(dir: string): string {
	return process.platform === "darwin" ? path.join(dir, "Contents", "Home") : dir;
}

async function isSuitableJdk(home: string): Promise<boolean> {
	const release = await optionalText(path.join(home, "release"));
	const version = release?.match(/^JAVA_VERSION="(\d+)(?:[.\-+"_])/m);
	return (
		!!version &&
		Number(version[1]) >= 25 &&
		Bun.file(path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java")).exists()
	);
}

async function managedJdk(jdkRoot: string): Promise<string | undefined> {
	const directories = await fs.readdir(jdkRoot, { withFileTypes: true });
	directories.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const dir = path.join(jdkRoot, directory.name);
		if ((await Bun.file(path.join(dir, READY_MARKER)).exists()) && (await isSuitableJdk(jdkHome(dir))))
			return jdkHome(dir);
	}
	return undefined;
}

interface JdkRelease {
	name: string;
	asset: string;
	url: string;
	sha256: string;
}

async function latestJdkRelease(): Promise<JdkRelease> {
	const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
	const arch = process.arch === "arm64" ? "aarch64" : "x64";
	status = "locating JDK 25 download";
	const response = await fetch(
		`https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`,
		{ headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok) throw new DisasmUnavailableError(`JDK download metadata request failed: ${response.status}`);
	const data: unknown = await response.json();
	const release: unknown = Array.isArray(data) ? data[0] : undefined;
	const binary = isRecord(release) ? release.binary : undefined;
	const asset = isRecord(binary) ? binary.package : undefined;
	if (
		!isRecord(release) ||
		typeof release.release_name !== "string" ||
		!/^[\w.+-]+$/.test(release.release_name) ||
		!isRecord(asset) ||
		typeof asset.name !== "string" ||
		!/^[\w.+-]+$/.test(asset.name) ||
		typeof asset.link !== "string" ||
		!asset.link.startsWith("https://") ||
		typeof asset.checksum !== "string" ||
		!/^[a-f\d]{64}$/i.test(asset.checksum)
	) {
		throw new DisasmUnavailableError("JDK download metadata is missing a release, package, or SHA-256 checksum");
	}
	return { name: release.release_name, asset: asset.name, url: asset.link, sha256: asset.checksum };
}

/** Use JAVA_HOME when it is JDK 25+, otherwise provision and reuse a managed Temurin JDK 25. */
export async function ensureJdk(): Promise<string> {
	status = "locating JDK 25";
	try {
		const environment = $env.JAVA_HOME?.trim();
		if (environment && (await isSuitableJdk(environment))) return path.resolve(environment);
		if (!ghidraHostSupported())
			throw new DisasmUnavailableError(`Ghidra does not support ${process.platform}/${process.arch}`);
		const root = getGhidraDir();
		const jdkRoot = path.join(root, "jdk");
		await fs.mkdir(jdkRoot, { recursive: true });
		status = "waiting for JDK installation lock";
		return await withFileLock(
			path.join(root, "install"),
			async () => {
				const existing = await managedJdk(jdkRoot);
				if (existing) return existing;
				const release = await latestJdkRelease();
				const archive = path.join(root, `${release.asset}.part`);
				const installDir = path.join(jdkRoot, release.name);
				let temporary: string | undefined;
				try {
					return await withDownload("Temurin JDK 25", async tracker => {
						status = "downloading JDK 25";
						await downloadFile(release.url, archive, {
							timeoutMs: 15 * 60_000,
							onProgress: downloadProgress("JDK 25", tracker),
						});
						tracker.update({ detail: "verifying checksum" });
						await verifyChecksum(archive, release.sha256, "JDK");
						status = "extracting JDK 25";
						tracker.update({ detail: "extracting" });
						temporary = await fs.mkdtemp(path.join(root, ".jdk-extract-"));
						await extractArchive(
							{ path: archive, format: process.platform === "win32" ? "zip" : "tar.gz" },
							temporary,
							ARCHIVE_OPTIONS,
						);
						const entries = await fs.readdir(temporary, { withFileTypes: true });
						const directory = entries[0];
						if (entries.length !== 1 || !directory?.isDirectory())
							throw new DisasmUnavailableError("JDK archive does not contain a single installation directory");
						const extracted = path.join(temporary, directory.name);
						if (!(await isSuitableJdk(jdkHome(extracted))))
							throw new DisasmUnavailableError("JDK archive does not contain Java 25+ and bin/java");
						await fs.rm(installDir, { recursive: true, force: true });
						await fs.rename(extracted, installDir);
						await Bun.write(path.join(installDir, READY_MARKER), `${release.name}\n`);
						return jdkHome(installDir);
					});
				} finally {
					await fs.rm(archive, { force: true });
					if (temporary) await fs.rm(temporary, { recursive: true, force: true });
				}
			},
			INSTALL_LOCK_OPTIONS,
		);
	} catch (error) {
		throw unavailable("JDK", error);
	} finally {
		status = undefined;
	}
}

/** Provision a Python 3.10–3.13 venv using only an installation's bundled PyGhidra wheels. */
export async function ensurePyGhidraVenv(installDir: string): Promise<string> {
	status = "locating PyGhidra wheels";
	try {
		const dist = path.join(installDir, "Ghidra", "Features", "PyGhidra", "pypkg", "dist");
		let wheels: string[];
		try {
			wheels = await fs.readdir(dist);
		} catch (error) {
			if (!isEnoent(error) && !isEnotdir(error)) throw error;
			throw new DisasmUnavailableError(`PyGhidra bundled wheels are missing: ${dist}`);
		}
		const wheel = wheels.find(name => /^pyghidra-(.+)-py3-none-any\.whl$/.test(name));
		const version = wheel?.match(/^pyghidra-(.+)-py3-none-any\.whl$/)?.[1];
		if (!version) throw new DisasmUnavailableError(`PyGhidra bundled wheel is missing: ${dist}`);
		status = "installing PyGhidra (waiting for installation lock)";
		return await withDownload(
			"PyGhidra",
			async tracker =>
				ensureManagedVenv(
					{
						dir: path.join(getGhidraDir(), `pyghidra-${version}`),
						marker: READY_MARKER,
						key: `${version}\n${installDir}`,
						python: { min: "3.10", below: "3.14" },
						install: ["--no-index", "--find-links", dist, `pyghidra==${version}`],
						label: "PyGhidra",
					},
					phase => {
						if (phase === "download") {
							status = "installing PyGhidra";
							tracker.update({ detail: "installing bundled wheels" });
						}
					},
				),
			{ detail: "waiting for installation lock" },
		);
	} catch (error) {
		throw unavailable("PyGhidra", error);
	} finally {
		status = undefined;
	}
}
