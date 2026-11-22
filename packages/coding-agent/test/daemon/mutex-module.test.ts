/**
 * The daemon `mutex` module. The lock contracts run the module's unit in this
 * process behind in-memory tunnels, one {@link DaemonMutex} per simulated
 * process; the single-flight case drives two real processes through a real
 * daemon in a private runtime dir (see test/fixtures/daemon-harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonClient } from "../../src/daemon/client";
import type { ModuleClient, ModuleContext, ModuleTunnel, ModuleUnit } from "../../src/daemon/module";
import { DaemonMutex, MUTEX_KIND, MUTEX_VERSION, type MutexDaemon, mutexModule } from "../../src/daemon/modules/mutex";
import type { DaemonTunnel, OpenRequest, OpenResult, UnitSnapshot } from "../../src/daemon/protocol";
import { SkillDescriptionStore } from "../../src/extensibility/skill-descriptions";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

// The mutex module uses no core services.
const CONTEXT = {} as ModuleContext;
const SNAPSHOT = { id: "mutex-unit" } as UnitSnapshot;

/** One macrotask: every queued tunnel delivery and its continuations have run. */
const delivered = (): Promise<void> => Bun.sleep(0);

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

/** A daemon whose mutex unit runs in this process; every attach is one process's tunnel. */
class LocalDaemon implements MutexDaemon {
	readonly welcome = {
		v: 1,
		daemon: { pid: process.pid, build: "test", startedAt: 0 },
		caps: { [MUTEX_KIND]: MUTEX_VERSION },
	};
	/** Client ends, in attach order. */
	readonly tunnels: DaemonTunnel[] = [];
	#unit: ModuleUnit | undefined;

