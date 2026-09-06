/**
 * Exposure backends for the blob broker: make the loopback blob server
 * reachable by provider-side image fetchers.
 *
 * Every adapter resolves to a public base URL. Tunnel adapters own a child
 * process whose exit is observable via {@link ActiveExposure.exited} so the
 * broker can stop advertising URLs the moment the tunnel dies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { $which, getSafeProjectCwd, logger, TempDir } from "@oh-my-pi/pi-utils";
import { credentialString, type DestinationRuntimeConfig, optionString } from "./uploader-runtime";

/** User-selectable exposure strategy. */
export type ExposureKind =
	| "cloudflared"
	| "ngrok"
	| "tailscale"
	| "ssh"
	| "direct"
	| "localhost-run"
	| "pinggy"
	| "devtunnel"
	| "zrok"
	| "bore"
	| "named-cloudflared";

export interface ExposureConfig {
	kind: ExposureKind;
	/**
	 * Externally reachable base URL. Required for `ssh` (the remote web server
	 * fronting the forwarded port); optional for `direct`, which otherwise
	 * advertises the bind address itself (LAN / same-host use).
	 */
	publicBaseUrl?: string;
	/** Blob server bind host. Loopback for tunnels; `0.0.0.0` for direct serving. */
	bindHost: string;
	/** `user@host[:port]` destination for the ssh reverse forward. */
	sshTarget?: string;
	/** Remote listen port of the ssh reverse forward. */
	sshRemotePort?: number;
	/** Destination-specific non-secret tunnel settings. */
	options: DestinationRuntimeConfig["options"];
	/** Destination credentials. Values must never be included in logs or errors. */
	credentials: DestinationRuntimeConfig["credentials"];
}

/** Live exposure of one local port. */
export interface ActiveExposure {
	readonly kind: ExposureKind;
	/** Public origin (no trailing slash) that reaches the local blob server. */
	readonly baseUrl: string;
	/** Resolves when the tunnel child exits; `null` for processless kinds. */
	readonly exited: Promise<void> | null;
	stop(): void;
}

const READY_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/.well-known/omp-blob-health";
const DEFAULT_HEALTH_ATTEMPTS = 5;
const MAX_HEALTH_ATTEMPTS = 10;
const DEFAULT_HEALTH_BACKOFF_MS = 250;
const MAX_HEALTH_BACKOFF_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const MAX_HEALTH_TIMEOUT_MS = 30_000;

/** Retry and timeout limits for an exposure edge-to-origin health probe. */
export interface ExposureHealthProbeOptions {
	/** Maximum fetch attempts before the exposure is rejected. */
	attempts?: number;
	/** Delay between attempts, in milliseconds. */
	backoffMs?: number;
	/** Per-attempt fetch timeout, in milliseconds. */
	timeoutMs?: number;
}

/** ssh prints nothing on success; alive past this grace period means forwarded. */
const SSH_READY_GRACE_MS = 1_500;

/** First `https://<sub>.trycloudflare.com` origin in a cloudflared log line. */
export function parseCloudflaredUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null;
}

/** Public URL from an ngrok `--log-format json` line (`started tunnel`). */
export function parseNgrokUrl(line: string): string | null {
	if (!line.includes('"url"')) return null;
	try {
		const parsed = JSON.parse(line) as { msg?: string; url?: string };
		if (typeof parsed.url === "string" && parsed.url.startsWith("https://")) return parsed.url;
	} catch {
		// Interleaved non-JSON output; keep scanning.
	}
	return null;
}

/** Funnel URL from `tailscale funnel` foreground output. */
export function parseTailscaleUrl(line: string): string | null {
	const match = /https:\/\/[a-z0-9.-]+\.ts\.net[^\s|]*/.exec(line);
	return match ? match[0].replace(/\/+$/, "") : null;
}

