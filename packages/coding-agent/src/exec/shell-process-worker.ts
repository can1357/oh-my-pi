/**
 * Shell process: the bash tool's shell run as a process of its own.
 *
 * `omp __omp_worker_shell_process [options] -- <command>` runs one command in
 * the embedded engine with the tool profile (omp's utilities and tools resolve
 * ahead of `PATH`) over this process's own stdin, stdout and stderr, then
 * exits with its status. Externals stay in this process's session and group,
 * so a process started on a pseudo-terminal is that terminal's shell: its
 * programs own the terminal, receive its signals and see `/dev/tty`. Named
 * services and `pty` commands run this way.
 *
 * URL paths are the session's: each filesystem request for one is forwarded
 * to the omp process that started this one, and is missing once it is gone.
 */
import * as fs from "node:fs";
import {
	IpcConnection,
	Shell,
	type ShellFilesystem,
	type ShellFsRequest,
	type ShellFsResponse,
} from "@oh-my-pi/pi-natives";
import {
	decodeShellUrlFrame,
	encodeShellUrlFrame,
	parseShellProcessArgs,
	SHELL_URLS_GONE,
	type ShellProcessUrls,
	type ShellUrlResponse,
} from "./shell-process-protocol";

/**
 * How long the externals alive at a terminal interrupt have to exit for the
 * interrupt to end the command, as a shell stops a script whose foreground
 * program the interrupt killed. One that outlives it handled the signal itself
 * (a REPL, an editor) and the command goes on.
 */
const INTERRUPT_SETTLE_MS = 250;

/** The session's URL paths, reached over its URL server. */
class RemoteUrls {
	#connection: IpcConnection | undefined;
	readonly #pending = new Map<number, (response: ShellFsResponse) => void>();
	#nextId = 1;

	/** Connect to the session at `urls`; a session that is gone serves nothing. */
	static async connect(urls: ShellProcessUrls): Promise<RemoteUrls> {
		const remote = new RemoteUrls();
		try {
			const connection = await IpcConnection.connect(urls.endpoint, { framing: "lines" });
			connection.start(
				line => remote.#answer(line),
				() => remote.#close(),
			);
			// The command, not this connection, decides how long the process lives.
			connection.unref();
			connection.send(encodeShellUrlFrame({ token: urls.token }));
			remote.#connection = connection;
		} catch {
			// No listener: the session ended before this process started.
		}
		return remote;
	}

	filesystem(): ShellFilesystem {
		return {
			handler: (error, request) =>
				error ? Promise.resolve({ error: { code: "EIO", message: error.message } }) : this.#request(request),
			nativeLocalPaths: true,
		};
	}

	#request(request: ShellFsRequest): Promise<ShellFsResponse> {
		const connection = this.#connection;
		if (!connection) return Promise.resolve(SHELL_URLS_GONE);
		const id = this.#nextId++;
		const { promise, resolve } = Promise.withResolvers<ShellFsResponse>();
		this.#pending.set(id, resolve);
		connection.send(encodeShellUrlFrame({ id, request }));
		return promise;
	}

	#answer(line: string): void {
		let frame: ShellUrlResponse;
		try {
			frame = decodeShellUrlFrame(line) as ShellUrlResponse;
		} catch {
			return;
		}
		const resolve = this.#pending.get(frame.id);
		if (!resolve) return;
		this.#pending.delete(frame.id);
		resolve(frame.response);
	}

	#close(): void {
		this.#connection = undefined;
		for (const resolve of this.#pending.values()) resolve(SHELL_URLS_GONE);
		this.#pending.clear();
	}
}

/** Run the shell process `args` (the argv after the worker selector) describe, then exit with the command's status. */
export async function runShellProcess(args: readonly string[]): Promise<never> {
	const spec = parseShellProcessArgs(args);
	if (!spec) {
		process.stderr.write("omp: malformed shell process arguments\n");
		process.exit(2);
	}
	const urls = spec.urls ? await RemoteUrls.connect(spec.urls) : undefined;
	const shell = new Shell({
		process: true,
		// A relaunch may outlive the script its first start was given.
		snapshotPath: spec.source !== undefined && fs.existsSync(spec.source) ? spec.source : undefined,
		filesystem: urls?.filesystem(),
	});

	const abort = new AbortController();
	/** The status this process exits with once a signal ended the command. */
	let signalStatus: number | undefined;
	const stop = (status: number): void => {
		signalStatus ??= status;
		abort.abort();
	};
	// The terminal sends its interrupt to the whole foreground group, the externals included.
	const interrupt = (status: number): void => {
		const running = shell.pids();
		if (running.length === 0) {
			stop(status);
			return;
		}
		setTimeout(() => {
			const alive = new Set(shell.pids());
			if (!running.some(pid => alive.has(pid))) stop(status);
		}, INTERRUPT_SETTLE_MS);
	};
	// The CLI's own handler exits at once, leaving the command's programs behind.
	process.removeAllListeners("SIGINT");
	process.on("SIGINT", () => interrupt(130));
	process.on("SIGTERM", () => stop(143));
	process.on("SIGHUP", () => stop(129));
	if (process.platform !== "win32") process.on("SIGQUIT", () => interrupt(131));

	let status: number;
	try {
		const result = await shell.run({ command: spec.command, cwd: spec.cwd, signal: abort.signal });
		status = signalStatus ?? result.exitCode ?? 1;
	} catch (error) {
		process.stderr.write(`omp: ${error instanceof Error ? error.message : String(error)}\n`);
		status = 1;
	}
	process.exit(status);
}
