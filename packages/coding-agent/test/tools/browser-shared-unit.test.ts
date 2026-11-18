/**
 * Contract of the project-shared Chromium unit (`tools/browser/shared-daemon.ts`) against the
 * daemon client surface: adopt-or-replace on attach, generation-scoped stops, lease lifetime
 * across dispose and daemon reconnects, and the error a failed start surfaces.
 *
 * The daemon is a stub `DaemonClient` that models the real one's open/stop/lease semantics
 * (find-or-start by identity, `stop` honoring `generation`, connection-bound leases); the CDP
 * probe is spied so no Chromium runs.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as daemonClientModule from "@oh-my-pi/pi-coding-agent/daemon/client";
import type {
	DaemonClient,
	DaemonOp,
	DaemonResult,
	OpenRequest,
	OpenResult,
	UnitScope,
	UnitSnapshot,
} from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	ensureSharedBrowser,
	type SharedBrowserEndpoint,
	sharedBrowserDaemonName,
	stopSharedBrowserIfUnreachable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import * as piUtils from "@oh-my-pi/pi-utils";

const NAME = sharedBrowserDaemonName(true);

function snapshot(fields: { key: string; scope: UnitScope; generation: string } & Partial<UnitSnapshot>): UnitSnapshot {
	return {
		id: `unit-${fields.key}`,
		kind: "proc",
		label: fields.key,
		state: "running",
		pids: [4242],
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		outputBytes: 0,
		leases: 0,
		policy: { hold: "leases", idleMs: 3_000, onIdle: "stop", restart: "no", survive: "exec" },
		supervised: true,
		...fields,
	};
}

function devtools(port: number): string {
	return `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/${crypto.randomUUID()}`;
}

/** In-memory daemon: one unit per key, leases by id, `stop` scoped to a generation like `units.ts`. */
class StubDaemon implements DaemonClient {
	readonly welcome = { v: 1, daemon: { pid: 1, build: "test", startedAt: 0 }, caps: {} };
	readonly units = new Map<string, UnitSnapshot>();
	readonly opens: OpenRequest[] = [];
	readonly stops: { unit: string; generation?: string }[] = [];
	readonly released: string[] = [];
	/** Lease id -> unit key, for leases the stub currently honors. */
	readonly leases = new Map<string, string>();
	readonly logs = new Map<string, string>();
	describes = 0;
	#reconnect = new Set<() => void>();
	#generation = 0;
	/** What a fresh start produces; default: a running Chrome with no endpoint yet. */
	launch: (request: OpenRequest, generation: string) => Partial<UnitSnapshot> = () => ({});
	/** Observes each open before it is served. */
	beforeOpen: (request: OpenRequest) => void = () => {};

