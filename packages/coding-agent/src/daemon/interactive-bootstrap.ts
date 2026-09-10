import { ProcessTerminal } from "@oh-my-pi/pi-tui";
import { APP_NAME, logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";
import { parseArgs } from "../cli/args";
import { selectSession } from "../cli/session-picker";
import { applyStartupCwd } from "../cli/startup-cwd";
import { Settings } from "../config/settings";
import { initTheme, stopThemeWatcher } from "../modes/theme/theme";
import { RemoteSessionHandle, type SessionHandleCommand } from "../session/session-handle";
import { isSessionFileArg, resolveResumableSession, resolveSessionFileArg } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { daemonBuildStamp } from "./build-stamp";
import { createDaemonClient, type DaemonClient } from "./client";
import { readDaemonOwnerPid } from "./paths";
import { DAEMON_PROTOCOL_MAJOR, type DaemonOperation } from "./protocol";
import type { DaemonConnectionSnapshot, DaemonProfile } from "./status";
import { ClientTerminalBridge, clientTerminalEnvSnapshot } from "./terminal-bridge";

export { isDefaultInteractiveArgv } from "./interactive-route";

function launchArgs(argv: readonly string[]): string[] {
	return argv[0] === "launch" ? [...argv.slice(1)] : [...argv];
}

const DAEMON_SERVER_WORKER_ARG = "__omp_worker_daemon_server";
const CONNECT_RETRY_MS = 50;
const DAEMON_START_TIMEOUT_MS = 15_000;

export type DaemonInteractiveBootstrapOptions = {
	argv: string[];
	profile?: DaemonProfile;
	cwd?: string;
	runtimeDir?: string;
	endpoint?: string;
	token?: string;
	connectTimeoutMs?: number;
	startTimeoutMs?: number;
	/** Test seam: replaces the detached daemon worker spawn. */
	spawnDaemon?: typeof spawnDaemonServer;
};

export type DaemonInteractiveSession = {
	client: DaemonClient;
	handle: RemoteSessionHandle;
	snapshot: () => DaemonConnectionSnapshot;
	sessions: () => Promise<string>;
	reconnect: () => Promise<void>;
	stop: () => Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>;
};

/**
 * Daemon hosting is opt-in: `--daemon` (or the `daemon.enabled` setting) turns
 * it on, `--no-daemon` always wins, and the default stays the historical
 * direct-mode launch.
 */
export function isDaemonModeOptedIn(argv: readonly string[], settingEnabled: boolean): boolean {
	if (argv.includes("--no-daemon")) return false;
	return argv.includes("--daemon") || settingEnabled;
}

/** Read `daemon.enabled` without touching global Settings state. */
export async function readDaemonModeSetting(): Promise<boolean> {
	try {
		const settings = await Settings.loadIsolated();
		return settings.get("daemon.enabled") === true;
	} catch {
		return false;
	}
}

const RESUME_FLAGS = ["--resume", "-r", "--session"];

/**
 * Rewrite the resume argument's value in `argv`, honoring both `--resume <v>`
 * and `--resume=<v>`. The daemon replays this argv verbatim in its runtime
 * factory, so an inline form left unrewritten would resume the pre-fork
 * session and defeat the fork entirely.
 */
function withResumeValue(argv: readonly string[], value: string): string[] {
	const next = [...argv];
	const inline = next.findIndex(argument => RESUME_FLAGS.some(flag => argument.startsWith(`${flag}=`)));
	if (inline >= 0) {
		next.splice(inline, 1, "--resume", value);
		return next;
	}
	const index = next.findIndex(argument => RESUME_FLAGS.includes(argument));
	if (index < 0) throw new Error("Unable to locate resume argument");
	next.splice(index, 2, "--resume", value);
	return next;
}

export async function resolveDaemonInteractiveResume(
	options: DaemonInteractiveBootstrapOptions,
): Promise<DaemonInteractiveBootstrapOptions | undefined> {
	const parsed = parseArgs(launchArgs(options.argv));
	if (parsed.resume === undefined) return options;
	await applyStartupCwd(parsed);
	const cwd = options.cwd ?? getProjectDir();
	if (typeof parsed.resume === "string") {
		// An explicit transcript path addresses one exact file, and the direct
		// entrypoint (`SessionManager.open` in main.ts) resumes it in place. Forking
		// it into cwd here would make `--resume <file>` mean two different things
		// depending on whether a daemon hosts the session.
		if (isSessionFileArg(parsed.resume)) return options;
		const match = await resolveResumableSession(parsed.resume, cwd, parsed.sessionDir);
		if (
			match?.scope !== "global" ||
			normalizePathForComparison(match.session.cwd || cwd) === normalizePathForComparison(cwd)
		)
			return options;
		const forked = await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
		const forkedPath = forked.getSessionFile();
		if (!forkedPath) throw new Error(`Unable to fork session "${parsed.resume}" into ${cwd}`);
		return { ...options, argv: withResumeValue(options.argv, forkedPath), cwd };
	}
	const folderSessions = await SessionManager.list(cwd, parsed.sessionDir);
	const allSessions = folderSessions.length === 0 ? await SessionManager.listAll() : undefined;
	await initTheme();
	const selected = await selectSession(folderSessions, { allSessions }).finally(stopThemeWatcher);
	if (!selected) return undefined;
	const argv = [...options.argv];
	const resumeIndex = argv.findIndex(
		argument => argument === "--resume" || argument === "-r" || argument === "--session",
	);
	if (resumeIndex < 0) throw new Error("Unable to locate bare resume argument");
	argv.splice(resumeIndex, 1, "--resume", selected.path);
	return {
		...options,
		argv,
		cwd: selected.cwd ?? cwd,
	};
}

function createSessionOverrides(argv: readonly string[]): Record<string, unknown> {
	return { argv: [...argv], clientEnv: clientTerminalEnvSnapshot() };
}

type SpawnedDaemonServer = {
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	unref(): void;
};

function spawnDaemonServer(
	profile: DaemonProfile,
	runtimeDir?: string,
	stderr: "inherit" | "ignore" = "inherit",
): SpawnedDaemonServer {
	const spawn = resolveWorkerSpawnCmd(DAEMON_SERVER_WORKER_ARG);
	const env: Record<string, string> = {
		OMP_PROFILE: profile ?? "",
	};
	if (runtimeDir !== undefined) env.OMP_DAEMON_RUNTIME_DIR = runtimeDir;
	return Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent(env),
		stdin: "ignore",
		stdout: "ignore",
		stderr,
		detached: true,
	});
}

