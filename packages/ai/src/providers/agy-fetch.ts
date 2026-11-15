import * as fs from "node:fs";
import * as path from "node:path";
import { extractEmbeddedAddons, prepareNativeVersionDir } from "@oh-my-pi/pi-natives/loader-state";
import { getNativesDir } from "@oh-my-pi/pi-utils/dirs";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import type { FetchImpl } from "@oh-my-pi/pi-utils/tls-fetch";
import profile from "./agy-transport/profile.json" with { type: "json" };
import { embeddedAgyTransport } from "./agy-embedded";

export interface AgyFetchOptions {
	/** Built transport helper; defaults to PI_AI_AGY_TRANSPORT or this package's dist executable. */
	executable?: string;
	/** Optional measured TLS record override; defaults to the embedded 1.5.9 consumer profile. */
	clientHello?: string;
	/** Additional trusted CA bundle. Certificate verification is never disabled. */
	ca?: string;
	/** Override the measured account/profile-specific CLI User-Agent. */
	userAgent?: string;
	/** Explicit quota/billing project, distinct from the CCPA project in OAuth credentials. */
	quotaProject?: string;
}

/** Signals that the transport returns one already-resumed CCPA response stream. */
export type AgyFetch = FetchImpl & { readonly handlesGoogleContinuations: true };

export interface AgyFetchHandle {
	fetch: AgyFetch;
	close(): Promise<void>;
}

function defaultExecutable(): string {
	if (embeddedAgyTransport) {
		const directory = path.join(getNativesDir(), "agy", embeddedAgyTransport.sha256);
		prepareNativeVersionDir(directory);
		extractEmbeddedAddons({
			targetDir: directory,
			files: [{ ...embeddedAgyTransport, variant: "default" }],
		});
		return path.join(directory, embeddedAgyTransport.filename);
	}
	return path.resolve(
		isCompiledBinary() ? path.dirname(process.execPath) : path.resolve(import.meta.dir, "../../dist"),
		`agy-transport${process.platform === "win32" ? ".exe" : ""}`,
	);
}

export function getAgyUserAgent(): string {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	return `antigravity/cli/${profile.version} (aidev_client; os_type=${platform}; arch=${arch}; cl=${profile.changelist}; auth_method=consumer)`;
}

export function getAgyHeaders(): { "User-Agent": string; "Accept-Encoding": string } {
	return { "User-Agent": getAgyUserAgent(), "Accept-Encoding": "gzip" };
}

let defaultTransport: Promise<AgyFetchHandle> | undefined;

/** Shared native transport for built-in requests; initialization is single-flight. */
export const agyFetch: AgyFetch = Object.assign<FetchImpl, { handlesGoogleContinuations: true }>(
	async (input, init) => {
		if (!defaultTransport) {
			const pending = createAgyFetch().catch(error => {
				if (defaultTransport === pending) defaultTransport = undefined;
				throw error;
			});
			defaultTransport = pending;
		}
		return (await defaultTransport).fetch(input, init);
	},
	{ handlesGoogleContinuations: true },
);

export async function closeDefaultAgyFetch(): Promise<void> {
	const pending = defaultTransport;
	defaultTransport = undefined;
	if (pending) await (await pending).close();
}

/**
 * A persistent, pooled HTTP/1.1 transport with a capture-derived TLS ClientHello.
 * Owns no OAuth credentials and never fabricates attestation. Pass fetch to the
 * provider's existing fetch option; close after every response body is consumed.
 */
