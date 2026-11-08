/**
 * IDA host daemon: the broker-supervised process behind one open database.
 *
 * `acquireIdaDatabase` (`client.ts`) starts it under the project's daemon broker, so `omp ps`
 * lists it as `omp.ida.<id>`. The host listens on its endpoint first, then takes the IDB lock and
 * opens the database in an {@link IdaWorker}; every omp process in the project shares that worker
 * over NDJSON ({@link IdaHostRequest}). The host exits once the worker does (`close`, idle close,
 * crash). SIGTERM (broker shutdown after the last omp process leaves, `omp ps stop`) closes the
 * worker first, saving when it has unsaved changes.
 */
import * as fs from "node:fs";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { acquireFileLock, logger, postmortem, setProcessName } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	errorMessage,
	IDA_HOST_CONFIG_ENV,
	type IdaHostConfig,
	type IdaHostRequest,
	type IdaHostStatus,
	idaHostReadyBanner,
	parseIdaHostConfig,
	parseIdaHostRequest,
} from "./protocol";
import { idbRef, prepareStoreDir } from "./store";
import { IdaWorker } from "./supervisor";

/** How long a host whose open failed keeps answering with the failure before exiting. */
const OPEN_FAILED_LINGER_MS = 10_000;
/** Budget for a `flush` save. */
const FLUSH_TIMEOUT_MS = 120_000;

class IdaHost {
	readonly #config: IdaHostConfig;
	readonly #startedAt = Date.now();
	readonly #opening: Promise<IdaWorker>;
	readonly #connections = new Set<IpcConnection>();
	/** Request handlers still running; shutdown lets them answer before closing sockets. */
	readonly #inflight = new Set<Promise<void>>();
	#server: IpcServer | undefined;
	/** The open worker; cleared once it exits. */
	#worker: IdaWorker | undefined;
	#stopping: Promise<void> | undefined;

	constructor(config: IdaHostConfig) {
		this.#config = config;
		this.#opening = this.#open();
		// Failures are answered per request and reported by `run`.
		this.#opening.catch(() => undefined);
	}

	/** Listen on the endpoint; rejects with code EADDRINUSE when a live host already owns it. */
	async listen(): Promise<void> {
		this.#server = await IpcServer.listen(this.#config.endpoint, { framing: "lines" }, conn => this.#accept(conn));
	}

	/** Wait for the database to open and later close; resolves with the host's exit code. */
	async run(): Promise<number> {
		let worker: IdaWorker;
		try {
			worker = await this.#opening;
		} catch (error) {
			process.stderr.write(`IDA open failed: ${errorMessage(error)}\n`);
			await Bun.sleep(OPEN_FAILED_LINGER_MS);
			await this.shutdown();
			return 1;
		}
		const code = await worker.exited;
		this.#worker = undefined;
		await this.shutdown();
		return code === 0 ? 0 : 1;
	}

	/** Startup failed before serving: let the in-flight open settle, then close whatever it opened. */
	async abandon(): Promise<void> {
		await this.#opening.catch(() => undefined);
		await this.shutdown();
	}

