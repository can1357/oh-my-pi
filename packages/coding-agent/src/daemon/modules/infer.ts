/**
 * `infer` daemon module: one unit per loaded local model (tiny-model ONNX or
 * MLX worker, mnemopi fastembed worker), each a child of the daemon.
 *
 * Children speak LF-delimited JSON over stdin/stdout (logs go to stderr).
 * Every attached tunnel speaks the same JSONL protocol as the child (`ping`,
 * `load`/`chat` for tiny, `init`/`embed` for embeddings); the unit rewrites
 * request ids per tunnel, routes replies back, counts in-flight work for
 * {@link ModuleUnit.busy}, and fails a tunnel's requests when the child dies.
 * The tiny workers serialize their own work; the embed worker runs requests
 * concurrently, and an `embed` exceeding {@link INFER_EMBED_TIMEOUT_MS} gets
 * its (wedged) child SIGKILLed and lazily respawned on the next request.
 *
 * Children are always SIGKILLed, never asked to exit: `onnxruntime-node`'s
 * NAPI finalizer must never run (issues #1606, #3031).
 *
 * The client half ({@link InferConnection}) lives here too so both ends of the
 * contract stay in one file.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClient } from "../client";
import type { DaemonModule, ManagedChild, ModuleContext, ModuleOpen, ModuleTunnel, ModuleUnit } from "../module";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE, type UnitPolicy } from "../protocol";

/** Unit kind and `call` module name. */
export const INFER_KIND = "infer";
/** Default idle grace after the last lease and request end. */
export const INFER_IDLE_MS = 15 * 60 * 1_000;
/**
 * How long an {@link InferConnection} keeps its lease after its last request
 * settles (capped at the unit's idle grace). Bounds a burst's reconnect churn
 * while letting a unit idle-stop as documented instead of when its client exits
 * (issue #20452).
 */
export const INFER_LINGER_MS = 10_000;
/** Bound on one steady-state `embed`; a longer stall means a hung native runtime (issues #4792, #7352). */
export const INFER_EMBED_TIMEOUT_MS = 120_000;
/** Prefix of the error a client sees when its tunnel to an infer unit closes. */
export const INFER_CONNECTION_CLOSED = "infer connection closed";

const STDERR_TAIL_CHARS = 2_000;
/** Replies that settle a request; `progress` (and anything else) only streams. */
const TERMINAL_REPLIES: Record<string, true> = {
	pong: true,
	loaded: true,
	text: true,
	ready: true,
	vectors: true,
	error: true,
};

/** Launch parameters of one infer unit; read only when the unit is created. */
export interface InferParams {
	/** `tiny` units end with their child; `embed` units respawn it lazily and reap wedged embeds. */
	worker: "tiny" | "embed";
	label: string;
	application: string;
	args: string[];
	cwd: string;
	/** Complete child environment (from `inferenceWorkerEnv`). */
	env: Record<string, string>;
	/** Idle grace override (`OMP_TINY_WORKER_IDLE_MS` / `OMP_MNEMOPI_EMBED_IDLE_MS`). */
	idleMs?: number;
}

/** Every request on an infer tunnel or child stdin. */
interface WireMessage {
	type: string;
	id?: string;
	[field: string]: unknown;
}

/** Split a byte stream into LF-terminated lines. */
function lineSplitter(onLine: (line: string) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffered = "";
	return chunk => {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) onLine(line);
			newline = buffered.indexOf("\n");
		}
	};
}

function parseMessage(line: string): WireMessage | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (value && typeof value === "object" && typeof (value as WireMessage).type === "string") {
			return value as WireMessage;
		}
	} catch {
		// Not JSON: stray stdout from a native library.
	}
	return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	for (const key in record) if (typeof record[key] !== "string") return false;
	return true;
}

