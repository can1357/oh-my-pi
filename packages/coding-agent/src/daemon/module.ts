/**
 * In-daemon modules: the logic that used to live in per-feature host processes
 * (LSP mux, disassembler host, blob broker, embedding server, text prediction).
 *
 * A module creates {@link ModuleUnit}s on `open` and serves tunnels and calls
 * for them. The daemon core (`units.ts`, `server.ts`) owns identity, leases,
 * idle timers, caps, the board, and persistence; a module never implements
 * its own idle exit or find-or-start.
 *
 * Module code runs on the daemon's event loop: async I/O only. Blocking or
 * crash-prone work (ONNX, Python, user code) goes in a child process.
 */
import type { ProcSpec, UnitPolicy, UnitScope, UnitSnapshot } from "./protocol";

/** The client a request came from. */
export interface ModuleClient {
	/** Unique per connection. */
	connectionId: string;
	pid: number;
	build: string;
	session?: string;
	project?: string;
}

/** Daemon side of an attached tunnel. */
export interface ModuleTunnel {
	readonly client: ModuleClient;
	send(data: string | Uint8Array): boolean;
	drained(): Promise<void>;
	/** Call once, synchronously inside `attach`; bytes received earlier are buffered. */
	start(onData: (chunk: Uint8Array) => void, onClose: () => void): void;
	close(): void;
}

/** Exit of a child process. */
export interface ChildExit {
	exitCode?: number;
	signal?: number;
}

/**
 * A child whose stdio is raw fds owned by the daemon, so it survives an
 * in-place re-exec. Re-created from {@link ManagedChildState} in `restore`.
 */
export interface ManagedChild {
	readonly pid: number;
	/** False once more than 1 MiB is unwritten. */
	write(data: string | Uint8Array): boolean;
	drained(): Promise<void>;
	/** Call each at most once; output produced earlier is buffered. */
	onStdout(sink: (chunk: Uint8Array) => void): void;
	onStderr(sink: (chunk: Uint8Array) => void): void;
	readonly exited: Promise<ChildExit>;
	/** Signal the process group. */
	kill(signal?: NodeJS.Signals): void;
	/** Serializable handle (pid, start time, fds) for {@link ModuleContext.adoptChild}. */
	state(): ManagedChildState;
}

export interface ManagedChildState {
	pid: number;
	startedAt: number;
	stdin: number;
	stdout: number;
	stderr: number;
}

export interface ChildSpawn {
	application: string;
	args: string[];
	/** Complete environment. Never inherit the daemon's: it belongs to whichever client started the daemon. */
	env: Record<string, string>;
	cwd: string;
}

/** Services the core provides to a module. */
export interface ModuleContext {
	/** `<daemonDir>/modules/<kind>`; created on first use. */
	readonly stateDir: string;
	spawn(spec: ChildSpawn): ManagedChild;
	/** Re-attach to a child that survived a re-exec; undefined when it is gone. */
	adoptChild(state: ManagedChildState): ManagedChild | undefined;
	/** Publish a changed snapshot (pids, label) of a unit this module owns. */
	changed(unitId: string): void;
	/** Find a live unit of this module's kind. */
	unit(scope: UnitScope, key: string): ModuleUnit | undefined;
}

export interface ModuleOpen {
	unitId: string;
	scope: UnitScope;
	key: string;
	params: unknown;
	proc?: ProcSpec;
	client: ModuleClient;
}

/** One live resource of a module: a language server, an open database, a loaded model. */
export interface ModuleUnit {
	/** Board label. */
	label: string;
	/** Every process the unit owns, main one first. */
	pids(): number[];
	/** Resolves once the unit accepts tunnels and calls. */
	ready: Promise<void>;
	/** In-flight work; a busy unit is never idle-stopped or evicted. */
	busy(): boolean;
	/** A client attached. `channel` selects a sub-stream when the unit has several. */
	attach(tunnel: ModuleTunnel, channel: string | undefined): void | Promise<void>;
	/** A lease was released or its connection closed. */
	released?(client: ModuleClient): void;
	/** Save state before an `onIdle: "flush-stop"` stop or a daemon replacement. */
	flush?(): Promise<void>;
	stop(reason: string): Promise<void>;
	/** Settles when the unit is gone, however that happened. */
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	/** Serializable state for re-exec; undefined means the unit cannot survive and is stopped first. */
	snapshot?(): unknown;
}

export interface DaemonModule {
	/** Unit kind and `call` module name. */
	readonly kind: string;
	/** Advertised in `DaemonWelcome.caps`; clients fall back or `upgrade` on mismatch. */
	readonly version: number;
	/** Policy of a unit opened with `params`, before the request's overrides. */
	policy(params: unknown): UnitPolicy;
	init?(context: ModuleContext): Promise<void> | void;
	open(context: ModuleContext, request: ModuleOpen): Promise<ModuleUnit> | ModuleUnit;
	/** `call` op. `unit` is set when the request named one. */
	call?(
		context: ModuleContext,
		method: string,
		params: unknown,
		client: ModuleClient,
		unit: { snapshot: UnitSnapshot; unit: ModuleUnit } | undefined,
	): Promise<unknown>;
	/** Rebuild a unit from its {@link ModuleUnit.snapshot} after a re-exec; undefined drops it. */
	restore?(
		context: ModuleContext,
		request: Omit<ModuleOpen, "client" | "params">,
		state: unknown,
	): Promise<ModuleUnit | undefined>;
	/** A client connection closed. */
	disconnected?(client: ModuleClient): void;
	/** Daemon is stopping or being replaced. */
	dispose?(): Promise<void>;
}