	/** Close the worker (saving unsaved changes), let pending requests answer, then stop listening. */
	shutdown(): Promise<void> {
		this.#stopping ??= this.#stop();
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		const worker = this.#worker;
		this.#worker = undefined;
		if (worker) {
			try {
				await worker.close({ save: worker.needsSave });
			} catch (error) {
				logger.warn("IDA host close failed", { id: this.#config.loc.id, error: errorMessage(error) });
			}
		}
		await Promise.all(this.#inflight);
		const server = this.#server;
		this.#server = undefined;
		for (const conn of this.#connections) conn.end();
		await server?.close();
	}

	async #open(): Promise<IdaWorker> {
		const { loc, runtime, idleCloseMs } = this.#config;
		if (loc.kind === "store") await fs.promises.mkdir(loc.dir, { recursive: true });
		const lock = await acquireFileLock(loc.lockTarget, { retries: 1 }).catch(() => {
			throw new ToolError(`IDB ${loc.id} is in use by another omp process outside this project`);
		});
		try {
			await prepareStoreDir(loc);
			const worker = await IdaWorker.start(loc, runtime, lock, idleCloseMs);
			this.#worker = worker;
			return worker;
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	#status(): IdaHostStatus {
		const { loc } = this.#config;
		const worker = this.#worker;
		if (!worker) {
			return {
				id: loc.id,
				ref: idbRef(loc),
				fat: loc.fat,
				idbPath: loc.openPath,
				info: { module: "", format: "", arch: "", bitness: 0 },
				state: "opening",
				busy: true,
				lastUsed: this.#startedAt,
				current: null,
				dirty: false,
			};
		}
		return {
			id: loc.id,
			ref: worker.ref,
			fat: loc.fat,
			idbPath: worker.idbPath,
			info: worker.info,
			state: "open",
			busy: worker.busy,
			lastUsed: worker.lastUsed,
			current: worker.current,
			dirty: worker.needsSave,
		};
	}

	#accept(conn: IpcConnection): void {
		this.#connections.add(conn);
		// This connection's pending `call`s, aborted by `cancel` or when the connection drops.
		const calls = new Map<number, AbortController>();
		const onLine = (line: string): void => {
			let request: IdaHostRequest;
			try {
				request = parseIdaHostRequest(line);
			} catch (error) {
				logger.warn("IDA host received a malformed request", { error: errorMessage(error) });
				return;
			}
			if (request.op === "cancel") {
				calls.get(request.target)?.abort();
				return;
			}
			const handled = this.#handle(request, calls).then(
				result => {
					conn.send(JSON.stringify({ id: request.id, ok: true, result }));
				},
				error => {
					conn.send(JSON.stringify({ id: request.id, ok: false, error: errorMessage(error) }));
				},
			);
			this.#inflight.add(handled);
			void handled.finally(() => this.#inflight.delete(handled));
		};
		conn.start(onLine, reason => {
			if (reason) logger.debug("IDA host connection closed", { reason });
			this.#connections.delete(conn);
			for (const controller of calls.values()) controller.abort();
		});
	}

	async #handle(
		request: Exclude<IdaHostRequest, { op: "cancel" }>,
		calls: Map<number, AbortController>,
	): Promise<unknown> {
		switch (request.op) {
			case "ping":
				return "pong";
			case "status":
				return this.#status();
			case "open":
				await this.#opening;
				return this.#status();
			case "call": {
				const worker = await this.#liveWorker();
				const controller = new AbortController();
				calls.set(request.id, controller);
				try {
					return await worker.request(request.method, request.params, {
						signal: controller.signal,
						timeoutMs: request.timeoutMs,
					});
				} finally {
					calls.delete(request.id);
				}
			}
			case "flush": {
				const worker = await this.#liveWorker();
				if (!worker.needsSave) return { saved: false };
				await worker.request("save", {}, { timeoutMs: FLUSH_TIMEOUT_MS });
				return { saved: true };
			}
			case "close": {
				const worker = await this.#liveWorker();
				await worker.close({ save: request.save });
				return { closed: true };
			}
		}
	}

	async #liveWorker(): Promise<IdaWorker> {
		await this.#opening;
		const worker = this.#worker;
		if (!worker || this.#stopping) throw new ToolError(`IDA database ${this.#config.loc.id} is closing`);
		return worker;
	}
}

/** Run the IDA host selected by the CLI worker dispatcher; exits with the host's status. */
export async function startIdaHostFromEnvironment(): Promise<void> {
	const raw = process.env[IDA_HOST_CONFIG_ENV];
	if (!raw) throw new Error("IDA host environment is incomplete");
	delete process.env[IDA_HOST_CONFIG_ENV];
	const config = parseIdaHostConfig(raw);
	setProcessName(`omp ida ${config.loc.id}`);
	const host = new IdaHost(config);
	const cancelCleanup = postmortem.register("ida-host", () => host.shutdown());
	let code: number;
	try {
		try {
			await host.listen();
		} catch (error) {
			// EADDRINUSE: a live host already serves this database; ours must not touch its endpoint.
			process.stderr.write(`IDA host listen failed: ${errorMessage(error)}\n`);
			await host.abandon();
			process.exit(1);
		}
		process.stdout.write(`${idaHostReadyBanner(config.endpoint)}\n`);
		code = await host.run();
	} finally {
		cancelCleanup();
	}
	process.exit(code);
}