	async open(request: OpenRequest): Promise<OpenResult> {
		const created = this.#unit === undefined;
		this.#unit ??= await mutexModule.open(CONTEXT, {
			unitId: SNAPSHOT.id,
			scope: request.scope,
			key: request.key,
			params: undefined,
			client: { connectionId: "opener", pid: process.pid, build: "test" },
		});
		return { unit: SNAPSHOT, lease: `lease-${this.tunnels.length}`, created };
	}

	async release(): Promise<void> {}

	async attach(): Promise<DaemonTunnel> {
		if (!this.#unit) throw new Error("attach before open");
		const tunnel = attachTunnel(this.#unit, {
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
		await this.#unit?.stop("test");
	}
}

/** One simulated process's mutex on `daemon`. */
function processMutex(daemon: LocalDaemon, waitMs?: number): DaemonMutex {
	return new DaemonMutex("test", { connect: async () => daemon, waitMs });
}

/** Take `key` and record when it was granted. */
function take(mutex: DaemonMutex, key: string): { granted: boolean; release: Promise<() => void> } {
	const taken = { granted: false, release: Promise.resolve(() => {}) };
	taken.release = mutex.lock(key).then(release => {
		taken.granted = true;
		return release;
	});
	return taken;
}

describe("daemon mutex", () => {
	it("grants a key to one process at a time, in the order they asked, and other keys meanwhile", async () => {
		const daemon = new LocalDaemon();
		const first = await processMutex(daemon).lock("k");
		const second = take(processMutex(daemon), "k");
		await delivered();
		const third = take(processMutex(daemon), "k");
		await delivered();
		expect([second.granted, third.granted]).toEqual([false, false]);
		(await processMutex(daemon).lock("other"))();

		first();
		await delivered();
		expect([second.granted, third.granted]).toEqual([true, false]);
		(await second.release)();
		(await third.release)();
		expect(third.granted).toBe(true);
	});

	it("passes the key on when the process holding it goes away", async () => {
		const daemon = new LocalDaemon();
		await processMutex(daemon).lock("k");
		const waiting = take(processMutex(daemon), "k");
		await delivered();
		expect(waiting.granted).toBe(false);

		// The holder's process exited: its connection closed without an unlock.
		daemon.tunnels[0].close();
		await delivered();
		expect(waiting.granted).toBe(true);
		(await waiting.release)();
	});

	it("stops waiting at its limit, goes ahead, and leaves the line", async () => {
		const daemon = new LocalDaemon();
		const held = await processMutex(daemon).lock("k");
		// A real 20 ms limit: it runs on the mutex's own timer, beside deliveries that need the event loop.
		const impatient = processMutex(daemon, 20);
		// Another key of its own keeps the impatient process attached after it gave up on `k`.
		const kept = await impatient.lock("other");
		const gaveUp = await impatient.lock("k");
		const third = take(processMutex(daemon), "k");
		await delivered();
		expect(third.granted).toBe(false);

		// Still queued, the impatient process would be granted `k` here and never use it.
		held();
		await delivered();
		expect(third.granted).toBe(true);
		gaveUp();
		kept();
		(await third.release)();
	});

	it("goes ahead without a daemon and does not look for one again right away", async () => {
		const connect = vi.fn(async (): Promise<MutexDaemon> => {
			throw new Error("no daemon");
		});
		const offline = new DaemonMutex("test", { connect });

		(await offline.lock("a"))();
		(await offline.lock("b"))();
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("makes the locks of one process take turns on a key", async () => {
		const daemon = new LocalDaemon();
		const mutex = processMutex(daemon);
		const first = await mutex.lock("k");
		const second = take(mutex, "k");
		await delivered();
		expect(second.granted).toBe(false);

		first();
		(await second.release)();
		expect(second.granted).toBe(true);
	});

	it("goes ahead when the daemon stops the unit while it waits", async () => {
		const daemon = new LocalDaemon();
		await processMutex(daemon).lock("k");
		const waiting = take(processMutex(daemon), "k");
		await delivered();
		expect(waiting.granted).toBe(false);

		await daemon.stop();
		await delivered();
		expect(waiting.granted).toBe(true);
	});
});

describe("hint single-flight through the daemon", () => {
	let harness: IsolatedDaemon;

	beforeEach(async () => {
		harness = await IsolatedDaemon.create();
	});

	afterEach(async () => {
		await harness.dispose();
	});

	it("asks the model once per hint when two processes condense the same hints at once", async () => {
		// Up before either child dials, so neither goes ahead without it.
		harness.track((await daemonClient()).welcome.daemon.pid);
		const storePath = path.join(harness.dir, "hints.db");
		const callsPath = path.join(harness.dir, "calls.txt");
		// Made, and held open, before either child starts: the test checks the model requests, not the
		// creation of the store. Two children that both create it switch it to WAL mode at the same
		// moment, and SQLite answers one of them SQLITE_BUSY, usually at once, so it exits before it is
		// ready.
		using _store = SkillDescriptionStore.open(storePath);
		const fixture = path.join(import.meta.dir, "..", "fixtures", "hint-single-flight.ts");
		const readyPaths = [0, 1].map(index => path.join(harness.dir, `ready-${index}`));
		const children = readyPaths.map(readyPath =>
			Bun.spawn([process.execPath, fixture, storePath, callsPath, readyPath], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
				env: { ...process.env },
			}),
		);
		try {
			// Both are loaded and waiting before either starts: they really ask at once.
			for (const [index, readyPath] of readyPaths.entries()) {
				const child = children[index]!;
				await waitFor(async () => {
					if (await Bun.file(readyPath).exists()) return true;
					// A child that died before it was ready says why, rather than leaving the wait to run out.
					if (child.exitCode !== null || child.signalCode !== null) {
						// It may have written its ready file just before it exited.
						if (await Bun.file(readyPath).exists()) return true;
						const stderr = await new Response(child.stderr).text();
						throw new Error(`child exited ${child.exitCode ?? child.signalCode} before it was ready: ${stderr}`);
					}
					return false;
				}, "child ready");
			}
			for (const child of children) {
				child.stdin.write("go\n");
				await child.stdin.flush();
			}
			const exits = await Promise.all(
				children.map(async child => ({
					code: await child.exited,
					stderr: await new Response(child.stderr).text(),
				})),
			);
			for (const exit of exits) if (exit.code !== 0) throw new Error(`child exited ${exit.code}: ${exit.stderr}`);

			const calls = (await fs.readFile(callsPath, "utf8")).trim().split("\n").sort();
			expect(calls).toEqual(["hint-0", "hint-1", "hint-2", "hint-3", "hint-4", "hint-5"]);
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map(child => child.exited));
		}
	}, 60_000);
});
