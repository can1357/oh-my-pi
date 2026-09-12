// Subpath imports: cli.ts imports this module for the smoke probe, and the
// pi-utils barrel would pull native addons into normal CLI startup.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type { Subprocess } from "bun";
import { isThenable } from "../utils/ipc";
import { replaceFileAtomically } from "../utils/atomic-file";
import { compileAppleSpeechSidecar } from "./apple-speech-compiler";
import type { SttStreamHandle, SttStreamOptions } from "./asr-client";
import SPEECH_ANALYZER_SOURCE from "./speech-analyzer.swift" with { type: "text" };

const APPLE_SPEECH_SIDECAR_OVERRIDE = "OMP_SPEECH_ANALYZER_PATH";
const EMBEDDED_SIDECAR_BASE64 = process.env.PI_APPLE_SPEECH_SIDECAR_BASE64;
/** Darwin kernel 25 is macOS 26 (Tahoe). Do not raise this to 26. */
const MINIMUM_DARWIN_MAJOR = 25;
const MAX_PENDING_AUDIO_BYTES = 16_000 * Float32Array.BYTES_PER_ELEMENT * 2;
const STDERR_DRAIN_GRACE_MS = 25;
const MAX_STDERR_CHARACTERS = 16_384;
const SIDECAR_NAME = "omp-speech-analyzer";

type SpeechSubprocess = Subprocess<"pipe", "pipe", "pipe">;
type ExecutableResolver = () => Promise<string>;

/** Availability and system-managed locale-asset state reported by the native helper. */
export interface AppleSpeechStatus {
	success: boolean;
	available: boolean;
	supported: boolean;
	installed: boolean;
	locale?: string;
	displayName: string;
	systemManaged: boolean;
	error?: string;
}

interface StreamEvent {
	type: "ready" | "partial" | "segment" | "done" | "error";
	text?: string;
	index?: number;
	locale?: string;
	error?: string;
}

let resolvedExecutable: Promise<string> | null = null;

function unavailableStatus(error: unknown): AppleSpeechStatus {
	return {
		success: false,
		available: false,
		supported: false,
		installed: false,
		displayName: "Apple SpeechAnalyzer",
		systemManaged: true,
		error: error instanceof Error ? error.message : String(error),
	};
}

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function normalizeLocale(locale: string | undefined): string {
	return locale?.trim() || "auto";
}

function isMacos26OrLater(): boolean {
	if (process.platform !== "darwin") return false;
	const major = Number.parseInt(os.release().split(".", 1)[0] ?? "", 10);
	return Number.isFinite(major) && major >= MINIMUM_DARWIN_MAJOR;
}

