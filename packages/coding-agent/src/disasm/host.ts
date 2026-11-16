/**
 * Disassembler host daemon: the broker-supervised process behind one open database.
 *
 * `acquireDatabase` (`client.ts`) starts it under the project's daemon broker, so `omp ps`
 * lists it as `omp.<backend>.<id>`. The host listens first, then takes the database lock and
 * opens the database in an {@link DisasmWorker}; every omp process in the project shares that worker
 * over NDJSON ({@link HostRequest}). The host exits once the worker does (`close`, idle close,
 * crash). SIGTERM (broker shutdown after the last omp process leaves, `omp ps stop`) closes the
 * worker first, saving when it has unsaved changes.
 */
import * as fs from "node:fs";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { acquireFileLock, logger, postmortem, setProcessName } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { DISASM_BACKENDS } from "./backend";
import {
	errorMessage,
	formatDatabaseHandle,
	DISASM_HOST_CONFIG_ENV,
	type HostConfig,
	type HostRequest,
	type HostStatus,
	hostReadyBanner,
	parseHostConfig,
	parseHostRequest,
} from "./protocol";
import { databaseRef, prepareStoreDir } from "./store";
import { DisasmWorker } from "./supervisor";

/** How long a host whose open failed keeps answering with the failure before exiting. */
const OPEN_FAILED_LINGER_MS = 10_000;
/** Budget for a `flush` save. */
const FLUSH_TIMEOUT_MS = 120_000;

class DisasmHost {
	readonly #config: HostConfig;
	readonly #reference: string;
	readonly #references = new Set<string>();
	#saveOnRelease = false;
	#closing: Promise<void> | undefined;
	readonly #startedAt = Date.now();
	readonly #opening: Promise<DisasmWorker>;
	readonly #connections = new Set<IpcConnection>();
	/** Request handlers still running; shutdown lets them answer before closing sockets. */
	readonly #inflight = new Set<Promise<void>>();
	#server: IpcServer | undefined;
	/** The open worker; cleared once it exits. */
	#worker: DisasmWorker | undefined;
	#stopping: Promise<void> | undefined;

