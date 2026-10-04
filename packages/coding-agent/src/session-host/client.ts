import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { ensurePrivateDir, pidAlive } from "../ipc/private-endpoint";
import { type RpcAgentProcess, RpcClient } from "../modes/rpc/rpc-client";
import type { RpcHelloFrame } from "../modes/rpc/rpc-types";
import { resolveCliEntryCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import {
	listSessionHosts,
	newHostId,
	SESSION_HOST_REGISTRY_LABEL,
	type SessionHostEntry,
	sessionHostsDir,
} from "./registry";

/** Default {@link SpawnSessionHostOptions.timeoutMs}: ompweb's cold-start budget. */
const SPAWN_TIMEOUT_MS = 120_000;
const SPAWN_POLL_MS = 50;

export interface ConnectSessionHostOptions {
	entry: Pick<SessionHostEntry, "endpoint" | "token">;
	client: { kind: string; label?: string };
	ui: boolean;
	/** From the `attached` frame (`hostId`) and the last `seq`/`epoch` seen; a mismatched host answers with a snapshot. */
	resume?: { hostId: string; epoch: number; lastSeq: number };
}

/** Socket transport for RpcClient's `spawn` option, speaking protocol v2 from `attached` on. `kill()` closes the socket (a detach). */
export async function connectSessionHost(options: ConnectSessionHostOptions): Promise<RpcAgentProcess> {
	const socket = net.connect(options.entry.endpoint);
	const connected = Promise.withResolvers<void>();
	socket.once("connect", connected.resolve);
	socket.once("error", connected.reject);
	await connected.promise;
	socket.off("error", connected.reject);
	// A reset after connect surfaces as the stream's end; `close` always follows.
	socket.on("error", () => {});
	const exited = Promise.withResolvers<number>();
	socket.once("close", () => exited.resolve(0));
	const hello: RpcHelloFrame = {
		type: "hello",
		token: options.entry.token,
		protocolVersion: 2,
		client: options.client,
		capabilities: { ui: options.ui },
		resume: options.resume,
	};
	socket.write(`${JSON.stringify(hello)}\n`);
	return {
		stdin: { write: data => socket.write(data) },
		stdout: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
		peekStderr: () => "",
		kill: () => socket.destroy(),
		exited: exited.promise,
		protocolVersion: hello.protocolVersion,
	};
}

export interface SpawnSessionHostOptions {
	cwd: string;
	/** Absolute session file to resume; omitted = new session. */
	sessionFile?: string;
	/** Extra launch flags (model, profile, …) forwarded verbatim. */
	args?: string[];
	/**
	 * Registry the host publishes in and this call polls, resolved against this process's cwd. Created if
	 * missing; an existing one open to group/other is chmodded to 0700 (POSIX). Default {@link sessionHostsDir}.
	 */
	registryDir?: string;
	/** Merged over the inherited environment (e.g. an isolated `HOME` / `PI_CODING_AGENT_DIR`). */
	env?: Record<string, string>;
	/** Default 120 s. */
	timeoutMs?: number;
}

/**
 * Start `omp --mode host` detached, so it outlives this process, and resolve
 * with its registry entry once it publishes one. Its stdout and stderr go to
 * `<registryDir>/<hostId>.log`. Rejects, naming that log, when the host exits
 * first, has not published within `timeoutMs`, or the registry cannot be read;
 * a host still running then is killed.
 */
export async function spawnSessionHost(options: SpawnSessionHostOptions): Promise<SessionHostEntry> {
	const { cwd, sessionFile, args = [], env, timeoutMs = SPAWN_TIMEOUT_MS } = options;
	// The host runs in `cwd`: a relative registry would name a different directory there.
	const registryDir = path.resolve(options.registryDir ?? sessionHostsDir());
	const hostId = newHostId();
	await ensurePrivateDir(registryDir, SESSION_HOST_REGISTRY_LABEL);
	const logPath = path.join(registryDir, `${hostId}.log`);
	const log = fs.openSync(logPath, "w", 0o600);
	let child: Subprocess;
	try {
		child = Bun.spawn({
			cmd: [
				...resolveCliEntryCmd(),
				"--mode",
				"host",
				"--host-id",
				hostId,
				"--host-registry-dir",
				registryDir,
				"--cwd",
				cwd,
				...(sessionFile ? ["--resume", sessionFile] : []),
				...args,
			],
			env: workerEnvFromParent(env),
			stdin: "ignore",
			stdout: log,
			stderr: log,
			// Its own process group on POSIX; on Windows no console at all, so closing the
			// spawner's console cannot end the host (spec D7).
			detached: true,
			windowsHide: true,
		});
	} finally {
		fs.closeSync(log);
	}
	child.unref();

	const entryPath = path.join(registryDir, `${hostId}.json`);
	const deadline = Date.now() + timeoutMs;
	let exitCode: number | undefined;
	void child.exited.then(code => {
		exitCode = code;
	});
	try {
		while (exitCode === undefined && Date.now() < deadline) {
			// Listing probes every host, so it runs only once this host's entry exists.
			if (await Bun.file(entryPath).exists()) {
				const entry = (await listSessionHosts(registryDir)).find(candidate => candidate.hostId === hostId);
				if (entry) return entry;
			}
			await Promise.race([Bun.sleep(SPAWN_POLL_MS), child.exited]);
		}
		if (exitCode !== undefined) {
			throw new Error(`Session host exited with code ${exitCode} before registering; log: ${logPath}`);
		}
		throw new Error(`Session host (pid ${child.pid}) did not register within ${timeoutMs} ms; log: ${logPath}`);
	} catch (error) {
		// Detached and unreferenced: a host left running here would be an orphan nobody can find.
		child.kill();
		throw error;
	}
}

/** Exercise host spawn, socket handshake, `get_state` and last-client `exit` for distribution smoke tests. */
export async function smokeTestSessionHost(): Promise<void> {
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-smoke-"));
	let pid: number | undefined;
	try {
		// Booting needs a model. `--provider/--model` and this models.yml each suffice alone; both are
		// passed so a change to either path cannot fail the probe, and the models.yml also points
		// anthropic discovery at a closed port with a dummy key.
		await Bun.write(
			path.join(tmp, "models.yml"),
			"providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n    apiKey: smoke-dummy-key\n",
		);
		// The host inherits this process's env and runs model discovery on boot: outbound HTTP is
		// refused best-effort by a proxy on a closed port. USERPROFILE is the home dir on win32.
		const closedProxy = "http://127.0.0.1:9";
		const entry = await spawnSessionHost({
			cwd: tmp,
			registryDir: tmp,
			env: {
				PI_CODING_AGENT_DIR: tmp,
				HOME: tmp,
				USERPROFILE: tmp,
				HTTP_PROXY: closedProxy,
				HTTPS_PROXY: closedProxy,
				http_proxy: closedProxy,
				https_proxy: closedProxy,
				NO_PROXY: "",
				no_proxy: "",
			},
			args: [
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			timeoutMs: SMOKE_TEST_TIMEOUT_MS,
		});
		pid = entry.pid;
		const client = new RpcClient({
			spawn: () => connectSessionHost({ entry, client: { kind: "smoke-test" }, ui: false }),
		});
		try {
			await client.start();
			const state = await client.getState();
			if (state.sessionFile !== entry.sessionFile) throw new Error("get_state returned another session");
			await client.exit();
		} finally {
			await client.stop();
		}
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		while (pidAlive(pid)) {
			if (Date.now() > deadline) throw new Error(`pid ${pid} survived exit`);
			await Bun.sleep(50);
		}
	} catch (error) {
		// The host's log lives in `tmp`, which the cleanup below deletes.
		const logs = (await fs.promises.readdir(tmp)).filter(name => name.endsWith(".log"));
		const text = await Promise.all(logs.map(name => Bun.file(path.join(tmp, name)).text()));
		throw new Error(`session host smoke failed: ${error}\n${text.join("\n")}`, { cause: error });
	} finally {
		// Detached: a host left running here would outlive the smoke run.
		if (pid !== undefined && pidAlive(pid)) process.kill(pid, "SIGKILL");
		await removeWithRetries(tmp);
	}
}
