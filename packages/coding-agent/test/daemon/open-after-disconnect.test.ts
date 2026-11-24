/**
 * A lease taken by a connection that closed while its `open` was still waiting for the unit to be created
 * is dropped as a lost connection's, instead of pinning the unit forever.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonModule, ModuleClient, ModuleUnit } from "../../src/daemon/module";
import { type DaemonEvent, GLOBAL_SCOPE, type UnitPolicy } from "../../src/daemon/protocol";
import { DaemonStore } from "../../src/daemon/store";
import { type UnitConnection, UnitTable } from "../../src/daemon/units";

const KIND = "gated";
const LEASE_GRACE_MS = 60_000;
// No idle delay of its own, so an idle timer that waits longer shows the reconnect grace.
const POLICY: UnitPolicy = { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "none" };

interface Harness {
	table: UnitTable;
	/** Let the pending module open finish. */
	finishOpen(): void;
	/** Clients the unit's `released` hook was called for. */
	released: string[];
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startTable(): Promise<Harness> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-open-lease-"));
	const store = DaemonStore.open(path.join(dir, "daemon.db"));
	const gate = Promise.withResolvers<void>();
	const released: string[] = [];
	const module: DaemonModule = {
		kind: KIND,
		version: 1,
		policy: () => POLICY,
		async open(): Promise<ModuleUnit> {
			await gate.promise;
			const exited = Promise.withResolvers<{ reason?: string }>();
			return {
				label: "gated",
				pids: () => [],
				ready: Promise.resolve(),
				busy: () => false,
				attach() {},
				released: (client: ModuleClient) => void released.push(client.connectionId),
				async stop(reason: string) {
					exited.resolve({ reason });
				},
				exited: exited.promise,
			};
		},
	};
	const table = new UnitTable({
		store,
		modules: [module],
		resumed: false,
		leaseGraceMs: LEASE_GRACE_MS,
		onLivenessChange() {},
	});
	await table.start();
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => store.close());
	cleanups.push(() => table.shutdown());
	return { table, finishOpen: () => gate.resolve(), released };
}

function connection(): UnitConnection & { closed: boolean } {
	return {
		client: { connectionId: crypto.randomUUID(), pid: 0, build: "" },
		closed: false,
		send(_event: DaemonEvent) {},
	};
}

function unit(table: UnitTable) {
	const found = table.list({ op: "list", kind: KIND }).units[0];
	if (!found) throw new Error("the gated unit is missing");
	return found;
}

describe("daemon open after its connection closed", () => {
	it("drops the lease of a connection that closed while its open created the unit", async () => {
		const { table, finishOpen, released } = await startTable();
		const client = connection();

		const opening = table.open(client, { kind: KIND, scope: GLOBAL_SCOPE, key: "k" });
		const closedAt = Date.now();
		client.closed = true;
		table.disconnected(client);
		finishOpen();
		await opening;

		const snapshot = unit(table);
		expect(snapshot.leases).toBe(0);
		// The idle timer is armed again, after the reconnect grace: the unit is no longer pinned.
		expect(snapshot.idleAt).toBeGreaterThanOrEqual(closedAt + LEASE_GRACE_MS);
		expect(released).toEqual([client.client.connectionId]);
	});

	it("drops the lease of a connection that closed while its open waited for another client's creation", async () => {
		const { table, finishOpen, released } = await startTable();
		const creator = connection();
		const waiter = connection();

		const creating = table.open(creator, { kind: KIND, scope: GLOBAL_SCOPE, key: "k" });
		const waiting = table.open(waiter, { kind: KIND, scope: GLOBAL_SCOPE, key: "k" });
		const closedAt = Date.now();
		waiter.closed = true;
		table.disconnected(waiter);
		finishOpen();
		const created = await creating;
		await waiting;

		expect(unit(table).leases).toBe(1);
		expect(released).toEqual([waiter.client.connectionId]);
		table.release(creator, created.lease!);
		expect(unit(table).leases).toBe(0);
		expect(unit(table).idleAt).toBeGreaterThanOrEqual(closedAt + LEASE_GRACE_MS);
	});
});
