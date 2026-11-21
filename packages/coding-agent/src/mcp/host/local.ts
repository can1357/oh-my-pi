/**
 * The MCP host inside the session process, for when no daemon serves MCP:
 * the same {@link McpEndpoint} units, found or created by unit key, held by
 * lease counts and reached through in-memory pipes instead of sockets.
 *
 * Nothing outlives the process here, so a unit stops as soon as its last
 * lease is released: no other process could adopt it, and a lingering child
 * would be orphaned when the session exits.
 */
import { isBunTestRuntime, logger, postmortem } from "@oh-my-pi/pi-utils";
import { spawnManagedChild } from "../../daemon/children";
import type { ModuleClient, ModuleTunnel } from "../../daemon/module";
import { moduleStateDir } from "../../daemon/paths";
import {
	MCP_MODULE_KIND,
	type McpAttachment,
	type McpAttachRequest,
	type McpHostAccess,
	type McpResolveResult,
	type McpServerSpec,
	type McpTunnel,
	mcpUnitKey,
} from "./contract";
import { McpEndpoint, McpEraResolver } from "./endpoint";
import type { McpUpstreams } from "./peer";
import { mcpUpstreams } from "./peers";
import { McpStore } from "./store";

/** How often a released unit that is still finishing work is checked again. */
const RELEASE_POLL_MS = 50;

const LOCAL_CLIENT: ModuleClient = { connectionId: "local", pid: process.pid, build: "" };

const encoder = new TextEncoder();

/**
 * One end of an in-memory tunnel. Bytes and the close reach the other end on
 * a later microtask, in order, so handlers re-enter as they would on a socket.
 */
class PipeEnd implements McpTunnel, ModuleTunnel {
	readonly client = LOCAL_CLIENT;
	#other: PipeEnd | undefined;
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: ((reason: string | null) => void) | undefined;
	#buffered: Uint8Array[] = [];
	#closing = false;
	#ended = false;

	static pair(): [PipeEnd, PipeEnd] {
		const a = new PipeEnd();
		const b = new PipeEnd();
		a.#other = b;
		b.#other = a;
		return [a, b];
	}

	send(data: string | Uint8Array): boolean {
		if (this.#closing) return true;
		const chunk = typeof data === "string" ? encoder.encode(data) : data;
		const other = this.#other;
		if (other) queueMicrotask(() => other.#receive(chunk));
		return true;
	}

	drained(): Promise<void> {
		return Promise.resolve();
	}

	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void {
		if (this.#onData) throw new Error("MCP pipe already started");
		this.#onData = onData;
		this.#onClose = onClose;
		const buffered = this.#buffered;
		this.#buffered = [];
		for (const chunk of buffered) onData(chunk);
		if (this.#ended) onClose(null);
	}

	close(): void {
		if (this.#closing) return;
		this.#closing = true;
		const other = this.#other;
		queueMicrotask(() => {
			if (other) other.#end();
			this.#end();
		});
	}

	#receive(chunk: Uint8Array): void {
		if (this.#ended) return;
		if (this.#onData) this.#onData(chunk);
		else this.#buffered.push(chunk);
	}

	#end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#closing = true;
		this.#onClose?.(null);
	}
}

interface LocalUnit {
	endpoint: McpEndpoint;
	leases: number;
}

/** Construction parameters of {@link LocalMcpHost}. */
export interface LocalMcpHostOptions {
	/** Owned by the host from here on: {@link LocalMcpHost.dispose} closes it. */
	store: McpStore;
	upstreams: McpUpstreams;
}

/** MCP units living in this process; see the module comment. */
export class LocalMcpHost implements McpHostAccess {
	readonly shared = false;
	readonly #store: McpStore;
	readonly #upstreams: McpUpstreams;
	readonly #resolver: McpEraResolver;
	readonly #units = new Map<string, LocalUnit>();
	/** Units released by their last session and still shutting down. */
	readonly #stopping = new Set<Promise<void>>();
	#disposed = false;

	constructor(options: LocalMcpHostOptions) {
		this.#store = options.store;
		this.#upstreams = options.upstreams;
		this.#resolver = new McpEraResolver(options.store, options.upstreams, spawnManagedChild);
	}

	async resolve(spec: McpServerSpec, signal?: AbortSignal): Promise<McpResolveResult> {
		if (this.#disposed) throw new Error("MCP host is disposed");
		return { era: await this.#resolver.resolve(spec, signal) };
	}

	async attach(request: McpAttachRequest, signal?: AbortSignal): Promise<McpAttachment> {
		signal?.throwIfAborted();
		if (this.#disposed) throw new Error("MCP host is disposed");
		const key = mcpUnitKey(request.spec, request.era, request.instance);
		let unit = this.#units.get(key);
		if (!unit) {
			const endpoint = new McpEndpoint({
				unitId: `local:${key}`,
				spec: request.spec,
				era: request.era,
				name: request.name,
				store: this.#store,
				upstreams: this.#upstreams,
				deps: { spawn: spawnManagedChild },
				idleMs: request.idleMs,
				changed: () => {},
			});
			unit = { endpoint, leases: 0 };
			this.#units.set(key, unit);
		}
		unit.leases++;
		const [sessionEnd, unitEnd] = PipeEnd.pair();
		unit.endpoint.attach(unitEnd);
		const held = unit;
		let released = false;
		return {
			tunnel: sessionEnd,
			release: () => {
				if (released) return;
				released = true;
				held.leases--;
				this.#collect(key, held);
			},
		};
	}

	/** The local host is never replaced under its sessions. */
	onReconnect(): () => void {
		return () => {};
	}

	/**
	 * Stop every unit and abort every probe, then close the store. Resolves
	 * only when no process the host started is left, units already being
	 * collected included.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const stops = Array.from(this.#units.values(), unit => unit.endpoint.stop("host disposed"));
		this.#units.clear();
		await Promise.all([this.#resolver.dispose(), ...stops, ...this.#stopping]);
		this.#store.close();
	}

	/** Stop an unleased unit, once the work its last session left behind has wound down. */
	#collect(key: string, unit: LocalUnit): void {
		if (unit.leases > 0 || this.#units.get(key) !== unit) return;
		if (unit.endpoint.busy()) {
			setTimeout(() => this.#collect(key, unit), RELEASE_POLL_MS).unref();
			return;
		}
		this.#units.delete(key);
		const stopping = unit.endpoint
			.stop("released")
			.catch(error => {
				logger.debug("MCP unit stop failed", { unit: key, error: String(error) });
			})
			.finally(() => this.#stopping.delete(stopping));
		this.#stopping.add(stopping);
	}
}

let host: LocalMcpHost | undefined;
let cancelExitCleanup: (() => void) | undefined;

/**
 * The process-wide in-process host, created on first use. Test runs keep
 * their store in memory so they never read or write the user's cache.
 */
export function localMcpHost(): LocalMcpHost {
	if (!host) {
		host = new LocalMcpHost({
			store: isBunTestRuntime() ? McpStore.memory() : McpStore.open(moduleStateDir(MCP_MODULE_KIND)),
			upstreams: mcpUpstreams,
		});
		cancelExitCleanup ??= postmortem.register("mcp-local-host", () => disposeLocalMcpHost());
	}
	return host;
}

/** Stop every unit of the in-process host and close its store; the next use starts a fresh one. */
export async function disposeLocalMcpHost(): Promise<void> {
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
	const current = host;
	host = undefined;
	await current?.dispose();
}