function isTransportUnavailableError(error: unknown): boolean {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") return true;
	const message = error instanceof Error ? error.message : String(error);
	// "Daemon connection closed" / reset / hang up: the socket was accepted by
	// a daemon that is shutting down (e.g. another client just replaced a
	// stale build, or several `--resume` launches raced the same takeover) and
	// destroyed mid-handshake. That daemon is GONE — transport-level
	// unavailability, not a terminal failure: the spawn/retry loop owns it.
	return /\b(?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|socket is unavailable|connection closed|socket hang up/i.test(
		message,
	);
}

function isTerminalConnectionError(client: DaemonClient, error: unknown): boolean {
	if (client.snapshot.state === "incompatible") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /auth|token|scope|shard|protocol|invalid|unsupported|incompatible/i.test(message);
}

/**
 * Extract the server's protocol major from a handshake failure. Both mismatch
 * shapes carry it: the envelope decoder rejects a foreign frame with
 * `unsupported protocol major N` (protocol.ts version()), and a decoded
 * hello_ok with a foreign major throws `incompatible protocol: server major N`
 * (client.ts). Malformed frames surface as invalid_frame and never match.
 */
function protocolMismatchServerMajor(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /\b(?:unsupported|incompatible) protocol\b[^0-9]*(\d+)/i.exec(message);
	if (!match) return undefined;
	const major = Number(match[1]);
	return Number.isInteger(major) ? major : undefined;
}

/**
 * SIGTERM the owner of a daemon speaking an OLDER protocol major. It cannot
 * serve this client and cannot be asked to shut down over the wire, so the
 * polite build-pairing takeover (which checks blockers first) is unreachable
 * by definition — a protocol bump always changes the build stamp too. Session
 * transcripts persist on disk and rehydrate on the replacement daemon; the
 * accepted tradeoff is that another live client of the old daemon loses its
 * in-flight turn, which we take over the alternative of every new-build `omp`
 * start staying dead until the user hand-kills the old daemon.
 */
async function signalOlderProtocolOwner(client: DaemonClient, serverMajor: number): Promise<boolean> {
	const pid = await readDaemonOwnerPid(client.runtimeDir);
	if (pid === undefined || pid === process.pid) return false;
	try {
		process.kill(pid, "SIGTERM");
		logger.warn("Daemon speaks an older protocol; signaled it to make way for this build", {
			pid,
			serverMajor,
			clientMajor: DAEMON_PROTOCOL_MAJOR,
		});
		return true;
	} catch {
		return false;
	}
}

async function connectWithSpawn(
	client: DaemonClient,
	profile: DaemonProfile,
	runtimeDir: string | undefined,
	startTimeoutMs: number,
	spawn: typeof spawnDaemonServer = spawnDaemonServer,
): Promise<void> {
	try {
		await client.connect();
		return;
	} catch (firstError) {
		const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
		const staleMajor = protocolMismatchServerMajor(firstError);
		let signaledOlderProtocol = false;
		if (staleMajor !== undefined && staleMajor < DAEMON_PROTOCOL_MAJOR) {
			signaledOlderProtocol = await signalOlderProtocolOwner(client, staleMajor);
		} else if (isTerminalConnectionError(client, firstError)) {
			// Includes a NEWER server major: this client is the outdated build
			// and must not kill a daemon it cannot replace.
			throw new Error(`Daemon connection is terminal: ${firstMessage}`);
		} else if (!isTransportUnavailableError(firstError)) {
			throw new Error(`Daemon connection failed before startup: ${firstMessage}`);
		}
		let child = spawn(profile, runtimeDir);
		const deadline = Date.now() + startTimeoutMs;
		let lastError = firstError instanceof Error ? firstError : new Error(String(firstError));
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				// A contender losing the owner lease (or racing a draining
				// predecessor) exits nonzero BY DESIGN; that must not abort the
				// whole startup while the deadline still has budget. Remember
				// the exit and try again.
				lastError = new Error(`Daemon server exited during startup with code ${child.exitCode}`);
				await Bun.sleep(CONNECT_RETRY_MS * 4);
				child = spawn(profile, runtimeDir);
				continue;
			}
			try {
				await client.connect();
				child.unref();
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const major = protocolMismatchServerMajor(lastError);
				if (major !== undefined && major < DAEMON_PROTOCOL_MAJOR) {
					// The older daemon is still draining; keep waiting it out.
					if (!signaledOlderProtocol) signaledOlderProtocol = await signalOlderProtocolOwner(client, major);
					await Bun.sleep(CONNECT_RETRY_MS);
					continue;
				}
				if (isTerminalConnectionError(client, lastError))
					throw new Error(`Daemon connection is terminal: ${lastError.message}`);
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(`Unable to connect to daemon: ${lastError.message}`);
	}
}

async function requestWithTransportRecovery(
	client: DaemonClient,
	operation: DaemonOperation["op"] | DaemonOperation,
	payload: Record<string, unknown>,
	profile: DaemonProfile,
	runtimeDir: string,
	startTimeoutMs: number,
	spawnDaemon: typeof spawnDaemonServer,
): Promise<unknown> {
	try {
		return await client.request(operation, payload);
	} catch (error) {
		if (!isTransportUnavailableError(error)) throw error;
		await connectWithSpawn(client, profile, runtimeDir, startTimeoutMs, spawnDaemon);
		return client.request(operation, payload);
	}
}

export type BuildPairingOutcome = "matched" | "replaced";

export type BuildPairingEffects = {
	localStamp: string;
	/** Spawn a fresh daemon for this shard (detached; errors surface via reconnect). */
	spawn: () => void;
	/** Signal the stale daemon owner process; defaults to SIGTERM via process.kill. */
	killOwner?: (pid: number) => void;
	/** Read the daemon.owner pid for the client's runtime dir. */
	readOwnerPid?: () => Promise<number | undefined>;
	waitMs?: number;
};

/**
 * Client↔server build pairing: a daemon left over from another build must
 * never serve this client. After a successful handshake, compare build stamps
 * and replace any stale daemon:
 *
 * - request graceful protocol shutdown first;
 * - if shutdown is refused or fails while the server remains reachable,
 *   signal the verified daemon owner regardless of active clients/sessions;
 * - after the old owner exits, spawn a fresh daemon and reconnect;
 * - fail closed if the stale owner cannot be replaced or the replacement
 *   still reports a mismatched build stamp.
 *
 * A daemon without a stamp (pre-pairing build) is by definition stale.
 */
export async function ensureDaemonBuildPairing(
	client: DaemonClient,
	effects: BuildPairingEffects,
): Promise<BuildPairingOutcome> {
	if (client.serverBuildStamp === effects.localStamp) return "matched";
	const staleStamp = client.serverBuildStamp ?? "(pre-pairing daemon)";
	const waitMs = effects.waitMs ?? DAEMON_START_TIMEOUT_MS;
	let shutdown: { shutdown?: boolean; blockers?: string[] } | undefined;
	let forceStop = false;
	try {
		shutdown = (await client.request("shutdown")) as { shutdown?: boolean; blockers?: string[] };
	} catch (error) {
		if (isTransportUnavailableError(error)) {
			// The stale daemon died mid-request — a concurrent client's replacement
			// won the race (several launches hitting one stale daemon). That is the
			// desired outcome: wait out the old owner and reconnect or respawn.
			logger.warn("Stale daemon vanished during shutdown request; proceeding to replacement", {
				staleStamp,
				localStamp: effects.localStamp,
				error: String(error),
			});
		} else {
			forceStop = true;
			logger.warn("Stale daemon shutdown request failed; forcing build replacement", {
				staleStamp,
				localStamp: effects.localStamp,
				error: String(error),
			});
		}
	}
	if (shutdown !== undefined && shutdown.shutdown !== true) {
		forceStop = true;
		logger.warn("Daemon build differs from this client; forcing replacement despite active work", {
			staleStamp,
			localStamp: effects.localStamp,
			blockers: shutdown.blockers ?? [],
		});
	}
	if (forceStop) {
		const pid = await effects.readOwnerPid?.();
		if (pid === undefined) {
			logger.warn("Stale daemon owner PID unavailable; attempting replacement without a signal", {
				staleStamp,
				localStamp: effects.localStamp,
			});
		} else {
			try {
				(effects.killOwner ?? (target => process.kill(target, "SIGTERM")))(pid);
			} catch {
				// Already exited between status and signal — proceed to respawn.
			}
		}
	}
	// Wait for the old owner to actually vanish before spawning: the fresh
	// daemon races the owner lease and the stale socket otherwise.
	const deadline = Date.now() + waitMs;
	let ownerGone = false;
	for (;;) {
		const pid = await effects.readOwnerPid?.();
		if (pid === undefined) {
			ownerGone = true;
			break;
		}
		try {
			process.kill(pid, 0);
		} catch {
			ownerGone = true;
			break;
		}
		if (Date.now() >= deadline) break;
		await Bun.sleep(CONNECT_RETRY_MS);
	}
	if (!ownerGone) {
		// The old daemon acknowledged shutdown but is still draining past our
		// budget. Spawn anyway: the contender's server-side lease wait tolerates
		// a live-but-unbound owner, so it parks until the drain finishes instead
		// of exiting 1. A single reconnect here would just fail (the old
		// listener is already closing) and abort bootstrap.
		logger.warn("Stale daemon is still draining; spawning a patient replacement contender", {
			staleStamp,
			localStamp: effects.localStamp,
		});
	}
	effects.spawn();
	// Fresh budget for the bind: the owner wait may have consumed the first
	// one, and a drain-timeout contender also waits out the lease server-side.
	const reconnectDeadline = Date.now() + waitMs;
	let lastError: Error | undefined;
	for (;;) {
		try {
			await client.reconnect();
			if (client.snapshot.state === "connected" && client.serverBuildStamp === effects.localStamp) break;
			// Landed back on the draining stale daemon (its listener can outlive
			// the shutdown acknowledgement): nudge it again and keep retrying
			// until the replacement's stamp appears or the budget runs out.
			if (client.snapshot.state === "connected") {
				await client.request("shutdown").catch(() => undefined);
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		if (Date.now() >= reconnectDeadline) break;
		await Bun.sleep(CONNECT_RETRY_MS);
	}
	if (client.snapshot.state !== "connected") {
		throw new Error(`Unable to reconnect after replacing stale daemon: ${lastError?.message ?? "timeout"}`);
	}
	if (client.serverBuildStamp !== effects.localStamp) {
		throw new Error(
			`Refusing mismatched replacement daemon build ${client.serverBuildStamp ?? "(missing stamp)"}; expected ${effects.localStamp}`,
		);
	}
	return "replaced";
}

/**
 * Connect to (or start) the authenticated per-profile daemon and attach one
 * interactive session. This module deliberately imports the interactive UI
 * only after the daemon handshake so the default route never loads main.ts or
 * the command graph before the connection is established.
 */
export async function bootstrapDaemonInteractive(
	options: DaemonInteractiveBootstrapOptions,
): Promise<DaemonInteractiveSession> {
	const parsed = parseArgs(launchArgs(options.argv));
	await applyStartupCwd(parsed);
	const profile = options.profile === undefined ? (getActiveProfile() ?? null) : options.profile;
	const cwd = options.cwd ?? getProjectDir();
	let recoveryRuntimeDir = options.runtimeDir;
	const spawnDaemon = options.spawnDaemon ?? spawnDaemonServer;
	const client = await createDaemonClient({
		profile,
		runtimeDir: options.runtimeDir,
		endpoint: options.endpoint,
		token: options.token,
		connectTimeoutMs: options.connectTimeoutMs,
		recoverUnavailable: () => {
			spawnDaemon(profile, recoveryRuntimeDir, "ignore").unref();
		},
	});
	recoveryRuntimeDir = client.runtimeDir;
	await connectWithSpawn(
		client,
		profile,
		client.runtimeDir,
		options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
		spawnDaemon,
	);
	await ensureDaemonBuildPairing(client, {
		localStamp: await daemonBuildStamp(),
		spawn: () => {
			spawnDaemon(profile, client.runtimeDir, "ignore").unref();
		},
		readOwnerPid: () => readDaemonOwnerPid(client.runtimeDir),
		waitMs: options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
	});

	const bootstrapRequest = (
		operation: DaemonOperation["op"] | DaemonOperation,
		payload: Record<string, unknown> = {},
	): Promise<unknown> =>
		requestWithTransportRecovery(
			client,
			operation,
			payload,
			profile,
			client.runtimeDir,
			options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
			spawnDaemon,
		);

	// A string `--resume` names a specific session that may ALREADY be hosted
	// by this daemon (a client died and left it parked). Probe the live list
	// first and attach to the existing runtime — a blind session_create would
	// resume the same transcript into a duplicate runtime and fail with
	// session_busy. Fresh (unhosted) resumes keep the plain create path so the
	// runtime factory still processes the full launch argv. A transcript path
	// resolves through its file: the id matcher is prefix-based and would never
	// match a path, silently skipping the probe.
	const resumeArg = typeof parsed.resume === "string" ? parsed.resume : undefined;
	const resumeSession =
		resumeArg === undefined
			? undefined
			: isSessionFileArg(resumeArg)
				? await resolveSessionFileArg(resumeArg)
				: (await resolveResumableSession(resumeArg, cwd, parsed.sessionDir))?.session;
	const resumeSessionId = resumeSession?.id;
	const createOperation = {
		op: "session_create",
		cwd,
		overrides: createSessionOverrides(launchArgs(options.argv)),
	} as const;
	let sessionId: string | undefined;
	if (resumeSessionId !== undefined) {
		try {
			const listed = (await bootstrapRequest("session_list")) as Array<{ sessionId?: unknown }>;
			if (Array.isArray(listed) && listed.some(entry => entry.sessionId === resumeSessionId)) {
				await bootstrapRequest("session_load", { sessionId: resumeSessionId });
				sessionId = resumeSessionId;
			}
		} catch (error) {
			logger.debug("daemon resume probe failed; falling back to session_create", { err: String(error) });
		}
	}
	if (sessionId === undefined) {
		try {
			const created = (await bootstrapRequest(createOperation)) as { sessionId?: unknown };
			if (typeof created.sessionId !== "string" || created.sessionId.length === 0) {
				client.close();
				throw new Error("Daemon did not return a session id");
			}
			sessionId = created.sessionId;
		} catch (error) {
			// Safety net for the probe/create race: another client hosted the
			// resumed session between the probe and the create.
			const busy = /\bsession_busy\b/.test(error instanceof Error ? error.message : String(error));
			if (!busy || resumeSessionId === undefined) {
				client.close();
				throw error;
			}
			await bootstrapRequest("session_load", { sessionId: resumeSessionId });
			sessionId = resumeSessionId;
		}
	}
	const handle = new RemoteSessionHandle(client, sessionId, {
		delivery: "terminal",
		reconnectWaitMs: 60_000,
		recover: async () => {
			await client.request({ ...createOperation, sessionId });
		},
	});
	await handle.whenReady();
	return {
		client,
		handle,
		snapshot: () => client.snapshot,
		sessions: async () => JSON.stringify(await client.request("session_list")),
		reconnect: () => client.reconnect(),
		stop: async () => {
			const result = (await client.request("shutdown")) as { shutdown?: boolean; blockers?: string[] };
			if (result.shutdown === true) client.close();
			return result;
		},
	};
}
/** Launch the complete existing OMP interactive mode hosted by the daemon. */
export async function launchDaemonInteractive(options: DaemonInteractiveBootstrapOptions): Promise<void> {
	const resolvedOptions = await resolveDaemonInteractiveResume(options);
	if (!resolvedOptions) return;
	const session = await bootstrapDaemonInteractive(resolvedOptions);
	const terminal = new ProcessTerminal();
	const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
	let hostReady = false;
	let pendingInput = "";
	let pendingSize = { columns: terminal.columns, rows: terminal.rows };
	let pendingAppearance = terminal.appearance;
	let commandChain = Promise.resolve();
	const enqueue = (command: SessionHandleCommand): void => {
		commandChain = commandChain
			.then(() => session.handle.command(command))
			.then(() => undefined)
			.catch(() => undefined);
	};
	const bridge = new ClientTerminalBridge(terminal, {
		onInput: data => {
			if (hostReady) enqueue({ type: "terminal_input", data });
			else pendingInput += data;
		},
		onResize: size => {
			pendingSize = size;
			if (hostReady) enqueue({ type: "terminal_resize", size });
		},
		onAppearance: appearance => {
			pendingAppearance = appearance;
			if (hostReady) enqueue({ type: "terminal_appearance", appearance });
		},
	});
	let closedReason: "exit" | "error" | undefined;
	const unsubscribeEvents = session.handle.subscribe(event => {
		if (event.type === "terminal_output") bridge.output(event.data);
		else if (event.type === "terminal_closed" && (event.reason === "exit" || event.reason === "error")) {
			closedReason = event.reason;
			resolveClosed();
		}
	});
	let startTask: Promise<void> | undefined;
	const startHost = (): Promise<void> => {
		if (startTask) return startTask;
		hostReady = false;
		startTask = (async () => {
			await session.handle.command({
				type: "terminal_start",
				terminal: {
					columns: terminal.columns,
					rows: terminal.rows,
					kittyProtocolActive: terminal.kittyProtocolActive,
					kittyEnableSequence: terminal.kittyEnableSequence,
					keyboardEnhancementEnterSequence: terminal.keyboardEnhancementEnterSequence,
					keyboardEnhancementExitSequence: terminal.keyboardEnhancementExitSequence,
					appearance: terminal.appearance,
					clientEnv: clientTerminalEnvSnapshot(),
				},
			});
			hostReady = true;
			enqueue({ type: "terminal_resize", size: pendingSize });
			if (pendingAppearance) enqueue({ type: "terminal_appearance", appearance: pendingAppearance });
			if (pendingInput) {
				const data = pendingInput;
				pendingInput = "";
				enqueue({ type: "terminal_input", data });
			}
		})().finally(() => {
			startTask = undefined;
		});
		return startTask;
	};
	let startRetryTimer: NodeJS.Timeout | undefined;
	const scheduleStartHost = (attempt = 0): void => {
		void startHost().catch(error => {
			// No snapshot flip follows a failed terminal_start on a healthy
			// connection, so a swallowed failure is a permanently blank screen.
			logger.warn("Hosted terminal start failed", { attempt, error: String(error) });
			if (attempt >= 4 || session.client.snapshot.state !== "connected") return;
			clearTimeout(startRetryTimer);
			startRetryTimer = setTimeout(() => scheduleStartHost(attempt + 1), 250 * 2 ** attempt);
		});
	};
	const unsubscribeConnection = session.client.onSnapshot(snapshot => {
		if (snapshot.state === "connected") scheduleStartHost();
		else hostReady = false;
	});
	try {
		bridge.start();
		pendingSize = { columns: terminal.columns, rows: terminal.rows };
		pendingAppearance = terminal.appearance;
		await startHost();
		await closed;
	} finally {
		clearTimeout(startRetryTimer);
		startRetryTimer = undefined;
		unsubscribeConnection();
		unsubscribeEvents();
		if (session.handle.connectionState === "connected") {
			await session.handle.command({ type: "terminal_detach" }).catch(() => undefined);
		}
		await bridge.stop();
		if (session.handle.connectionState !== "detached") await session.handle.dispose().catch(() => undefined);
		// Parity with direct-mode shutdown: the hosted InteractiveMode returns
		// before its own resume hint (and would print to the DAEMON's stderr
		// anyway), so the client prints it — after bridge.stop() so the TUI
		// teardown cannot overwrite it. Only when the session actually
		// persisted: the file materializes on the first assistant message, so a
		// session whose only turn errored has an id --resume cannot find.
		const finalState = session.handle.state;
		if (
			closedReason === "exit" &&
			finalState.sessionId &&
			finalState.sessionFile &&
			(await Bun.file(finalState.sessionFile).exists())
		) {
			process.stderr.write(
				`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${finalState.sessionId}`)}\n`,
			);
		}
		session.client.close();
	}
}
