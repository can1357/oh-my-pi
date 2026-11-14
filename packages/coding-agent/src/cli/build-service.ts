/**
 * Client for Stencil's build service, the source of omp's standalone binaries
 * ({@link OMP_BUILD}) and of the engine its WebKit browser downloads (ABKit).
 *
 * `omp update` on a standalone binary install, the binary takeover of a
 * package-manager install, and the startup update check of a compiled binary
 * all ask the service which build to install ({@link fetchBuild}), as does the
 * browser's engine install:
 *
 * - `GET {origin}/api/products/{product}/latest/{target}?channel=stable|canary`
 *   for the newest build on a channel;
 * - `GET {origin}/api/products/{product}/versions/{version}/{target}` for one
 *   exact version.
 *
 * Both products are public, so no token is sent. The origin is `PI_BUILD_URL`
 * ({@link DEFAULT_BUILD_URL} when unset). `{target}` is
 * `{macos|linux|linux-musl|windows}-{arm64|x86_64}` ({@link resolveBuildHost}).
 * Requests carry `User-Agent: omp/<version>`, which the service counts in its
 * update-check statistics.
 *
 * Adding `from_version=<installed version>` makes the answer carry an
 * HDiffPatch patch from that version's file to the answered one when the
 * service has it; when it does not yet, the service starts making it
 * (`patch_pending`) so a later check finds it.
 *
 * An answer is checked before anything in it is used ({@link parseBuildAnswer}):
 * a malformed answer is an error, a malformed `patch` is dropped so the whole
 * file still installs. `404 {"error":"no_build"}` means nothing is published
 * for the target (on the channel, or at the version).
 */