/** Registered localhost.run TLS origin from its JSON or text output. */
export function parseLocalhostRunUrl(line: string): string | null {
	if (line.includes('"domain"')) {
		try {
			const parsed = JSON.parse(line) as { type?: string; domain?: string };
			if (
				parsed.type === "registered" &&
				typeof parsed.domain === "string" &&
				/^[a-z0-9-]+\.(?:lhr\.life|lhr\.rocks|localhost\.run)$/i.test(parsed.domain)
			) {
				return `https://${parsed.domain.toLowerCase()}`;
			}
		} catch {
			// localhost.run may interleave its JSON events with SSH diagnostics.
		}
	}
	return /https:\/\/[a-z0-9-]+\.(?:lhr\.life|lhr\.rocks|localhost\.run)/i.exec(line)?.[0] ?? null;
}

/** Public HTTPS origin printed by Pinggy's SSH endpoint. */
export function parsePinggyUrl(line: string): string | null {
	return (
		/https:\/\/[a-z0-9-]+\.(?:a\.pinggy\.link|free\.pinggy\.link|pinggy\.link|pinggy\.online)/i.exec(line)?.[0] ??
		null
	);
}

/** Public HTTPS origin printed by `devtunnel host`. */
export function parseDevtunnelUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+-\d+\.[a-z0-9.-]+\.devtunnels\.ms/i.exec(line)?.[0] ?? null;
}

/** Public frontend origin printed by `zrok share public`. */
export function parseZrokUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+\.share\.zrok\.io/i.exec(line)?.[0] ?? null;
}

/** HTTP origin constructed from the host and port reported by `bore local`. */
export function parseBoreUrl(line: string, fallbackHost?: string): string | null {
	const match = /listening at (?:(?<host>[a-z0-9.-]+):)?(?<port>\d+)/i.exec(line);
	const host = match?.groups?.host ?? fallbackHost;
	const port = match?.groups?.port;
	return host && port ? `http://${host}:${port}` : null;
}

function requireBinary(name: string): string {
	const path = $which(name);
	if (!path) {
		throw new Error(`imageUrls exposure "${name}" requires the ${name} binary on PATH`);
	}
	return path;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(0, Math.floor(value)));
}

/**
 * Verify that a public exposure reaches the local blob origin.
 *
 * Each request is cache-busted and time-bounded. Only the broker health
 * endpoint's exact 204 response is accepted; errors expose only the sanitized
 * destination origin and final status.
 */
export async function probeExposureHealth(
	baseUrl: string,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	options: ExposureHealthProbeOptions = {},
): Promise<void> {
	const attempts = Math.max(1, boundedInteger(options.attempts, DEFAULT_HEALTH_ATTEMPTS, MAX_HEALTH_ATTEMPTS));
	const backoffMs = boundedInteger(options.backoffMs, DEFAULT_HEALTH_BACKOFF_MS, MAX_HEALTH_BACKOFF_MS);
	const timeoutMs = Math.max(1, boundedInteger(options.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS));
	const healthUrl = new URL(HEALTH_PATH, `${normalizeBaseUrl(baseUrl)}/`);
	const destination = healthUrl.origin;
	let finalStatus = "request failed";

	for (let attempt = 0; attempt < attempts; attempt++) {
		healthUrl.searchParams.set("nonce", `${Date.now().toString(36)}-${attempt.toString(36)}`);
		try {
			const response = await fetchFn(healthUrl, {
				cache: "no-store",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status === 204) return;
			finalStatus = `HTTP ${response.status}`;
			try {
				await response.body?.cancel();
			} catch {
				// The response status is authoritative even if body disposal fails.
			}
		} catch (error) {
			finalStatus = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "request failed";
		}
		if (attempt + 1 < attempts && backoffMs > 0) await Bun.sleep(backoffMs);
	}

	throw new Error(`Exposure health probe for ${destination} failed with status ${finalStatus}`);
}

/**
 * SIGTERM, escalating to SIGKILL after a grace period. `tailscale funnel`
 * observably survives a bare SIGTERM mid-startup, and a leaked funnel child
 * blocks every later funnel invocation on the machine.
 */
function killTunnelProcess(proc: Bun.Subprocess): void {
	proc.kill();
	const timer = setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 2_000);
	timer.unref();
}

