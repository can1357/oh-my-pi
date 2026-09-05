import type { TinyTitleLocalModelSpec } from "./models";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import { LockAcquireError, withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import bundledArm64Identity from "./apple-fm/prebuilt/arm64-apple-macosx26.0/digest.txt" with { type: "text" };
import bundledArm64Sidecar from "./apple-fm/prebuilt/arm64-apple-macosx26.0/omp-apple-fm" with { type: "file" };
import sidecarSource from "./apple-fm/sidecar.swift" with { type: "text" };

/** Override path to a compiled sidecar. Used by tests; also handy for a prebuilt helper. */
export const AFM_CORE_SIDECAR_ENV = "OMP_APPLE_FM_SIDECAR";

export interface AfmStatus {
	available: boolean;
	reason?: string;
	contextSize?: number;
}

interface SidecarPayload {
	available?: boolean;
	reason?: string;
	contextSize?: number;
	text?: string;
	error?: string;
}

function sidecarOverride(): string | undefined {
	const value = process.env[AFM_CORE_SIDECAR_ENV]?.trim();
	return value || undefined;
}

/** Env override disables the platform gate so tests can drive a fake sidecar anywhere. */
export function foundationModelsUnavailableReason(spec: TinyTitleLocalModelSpec): string | undefined {
	if (sidecarOverride()) return undefined;
	if (spec.unsupportedReason) return spec.unsupportedReason;
	// Darwin 25 == macOS 26, when FoundationModels shipped. A 26.0-target
	// sidecar cannot launch on older kernels, so the Swift `#available` guard
	// never runs; refuse before install/spawn.
	if (!darwinMeetsAfmRuntime()) return "unsupported_os";
	return undefined;
}

/** Darwin 25 is macOS 26 (FoundationModels). Keep in sync with swiftTargetTriple. */
function darwinMeetsAfmRuntime(platform: NodeJS.Platform = process.platform, release: string = os.release()): boolean {
	if (platform !== "darwin") return false;
	const major = Number.parseInt(release.split(".")[0] ?? "", 10);
	return Number.isFinite(major) && major >= 25;
}

function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

async function settleSpawn(
	proc: { kill: (signal?: NodeJS.Signals) => void; exited: Promise<number>; stdout: unknown; stderr: unknown },
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	if (!signal) {
		const [stdout, stderr, exitCode] = await Promise.all([stdoutP, stderrP, proc.exited]);
		return { stdout, stderr, exitCode };
	}
	const { promise: aborted, resolve } = Promise.withResolvers<void>();
	const onAbort = (): void => resolve();
	if (signal.aborted) resolve();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const winner = await Promise.race([
			Promise.all([stdoutP, stderrP, proc.exited]).then(([stdout, stderr, exitCode]) => ({
				kind: "done" as const,
				stdout,
				stderr,
				exitCode,
			})),
			aborted.then(() => ({ kind: "aborted" as const })),
		]);
		if (winner.kind === "aborted") {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already exited
			}
			await proc.exited;
			throw abortError(signal);
		}
		return { stdout: winner.stdout, stderr: winner.stderr, exitCode: winner.exitCode };
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function isAfmModelNotReady(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /\bmodelNotReady\b/.test(text);
}

/** Only explicit permanent availability reports disable AFM for later titles. */
const AFM_TERMINAL_AVAILABILITY: Record<string, true> = {
	deviceNotEligible: true,
	appleIntelligenceNotEnabled: true,
	unsupported_os: true,
	unavailable: true,
};

export function isAfmRequestScopedFailure(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	const prefix = "apple_fm_failed: ";
	const reason = text.startsWith(prefix) ? text.slice(prefix.length) : text;
	return AFM_TERMINAL_AVAILABILITY[reason] !== true;
}

function mapSidecarInstallError(error: unknown): unknown {
	if (error instanceof LockAcquireError) return new Error("apple_fm_busy: sidecar install lock");
	return error;
}

function sidecarCacheDir(): string {
	return path.join(getTinyModelsCacheDir(), "apple-fm");
}

function swiftTargetTriple(): string {
	const arch = process.arch === "x64" ? "x86_64" : process.arch;
	return `${arch}-apple-macosx26.0`;
}

function cacheIdentity(): string {
	return Bun.hash(`${sidecarSource}\0${swiftTargetTriple()}`).toString(16);
}

const BUNDLED_SIDECARS: Record<string, { file: string; identity: string }> = {
	"arm64-apple-macosx26.0": { file: bundledArm64Sidecar, identity: bundledArm64Identity.trim() },
};

/** Resolve a Bun file-loader value without treating a cwd-relative emit as cwd. */
export function resolveBundledSidecarPath(assetPath: string, moduleDir: string = import.meta.dir): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(moduleDir, assetPath);
}

async function bundledSidecarPath(): Promise<string | undefined> {
	const bundled = BUNDLED_SIDECARS[swiftTargetTriple()];
	if (!bundled || bundled.identity !== cacheIdentity()) return undefined;
	const file = resolveBundledSidecarPath(bundled.file);
	return (await Bun.file(file).exists()) ? file : undefined;
}

async function publishSidecar(srcPath: string, destPath: string): Promise<void> {
	const tmpPath = `${destPath}.${process.pid}.copy`;
	const bytes = await Bun.file(srcPath).arrayBuffer();
	if (bytes.byteLength === 0) {
		throw new Error(`bundled AFM sidecar is empty: ${srcPath}`);
	}
	await Bun.write(tmpPath, bytes);
	await fs.promises.chmod(tmpPath, 0o755);
	await fs.promises.rename(tmpPath, destPath);
}

