/**
 * A daemon whose one module unit runs in this process behind in-memory
 * tunnels, for module contract tests: every `attach` is one simulated
 * process's tunnel. Real-daemon cases use `daemon-harness.ts` instead.
 */
import type { DaemonModule, ModuleClient, ModuleContext, ModuleTunnel, ModuleUnit } from "../../src/daemon/module";
import type { DaemonTunnel, DaemonWelcome, OpenRequest, OpenResult, UnitSnapshot } from "../../src/daemon/protocol";

// Modules driven this way use no core services.
const CONTEXT = {} as ModuleContext;
const SNAPSHOT = { id: "local-unit" } as UnitSnapshot;

/** One macrotask: every queued tunnel delivery and its continuations have run. */
export const delivered = (): Promise<void> => Bun.sleep(0);

/** An in-memory tunnel to `unit`; returns the client's end. */
function attachTunnel(unit: ModuleUnit, client: ModuleClient): DaemonTunnel {
	const encoder = new TextEncoder();
	let toUnit: ((chunk: Uint8Array) => void) | undefined;
	let toClient: ((chunk: Uint8Array) => void) | undefined;
	let unitClosed: (() => void) | undefined;
	let clientClosed: ((reason: string | null) => void) | undefined;
	let open = true;
	const close = (): void => {
		if (!open) return;
		open = false;
		unitClosed?.();
		clientClosed?.(null);
	};
	// Asynchronous like a socket: a reply never arrives inside the send that caused it.
	const deliver = (sink: () => ((chunk: Uint8Array) => void) | undefined, data: string | Uint8Array): boolean => {
		const chunk = typeof data === "string" ? encoder.encode(data) : data;
		queueMicrotask(() => {
			if (open) sink()?.(chunk);
		});
		return true;
	};
	const unitEnd: ModuleTunnel = {
		client,
		send: data => deliver(() => toClient, data),
		drained: () => Promise.resolve(),
		start(onData, onClose) {
			toUnit = onData;
			unitClosed = onClose;
		},
		close,
	};
	void unit.attach(unitEnd, undefined);
	return {
		unit: SNAPSHOT,
		send: data => deliver(() => toUnit, data),
		drained: () => Promise.resolve(),
		start(onData, onClose) {
			toClient = onData;
			clientClosed = onClose;
		},
		close,
		ref() {},
		unref() {},
	};
}

/** Serves `module`'s unit in this process; `open` starts a new unit once the last one was stopped. */
export class LocalModuleDaemon {
	readonly welcome: DaemonWelcome;
	/** Client ends, in attach order. */
	readonly tunnels: DaemonTunnel[] = [];
	/** The live unit; a promise so concurrent opens share one. */
	#unit: Promise<ModuleUnit> | undefined;

	constructor(readonly module: DaemonModule) {
		this.welcome = {
			v: 1,
			daemon: { pid: process.pid, build: "test", startedAt: 0 },
			caps: { [module.kind]: module.version },
		};
	}

	async open(request: OpenRequest): Promise<OpenResult> {
		const created = this.#unit === undefined;
		this.#unit ??= Promise.resolve(
			this.module.open(CONTEXT, {
				unitId: SNAPSHOT.id,
				scope: request.scope,
				key: request.key,
				params: undefined,
				client: { connectionId: "opener", pid: process.pid, build: "test" },
			}),
		);
		await this.#unit;
		return { unit: SNAPSHOT, lease: `lease-${this.tunnels.length}`, created };
	}

	async release(): Promise<void> {}

	async attach(): Promise<DaemonTunnel> {
		if (!this.#unit) throw new Error("attach before open");
		const tunnel = attachTunnel(await this.#unit, {
			connectionId: `tunnel-${this.tunnels.length}`,
			pid: process.pid,
			build: "test",
		});
		this.tunnels.push(tunnel);
		return tunnel;
	}

	onReconnect(): () => void {
		return () => {};
	}

	/** The daemon stops the unit (shutdown, upgrade): every tunnel closes. */
	async stop(): Promise<void> {
		const unit = this.#unit;
		this.#unit = undefined;
		await (await unit)?.stop("test");
	}
}