/**
 * Spawn a tunnel process with its output redirected to a temp log file and
 * poll the file until `extract` yields the public URL. Kills the child and
 * throws on exit, timeout, or abort.
 *
 * Deliberately avoids piped stdio: a piped subprocess with an active reader
 * spuriously settles `proc.exited` after `unref()` (observed on Bun 1.3.14,
 * exit code 143 with the process still alive), and an unconsumed pipe would
 * eventually block — or SIGPIPE-kill — the Go tunnel binaries. A file sink
 * has neither failure mode, so `exited` remains a trustworthy death signal.
 */
interface SpawnUrlTunnelOptions {
	/** Hold a scanned URL until this marker also appears in the log. */
	readyPattern?: RegExp;
	/**
	 * Accept a URL published by a child that already exited. Only supervised
	 * callers can recover a dead tunnel (their supervisor respawns it);
	 * unsupervised adapters must reject immediately so the broker falls back
	 * instead of health-probing a dead tunnel.
	 */
	recoverPostExitUrl?: boolean;
	/** Abort readiness and terminate the spawned tunnel process. */
	signal?: AbortSignal;
}

type SpawnedUrlTunnelLifecycle = "running" | "exited-after-ready";

interface SpawnedUrlTunnel {
	proc: Bun.Subprocess;
	baseUrl: string;
	lifecycle: SpawnedUrlTunnelLifecycle;
}

async function spawnUrlTunnel(
	argv: string[],
	extract: (line: string) => string | null,
	options: SpawnUrlTunnelOptions = {},
): Promise<SpawnedUrlTunnel> {
	const { readyPattern, recoverPostExitUrl = false, signal } = options;
	// A private mkdtemp directory per spawn: a name derived from time and pid
	// collides when several tunnels start in the same process concurrently.
	const logDir = await TempDir.create("@omp-blob-tunnel-");
	const logPath = logDir.join("tunnel.log");
	const removeLogBestEffort = async (): Promise<void> => {
		try {
			await logDir.remove();
		} catch (error) {
			logger.warn("blob-broker: failed to remove temporary tunnel log", { path: logDir.path(), error });
		}
	};
	const fd = fs.openSync(logPath, "w");
	let proc: Bun.Subprocess;
	try {
		try {
			proc = Bun.spawn(argv, {
				env: process.env,
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				cwd: getSafeProjectCwd(),
			});
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		await removeLogBestEffort();
		throw error;
	}
	let logCleaned: Promise<void> | undefined;
	const cleanupLogAfterExit = (): Promise<void> => {
		logCleaned ??= proc.exited.then(() => removeLogBestEffort());
		return logCleaned;
	};
	let lifecycleHandedOff = false;

	const aborted = Promise.withResolvers<void>();
	const abort = (): void => {
		killTunnelProcess(proc);
		aborted.resolve();
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();

	const deadline = Date.now() + READY_TIMEOUT_MS;
	let scanned = 0;
	let baseUrl: string | undefined;
	const scanLog = (text: string): string | undefined => {
		if (text.length > scanned && baseUrl === undefined) {
			for (const line of text.slice(scanned).split("\n")) {
				const url = extract(line);
				if (url) {
					baseUrl = normalizeBaseUrl(url);
					break;
				}
			}
			scanned = text.lastIndexOf("\n") + 1;
		}
		// The URL banner can precede edge registration (cloudflared prints the
		// hostname before any connection is live); wait for the ready marker.
		return baseUrl !== undefined && (!readyPattern || readyPattern.test(text)) ? baseUrl : undefined;
	};

	try {
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				await proc.exited;
				signal.throwIfAborted();
			}
			// Capture exit before reading so a process already dead here cannot
			// race its final log write against the readiness scan.
			const exitCode = proc.exitCode;
			let text = "";
			try {
				text = await Bun.file(logPath).text();
			} catch {
				// Log file not flushed yet; keep polling.
			}
			let readyUrl = scanLog(text);
			if (exitCode !== null || proc.exitCode !== null) {
				// exitCode may become visible after the poll's read but before the
				// child descriptor is fully drained. Read once more after exit so a
				// valid URL is not mistaken for a missing banner.
				await proc.exited;
				signal?.throwIfAborted();
				try {
					text = await Bun.file(logPath).text();
				} catch {
					// The diagnostic below remains authoritative when no log exists.
				}
				readyUrl = scanLog(text);
				if (recoverPostExitUrl && readyUrl) {
					lifecycleHandedOff = true;
					void cleanupLogAfterExit();
					return {
						proc,
						baseUrl: readyUrl,
						lifecycle: "exited-after-ready",
					};
				}
				const exitTiming = readyUrl ? "after reporting a tunnel URL" : "before reporting a tunnel URL";
				throw new Error(`${argv[0]} exited with code ${proc.exitCode} ${exitTiming}`);
			}
			if (readyUrl) {
				lifecycleHandedOff = true;
				void cleanupLogAfterExit();
				return { proc, baseUrl: readyUrl, lifecycle: "running" };
			}
			await (signal ? Promise.race([Bun.sleep(150), aborted.promise]) : Bun.sleep(150));
		}
		throw new Error(`${argv[0]} did not report a tunnel URL within ${READY_TIMEOUT_MS / 1000}s`);
	} finally {
		signal?.removeEventListener("abort", abort);
		if (!lifecycleHandedOff) {
			if (proc.exitCode === null) killTunnelProcess(proc);
			await cleanupLogAfterExit();
		}
	}
}

