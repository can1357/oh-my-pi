/**
 * Contract of the daemon's `disasm` module (`src/daemon/modules/disasm.ts`) as omp processes see
 * it through `disasm/client.ts`: one shared worker per database, tunnel-owned references, the
 * idle/cap policies, the database file lock, and re-adoption across a daemon crash.
 *
 * Runs a real daemon in a private runtime dir (`IsolatedDaemon`). The worker is
 * `test/fixtures/fake-disasm-worker.py`, launched through `params.runtime.pythonPath` (a shim
 * that execs python3 on it); it journals every step to a file the tests read.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeDaemonClient, daemonClient, probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { GLOBAL_SCOPE, type UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { DisasmDatabase, findDatabaseHandle, releaseDatabases } from "@oh-my-pi/pi-coding-agent/disasm/client";
import {
	DISASM_UNIT_KIND,
	type DisasmUnitParams,
	disasmUnitKey,
	parseDatabaseHandle,
} from "@oh-my-pi/pi-coding-agent/disasm/protocol";
import { daemonLockHeld, IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

const PYTHON3 = Bun.which("python3");
const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-disasm-worker.py");
const TEST_TIMEOUT_MS = 60_000;

interface JournalEvent {
	event: "start" | "open" | "recv" | "done" | "interrupted" | "save" | "close" | "orphaned";
	pid: number;
	id?: number;
	method?: string;
	tag?: string | null;
	save?: boolean;
}

interface ExecResult {
	pid: number;
	tag: string;
}

let daemon: IsolatedDaemon;
let tmp: string;
let journal: string;
let shim: string;
const attached: DisasmDatabase[] = [];

function isLive(unit: UnitSnapshot | undefined): unit is UnitSnapshot {
	return unit !== undefined && unit.state !== "exited" && unit.state !== "failed";
}

function journalEvents(): JournalEvent[] {
	let text: string;
	try {
		text = fs.readFileSync(journal, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as JournalEvent);
}

function eventsOf(kind: JournalEvent["event"]): JournalEvent[] {
	return journalEvents().filter(event => event.event === kind);
}

function unitRef(key: string) {
	return { kind: DISASM_UNIT_KIND, scope: GLOBAL_SCOPE, key };
}

function newKey(): { id: string; key: string } {
	const id = `db-${crypto.randomUUID().slice(0, 8)}`;
	return { id, key: disasmUnitKey("ida", id) };
}

function unitParams(
	id: string,
	options: { lockTarget?: string; idleCloseMs?: number; maxOpen?: number } = {},
): DisasmUnitParams {
	const idb = path.join(tmp, `${id}.i64`);
	return {
		backend: "ida",
		loc: {
			id,
			dir: tmp,
			sourcePath: idb,
			stagedPath: idb,
			kind: "inplace",
			openPath: idb,
			isNew: false,
			lockTarget: options.lockTarget ?? idb,
		},
		runtime: {
			pythonPath: shim,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_DISASM_JOURNAL: journal },
		},
		idleCloseMs: options.idleCloseMs ?? 0,
		maxOpen: options.maxOpen ?? 8,
	};
}

/** Ask the daemon to find-or-start the unit, as `acquireDatabase` does (references, not leases, pin it). */
async function startUnit(key: string, params: DisasmUnitParams): Promise<boolean> {
	const client = await daemonClient();
	const opened = await client.open({ ...unitRef(key), label: key, params, lease: false });
	return opened.created;
}

/** A new tunnel (its own daemon connection) to the unit, after its database opened. */
async function attachDb(key: string): Promise<DisasmDatabase> {
	const db = await DisasmDatabase.attach(key, "open");
	if (!db) throw new Error(`no ${key} unit to attach to`);
	attached.push(db);
	return db;
}

async function openDb(key: string, params: DisasmUnitParams): Promise<DisasmDatabase> {
	await startUnit(key, params);
	return attachDb(key);
}

async function describeUnit(key: string): Promise<UnitSnapshot | undefined> {
	try {
		const client = await daemonClient();
		return (await client.request({ op: "describe", unit: unitRef(key) })).unit;
	} catch {
		return undefined;
	}
}

async function waitUnitGone(key: string, timeoutMs = 20_000): Promise<void> {
	await waitFor(async () => !isLive(await describeUnit(key)), `${key} to close`, timeoutMs);
}

async function workerPid(key: string): Promise<number> {
	const unit = await describeUnit(key);
	const pid = unit?.pids[0];
	if (pid === undefined) throw new Error(`${key} has no worker`);
	return pid;
}