function parseParams(value: unknown): InferParams {
	const params = value as Partial<InferParams> | undefined;
	if (
		!params ||
		(params.worker !== "tiny" && params.worker !== "embed") ||
		typeof params.label !== "string" ||
		typeof params.application !== "string" ||
		!Array.isArray(params.args) ||
		typeof params.cwd !== "string" ||
		!isStringRecord(params.env)
	) {
		throw new Error("infer: invalid unit params");
	}
	return params as InferParams;
}

interface TunnelState {
	tunnel: ModuleTunnel;
	open: boolean;
}

interface InFlight {
	tunnel: TunnelState;
	/** The client's own request id. */
	id: string;
	timer?: NodeJS.Timeout;
}

/** One loaded model: its worker child plus the routing between tunnels and that child. */
class InferUnit implements ModuleUnit {
	readonly label: string;
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	#ctx: ModuleContext;
	#unitId: string;
	#params: InferParams;
	#child: ManagedChild | undefined;
	#stderrTail = "";
	#inFlight = new Map<string, InFlight>();
	/**
	 * Reaper timers of `embed` requests whose tunnel closed while the current
	 * child still runs them, keyed by child-side id. Nobody awaits the answer,
	 * but a wedged child must still die at the original deadline.
	 */
	#orphanedReapers = new Map<string, NodeJS.Timeout>();
	#tunnels = new Set<TunnelState>();
	#nextId = 0;
	#stopped = false;
	#finish: (result: { exitCode?: number; reason?: string }) => void;

	constructor(ctx: ModuleContext, unitId: string, params: InferParams) {
		this.#ctx = ctx;
		this.#unitId = unitId;
		this.#params = params;
		this.label = params.label;
		const { promise, resolve } = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
		this.exited = promise;
		this.#finish = resolve;
		this.#spawn();
	}

	pids(): number[] {
		return this.#child ? [this.#child.pid] : [];
	}

	busy(): boolean {
		return this.#inFlight.size > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		if (this.#stopped) {
			tunnel.close();
			return;
		}
		const state: TunnelState = { tunnel, open: true };
		this.#tunnels.add(state);
		tunnel.start(
			lineSplitter(line => {
				const request = parseMessage(line);
				if (!request || typeof request.id !== "string") {
					logger.debug("infer: malformed tunnel request", { unit: this.#unitId });
					return;
				}
				this.#forward(state, request, request.id);
			}),
			() => {
				state.open = false;
				this.#tunnels.delete(state);
				// Nobody reads these answers, and a request the child never answers must
				// not keep the unit busy forever; late replies find no entry and are dropped.
				// An embed's reaper keeps running: the child may be wedged on it.
				for (const [id, entry] of this.#inFlight) {
					if (entry.tunnel !== state) continue;
					this.#inFlight.delete(id);
					if (entry.timer) this.#orphanedReapers.set(id, entry.timer);
				}
			},
		);
	}

	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		const child = this.#child;
		this.#child = undefined;
		child?.kill("SIGKILL");
		this.#clearOrphanedReapers();
		this.#failAll(`${this.label} stopped: ${reason}`);
		if (child) await child.exited.catch(() => undefined);
		this.#end({ reason });
	}

