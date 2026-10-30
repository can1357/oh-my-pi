import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { logger, postmortem } from "@oh-my-pi/pi-utils";

/** Writes one JSON line back to the connection a request arrived on. */
export interface JsonLineReply<Res> {
	send(message: Res): void;
}

export interface JsonLineServerOptions<Req, Res> {
	/** Log scope. */
	name: string;
	/** `postmortem` cleanup label. */
	cleanupLabel: string;
	/** Idle window (nothing {@link JsonLineServer.busy}, no request received) after which the process exits. */
	idleMs: number;
	/** Stdout line announcing the bound endpoint. */
	banner(endpoint: string): string;
	/** Handle one parsed request line; `reply` reaches only the requesting connection. */
	onRequest(request: Req, reply: JsonLineReply<Res>): void;
	/** Runs synchronously as stop begins, before connections and the listener close. */
	beforeStop?(): void;
	/** Runs once during stop, after the listener closes. */
	onStop?(): Promise<void>;
}

/**
 * Newline-JSON request loop over a native {@link IpcServer}: the server half of
 * the machine-shared workers (`shared-worker.ts` is the client half;
 * `mlx-server.py` mirrors it in Python) and of the text-prediction daemon.
 * Owns one endpoint — binding, owner-only permissions, and taking over a
 * crashed predecessor's socket are native; a live owner makes {@link serve}
 * reject with `EADDRINUSE` — feeds every connection's request lines to
 * `onRequest`, and exits the process once idle.
 */
export class JsonLineServer<Req, Res> {
	#options: JsonLineServerOptions<Req, Res>;
	#connections = new Set<IpcConnection>();
	#inFlight = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#server: IpcServer | undefined;
	#endpoint = "";
	#stopped = Promise.withResolvers<void>();
	#stopping: Promise<void> | undefined;

	constructor(options: JsonLineServerOptions<Req, Res>) {
		this.#options = options;
	}

	/** Bind `endpoint` and serve until idle exit or {@link exit}; resolves once the endpoint is released. */
	async serve(endpoint: string): Promise<void> {
		this.#endpoint = endpoint;
		this.#server = await IpcServer.listen(endpoint, { framing: "lines" }, connection => this.#accept(connection));
		const cancelCleanup = postmortem.register(this.#options.cleanupLabel, () => this.#shutdown());
		this.#armIdle();
		process.stdout.write(`${this.#options.banner(endpoint)}\n`);
		try {
			await this.#stopped.promise;
		} finally {
			cancelCleanup();
		}
	}

	/** Count `work` as in flight, holding off idle exit until it settles. */
	async busy<T>(work: () => Promise<T>): Promise<T> {
		this.#inFlight += 1;
		this.#armIdle();
		try {
			return await work();
		} finally {
			this.#inFlight -= 1;
			this.#armIdle();
		}
	}

	/** Release the endpoint, then exit the process. */
	exit(reason: string): void {
		logger.debug(`${this.#options.name}: ${reason}; exiting`, { endpoint: this.#endpoint });
		void this.#shutdown().finally(() => process.exit(0));
	}

	#accept(connection: IpcConnection): void {
		this.#connections.add(connection);
		const reply: JsonLineReply<Res> = { send: message => connection.send(JSON.stringify(message)) };
		connection.start(
			line => {
				let request: Req;
				try {
					request = JSON.parse(line) as Req;
				} catch (error) {
					logger.warn(`${this.#options.name}: malformed request line`, { error: String(error) });
					return;
				}
				this.#options.onRequest(request, reply);
			},
			() => this.#connections.delete(connection),
		);
	}

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#inFlight > 0) {
				this.#armIdle();
				return;
			}
			this.exit(`idle for ${this.#options.idleMs}ms`);
		}, this.#options.idleMs);
	}

	#shutdown(): Promise<void> {
		this.#stopping ??= this.#stop();
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		clearTimeout(this.#idleTimer);
		this.#options.beforeStop?.();
		// Clients reconnect on demand.
		for (const connection of this.#connections) connection.destroy();
		this.#connections.clear();
		await this.#server?.close();
		this.#server = undefined;
		await this.#options.onStop?.();
		this.#stopped.resolve();
	}
}