	#find(ref: string | { key: string }): UnitSnapshot {
		const unit =
			typeof ref === "string"
				? [...this.units.values()].find(candidate => candidate.id === ref)
				: this.units.get(ref.key);
		if (!unit) throw new Error(`unknown unit ${JSON.stringify(ref)}`);
		return unit;
	}

	async request<O extends DaemonOp>(request: O): Promise<DaemonResult<O["op"]>> {
		const operation: DaemonOp = request;
		switch (operation.op) {
			case "describe":
				this.describes++;
				return { unit: { ...this.#find(operation.unit) } } as never;
			case "stop": {
				const unit = this.#find(operation.unit);
				this.stops.push({ unit: unit.id, generation: operation.generation });
				if (operation.generation === undefined || operation.generation === unit.generation) {
					unit.state = "exited";
					unit.pids = [];
				}
				return { unit: { ...unit } } as never;
			}
			case "logs": {
				const unit = this.#find(operation.unit);
				return { text: this.logs.get(unit.id) ?? "", terminalOutput: "", cursor: 0, unit } as never;
			}
			default:
				throw new Error(`stub daemon does not serve ${operation.op}`);
		}
	}

	async open(request: OpenRequest): Promise<OpenResult> {
		this.beforeOpen(request);
		this.opens.push(request);
		const current = this.units.get(request.key);
		const live = current && current.state !== "exited" && current.state !== "failed";
		let unit: UnitSnapshot;
		let created = false;
		if (live && !request.replace) {
			unit = current;
		} else {
			if (live) current.state = "exited";
			const generation = `g${++this.#generation}`;
			unit = snapshot({
				key: request.key,
				scope: request.scope,
				generation,
				...this.launch(request, generation),
			});
			this.units.set(request.key, unit);
			created = true;
		}
		let lease: string | undefined;
		if (request.lease !== false) {
			lease = `lease-${crypto.randomUUID()}`;
			this.leases.set(lease, request.key);
		}
		return { unit: { ...unit }, lease, created };
	}

	async release(lease: string): Promise<void> {
		this.released.push(lease);
		this.leases.delete(lease);
	}

	/** A daemon restart: every lease is gone, then reconnect sinks fire. */
	restart(): void {
		this.leases.clear();
		for (const sink of this.#reconnect) sink();
	}

	onReconnect(sink: () => void): () => void {
		this.#reconnect.add(sink);
		return () => this.#reconnect.delete(sink);
	}

	call<T>(): Promise<T> {
		throw new Error("not served");
	}
	attach(): never {
		throw new Error("not served");
	}
	onCompletion(): () => void {
		return () => {};
	}
	onNotify(): () => void {
		return () => {};
	}
	onUnit(): () => void {
		return () => {};
	}
	close(): void {}
}

/** Resolves once the microtask queue drained (a macrotask turn), without a wall-clock delay. */
function drainMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** After the stub's describe resolves, the lease's retake decides within the same microtask chain. */
async function settleRetake(stub: StubDaemon, describesBefore: number): Promise<void> {
	// The retake is fire-and-forget from the reconnect sink; poll for its describe with a deadline.
	for (let turn = 0; stub.describes === describesBefore; turn++) {
		if (turn > 1_000) throw new Error("reconnect never described the unit");
		await drainMicrotasks();
	}
	await drainMicrotasks();
}

let tmp: string;
let projectDir: string;
let runtimeDir: string;
let stub: StubDaemon;
/** CDP ports whose /json/version answers 200. */
let answering: Set<number>;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shared-unit-"));
	projectDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "project-")));
	runtimeDir = path.join(tmp, "runtime");
	stub = new StubDaemon();
	answering = new Set();
	spyOn(daemonClientModule, "daemonClient").mockResolvedValue(stub);
	spyOn(piUtils, "getDaemonRuntimeDir").mockReturnValue(runtimeDir);
	spyOn(launch, "resolveSharedBrowserLaunchSpec").mockResolvedValue({
		executablePath: "/opt/fake/chrome",
		args: ["--remote-debugging-port=0"],
	});
	spyOn(attach, "probeCdpStatus").mockImplementation(async url =>
		answering.has(Number(new URL(url).port)) ? 200 : null,
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
});

function seedLiveUnit(port: number, generation = "g-old"): UnitSnapshot {
	const unit = snapshot({
		key: NAME,
		scope: { kind: "project", dir: projectDir },
		generation,
		readyMatch: devtools(port),
	});
	stub.units.set(NAME, unit);
	return unit;
}

async function attachShared(): Promise<SharedBrowserEndpoint> {
	return ensureSharedBrowser({ projectDir, headless: true });
}