import * as fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { $env, APP_NAME, isEnoent, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

export type UpdateChannel = "stable" | "canary";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Build service origin used when `PI_BUILD_URL` is unset. */
export const DEFAULT_BUILD_URL = "https://build.stencil.so";

const BUILD_CHECK_TIMEOUT_MS = 30_000;

/** Ceiling of one build file download ({@link downloadBuildFile}); a temp file older than this is abandoned. */
export const BUILD_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Build service origin: `PI_BUILD_URL` without trailing slashes, else {@link DEFAULT_BUILD_URL}. */
export function buildServiceUrl(): string {
	const configured = ($env.PI_BUILD_URL ?? "").trim().replace(/\/+$/, "");
	return configured || DEFAULT_BUILD_URL;
}

/** Where this host's builds live on the build service. */
export interface BuildHost {
	/** Build service target, e.g. `macos-arm64` or `linux-musl-x86_64`. */
	target: string;
	/** Platform part of release file names, e.g. `darwin-arm64` or `linux-musl-x64`. */
	asset: string;
	/** Windows host: executables end in `.exe` and archives are `.zip`. */
	windows: boolean;
}

/** A product the build service publishes, and what its file for a host is called. */
export interface BuildProduct {
	/** Product id in the service's routes, e.g. `omp`. */
	id: string;
	/** The file name a build of `version` has for `host`; an answer naming another file is refused. */
	fileName(host: BuildHost, version: string): string;
}

/** omp's standalone binary, named like its GitHub release asset: `omp-darwin-arm64`, `omp-windows-x64.exe`. */
export const OMP_BUILD: BuildProduct = {
	id: "omp",
	fileName: host => `${APP_NAME}-${host.asset}${host.windows ? ".exe" : ""}`,
};

/** The build service target and release file platform for a platform, architecture, and libc. */
export function resolveBuildHost(platform: NodeJS.Platform, arch: string, musl: boolean): BuildHost {
	let targetOs: string;
	let fileOs: string;
	switch (platform) {
		case "darwin":
			targetOs = "macos";
			fileOs = "darwin";
			break;
		case "linux":
			targetOs = musl ? "linux-musl" : "linux";
			fileOs = targetOs;
			break;
		case "win32":
			targetOs = "windows";
			fileOs = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
	let targetArch: string;
	switch (arch) {
		case "x64":
			targetArch = "x86_64";
			break;
		case "arm64":
			targetArch = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}
	return { target: `${targetOs}-${targetArch}`, asset: `${fileOs}-${arch}`, windows: platform === "win32" };
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl build instead of the glibc one, which would fail
 * to start on the next run. The loader file alone is not sufficient: glibc
 * hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform: NodeJS.Platform;
	alpineRelease: boolean;
	lddOutput: string;
}

function isMuslLinux(options: MuslDetectionOptions): boolean {
	if (options.platform !== "linux") return false;
	return options.alpineRelease || /\bmusl\b/i.test(options.lddOutput);
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: MuslDetectionOptions): boolean {
	return isMuslLinux(options);
}

async function detectLddOutput(): Promise<string> {
	try {
		const result = await $`ldd --version`.quiet().nothrow();
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return "";
	}
}

let currentHost: Promise<BuildHost> | undefined;

/** This host's {@link BuildHost}, detected once per process. */
export function currentBuildHost(): Promise<BuildHost> {
	currentHost ??= (async () => {
		const platform = process.platform;
		const musl =
			platform === "linux" &&
			isMuslLinux({
				platform,
				alpineRelease: fs.existsSync("/etc/alpine-release"),
				lddOutput: await detectLddOutput(),
			});
		return resolveBuildHost(platform, process.arch, musl);
	})();
	return currentHost;
}

/** The answered build's file for this host. */
export interface BuildFile {
	name: string;
	size: number;
	/** Lowercase hex SHA-256. */
	sha256: string;
}

/** HDiffPatch single-stream patch (`HDIFFSF20`) from an installed file to {@link BuildFile}. */
export interface BuildPatch {
	/** Lowercase hex SHA-256 of the file the patch applies to. */
	fromSha256: string;
	/** Version the check named as installed (`from_version`), for progress output. */
	fromVersion?: string;
	size: number;
	/** Lowercase hex SHA-256 of the patch itself. */
	sha256: string;
	/** Presigned HTTPS URL of the patch. */
	url: string;
}

/** A checked build service answer. */
export interface BuildAnswer {
	version: string;
	file: BuildFile;
	/** Presigned HTTPS URL of the whole file, valid for minutes. */
	download: string;
	patch?: BuildPatch;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether `version` is a version the build service publishes builds under (semver, no build metadata). */
export function isBuildVersion(version: string): boolean {
	return SEMVER.test(version);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** The answer's patch when it is a complete `file` patch; anything else installs the whole file. */
function parseBuildPatch(patch: unknown, fromVersion: string | undefined): BuildPatch | undefined {
	if (!isRecord(patch) || patch.format !== "file") return undefined;
	if (!isSha256(patch.from_sha256) || !isSize(patch.size) || !isSha256(patch.sha256) || !isHttpsUrl(patch.url)) {
		return undefined;
	}
	return { fromSha256: patch.from_sha256, fromVersion, size: patch.size, sha256: patch.sha256, url: patch.url };
}

/**
 * Check a build service answer for `product`'s file for `host`.
 *
 * Throws when the answer cannot be installed safely: a version that is not
 * semver, a file other than the product's for that version, a size or SHA-256
 * that is not exact, or a download that is not HTTPS. A `patch` is kept only
 * when it is a complete `format: "file"` patch; any other patch is dropped,
 * not an error. `fromVersion` is the `from_version` the check sent.
 */
export function parseBuildAnswer(
	body: unknown,
	product: BuildProduct,
	host: BuildHost,
	fromVersion?: string,
): BuildAnswer {
	if (!isRecord(body) || !isRecord(body.build)) throw new Error("answer has no build");
	const version = body.build.version;
	if (typeof version !== "string" || !isBuildVersion(version)) throw new Error("build has no valid version");
	const fileName = product.fileName(host, version);
	const file = body.file;
	if (!isRecord(file)) throw new Error("answer has no file");
	if (file.name !== fileName) throw new Error(`answered file ${String(file.name)} is not ${fileName}`);
	if (!isSize(file.size)) throw new Error(`${fileName} has an invalid size`);
	if (!isSha256(file.sha256)) throw new Error(`${fileName} has an invalid sha256`);
	if (!isHttpsUrl(body.download)) throw new Error(`${fileName} has no HTTPS download`);
	return {
		version,
		file: { name: fileName, size: file.size, sha256: file.sha256 },
		download: body.download,
		patch: parseBuildPatch(body.patch, fromVersion),
	};
}

/** Which build to ask for: the newest on a channel, or one exact version. */
export type BuildSelector = { channel: UpdateChannel } | { version: string };

export interface FetchBuildOptions {
	/** Defaults to {@link OMP_BUILD}. */
	product?: BuildProduct;
	/** Installed version to ask a patch from (`from_version`). */
	fromVersion?: string;
	timeoutMs?: number;
	fetchImpl?: Fetch;
	/** Defaults to {@link currentBuildHost}. */
	host?: BuildHost;
}

/** Ask the build service for a build of this host's target ({@link BuildSelector}). */
export async function fetchBuild(selector: BuildSelector, options: FetchBuildOptions = {}): Promise<BuildAnswer> {
	const product = options.product ?? OMP_BUILD;
	const host = options.host ?? (await currentBuildHost());
	const origin = buildServiceUrl();
	const timeoutMs = options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
	const route =
		"channel" in selector
			? `latest/${host.target}`
			: `versions/${encodeURIComponent(selector.version)}/${host.target}`;
	const url = new URL(`${origin}/api/products/${product.id}/${route}`);
	if ("channel" in selector) url.searchParams.set("channel", selector.channel);
	if (options.fromVersion) url.searchParams.set("from_version", options.fromVersion);
	const what = `${product.id} ${"channel" in selector ? `${selector.channel} build` : `build ${selector.version}`} for ${host.target}`;

	const mapError = (err: unknown): unknown => {
		if (isTimeoutError(err)) {
			return new Error(`Timed out asking ${origin} for the ${what} after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) return new Error(unsupportedProxyMessage(), { cause: err });
		return err;
	};

	let response: Response;
	let body: unknown;
	try {
		response = await (options.fetchImpl ?? fetch)(url, {
			headers: { Accept: "application/json", "User-Agent": `${APP_NAME}/${VERSION}` },
			signal: withTimeoutSignal(timeoutMs),
		});
		try {
			body = await response.json();
		} catch (err) {
			// A malformed body is reported below; body-read timeouts and resets surface.
			if (!(err instanceof SyntaxError)) throw err;
		}
	} catch (err) {
		throw mapError(err);
	}

	if (response.status === 404 && isRecord(body) && body.error === "no_build") {
		const hint =
			product === OMP_BUILD && "channel" in selector && selector.channel === "canary"
				? ` Try \`${APP_NAME} update --stable\`.`
				: "";
		throw new Error(`No ${what} is published on ${origin} yet.${hint}`);
	}
	if (!response.ok) {
		throw new Error(`${origin} answered ${response.status} ${response.statusText} for the ${what}`);
	}
	try {
		return parseBuildAnswer(body, product, host, options.fromVersion);
	} catch (err) {
		throw new Error(`Invalid answer from ${origin} for the ${what}: ${err instanceof Error ? err.message : err}`);
	}
}

export interface BuildFileDownloadOptions {
	url: string;
	targetPath: string;
	/** Size the build service answered for the file. */
	size: number;
	/** Lowercase hex SHA-256 the build service answered for the file. */
	sha256: string;
	fetchImpl?: Fetch;
	/** Bytes received so far, after each chunk. */
	onProgress?: (received: number) => void;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Download a build service file (a build, or a patch to one) to `targetPath`,
 * checked against its answered size and SHA-256 while it streams.
 *
 * Throws on an HTTP error, a body larger than `size` (the stream is cancelled
 * at once), a final size or digest that differs, or no completion within
 * {@link BUILD_DOWNLOAD_TIMEOUT_MS}; nothing is left at `targetPath` then.
 */
export async function downloadBuildFile(options: BuildFileDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);
	const timeoutError = (err: unknown) =>
		new Error(`Timed out downloading ${options.url} after ${BUILD_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`, {
			cause: err,
		});

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BUILD_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) throw timeoutError(err);
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.status} ${response.statusText}`);
	}

	const hash = new Bun.SHA256();
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.size) {
				callback(new Error(`Download size mismatch: expected ${options.size} bytes, received at least ${size}`));
				return;
			}
			hash.update(chunk);
			options.onProgress?.(size);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		if (size !== options.size) {
			throw new Error(`Download size mismatch: expected ${options.size} bytes, received ${size}`);
		}
		const digest = hash.digest("hex");
		if (digest !== options.sha256) {
			throw new Error(`Download digest mismatch: expected sha256:${options.sha256}, received sha256:${digest}`);
		}
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) throw timeoutError(err);
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}