async function executableExists(file: string): Promise<boolean> {
	try {
		await fs.access(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function stageExecutable(bytes: Uint8Array): Promise<string> {
	const directory = path.join(getTinyModelsCacheDir(), "speech-analyzer");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const target = path.join(directory, `${SIDECAR_NAME}-${sha256(bytes).slice(0, 20)}`);
	if (await executableExists(target)) return target;

	const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporary, bytes);
		await fs.chmod(temporary, 0o700);
		await replaceFileAtomically(temporary, target);
		await fs.chmod(target, 0o700);
		return target;
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

async function readPackagedSidecar(): Promise<Uint8Array | null> {
	const filename = `${SIDECAR_NAME}-${process.arch}`;
	const candidates = [path.join(import.meta.dir, filename), path.join(import.meta.dir, "..", "..", "dist", filename)];
	for (const candidate of candidates) {
		try {
			const bytes = await Bun.file(candidate).bytes();
			if (bytes.byteLength > 0) return bytes;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return null;
}

async function compileSidecar(): Promise<string> {
	if (process.arch !== "arm64" && process.arch !== "x64") {
		throw new Error(`Apple SpeechAnalyzer does not support ${process.arch} macOS.`);
	}
	const directory = path.join(getTinyModelsCacheDir(), "speech-analyzer");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const identity = sha256(`${process.arch}\0${SPEECH_ANALYZER_SOURCE}`).slice(0, 20);
	const source = path.join(directory, `${SIDECAR_NAME}-${identity}.swift`);
	const target = path.join(directory, `${SIDECAR_NAME}-${identity}`);
	if (await executableExists(target)) return target;
	await Bun.write(source, SPEECH_ANALYZER_SOURCE);

	const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await compileAppleSpeechSidecar({
			architecture: process.arch,
			outputPath: temporary,
			sourcePath: source,
		});
		await replaceFileAtomically(temporary, target);
		await fs.chmod(target, 0o700);
		return target;
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

async function resolveAppleSpeechExecutable(): Promise<string> {
	const override = process.env[APPLE_SPEECH_SIDECAR_OVERRIDE];
	if (override) return override;
	if (!isMacos26OrLater()) {
		throw new Error("Apple SpeechAnalyzer requires macOS 26 or later.");
	}

	const packaged = await readPackagedSidecar();
	if (packaged) return await stageExecutable(packaged);
	if (EMBEDDED_SIDECAR_BASE64) {
		return await stageExecutable(Buffer.from(EMBEDDED_SIDECAR_BASE64, "base64"));
	}
	return await compileSidecar();
}

function defaultExecutableResolver(): Promise<string> {
	resolvedExecutable ??= resolveAppleSpeechExecutable().catch((error: unknown) => {
		resolvedExecutable = null;
		throw error;
	});
	return resolvedExecutable;
}

function parseStatus(value: unknown): AppleSpeechStatus {
	if (typeof value !== "object" || value === null)
		throw new Error("Apple SpeechAnalyzer returned invalid status JSON.");
	const status = value as Record<string, unknown>;
	for (const key of ["success", "available", "supported", "installed", "system_managed"] as const) {
		if (typeof status[key] !== "boolean") throw new Error(`Apple SpeechAnalyzer status omitted ${key}.`);
	}
	if (typeof status.display_name !== "string") {
		throw new Error("Apple SpeechAnalyzer status omitted display_name.");
	}
	if (status.locale !== undefined && status.locale !== null && typeof status.locale !== "string") {
		throw new Error("Apple SpeechAnalyzer returned an invalid locale.");
	}
	if (status.error !== undefined && status.error !== null && typeof status.error !== "string") {
		throw new Error("Apple SpeechAnalyzer returned an invalid error.");
	}
	return {
		success: status.success as boolean,
		available: status.available as boolean,
		supported: status.supported as boolean,
		installed: status.installed as boolean,
		...(typeof status.locale === "string" ? { locale: status.locale } : {}),
		displayName: status.display_name,
		systemManaged: status.system_managed as boolean,
		...(typeof status.error === "string" ? { error: status.error } : {}),
	};
}

function parseStreamEvent(value: unknown): StreamEvent {
	if (typeof value !== "object" || value === null)
		throw new Error("Apple SpeechAnalyzer returned invalid stream JSON.");
	const event = value as Record<string, unknown>;
	if (
		event.type !== "ready" &&
		event.type !== "partial" &&
		event.type !== "segment" &&
		event.type !== "done" &&
		event.type !== "error"
	) {
		throw new Error("Apple SpeechAnalyzer returned an unknown stream event.");
	}
	if (event.text !== undefined && event.text !== null && typeof event.text !== "string") {
		throw new Error("Apple SpeechAnalyzer returned invalid transcript text.");
	}
	if (event.index !== undefined && event.index !== null && typeof event.index !== "number") {
		throw new Error("Apple SpeechAnalyzer returned an invalid segment index.");
	}
	if (event.locale !== undefined && event.locale !== null && typeof event.locale !== "string") {
		throw new Error("Apple SpeechAnalyzer returned an invalid stream locale.");
	}
	if (event.error !== undefined && event.error !== null && typeof event.error !== "string") {
		throw new Error("Apple SpeechAnalyzer returned an invalid stream error.");
	}
	return {
		type: event.type,
		...(typeof event.text === "string" ? { text: event.text } : {}),
		...(typeof event.index === "number" ? { index: event.index } : {}),
		...(typeof event.locale === "string" ? { locale: event.locale } : {}),
		...(typeof event.error === "string" ? { error: event.error } : {}),
	};
}

function terminateProcess(proc: SpeechSubprocess): void {
	try {
		proc.stdin.end();
	} catch {
		// Already closed.
	}
	try {
		proc.kill();
	} catch {
		// Already exited.
	}
}

/** Process client for Apple SpeechAnalyzer status, asset preparation, and live transcription. */
export class AppleSpeechClient {
	readonly #resolveExecutable: ExecutableResolver;

	constructor(resolveExecutable: ExecutableResolver = defaultExecutableResolver) {
		this.#resolveExecutable = resolveExecutable;
	}

	/**
	 * Probe native availability without installing assets. Unavailability is
	 * returned as status; caller-requested cancellation rejects.
	 */
	async status(locale?: string, signal?: AbortSignal): Promise<AppleSpeechStatus> {
		try {
			return await this.#runStatus("status", locale, signal);
		} catch (error) {
			if (signal?.aborted) signal.throwIfAborted();
			if (error instanceof Error && error.name === "AbortError") throw error;
			return unavailableStatus(error);
		}
	}

	/** Prepare the locale's system asset, rejecting on unavailability or cancellation. */
	async prepare(locale?: string, signal?: AbortSignal): Promise<AppleSpeechStatus> {
		const status = await this.#runStatus("prepare", locale, signal);
		if (!status.success || !status.available || !status.supported || !status.installed) {
			throw new Error(status.error ?? "Apple SpeechAnalyzer could not prepare its system-managed speech asset.");
		}
		return status;
	}

	async #runStatus(command: "status" | "prepare", locale?: string, signal?: AbortSignal): Promise<AppleSpeechStatus> {
		signal?.throwIfAborted();
		const executable = await this.#resolveExecutable();
		signal?.throwIfAborted();
		const proc = Bun.spawn([executable, command, normalizeLocale(locale)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		] as const);
		let output: [number, string, string];
		if (signal) {
			const aborted = Promise.withResolvers<never>();
			const abort = (): void => {
				try {
					proc.kill();
				} catch {
					// Already exited.
				}
				aborted.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			try {
				output = await Promise.race([result, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", abort);
			}
			signal.throwIfAborted();
		} else {
			output = await result;
		}
		const [exitCode, stdout, stderr] = output;
		const line = stdout
			.split("\n")
			.map(value => value.trim())
			.findLast(Boolean);
		if (!line) throw new Error(stderr.trim() || `Apple SpeechAnalyzer ${command} exited ${exitCode}.`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Apple SpeechAnalyzer ${command} returned malformed JSON.`);
		}
		const status = parseStatus(parsed);
		if (exitCode !== 0 && status.success) {
			throw new Error(stderr.trim() || `Apple SpeechAnalyzer ${command} exited ${exitCode}.`);
		}
		return status;
	}

	/** Start a stream and resolve only after the native helper's ready handshake. */
	async startStream(locale: string | undefined, options: SttStreamOptions = {}): Promise<SttStreamHandle> {
		options.signal?.throwIfAborted();
		const executable = await this.#resolveExecutable();
		options.signal?.throwIfAborted();
		const proc = Bun.spawn([executable, "stream", normalizeLocale(locale)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		return await this.#connectStream(proc, options);
	}

	async #connectStream(proc: SpeechSubprocess, options: SttStreamOptions): Promise<SttStreamHandle> {
		const ready = Promise.withResolvers<void>();
		const done = Promise.withResolvers<string>();
		void done.promise.catch(() => {});
		const decoder = new TextDecoder();
		const stdoutAbort = new AbortController();
		const pendingWrites = new Set<Promise<void>>();
		let pendingAudioBytes = 0;
		const collectedSegments: string[] = [];
		let lastPartial = "";
		let readySeen = false;
		let settled = false;
		let closing = false;

		const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
		const stderrDecoder = new TextDecoder();
		let stderr = "";
		let stderrFinished = false;
		const stderrDone = (async () => {
			try {
				for (;;) {
					const chunk = await stderrReader.read();
					if (chunk.done) break;
					const text = stderrDecoder.decode(chunk.value, { stream: true });
					if (stderr.length < MAX_STDERR_CHARACTERS) {
						stderr += text.slice(0, MAX_STDERR_CHARACTERS - stderr.length);
					}
				}
				if (stderr.length < MAX_STDERR_CHARACTERS) {
					stderr += stderrDecoder.decode().slice(0, MAX_STDERR_CHARACTERS - stderr.length);
				}
			} finally {
				stderrFinished = true;
				stderrReader.releaseLock();
			}
		})().catch(error => {
			logger.debug("stt: Apple SpeechAnalyzer stderr read failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (!readySeen) ready.reject(normalized);
			done.reject(normalized);
			terminateProcess(proc);
		};
		const finish = (text: string): void => {
			if (settled) return;
			settled = true;
			if (!readySeen) ready.resolve();
			done.resolve(text);
		};
		const abort = (): void => {
			fail(options.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		void done.promise.then(
			() => options.signal?.removeEventListener("abort", abort),
			() => options.signal?.removeEventListener("abort", abort),
		);

		void (async () => {
			for await (const bytes of readLines(proc.stdout as ReadableStream<Uint8Array>, stdoutAbort.signal)) {
				const line = decoder.decode(bytes).trim();
				if (!line) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					throw new Error("Apple SpeechAnalyzer stream returned malformed JSON.");
				}
				const event = parseStreamEvent(parsed);
				switch (event.type) {
					case "ready":
						if (!readySeen) {
							readySeen = true;
							ready.resolve();
						}
						break;
					case "partial":
						if (!settled && event.text !== undefined) {
							lastPartial = event.text;
							options.onPartial?.(event.text);
						}
						break;
					case "segment":
						if (!settled && event.text !== undefined) {
							collectedSegments.push(event.text);
							lastPartial = "";
							options.onSegment?.(event.text, event.index ?? collectedSegments.length - 1);
						}
						break;
					case "done":
						finish(event.text ?? (collectedSegments.join(" ") || lastPartial));
						break;
					case "error":
						fail(new Error(event.error ?? "Apple SpeechAnalyzer stream failed."));
						break;
				}
			}
			if (!settled) {
				const exitCode = await Promise.race([proc.exited, Bun.sleep(STDERR_DRAIN_GRACE_MS).then(() => null)]);
				// A null exitCode means stdout closed before the process settled:
				// leave the stream unresolved so the `proc.exited` handler below
				// reports the eventual outcome instead of masking a later failure
				// as a partial success.
				if (!settled && exitCode !== null) {
					if (exitCode === 0) {
						finish(collectedSegments.join(" ") || lastPartial);
					} else {
						fail(new Error(`Apple SpeechAnalyzer exited before completing (code ${exitCode}).`));
					}
				}
			}
		})().catch(fail);

		void proc.exited
			.then(async exitCode => {
				await Promise.race([stderrDone, Bun.sleep(STDERR_DRAIN_GRACE_MS)]);
				const error = stderr.trim();
				if (!settled) {
					if (exitCode === 0 || exitCode === null) {
						finish(collectedSegments.join(" ") || lastPartial);
					} else {
						fail(new Error(error || `Apple SpeechAnalyzer exited before completing (code ${exitCode}).`));
					}
				} else if (exitCode !== 0 && error) {
					logger.debug("stt: Apple SpeechAnalyzer stderr", { exitCode, error });
				}
				stdoutAbort.abort();
				if (!stderrFinished) {
					await stderrReader.cancel().catch(() => {});
				}
			})
			.catch(fail);

		const trackBackpressure = (result: unknown, byteLength: number): void => {
			if (!isThenable(result)) return;
			pendingAudioBytes += byteLength;
			const pending = Promise.resolve(result)
				.then(() => {})
				.catch(fail)
				.finally(() => {
					pendingAudioBytes -= byteLength;
					pendingWrites.delete(pending);
				});
			pendingWrites.add(pending);
		};

		const handle: SttStreamHandle = {
			pushAudio: audio => {
				if (settled || closing || audio.byteLength === 0) return;
				if (pendingAudioBytes + audio.byteLength > MAX_PENDING_AUDIO_BYTES) {
					fail(new Error("Apple SpeechAnalyzer fell more than two seconds behind microphone capture."));
					return;
				}
				try {
					const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
					const write = proc.stdin.write(bytes);
					const flush = proc.stdin.flush();
					if (isThenable(write)) {
						trackBackpressure(write, audio.byteLength);
						trackBackpressure(flush, 0);
					} else {
						trackBackpressure(flush, audio.byteLength);
					}
				} catch (error) {
					fail(error);
				}
			},
			stop: async () => {
				if (!closing && !settled) {
					closing = true;
					await Promise.all([...pendingWrites]);
					try {
						proc.stdin.end();
					} catch (error) {
						fail(error);
					}
				}
				return await done.promise;
			},
			cancel: () => {
				if (settled) return;
				settled = true;
				if (!readySeen) ready.reject(new DOMException("The operation was aborted.", "AbortError"));
				done.resolve("");
				terminateProcess(proc);
			},
		};

		await ready.promise;
		return handle;
	}
}

/** Shared process client used by the STT controller and setup flows. */
export const appleSpeechClient = new AppleSpeechClient();

/** Probe the packaged native helper on supported macOS hosts during distribution smoke tests. */
export async function smokeTestAppleSpeechSidecar(): Promise<void> {
	if (!isMacos26OrLater()) return;
	const status = await appleSpeechClient.status("auto");
	if (!status.success) throw new Error(status.error ?? "Apple SpeechAnalyzer status probe failed.");
}
