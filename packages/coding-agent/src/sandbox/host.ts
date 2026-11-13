/**
 * The in-sandbox host (`omp __omp_sandbox_host`): owns the embedded `Shell` and `PtySession`
 * instances of one agent session inside an MXC container and serves them to the trusted parent
 * over the JSONL protocol of {@link ./host-protocol}. It also performs the filesystem work of the
 * parent's in-process file tools — mutations (`file.mutate`, `ast.edit`, `sqlite.write`), searches
 * and listings (`search.grep`, `search.glob`, `ast.grep`, `dir.list`), SQLite reads, and the open
 * that decides a single-file read (`file.identify`) — so the container decides those at the
 * syscall too. Exits when stdin closes.
 *
 * stdout carries protocol lines only. `cli.ts` rebinds `process.stdout` and the console to stderr
 * before this module loads; protocol lines go through a dedicated `Bun.stdout` writer, and the
 * logger forwards its records to the parent instead of opening a log file (the agent directory is
 * not writable in here).
 */
import * as fs from "node:fs/promises";
import {
	astEdit,
	astGrep,
	glob,
	grep,
	listWorkspace,
	Process,
	PtySession,
	RunTrace,
	Shell,
	type ShellFilesystem,
	type ShellFsRequest,
	type ShellFsResponse,
} from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { readSqlite } from "../tools/read-sqlite";
import { writeSqliteRow } from "../tools/sqlite-reader";
import { applyFileMutation } from "./file-mutation-ops";
import {
	decodeHostMessage,
	encodeHostMessage,
	type HostEvent,
	type HostFileIdentity,
	type HostRequest,
	type HostResults,
	type HostRunFs,
	MAX_HOST_LINE_BYTES,
	readHostLines,
	SANDBOX_HOST_PROTOCOL_VERSION,
} from "./host-protocol";

/** Cadence of the trace/pid poll while a run is in flight (matches `bash-executor`'s trace poll). */
const RUN_POLL_MS = 80;

type RunRequest = Extract<HostRequest, { op: "shell.run" }>;
type PtyStartRequest = Extract<HostRequest, { op: "pty.start" }>;
type DispatchRequest = Exclude<
	HostRequest,
	{ op: "pty.write" | "pty.resize" | "fs.reply" | "pty.start" | "call.abort" }
>;