	constructor(config: HostConfig) {
		this.#config = config;
		this.#reference = formatDatabaseHandle({
			backend: config.backend,
			id: config.loc.id,
			instance: crypto.randomUUID(),
			project: config.projectDir,
		});
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
		let worker: DisasmWorker;
		try {
			worker = await this.#opening;
		} catch (error) {
			process.stderr.write(`${DISASM_BACKENDS[this.#config.backend].label} open failed: ${errorMessage(error)}\n`);
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
				logger.warn(`${DISASM_BACKENDS[this.#config.backend].label} host close failed`, {
					id: this.#config.loc.id,
					error: errorMessage(error),
				});
			}
		}
		await Promise.all(this.#inflight);
		const server = this.#server;
		this.#server = undefined;
		for (const conn of this.#connections) conn.end();
		await server?.close();
	}

	async #open(): Promise<DisasmWorker> {
		const { backend, loc, runtime, idleCloseMs } = this.#config;
		if (loc.kind === "store") await fs.promises.mkdir(loc.dir, { recursive: true });
		const lock = await acquireFileLock(loc.lockTarget, { retries: 1 }).catch(() => {
			throw new ToolError(
				`${DISASM_BACKENDS[backend].label} database ${loc.id} is in use by another omp process outside this project`,
			);
		});
		try {
			await prepareStoreDir(DISASM_BACKENDS[backend], loc);
			const worker = await DisasmWorker.start(DISASM_BACKENDS[backend], loc, runtime, lock, idleCloseMs);
			this.#worker = worker;
			return worker;
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	#status(): HostStatus {
		const { loc } = this.#config;
		const worker = this.#worker;
		if (!worker) {
			return {
				id: loc.id,
				ref: databaseRef(loc),
				handle: this.#reference,
				references: this.#references.size,
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
			handle: this.#reference,
			references: this.#references.size,
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
		const leases = new Set<string>();
		const onLine = (line: string): void => {
			let request: HostRequest;
			try {
				request = parseHostRequest(line);
			} catch (error) {
				logger.warn(`${DISASM_BACKENDS[this.#config.backend].label} host received a malformed request`, {
					error: errorMessage(error),
				});
				return;
			}
			if (request.op === "cancel") {
				calls.get(request.target)?.abort();
				return;
			}
			const handled = this.#handle(request, calls, conn, leases).then(
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
			if (reason) logger.debug(`${DISASM_BACKENDS[this.#config.backend].label} host connection closed`, { reason });
			this.#connections.delete(conn);
			for (const controller of calls.values()) controller.abort();
			if (leases.size > 0) {
				for (const lease of leases) this.#references.delete(lease);
				leases.clear();
				this.#saveOnRelease = true;
				this.#worker?.setReferenceCount(this.#references.size);
				void this.#closeUnreferenced()?.catch(error => {
					logger.warn("Disassembler orphaned-reference close failed", { id: this.#config.loc.id, error: errorMessage(error) });
				});
			}
		});
	}

	async #handle(
		request: Exclude<HostRequest, { op: "cancel" }>,
		calls: Map<number, AbortController>,
		conn: IpcConnection,
		leases: Set<string>,
	): Promise<unknown> {
		switch (request.op) {
			case "ping":
				return "pong";
			case "status":
				return this.#status();
			case "open":
				await this.#opening;
				return this.#status();
			case "retain": {
				const worker = await this.#liveWorker();
				if (!this.#connections.has(conn)) throw new ToolError("Disassembler connection closed before retain completed");
				if (request.handle !== this.#reference) throw new ToolError("dsm handle has expired; the original database is no longer open");
				const lease = crypto.randomUUID();
				leases.add(lease);
				this.#references.add(lease);
				worker.setReferenceCount(this.#references.size);
				return { lease, handle: this.#reference, references: this.#references.size };
			}
			case "release": {
				const worker = await this.#liveWorker();
				if (!leases.delete(request.lease)) throw new ToolError("Database reference is not owned by this connection or was already released");
				this.#references.delete(request.lease);
				this.#saveOnRelease ||= request.save;
				worker.setReferenceCount(this.#references.size);
				await this.#closeUnreferenced();
				return { references: this.#references.size };
			}
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
				await this.#liveWorker();
				if (this.#references.size > 0) {
					throw new ToolError(`Database has ${this.#references.size} active dsm references; each owner must close its own handle`);
				}
				this.#saveOnRelease ||= request.save;
				await this.#closeUnreferenced();
				return { closed: true };
			}
		}
	}

	/** The zero-reference transition starts closing synchronously, before another retain can enter. */
	#closeUnreferenced(): Promise<void> | undefined {
		if (this.#references.size > 0 || !this.#worker || this.#stopping) return undefined;
		this.#closing ??= this.#worker.close({ save: this.#saveOnRelease });
		return this.#closing;
	}

	async #liveWorker(): Promise<DisasmWorker> {
		await this.#opening;
		const worker = this.#worker;
		if (!worker || this.#stopping || this.#closing)
			throw new ToolError(
				`${DISASM_BACKENDS[this.#config.backend].label} database ${this.#config.loc.id} is closing`,
			);
		return worker;
	}
}

/** Run the disassembler host selected by the CLI worker dispatcher; exits with its status. */
export async function startDisasmHostFromEnvironment(): Promise<void> {
	const raw = process.env[DISASM_HOST_CONFIG_ENV];
	if (!raw) throw new Error("Disassembler host environment is incomplete");
	delete process.env[DISASM_HOST_CONFIG_ENV];
	const config = parseHostConfig(raw);
	setProcessName(`omp ${config.backend} ${config.loc.id}`);
	const host = new DisasmHost(config);
	const cancelCleanup = postmortem.register("disasm-host", () => host.shutdown());
	let code: number;
	try {
		try {
			await host.listen();
		} catch (error) {
			// EADDRINUSE: a live host already serves this database; ours must not touch its endpoint.
			process.stderr.write(`${DISASM_BACKENDS[config.backend].label} host listen failed: ${errorMessage(error)}\n`);
			await host.abandon();
			process.exit(1);
		}
		process.stdout.write(`${hostReadyBanner(config.backend, config.endpoint)}\n`);
		code = await host.run();
	} finally {
		cancelCleanup();
	}
	process.exit(code);
}
