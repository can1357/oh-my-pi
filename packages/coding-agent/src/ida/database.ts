/**
 * Client side of the IDA host protocol: one connection to a host (`host.ts`) and the
 * {@link IdaDatabase} view of the database behind it. The host is a broker daemon reached over an
 * IPC endpoint, or, while the OS sandbox is active, an in-process host reached over an `IdaLink`.
 */
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { IdaLink } from "./link";
import {
	errorMessage,
	type IdaCallMethod,
	type IdaHostRequest,
	type IdaHostResponse,
	type IdaHostStatus,
	parseIdaHostResponse,
	parseIdaHostStatus,
} from "./protocol";
import type { FatSelection } from "./store";
import type { IdaDatabaseInfo, IdaRequestOptions } from "./supervisor";

const CONNECT_TIMEOUT_MS = 3_000;

/** The host connection dropped (host exited or is exiting). */
export class IdaHostGoneError extends ToolError {}

/** Connect to `endpoint`; undefined when nothing listens there. */
export function connectSocket(endpoint: string): Promise<IpcConnection | undefined> {
	return IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS }).catch(() => undefined);
}

/** Where a host's logs are: a daemon has `omp ps logs`; an in-process host logs with omp. */
function exitedMessage(name: string, local: boolean): string {
	return local ? `IDA host ${name} exited` : `IDA host ${name} exited; see \`omp ps logs ${name}\``;
}

/** One connection to a host: numbered requests, responses matched by id. */
export class HostConnection {
	readonly #name: string;
	readonly #local: boolean;
	readonly #conn: IdaLink;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#open = true;

	constructor(name: string, conn: IdaLink, onClose: () => void, local = false) {
		this.#name = name;
		this.#local = local;
		this.#conn = conn;
		conn.start(
			line => this.#onLine(line),
			reason => {
				if (reason) logger.debug("IDA host connection error", { name, error: reason });
				this.#open = false;
				const error = new IdaHostGoneError(exitedMessage(name, local));
				for (const entry of this.#pending.values()) entry.reject(error);
				this.#pending.clear();
				onClose();
			},
		);
	}

	get open(): boolean {
		return this.#open;
	}

	nextId(): number {
		return this.#nextId++;
	}

	/** Send `request` and wait for its answer; host-side failures reject with a {@link ToolError}. */
	call(request: IdaHostRequest): Promise<unknown> {
		if (!this.#open) return Promise.reject(new IdaHostGoneError(exitedMessage(this.#name, this.#local)));
		const entry = Promise.withResolvers<unknown>();
		this.#pending.set(request.id, entry);
		this.#conn.send(JSON.stringify(request));
		return entry.promise;
	}

	/** Send a request that has no answer (`cancel`). */
	notify(request: IdaHostRequest): void {
		this.#conn.send(JSON.stringify(request));
	}

	close(): void {
		this.#conn.destroy();
	}

	#onLine(line: string): void {
		let response: IdaHostResponse;
		try {
			response = parseIdaHostResponse(line);
		} catch (error) {
			logger.warn("IDA host sent a malformed response", { name: this.#name, error: errorMessage(error) });
			return;
		}
		const entry = this.#pending.get(response.id);
		if (!entry) return;
		this.#pending.delete(response.id);
		if (response.ok) entry.resolve(response.result);
		else entry.reject(new ToolError(response.error));
	}
}

/** How {@link IdaDatabase.connect} reaches and tracks a host. */
export interface IdaConnectOptions {
	/** The host runs inside this omp process (contained mode), not as a broker daemon. */
	local?: boolean;
	/** The connection ended; `db` is undefined when it dropped before the first status arrived. */
	onClose(db: IdaDatabase | undefined): void;
}

/**
 * An open IDA database as seen from this omp process: a connection to its host plus the last
 * reported {@link IdaHostStatus}. Shared by every agent in the process.
 */
export class IdaDatabase {
	/** Host name: the broker daemon (`omp ps` row, `omp ps logs <name>`), or its in-process counterpart. */
	readonly name: string;
	readonly #conn: HostConnection;
	#status: IdaHostStatus;

	private constructor(name: string, conn: HostConnection, status: IdaHostStatus) {
		this.name = name;
		this.#conn = conn;
		this.#status = status;
	}

	/**
	 * Connect to the broker daemon `name` at `endpoint` and fetch its status (`open` waits for the
	 * database to open). Undefined when no host listens; throws the host's open failure.
	 */
	static async attach(
		name: string,
		endpoint: string,
		op: "open" | "status",
		onClose: IdaConnectOptions["onClose"],
	): Promise<IdaDatabase | undefined> {
		const socket = await connectSocket(endpoint);
		return socket ? IdaDatabase.connect(name, socket, op, { onClose }) : undefined;
	}

	/** Fetch the status of the host at the other end of `link`; on failure the link is closed and the error thrown. */
	static async connect(
		name: string,
		link: IdaLink,
		op: "open" | "status",
		options: IdaConnectOptions,
	): Promise<IdaDatabase> {
		let db: IdaDatabase | undefined;
		const conn = new HostConnection(name, link, () => options.onClose(db), options.local);
		try {
			const status = parseIdaHostStatus(await conn.call({ id: conn.nextId(), op }));
			db = new IdaDatabase(name, conn, status);
			return db;
		} catch (error) {
			conn.close();
			throw error;
		}
	}

	/** Registry key from `locateIdb`. */
	get id(): string {
		return this.#status.id;
	}

	/** Reference `read` and `ida db=` resolve back to this database (see `idbRef`). */
	get ref(): string {
		return this.#status.ref;
	}

	/** For universal binaries: the analyzed slice and its siblings. */
	get fat(): FatSelection | undefined {
		return this.#status.fat;
	}

	/** Path of the IDB file as reported by IDA. */
	get idbPath(): string {
		return this.#status.idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): IdaDatabaseInfo {
		return this.#status.info;
	}

	/** Last status fetched from the host. */
	get status(): IdaHostStatus {
		return this.#status;
	}

	/** Whether the host connection is still up. */
	get connected(): boolean {
		return this.#conn.open;
	}

	/** Refetch the host's status; `open` first waits for the database to finish opening. */
	async refresh(op: "open" | "status" = "status"): Promise<IdaHostStatus> {
		this.#status = parseIdaHostStatus(await this.#conn.call({ id: this.#conn.nextId(), op }));
		return this.#status;
	}

	/**
	 * Run one worker request on the host, queued behind requests from every omp process.
	 * `timeoutMs` covers the queue wait; an abort cancels this request only (see `IdaWorker.request`).
	 */
	async request<T>(method: IdaCallMethod, params: object, options: IdaRequestOptions = {}): Promise<T> {
		const { signal, timeoutMs } = options;
		signal?.throwIfAborted();
		const id = this.#conn.nextId();
		const answer = this.#conn.call({ id, op: "call", method, params, timeoutMs });
		const onAbort = () => this.#conn.notify({ id: this.#conn.nextId(), op: "cancel", target: id });
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// The worker answers with the JSON shape documented for `method`.
			return (await untilAborted(signal, answer)) as T;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Save when the database has unsaved changes. */
	async flush(): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "flush" });
	}

	/** Close the database (saving first when `save`); its host exits afterwards. */
	async close(options: { save: boolean }): Promise<void> {
		await this.#conn.call({ id: this.#conn.nextId(), op: "close", save: options.save });
	}

	/** Drop this process's connection; the host keeps running. */
	disconnect(): void {
		this.#conn.close();
	}
}