/** Opens `filePath` for reading, as the parent's read will, and reports which file that was. */
async function identifyFile(filePath: string): Promise<HostFileIdentity> {
	const handle = await fs.open(filePath, "r");
	try {
		const stats = await handle.stat({ bigint: true });
		return { dev: stats.dev, ino: stats.ino };
	} finally {
		await handle.close();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class SandboxHost {
	readonly #out = Bun.stdout.writer();
	readonly #shells = new Map<number, Shell>();
	readonly #ptys = new Map<number, PtySession>();
	readonly #fsReplies = new Map<number, (response: ShellFsResponse) => void>();
	/** Abort handles of the in-flight requests whose native call takes a signal. */
	readonly #aborts = new Map<number, AbortController>();
	#nextFsReq = 0;

	send(event: HostEvent): void {
		this.#out.write(encodeHostMessage(event));
		this.#out.flush();
	}

	handle(message: HostRequest): void {
		switch (message.op) {
			case "pty.write":
			case "pty.resize": {
				const pty = this.#ptys.get(message.pty);
				try {
					if (message.op === "pty.write") pty?.write(message.data);
					else pty?.resize(message.cols, message.rows);
				} catch {
					// The command already exited; input and resizes after that are dropped, as natively.
				}
				return;
			}
			case "fs.reply": {
				const resolve = this.#fsReplies.get(message.req);
				this.#fsReplies.delete(message.req);
				resolve?.(message.response);
				return;
			}
			case "call.abort":
				this.#aborts.get(message.target)?.abort();
				return;
			case "pty.start":
				this.#startPty(message);
				return;
			default:
				void this.#reply(message.id, () => this.#dispatch(message));
		}
	}

	/**
	 * Aborts every shell, kills every PTY, and ends the processes the shells started (they `setsid`,
	 * so this process exiting would not take them along); the process exits right after.
	 */
	async shutdown(): Promise<void> {
		for (const pty of this.#ptys.values()) {
			try {
				pty.kill();
			} catch {
				// Already exited.
			}
		}
		await Promise.allSettled([...this.#shells.values()].map(shell => shell.abort()));
		try {
			for (const child of Process.fromPid(process.pid)?.children() ?? []) child.killTree();
		} catch (error) {
			logger.warn("sandbox host: could not end its child processes", { error: errorMessage(error) });
		}
		await this.#out.flush();
	}

	async #reply(id: number, run: () => Promise<HostResults[keyof HostResults]>): Promise<void> {
		let line: string;
		try {
			line = encodeHostMessage({ id, ok: true, result: await run() });
		} catch (error) {
			// The errno name lets the parent's file tools tell a denial from a missing path.
			const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
			this.send({ id, ok: false, error: errorMessage(error), ...(typeof code === "string" ? { code } : {}) });
			return;
		}
		// The parent drops the connection on a line over the cap; answer with an error instead.
		if (Buffer.byteLength(line) > MAX_HOST_LINE_BYTES) {
			this.send({ id, ok: false, error: `Sandbox host reply too large (over ${MAX_HOST_LINE_BYTES} bytes)` });
			return;
		}
		this.#out.write(line);
		this.#out.flush();
	}

	#shell(id: number): Shell {
		const shell = this.#shells.get(id);
		if (!shell) throw new Error(`Unknown sandbox shell ${id}`);
		return shell;
	}

	/** The abort signal of request `id`, fired by a `call.abort`; released when the request settles. */
	async #abortable<T>(id: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		this.#aborts.set(id, controller);
		try {
			return await run(controller.signal);
		} finally {
			this.#aborts.delete(id);
		}
	}

	/** The URL-path filesystem of request `id`, when the parent bridges one. */
	#requestFilesystem(id: number, fs: HostRunFs | null): ShellFilesystem | undefined {
		return fs ? this.#bridgeFilesystem(id, fs.nativeLocalPaths) : undefined;
	}

	async #dispatch(message: DispatchRequest): Promise<HostResults[keyof HostResults]> {
		switch (message.op) {
			case "shell.create":
				this.#shells.set(message.shell, new Shell(message.options));
				return null;
			case "shell.fork":
				this.#shells.set(message.shell, this.#shell(message.from).fork());
				return null;
			case "shell.run":
				return this.#run(message);
			case "shell.abort":
				await this.#shell(message.shell).abort();
				return null;
			case "shell.jobs":
				return this.#shell(message.shell).liveBackgroundJobCount();
			case "shell.dispose":
				// Dropping the last reference tears the session down (kill-on-drop), as in the parent.
				this.#shells.delete(message.shell);
				return null;
			case "pty.kill":
				this.#ptys.get(message.pty)?.kill();
				return null;
			case "file.mutate":
				await applyFileMutation(message.mutation);
				return null;
			case "file.identify":
				return identifyFile(message.path);
			case "dir.list":
				return listWorkspace(message.options);
			case "search.grep": {
				const { id } = message;
				return this.#abortable(id, signal =>
					grep({
						...message.options,
						signal,
						filesystem: this.#requestFilesystem(id, message.fs),
						onMatches: message.stream ? matches => this.send({ ev: "search.matches", id, matches }) : undefined,
					}),
				);
			}
			case "search.glob":
				return this.#abortable(message.id, signal =>
					glob({ ...message.options, signal, filesystem: this.#requestFilesystem(message.id, message.fs) }),
				);
			case "ast.grep":
				return this.#abortable(message.id, signal =>
					astGrep({ ...message.options, signal, filesystem: this.#requestFilesystem(message.id, message.fs) }),
				);
			case "ast.edit": {
				const result = await this.#abortable(message.id, signal =>
					astEdit({ ...message.options, signal, filesystem: this.#requestFilesystem(message.id, message.fs) }),
				);
				// An applied rewrite is reported by its per-file counts; the before/after text of every
				// change could outgrow a protocol line. A preview needs them.
				return message.options.dryRun ? result : { ...result, changes: [] };
			}
			case "sqlite.read":
				return readSqlite(message.target);
			case "sqlite.write": {
				const { dbPath, table, key, content } = message.write;
				return writeSqliteRow(dbPath, table, key, content);
			}
		}
	}

	async #run(message: RunRequest): Promise<HostResults["shell.run"]> {
		const shell = this.#shell(message.shell);
		const { id } = message;
		const trace = message.trace ? new RunTrace(message.run.command) : undefined;
		let traceVersion = -1;
		let pids: number[] = [];
		const poll = (): void => {
			if (trace) {
				const version = trace.version();
				if (version !== traceVersion) {
					traceVersion = version;
					this.send({ ev: "shell.trace", id, snapshot: trace.snapshot() });
				}
			}
			const live = shell.pids();
			if (live.length !== pids.length || live.some((pid, i) => pid !== pids[i])) {
				pids = live;
				this.send({ ev: "shell.pids", id, pids });
			}
		};
		const timer = setInterval(poll, RUN_POLL_MS);
		try {
			return await shell.run(
				{
					...message.run,
					trace,
					filesystem: message.fs ? this.#bridgeFilesystem(id, message.fs.nativeLocalPaths) : undefined,
				},
				(error, chunk) => {
					if (!error) this.send({ ev: "shell.chunk", id, data: chunk });
				},
			);
		} finally {
			clearInterval(timer);
			poll();
		}
	}

	/** A filesystem whose every routed operation is answered by the parent (`fs.request` → `fs.reply`). */
	#bridgeFilesystem(id: number, nativeLocalPaths: boolean | undefined): ShellFilesystem {
		return {
			nativeLocalPaths,
			handler: (error: Error | null, request: ShellFsRequest): Promise<ShellFsResponse> => {
				if (error) return Promise.resolve({ error: { code: "EIO", message: error.message } });
				const req = ++this.#nextFsReq;
				const { promise, resolve } = Promise.withResolvers<ShellFsResponse>();
				this.#fsReplies.set(req, resolve);
				this.send({ ev: "fs.request", id, req, request });
				return promise;
			},
		};
	}

	#startPty(message: PtyStartRequest): void {
		const session = new PtySession();
		this.#ptys.set(message.pty, session);
		let started = false;
		session
			.start(
				message.start,
				(error, chunk) => {
					if (!error && chunk) this.send({ ev: "pty.data", pty: message.pty, data: chunk });
				},
				(error, pid) => {
					if (error || started) return;
					started = true;
					this.send({ id: message.id, ok: true, result: { pid } });
				},
			)
			.then(
				result => {
					if (!started) {
						started = true;
						this.send({ id: message.id, ok: true, result: { pid: 0 } });
					}
					this.send({ ev: "pty.exit", pty: message.pty, result });
				},
				(error: unknown) => {
					if (!started) {
						started = true;
						this.send({ id: message.id, ok: false, error: errorMessage(error) });
						return;
					}
					this.send({
						ev: "pty.exit",
						pty: message.pty,
						result: { exitCode: undefined, cancelled: false, timedOut: false },
						error: errorMessage(error),
					});
				},
			)
			.finally(() => this.#ptys.delete(message.pty));
	}
}

/** Serves the protocol on stdin/stdout until stdin closes, then exits the process. */
export async function runSandboxHost(): Promise<void> {
	const host = new SandboxHost();
	logger.setLogForwarder({
		emit: event => host.send({ ev: "log", record: { ...event, timestamp: event.timestamp.getTime() } }),
		flush: () => {},
	});
	host.send({ ev: "ready", version: SANDBOX_HOST_PROTOCOL_VERSION });
	try {
		for await (const line of readHostLines(Bun.stdin.stream())) {
			try {
				host.handle(decodeHostMessage<HostRequest>(line));
			} catch (error) {
				logger.warn("sandbox host: invalid request", { error: errorMessage(error) });
			}
		}
	} catch (error) {
		logger.warn("sandbox host: request stream failed", { error: errorMessage(error) });
	} finally {
		await host.shutdown();
		process.exit(0);
	}
}