async function compileSidecar(srcPath: string, binPath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const target = swiftTargetTriple();
	const proc = Bun.spawn({
		cmd: ["xcrun", "--sdk", "macosx", "swiftc", "-O", "-parse-as-library", "-target", target, "-o", binPath, srcPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const { stderr, exitCode } = await settleSpawn(proc, signal);
	if (exitCode !== 0) {
		const detail = stderr.trim();
		throw new Error(
			detail
				? `failed to compile Apple Foundation Models sidecar: ${detail}`
				: "failed to compile Apple Foundation Models sidecar (xcrun swiftc)",
		);
	}
	await fs.promises.chmod(binPath, 0o755);
}

/** Locked cache install. Published helper is named for cacheIdentity. */
async function installAfmSidecar(
	dir: string,
	signal?: AbortSignal,
	resolveBundledSidecar: () => Promise<string | undefined> = bundledSidecarPath,
	identity: string = cacheIdentity(),
): Promise<string> {
	await fs.promises.mkdir(dir, { recursive: true });
	const srcPath = path.join(dir, `sidecar-${identity}.swift`);
	const binPath = path.join(dir, `omp-apple-fm-${identity}`);

	return await withFileLock(
		binPath,
		async () => {
			throwIfAborted(signal);
			if (await Bun.file(binPath).exists()) return binPath;
			throwIfAborted(signal);
			const bundled = await resolveBundledSidecar();
			const tmpPath = path.join(dir, `omp-apple-fm.${process.pid}.${identity}.tmp`);
			try {
				if (bundled) {
					await publishSidecar(bundled, binPath);
				} else {
					await Bun.write(srcPath, sidecarSource);
					await compileSidecar(srcPath, tmpPath, signal);
					await fs.promises.rename(tmpPath, binPath);
				}
			} catch (error) {
				await fs.promises.rm(tmpPath, { force: true });
				await fs.promises.rm(srcPath, { force: true });
				await fs.promises.rm(`${binPath}.${process.pid}.copy`, { force: true });
				if (!bundled) {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}. afm-core needs the bundled Apple Silicon sidecar or Xcode/CLT to compile one.`,
					);
				}
				throw error;
			}
			return binPath;
		},
		{ retries: 120, retryDelayMs: 250, signal },
	);
}

/**
 * Resolve a runnable sidecar. Env override wins (tests / prebuilt). Otherwise
 * compile the bundled Swift into the tiny-models cache on first use.
 * Compile is locked and published by rename onto an identity-specific path
 * so two omp processes cannot publish a half-linked binary, and a later
 * install for a different identity cannot overwrite a path already returned.
 */
export async function ensureAfmSidecar(signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const override = sidecarOverride();
	if (override) {
		if (!(await Bun.file(override).exists())) {
			throw new Error(`OMP_APPLE_FM_SIDECAR does not exist: ${override}`);
		}
		return override;
	}
	if (process.platform !== "darwin") {
		throw new Error("Apple Foundation Models is macOS-only");
	}
	if (!darwinMeetsAfmRuntime()) {
		throw new Error("unsupported_os");
	}

	try {
		return await installAfmSidecar(sidecarCacheDir(), signal);
	} catch (error) {
		throw mapSidecarInstallError(error);
	}
}

async function runSidecar(args: string[], stdin?: string, signal?: AbortSignal): Promise<SidecarPayload> {
	throwIfAborted(signal);
	const bin = await ensureAfmSidecar(signal);
	throwIfAborted(signal);
	const proc = Bun.spawn({
		cmd: [bin, ...args],
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const { stdout, stderr, exitCode } = await settleSpawn(proc, signal);
	const line = stdout
		.split(/\r?\n/)
		.map(entry => entry.trim())
		.find(entry => entry.startsWith("{"));
	if (!line) {
		const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
		throw new Error(`Apple Foundation Models sidecar returned no JSON: ${detail}`);
	}
	let payload: SidecarPayload;
	try {
		payload = JSON.parse(line) as SidecarPayload;
	} catch {
		throw new Error(`Apple Foundation Models sidecar returned invalid JSON: ${line}`);
	}
	if (payload.error) {
		throw new Error(payload.reason ? `${payload.error}: ${payload.reason}` : payload.error);
	}
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `Apple Foundation Models sidecar exited ${exitCode}`);
	}
	return payload;
}

export async function probeAfmCore(signal?: AbortSignal): Promise<AfmStatus> {
	const payload = await runSidecar(["status"], undefined, signal);
	return {
		available: payload.available === true,
		reason: payload.reason,
		contextSize: typeof payload.contextSize === "number" ? payload.contextSize : undefined,
	};
}

export async function completeAfmCore(input: {
	instructions?: string;
	prompt: string;
	maxTokens?: number;
	signal?: AbortSignal;
}): Promise<string> {
	const payload = await runSidecar(
		["complete"],
		JSON.stringify({
			instructions: input.instructions ?? "",
			prompt: input.prompt,
			...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
		}),
		input.signal,
	);
	const text = payload.text?.trim() ?? "";
	if (!text) throw new Error("Apple Foundation Models sidecar returned empty text");
	return text;
}

/** Test-only. Not part of the supported module API. */
export const __internalsForTesting = {
	darwinMeetsAfmRuntime,
	mapSidecarInstallError,
	cacheIdentity,
	installAfmSidecar,
};