	#spawn(): ManagedChild {
		const { application, args, env, cwd } = this.#params;
		const child = this.#ctx.spawn({ application, args, env, cwd });
		this.#child = child;
		this.#stderrTail = "";
		const stderr = new TextDecoder();
		child.onStdout(lineSplitter(line => this.#onChildLine(child, line)));
		child.onStderr(chunk => {
			this.#stderrTail = (this.#stderrTail + stderr.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
		});
		void child.exited.then(exit => this.#onChildExit(child, exit.exitCode, exit.signal));
		this.#ctx.changed(this.#unitId);
		return child;
	}

	#forward(tunnel: TunnelState, request: WireMessage, clientId: string): void {
		if (this.#stopped) {
			this.#reply(tunnel, { type: "error", id: clientId, error: `${this.label} stopped` });
			return;
		}
		let child = this.#child;
		if (!child) {
			try {
				child = this.#spawn();
			} catch (error) {
				this.#reply(tunnel, {
					type: "error",
					id: clientId,
					error: `${this.label} failed to start: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
		}
		const id = String(++this.#nextId);
		const entry: InFlight = { tunnel, id: clientId };
		if (this.#params.worker === "embed" && request.type === "embed") {
			const wedged = child;
			entry.timer = setTimeout(() => this.#reap(wedged), INFER_EMBED_TIMEOUT_MS);
		}
		this.#inFlight.set(id, entry);
		child.write(`${JSON.stringify({ ...request, id })}\n`);
	}

	#onChildLine(child: ManagedChild, line: string): void {
		if (child !== this.#child) return;
		const message = parseMessage(line);
		if (!message) {
			logger.debug("infer: non-protocol worker output", { unit: this.#unitId, line: line.slice(0, 200) });
			return;
		}
		if (message.type === "log") {
			logger.debug(`infer: ${String(message.msg ?? "")}`, { unit: this.#unitId, level: message.level });
			return;
		}
		if (typeof message.id !== "string") return;
		const entry = this.#inFlight.get(message.id);
		if (!entry) {
			// The child answered an orphaned embed: it is not wedged on it after all.
			const reaper = this.#orphanedReapers.get(message.id);
			if (reaper && TERMINAL_REPLIES[message.type] === true) {
				clearTimeout(reaper);
				this.#orphanedReapers.delete(message.id);
			}
			return;
		}
		if (TERMINAL_REPLIES[message.type] === true) {
			this.#inFlight.delete(message.id);
			clearTimeout(entry.timer);
		}
		this.#reply(entry.tunnel, { ...message, id: entry.id });
	}

	#onChildExit(child: ManagedChild, exitCode: number | undefined, signal: number | undefined): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		this.#clearOrphanedReapers();
		const status = signal !== undefined ? `signal ${signal}` : `code ${exitCode ?? "?"}`;
		const tail = this.#stderrTail.trim().slice(-500);
		this.#failAll(`${this.label} exited with ${status}${tail ? `: ${tail}` : ""}`);
		if (this.#params.worker === "tiny") {
			this.#end({ exitCode, reason: `worker exited with ${status}` });
			return;
		}
		// Embed units respawn on the next request.
		this.#ctx.changed(this.#unitId);
	}

	/** SIGKILL a wedged embed child; the next request gets a fresh one. */
	#reap(child: ManagedChild): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		logger.warn("infer: embed request timed out; killing worker", { unit: this.#unitId, pid: child.pid });
		child.kill("SIGKILL");
		this.#clearOrphanedReapers();
		this.#failAll(`${this.label} request timed out`);
		this.#ctx.changed(this.#unitId);
	}

	/** The child running the orphaned embeds is gone; their reapers have nothing left to kill. */
	#clearOrphanedReapers(): void {
		for (const timer of this.#orphanedReapers.values()) clearTimeout(timer);
		this.#orphanedReapers.clear();
	}

	#failAll(error: string): void {
		const entries = [...this.#inFlight.values()];
		this.#inFlight.clear();
		for (const entry of entries) {
			clearTimeout(entry.timer);
			this.#reply(entry.tunnel, { type: "error", id: entry.id, error });
		}
	}

	#reply(tunnel: TunnelState, message: WireMessage): void {
		if (tunnel.open) tunnel.tunnel.send(`${JSON.stringify(message)}\n`);
	}

	#end(result: { exitCode?: number; reason?: string }): void {
		this.#stopped = true;
		for (const state of this.#tunnels) {
			state.open = false;
			state.tunnel.close();
		}
		this.#tunnels.clear();
		this.#finish(result);
	}
}

/** Daemon module hosting the local inference workers. */
export const inferModule: DaemonModule = {
	kind: INFER_KIND,
	version: 1,
	policy(params: unknown): UnitPolicy {
		const idleMs = (params as Partial<InferParams> | undefined)?.idleMs;
		return {
			hold: "leases",
			idleMs: typeof idleMs === "number" && idleMs >= 0 ? idleMs : INFER_IDLE_MS,
			onIdle: "stop",
			restart: "no",
			survive: "none",
		};
	},
	open(context: ModuleContext, request: ModuleOpen): ModuleUnit {
		return new InferUnit(context, request.unitId, parseParams(request.params));
	},
};

// ── Client half ──────────────────────────────────────────────────────

/** What a client opens: the unit identity plus its launch parameters. */
export interface InferOpenSpec {
	/** `tiny:<modelKey>:<backend>:<device>:<dtype>` or `embed:<model>:<cacheDirHash>`. */
	key: string;
	params: InferParams;
	policy?: Partial<UnitPolicy>;
}

/**
 * One client tunnel to an infer unit. Sends queue until the unit is open and
 * attached; a failed open, a closed tunnel (the unit stopped or its worker
 * exited), a daemon restart, or {@link INFER_LINGER_MS} without a request in
 * flight ends the connection once through `onClose` (callers drop it and open a
 * new one on next use). Ending on idle releases the lease, so the daemon's idle
 * grace runs from the last request, not from the client's exit.
 *
 * The process stays alive exactly while a request awaits its terminal reply:
 * the tunnel and the linger timer are unref'd, so an idle connection never
 * holds a short-lived (print-mode) process at exit.
 */
export class InferConnection<Req extends { id: string }, Res extends { type: string; id?: string }> {
	#queue: string[] = [];
	#client: DaemonClient | undefined;
	#tunnel: DaemonTunnel | undefined;
	#lease: string | undefined;
	#release: Promise<void> | undefined;
	#unsubscribeReconnect: (() => void) | undefined;
	#closed = false;
	/** Ids of requests still awaiting a terminal reply. */
	#inFlight = new Set<string>();
	#keepAlive: NodeJS.Timeout | undefined;
	#linger: NodeJS.Timeout | undefined;
	#lingerMs = INFER_LINGER_MS;
	#onMessage: (message: Res) => void;
	#onClose: (error: Error) => void;

	constructor(spec: () => Promise<InferOpenSpec>, onMessage: (message: Res) => void, onClose: (error: Error) => void) {
		this.#onMessage = onMessage;
		this.#onClose = onClose;
		void this.#connect(spec).catch((error: unknown) =>
			this.#end(error instanceof Error ? error : new Error(String(error))),
		);
		this.#armLinger();
	}

	/** Queue or send one request; throws once the connection ended (callers open a new one). */
	send(message: Req): void {
		if (this.#closed) throw new Error(INFER_CONNECTION_CLOSED);
		this.#inFlight.add(message.id);
		clearTimeout(this.#linger);
		this.#linger = undefined;
		this.#keepAlive ??= setInterval(() => {}, 1 << 30);
		const line = `${JSON.stringify(message)}\n`;
		if (this.#tunnel) this.#tunnel.send(line);
		else this.#queue.push(line);
	}

	/** Stop waiting for `id` (aborted by the caller); its late reply still reaches `onMessage`. */
	abandon(id: string): void {
		this.#settled(id);
	}

	/**
	 * Drop the tunnel and the lease; the unit keeps serving other clients until
	 * idle. Resolves once the daemon processed the release (never rejects).
	 */
	close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			this.#queue = [];
			this.#settled(undefined);
			this.#unsubscribeReconnect?.();
			this.#tunnel?.close();
			this.#releaseLease();
		}
		return this.#release ?? Promise.resolve();
	}

	#releaseLease(): void {
		const lease = this.#lease;
		const client = this.#client;
		this.#lease = undefined;
		if (lease && client) this.#release = client.release(lease).catch(() => undefined);
	}

	/** A terminal reply arrived for `id` (undefined: everything ended). */
	#settled(id: string | undefined): void {
		if (id === undefined) this.#inFlight.clear();
		else this.#inFlight.delete(id);
		if (this.#inFlight.size > 0) return;
		clearInterval(this.#keepAlive);
		this.#keepAlive = undefined;
		this.#armLinger();
	}

	/** Nothing in flight: end the connection (dropping its lease) unless a request arrives first. */
	#armLinger(): void {
		clearTimeout(this.#linger);
		this.#linger = undefined;
		if (this.#closed) return;
		this.#linger = setTimeout(() => this.#end(new Error(`${INFER_CONNECTION_CLOSED}: idle`)), this.#lingerMs).unref();
	}

	async #connect(spec: () => Promise<InferOpenSpec>): Promise<void> {
		const { key, params, policy } = await spec();
		this.#lingerMs = Math.min(INFER_LINGER_MS, policy?.idleMs ?? params.idleMs ?? INFER_IDLE_MS);
		if (this.#closed) return;
		const client = await daemonClient();
		if (this.#closed) return;
		this.#client = client;
		const { unit, lease } = await client.open({
			kind: INFER_KIND,
			scope: GLOBAL_SCOPE,
			key,
			label: params.label,
			params,
			policy,
		});
		this.#lease = lease;
		if (this.#closed) {
			this.#releaseLease();
			return;
		}
		let tunnel: DaemonTunnel;
		try {
			tunnel = await client.attach(unit.id);
		} catch (error) {
			// Not attached: the lease would pin the unit for this connection's lifetime.
			this.#releaseLease();
			throw error;
		}
		if (this.#closed) {
			tunnel.close();
			return;
		}
		tunnel.unref();
		this.#tunnel = tunnel;
		this.#unsubscribeReconnect = client.onReconnect(() =>
			this.#end(new Error(`${INFER_CONNECTION_CLOSED}: daemon restarted`)),
		);
		tunnel.start(
			lineSplitter(line => {
				let message: Res;
				try {
					message = JSON.parse(line) as Res;
				} catch (error) {
					logger.debug("infer: malformed reply line", { error: String(error) });
					return;
				}
				if (TERMINAL_REPLIES[message.type] === true && typeof message.id === "string") this.#settled(message.id);
				try {
					this.#onMessage(message);
				} catch (error) {
					logger.warn("infer: reply handler failed", { error: String(error) });
				}
			}),
			reason => this.#end(new Error(reason ? `${INFER_CONNECTION_CLOSED}: ${reason}` : INFER_CONNECTION_CLOSED)),
		);
		const queued = this.#queue;
		this.#queue = [];
		for (const line of queued) tunnel.send(line);
	}

	#end(error: Error): void {
		if (this.#closed) return;
		void this.close();
		this.#onClose(error);
	}
}

/**
 * Distribution smoke test: open the unit (its own key) with no idle grace,
 * wait for the worker child's `pong`, then release the lease so the daemon
 * stops it at once. Proves the worker selector boots and speaks the stdio
 * protocol in binary, source-link, and tarball installs.
 */
export async function smokeTestInferWorker(spec: InferOpenSpec, timeoutMs: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const connection = new InferConnection<{ type: "ping"; id: string }, { type: string; error?: string }>(
		async () => ({ ...spec, policy: { ...spec.policy, idleMs: 0 } }),
		message => {
			if (message.type === "pong") resolve();
			else if (message.type === "error") reject(new Error(`${spec.params.label}: ${message.error ?? "error"}`));
		},
		reject,
	);
	const timer = setTimeout(
		() => reject(new Error(`${spec.params.label} did not answer ping within ${timeoutMs}ms`)),
		timeoutMs,
	);
	connection.send({ type: "ping", id: "smoke" });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		await connection.close();
	}
}