export async function createAgyFetch(options: AgyFetchOptions = {}): Promise<AgyFetchHandle> {
	const executable = options.executable ?? process.env.PI_AI_AGY_TRANSPORT ?? defaultExecutable();
	const args = [executable];
	if (options.clientHello) args.push("--client-hello", options.clientHello);
	const ca = options.ca ?? process.env.NODE_EXTRA_CA_CERTS;
	if (ca) args.push("--ca", ca);
	if (options.userAgent) args.push("--user-agent", options.userAgent);
	if (options.quotaProject) args.push("--quota-project", options.quotaProject);

	// A drained stderr pipe still pins Bun's event loop after child.unref().
	// Capture to a file instead, and read a bounded diagnostic tail only on exit.
	const diagnostics = await TempDir.create("@omp-agy-transport-");
	const stderrPath = diagnostics.join("stderr.log");
	const stderr = Bun.file(stderrPath);
	let child: Bun.Subprocess<"pipe", "pipe", number>;
	try {
		const fd = fs.openSync(stderrPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
		try {
			child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: fd });
		} finally {
			// spawn duplicates the descriptor; the parent must not retain its copy.
			fs.closeSync(fd);
		}
	} catch (error) {
		await diagnostics.remove();
		throw new Error(
			`Unable to start AGY transport ${executable}. Build it with bun run build:agy-transport in packages/ai, or set PI_AI_AGY_TRANSPORT.`,
			{ cause: error },
		);
	}
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let exitDetail = "";
	const kill = (): void => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {
			// The subprocess can exit between the status check and the signal.
		}
	};
	const cleanupOnExit = (): void => {
		kill();
		try {
			diagnostics.removeSync();
		} catch {
			// Windows can retain the child's file handle during process teardown.
		}
	};
	process.once("exit", cleanupOnExit);
	const exited = child.exited.then(async code => {
		let detail = "";
		try {
			detail = (await stderr.slice(-64 * 1024).text()).trim();
		} catch {
			// A spawn failure may not have created the diagnostic file.
		}
		exitDetail = ` (${child.signalCode ?? `code ${code}`})${detail ? `: ${detail}` : ""}`;
		try {
			await child.stdin.end();
		} catch {
			// The child or close() may already have closed the pipe.
		}
		await diagnostics.remove().catch(() => {});
		process.off("exit", cleanupOnExit);
	});
	const reader = child.stdout.getReader();
	let ready: { port: number; token: string };
	const timeout = setTimeout(kill, 15_000);
	try {
		const decoder = new TextDecoder();
		let line = "";
		while (!line.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("AGY transport exited before ready");
			line += decoder.decode(chunk.value, { stream: true });
			if (line.length > 4096) throw new Error("AGY transport ready message exceeds 4096 bytes");
		}
		const parsed: unknown = JSON.parse(line.slice(0, line.indexOf("\n")));
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("port" in parsed) ||
			!("token" in parsed) ||
			typeof parsed.port !== "number" ||
			!Number.isInteger(parsed.port) ||
			parsed.port < 1 ||
			parsed.port > 65535 ||
			typeof parsed.token !== "string" ||
			!/^[a-f0-9]{64}$/.test(parsed.token)
		) {
			throw new Error("Invalid AGY transport ready message");
		}
		ready = { port: parsed.port, token: parsed.token };
	} catch (error) {
		kill();
		await exited;
		throw new Error(`${error instanceof Error ? error.message : String(error)}${exitDetail}`, { cause: error });
	} finally {
		clearTimeout(timeout);
		// Stdout is a one-message handshake, not a lifetime pipe. Releasing the
		// reader lock alone leaves the descriptor open and keeps the host alive.
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	child.stdin.unref();
	child.unref();
	const transportFetch: FetchImpl = async (input, init) => {
		if (closed) throw new Error("AGY transport is closed");
		if (child.exitCode !== null || child.signalCode !== null) {
			await exited;
			throw new Error(`AGY transport exited${exitDetail}`);
		}
		if (init && "proxy" in init && init.proxy !== undefined) {
			throw new Error(
				"AGY transport does not support per-request proxies; use HTTPS_PROXY/NO_PROXY or an explicit fetch override",
			);
		}
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		const target = new URL(request.url);
		if (target.protocol !== "https:") throw new Error("AGY transport requires an HTTPS target");
		const headers = [...request.headers.entries()];
		let response: Response;
		try {
			response = await fetch(`http://127.0.0.1:${ready.port}/`, {
				method: request.method,
				headers: {
					"X-AGY-Bridge-Token": ready.token,
					"X-AGY-Bridge-Target": target.href,
					"X-AGY-Bridge-Headers": JSON.stringify(headers),
				},
				body: request.body === null ? undefined : await request.arrayBuffer(),
				signal: request.signal,
				redirect: "manual",
				proxy: "",
				timeout: false,
			});
		} catch (error) {
			if (!request.signal.aborted && (child.exitCode !== null || child.signalCode !== null)) {
				await exited;
				throw new Error(`AGY transport exited${exitDetail}`, { cause: error });
			}
			throw error;
		}
		if (response.headers.has("X-AGY-Bridge-Error")) {
			throw new Error(`AGY transport failed: ${await response.text()}`);
		}
		const resultHeaders = new Headers(response.headers);
		resultHeaders.delete("X-AGY-Bridge-URL");
		// Bun can expose an empty stream for these responses, but constructing a
		// Response with a stream and a null-body status throws.
		const noBody =
			request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304;
		if (noBody) await response.body?.cancel();
		const result = new Response(noBody ? null : response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: resultHeaders,
		});
		Object.defineProperty(result, "url", { value: target.href });
		return result;
	};
	return {
		fetch: Object.assign(transportFetch, { handlesGoogleContinuations: true as const }),
		close() {
			if (closePromise) return closePromise;
			closed = true;
			closePromise = (async () => {
				const timeout = setTimeout(kill, 5_000);
				try {
					try {
						await child.stdin.end();
					} catch {
						kill();
					}
					await exited;
				} finally {
					clearTimeout(timeout);
				}
			})();
			return closePromise;
		},
	};
}