function processExposure(kind: ExposureKind, baseUrl: string, proc: Bun.Subprocess): ActiveExposure {
	proc.unref();
	return {
		kind,
		baseUrl,
		exited: proc.exited.then(() => undefined),
		stop: () => killTunnelProcess(proc),
	};
}

/** A supervised tunnel exiting sooner than this after (re)spawn counts as a quick exit. */
const PINGGY_QUICK_EXIT_WINDOW_MS = 5_000;
const PINGGY_RESTART_BACKOFF_MS = 250;
const PINGGY_RESTART_BACKOFF_MAX_MS = 5_000;
/** Consecutive quick exits before supervision gives up instead of respawning. */
const PINGGY_MAX_CONSECUTIVE_QUICK_EXITS = 5;

/**
 * Keep an authenticated Pinggy tunnel behind its configured stable hostname.
 * Random-hostname modes deliberately return their child exit to the broker:
 * restarting those would silently invalidate every already-published URL.
 */
async function restartingPinggyExposure(
	baseUrl: string,
	argv: string[],
	initial: SpawnedUrlTunnel,
): Promise<ActiveExposure> {
	let { proc } = initial;
	let stopping = false;
	const startup = Promise.withResolvers<void>();
	if (initial.lifecycle === "running" && proc.exitCode === null) startup.resolve();
	let restartController: AbortController | undefined;
	proc.unref();
	const exited = (async () => {
		let spawnedAt = Date.now();
		let quickExits = 0;
		while (true) {
			await proc.exited;
			if (stopping) return;
			// A persistently failing tunnel (for example rejected auth) can print
			// its URL and exit immediately, which would otherwise hot-loop this
			// supervisor: back off between respawns and give up after repeated
			// quick exits. A run that survives the window earns a fresh budget.
			if (Date.now() - spawnedAt < PINGGY_QUICK_EXIT_WINDOW_MS) {
				quickExits += 1;
				if (quickExits >= PINGGY_MAX_CONSECUTIVE_QUICK_EXITS) {
					const message = "blob-broker: authenticated Pinggy tunnel keeps exiting right after startup; giving up";
					logger.warn(message);
					startup.reject(new Error(message));
					return;
				}
				const backoff = Math.min(PINGGY_RESTART_BACKOFF_MS << (quickExits - 1), PINGGY_RESTART_BACKOFF_MAX_MS);
				await Bun.sleep(backoff);
				if (stopping) return;
			} else {
				quickExits = 0;
			}
			const controller = new AbortController();
			restartController = controller;
			try {
				const restarted = await spawnUrlTunnel(argv, parsePinggyUrl, {
					recoverPostExitUrl: true,
					signal: controller.signal,
				});
				if (stopping) {
					killTunnelProcess(restarted.proc);
					await restarted.proc.exited;
					return;
				}
				// Measure the quick-exit window from readiness, matching the initial
				// child: including the spawnUrlTunnel() wait would misclassify a
				// slow-to-publish child that dies right after publishing as long-lived.
				spawnedAt = Date.now();
				proc = restarted.proc;
				proc.unref();
				if (restarted.lifecycle === "running" && proc.exitCode === null) startup.resolve();
			} catch (error) {
				if (!stopping) {
					logger.warn("blob-broker: authenticated Pinggy tunnel failed to reconnect");
					startup.reject(error);
				}
				return;
			} finally {
				if (restartController === controller) restartController = undefined;
			}
		}
	})();
	const exposure: ActiveExposure = {
		kind: "pinggy",
		baseUrl,
		exited,
		stop: () => {
			stopping = true;
			restartController?.abort();
			killTunnelProcess(proc);
		},
	};
	await startup.promise;
	return exposure;
}