describe.skipIf(!PYTHON3 || process.platform === "win32")("daemon disasm module", () => {
	beforeEach(async () => {
		daemon = await IsolatedDaemon.create();
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-disasm-")));
		journal = path.join(tmp, "journal.ndjson");
		shim = path.join(tmp, "python-shim");
		fs.writeFileSync(shim, `#!/bin/sh\nexec '${PYTHON3}' '${FIXTURE}' "$@"\n`, { mode: 0o755 });
	});

	afterEach(async () => {
		try {
			await releaseDatabases();
			for (const db of attached.splice(0)) db.disconnect();
			// Workers are detached (`survive: "detached"`): a daemon shutdown leaves them running.
			const control = await probeDaemon();
			if (control) {
				try {
					const { units } = await control.request({ op: "list", kind: DISASM_UNIT_KIND });
					await Promise.all(
						units
							.filter(unit => isLive(unit))
							.map(unit =>
								control.request({ op: "stop", unit: unit.id, timeoutMs: 5_000 }).catch(() => undefined),
							),
					);
				} finally {
					control.close();
				}
			}
			daemon.track(...new Set(journalEvents().map(event => event.pid)));
		} finally {
			await daemon.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}, 30_000);

	it(
		"lets a second client attaching to the same database share its one worker",
		async () => {
			const { id, key } = newKey();
			const params = unitParams(id);
			const first = await openDb(key, params);

			// Regression: a second open spawning its own worker double-locks and double-analyzes the database.
			expect(await startUnit(key, params)).toBe(false);
			const second = await attachDb(key);

			expect(second.handle).toBe(first.handle);
			const [a, b] = await Promise.all([
				first.request<ExecResult>("exec", { tag: "a" }),
				second.request<ExecResult>("exec", { tag: "b" }),
			]);
			expect(a.pid).toBe(b.pid);
			expect(eventsOf("start")).toHaveLength(1);
			expect(eventsOf("open")).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs calls from different clients one at a time in the worker",
		async () => {
			const { id, key } = newKey();
			const first = await openDb(key, unitParams(id));
			const second = await attachDb(key);

			await Promise.all([
				first.request("exec", { tag: "a", sleep: 0.3 }),
				second.request("exec", { tag: "b", sleep: 0.3 }),
			]);

			// The daemon hands the worker the next call only after the previous one answered.
			const order = journalEvents()
				.filter(event => event.event === "recv" || event.event === "done")
				.filter(event => event.tag === "a" || event.tag === "b")
				.map(event => `${event.event}:${event.tag}`);
			expect([
				["recv:a", "done:a", "recv:b", "done:b"],
				["recv:b", "done:b", "recv:a", "done:a"],
			]).toContainEqual(order);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"closes a retained database only on the last release, saving because an earlier owner asked to",
		async () => {
			const { id, key } = newKey();
			const owner = await openDb(key, unitParams(id));
			const other = await attachDb(key);
			const ownerRef = await owner.retain();
			const otherRef = await other.retain();
			expect(otherRef.references).toBe(2);

			await expect(owner.close({ save: false })).rejects.toThrow("active dsm references");
			await owner.release(ownerRef.lease, { save: true });
			expect((await other.refresh()).references).toBe(1);
			expect(eventsOf("close")).toEqual([]);

			await other.release(otherRef.lease, { save: false });

			expect(eventsOf("close").map(event => event.save)).toEqual([true]);
			await waitUnitGone(key);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"drops the references of a client whose tunnel closed, closing and saving after the last one",
		async () => {
			const { id, key } = newKey();
			const crashed = await openDb(key, unitParams(id));
			const survivor = await attachDb(key);
			await crashed.retain();
			await survivor.retain();

			crashed.disconnect();

			await waitFor(async () => (await survivor.refresh()).references === 1, "the dropped reference");
			expect(isLive(await describeUnit(key))).toBe(true);
			expect(eventsOf("close")).toEqual([]);

			survivor.disconnect();

			await waitUnitGone(key);
			// An owner that vanished cannot say whether to keep its edits, so the close saves.
			expect(eventsOf("close").map(event => event.save)).toEqual([true]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"interrupts the running worker call when its caller cancels, keeping the worker",
		async () => {
			const { id, key } = newKey();
			const db = await openDb(key, unitParams(id));
			const pid = await workerPid(key);
			const abort = new AbortController();
			const long = db.request("exec", { tag: "long", sleep: 120 }, { signal: abort.signal });
			await waitFor(() => eventsOf("recv").some(event => event.tag === "long"), "the long call to start");

			abort.abort();

			await expect(long).rejects.toThrow();
			await waitFor(
				() => eventsOf("interrupted").some(event => event.tag === "long"),
				"the worker to be interrupted",
			);
			const next = await db.request<ExecResult>("exec", { tag: "next" });
			expect(next.pid).toBe(pid);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"saves and closes an unreferenced database once it sat idle for idleCloseMs",
		async () => {
			const { id, key } = newKey();
			const db = await openDb(key, unitParams(id, { idleCloseMs: 1_500 }));
			const editStarted = Date.now();
			await db.request("exec", { tag: "edit" });

			await waitUnitGone(key);

			expect(Date.now() - editStarted).toBeGreaterThanOrEqual(1_500);
			const steps = journalEvents()
				.filter(event => event.event === "save" || event.event === "close")
				.map(event => event.event);
			expect(steps).toEqual(["save", "close"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"evicts the least recently used unreferenced database at the cap, never a retained one",
		async () => {
			const retained = newKey();
			const idle = newKey();
			const incoming = newKey();
			const pinned = await openDb(retained.key, unitParams(retained.id, { maxOpen: 2 }));
			await pinned.retain();
			// `retained` is now the least recently used; only its reference keeps it open.
			await openDb(idle.key, unitParams(idle.id, { maxOpen: 2 }));

			await openDb(incoming.key, unitParams(incoming.id, { maxOpen: 2 }));

			await waitUnitGone(idle.key);
			expect(isLive(await describeUnit(retained.key))).toBe(true);
			expect(isLive(await describeUnit(incoming.key))).toBe(true);
			expect((await pinned.refresh()).state).toBe("open");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reports a database already open under another key as in use",
		async () => {
			const first = newKey();
			const second = newKey();
			const lockTarget = path.join(tmp, "shared.i64");
			await openDb(first.key, unitParams(first.id, { lockTarget }));

			await startUnit(second.key, unitParams(second.id, { lockTarget }));

			await expect(DisasmDatabase.attach(second.key, "open")).rejects.toThrow("is in use by another process");
			expect(eventsOf("start")).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"re-adopts the same worker and incarnation after the daemon is killed, so an earlier handle still opens",
		async () => {
			const { id, key } = newKey();
			const before = await openDb(key, unitParams(id));
			const handle = before.handle;
			const pid = await workerPid(key);
			const killed = (await daemonClient()).welcome.daemon.pid;
			daemon.track(killed);
			// A fresh control connection after the crash spawns the next daemon (no reconnect race).
			await closeDaemonClient();

			process.kill(killed, "SIGKILL");
			await waitFor(() => !daemonLockHeld(), "the killed daemon to release its lock");

			const restored = await waitFor(
				async () => {
					const unit = await describeUnit(key);
					return isLive(unit) && unit.pids.length > 0 ? unit : undefined;
				},
				"the restarted daemon to restore the unit",
				40_000,
			);
			const successor = (await daemonClient()).welcome.daemon.pid;
			daemon.track(successor);
			expect(successor).not.toBe(killed);
			expect(restored.pids[0]).toBe(pid);
			// The restored unit answers `open` once the re-adopted worker confirmed its database.
			expect((await attachDb(key)).handle).toBe(handle);

			const parsed = parseDatabaseHandle(handle);
			if (!parsed) throw new Error(`${handle} is not a dsm handle`);
			const reopened = await findDatabaseHandle(parsed);
			expect(reopened.handle).toBe(handle);
			const after = await reopened.request<ExecResult>("exec", { tag: "after-restart" });
			expect(after.pid).toBe(pid);
			expect(eventsOf("start")).toHaveLength(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects a dsm handle naming an incarnation that was closed and reopened",
		async () => {
			const { id, key } = newKey();
			const stale = await openDb(key, unitParams(id));
			const staleHandle = stale.handle;
			await stale.close({ save: false });
			await waitUnitGone(key);

			const current = await openDb(key, unitParams(id));

			expect(current.handle).not.toBe(staleHandle);
			const parsed = parseDatabaseHandle(staleHandle);
			if (!parsed) throw new Error(`${staleHandle} is not a dsm handle`);
			await expect(findDatabaseHandle(parsed)).rejects.toThrow("dsm handle has expired");
			await expect(current.retain(staleHandle)).rejects.toThrow("dsm handle has expired");
			expect((await current.refresh()).references).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