describe("ensureSharedBrowser", () => {
	it("replaces a live Chrome that stops answering CDP exactly once, on a profile cleared of its stale session", async () => {
		// Regression: adopting a wedged Chrome handed every session a dead endpoint; replacing it on
		// the unprepared profile restored the stale session's tabs.
		seedLiveUnit(9101);
		answering.add(9102);
		stub.launch = () => ({ readyMatch: devtools(9102), pids: [5151] });
		const profile = path.join(runtimeDir, `${NAME}.profile`);
		const sessions = path.join(profile, "Default", "Sessions");
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(path.join(sessions, "Session_1"), "stale tabs");
		let profileAtReplace: { sessions: boolean; preferences: boolean } | undefined;
		stub.beforeOpen = request => {
			if (request.replace) {
				profileAtReplace = {
					sessions: fs.existsSync(sessions),
					preferences: fs.existsSync(path.join(profile, "Default", "Preferences")),
				};
			}
		};

		const endpoint = await attachShared();

		expect(stub.opens.map(request => request.replace)).toEqual([false, true]);
		expect(stub.stops).toEqual([{ unit: `unit-${NAME}`, generation: "g-old" }]);
		expect(profileAtReplace).toEqual({ sessions: false, preferences: true });
		expect(new URL(endpoint.wsEndpoint).port).toBe("9102");
		expect(endpoint.pid).toBe(5151);
		// The adopted (wedged) lease was dropped; only the replacement's lease is held.
		expect([...stub.leases.keys()]).toHaveLength(1);
		await endpoint.lease.release();
	});

	it("releases the lease and reports Chrome's last output when Chrome never prints its DevTools endpoint", async () => {
		stub.launch = () => ({ readyMatch: undefined, pids: [6161] });
		stub.logs.set(
			`unit-${NAME}`,
			"[0101/000000.1:ERROR:gpu_init.cc] Passthrough is not supported\n\nFATAL: profile locked\n",
		);

		const error = await attachShared().then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("printed no DevTools endpoint");
		expect(message).toContain(
			"its last output: [0101/000000.1:ERROR:gpu_init.cc] Passthrough is not supported | FATAL: profile locked",
		);
		// No retry storm, no held lease, and the half-started Chrome was stopped.
		expect(stub.opens).toHaveLength(1);
		expect(stub.leases.size).toBe(0);
		expect(stub.released).toHaveLength(1);
		expect(stub.units.get(NAME)?.state).toBe("exited");
	});

	it("drops the daemon lease once when the handle is disposed, and a later reconnect does not retake it", async () => {
		seedLiveUnit(9201);
		answering.add(9201);
		const endpoint = await attachShared();
		expect(stub.leases.size).toBe(1);

		await endpoint.lease.release();
		await endpoint.lease.release();

		expect(stub.released).toHaveLength(1);
		expect(stub.leases.size).toBe(0);
		const opens = stub.opens.length;
		stub.restart();
		await drainMicrotasks();
		expect(stub.opens).toHaveLength(opens);
	});
});

describe("shared browser lease across daemon reconnects", () => {
	it("retakes the lease without replacing or waiting when the same generation is still live", async () => {
		seedLiveUnit(9301, "g-same");
		answering.add(9301);
		const endpoint = await attachShared();
		const describes = stub.describes;

		stub.restart();
		await settleRetake(stub, describes);

		const retake = stub.opens.at(-1)!;
		expect(stub.opens).toHaveLength(2);
		expect(retake).toMatchObject({ key: NAME, replace: false, awaitReady: false, lease: true });
		const [retaken] = [...stub.leases.keys()];
		expect(retaken).toBeDefined();
		// Dispose now releases the retaken lease, so Chrome can idle-stop.
		await endpoint.lease.release();
		expect(stub.released).toEqual([retaken!]);
	});

	it("does not lease a different generation that replaced the browser while the daemon was away", async () => {
		seedLiveUnit(9401, "g-before");
		answering.add(9401);
		const endpoint = await attachShared();
		seedLiveUnit(9402, "g-after");
		const describes = stub.describes;

		stub.restart();
		await settleRetake(stub, describes);

		expect(stub.opens).toHaveLength(1);
		expect(stub.leases.size).toBe(0);
		await endpoint.lease.release();
		expect(stub.released).toEqual([]);
	});

	it("does not restart a browser that exited while the daemon was away", async () => {
		seedLiveUnit(9501, "g-gone");
		answering.add(9501);
		await attachShared();
		stub.units.get(NAME)!.state = "exited";
		const describes = stub.describes;

		stub.restart();
		await settleRetake(stub, describes);

		expect(stub.opens).toHaveLength(1);
	});
});

describe("stopSharedBrowserIfUnreachable", () => {
	it("stops a browser whose endpoint stayed silent on both probes", async () => {
		seedLiveUnit(9601, "g-wedged");
		const probes: string[] = [];

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir, daemonName: NAME },
			{ client: stub, probe: async endpoint => (probes.push(endpoint), false) },
		);

		expect(stopped).toBe(true);
		expect(probes).toHaveLength(2);
		expect(stub.stops).toEqual([{ unit: `unit-${NAME}`, generation: "g-wedged" }]);
	});

	it("leaves alone a browser another session replaced between the failed probes and the stop", async () => {
		seedLiveUnit(9701, "g-stale");
		let probes = 0;

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir, daemonName: NAME },
			{
				client: stub,
				probe: async () => {
					// Another session's replacement lands while this check still holds the old snapshot.
					if (++probes === 2) seedLiveUnit(9702, "g-fresh");
					return false;
				},
			},
		);

		expect(stopped).toBe(false);
		expect(stub.stops).toEqual([{ unit: `unit-${NAME}`, generation: "g-stale" }]);
		expect(stub.units.get(NAME)).toMatchObject({ generation: "g-fresh", state: "running" });
	});
});