/**
 * Expose `port` per `config`. Throws when the backend is missing,
 * misconfigured, or fails to come up; the caller degrades to inline base64.
 */
export async function startExposure(config: ExposureConfig, port: number): Promise<ActiveExposure> {
	switch (config.kind) {
		case "direct": {
			const baseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://${config.bindHost}:${port}`);
			return { kind: "direct", baseUrl, exited: null, stop: () => {} };
		}
		case "cloudflared": {
			const binary = requireBinary("cloudflared");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
				parseCloudflaredUrl,
				{ readyPattern: /Registered tunnel connection/ },
			);
			return processExposure("cloudflared", baseUrl, proc);
		}
		case "ngrok": {
			const binary = requireBinary("ngrok");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "http", String(port), "--log", "stdout", "--log-format", "json"],
				parseNgrokUrl,
			);
			return processExposure("ngrok", baseUrl, proc);
		}
		case "tailscale": {
			const binary = requireBinary("tailscale");
			const { proc, baseUrl } = await spawnUrlTunnel([binary, "funnel", String(port)], parseTailscaleUrl);
			return processExposure("tailscale", baseUrl, proc);
		}
		case "localhost-run": {
			const binary = requireBinary("ssh");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[
					binary,
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=accept-new",
					"-o",
					"ServerAliveInterval=30",
					"-o",
					"ServerAliveCountMax=3",
					"-o",
					"ExitOnForwardFailure=yes",
					"-R",
					`80:127.0.0.1:${port}`,
					"nokey@localhost.run",
					"--",
					"--output",
					"json",
				],
				parseLocalhostRunUrl,
			);
			return processExposure("localhost-run", baseUrl, proc);
		}
		case "pinggy": {
			const binary = requireBinary("ssh");
			const token = credentialString(config, "token");
			const argv = token
				? [
						binary,
						"-p",
						"443",
						"-o",
						"BatchMode=yes",
						"-o",
						"StrictHostKeyChecking=accept-new",
						"-R",
						`0:127.0.0.1:${port}`,
						`${token}@pro.pinggy.io`,
					]
				: [
						binary,
						"-p",
						"443",
						"-o",
						"BatchMode=yes",
						"-o",
						"StrictHostKeyChecking=accept-new",
						"-o",
						"ServerAliveInterval=30",
						"-o",
						"ServerAliveCountMax=3",
						"-o",
						"ExitOnForwardFailure=yes",
						"-R",
						`0:127.0.0.1:${port}`,
						"free.pinggy.io",
					];
			const supervised = Boolean(token && config.publicBaseUrl);
			const spawned = await spawnUrlTunnel(argv, parsePinggyUrl, {
				recoverPostExitUrl: supervised,
			});
			if (token && config.publicBaseUrl) {
				return restartingPinggyExposure(normalizeBaseUrl(config.publicBaseUrl), argv, spawned);
			}
			return processExposure("pinggy", spawned.baseUrl, spawned.proc);
		}
		case "devtunnel": {
			const binary = requireBinary("devtunnel");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "host", "-p", String(port), "--allow-anonymous", "--protocol", "http"],
				parseDevtunnelUrl,
			);
			return processExposure("devtunnel", baseUrl, proc);
		}
		case "zrok": {
			const binary = requireBinary("zrok");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "share", "public", `http://127.0.0.1:${port}`, "--headless", "--backend-mode", "proxy"],
				parseZrokUrl,
			);
			return processExposure("zrok", baseUrl, proc);
		}
		case "bore": {
			const binary = requireBinary("bore");
			const server = optionString(config, "server", "bore.pub");
			if (!server) throw new Error('imageUrls exposure "bore" requires options.server');
			const secret = credentialString(config, "secret");
			const argv = [binary, "local", String(port), "--to", server];
			if (secret) argv.push("--secret", secret);
			const { proc, baseUrl } = await spawnUrlTunnel(argv, line => parseBoreUrl(line, server));
			return processExposure("bore", baseUrl, proc);
		}
		case "named-cloudflared": {
			if (!config.publicBaseUrl) {
				throw new Error('imageUrls exposure "named-cloudflared" requires imageUrls.publicBaseUrl');
			}
			const binary = requireBinary("cloudflared");
			const token = credentialString(config, "tunnelToken");
			let argv: string[];
			if (token) {
				argv = [binary, "tunnel", "--no-autoupdate", "run", "--token", token];
			} else {
				const configFile = optionString(config, "configFile");
				const tunnelName = optionString(config, "tunnelName");
				if (!configFile || !tunnelName) {
					throw new Error(
						'imageUrls exposure "named-cloudflared" requires credentials.tunnelToken or options.configFile and options.tunnelName',
					);
				}
				argv = [binary, "tunnel", "--no-autoupdate", "--config", configFile, "run", tunnelName];
			}
			const baseUrl = normalizeBaseUrl(config.publicBaseUrl);
			const { proc } = await spawnUrlTunnel(argv, () => baseUrl, {
				readyPattern: /Registered tunnel connection|Connection [a-z0-9-]+ registered/i,
			});
			return processExposure("named-cloudflared", baseUrl, proc);
		}
		case "ssh": {
			if (!config.publicBaseUrl) throw new Error('imageUrls exposure "ssh" requires imageUrls.publicBaseUrl');
			if (!config.sshTarget) throw new Error('imageUrls exposure "ssh" requires imageUrls.sshTarget');
			const binary = requireBinary("ssh");
			const remotePort = config.sshRemotePort ?? 8787;
			const proc = Bun.spawn(
				[
					binary,
					"-o",
					"BatchMode=yes",
					"-o",
					"ExitOnForwardFailure=yes",
					"-N",
					"-R",
					`${remotePort}:127.0.0.1:${port}`,
					config.sshTarget,
				],
				{ env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", cwd: os.homedir() },
			);
			const early = await Promise.race([
				proc.exited.then(code => code),
				Bun.sleep(SSH_READY_GRACE_MS).then(() => null),
			]);
			if (early !== null) {
				throw new Error(`ssh reverse forward to ${config.sshTarget} exited with code ${early}`);
			}
			logger.debug("blob-broker: ssh reverse forward established", {
				target: config.sshTarget,
				remotePort,
				localPort: port,
			});
			return processExposure("ssh", normalizeBaseUrl(config.publicBaseUrl), proc);
		}
	}
}
