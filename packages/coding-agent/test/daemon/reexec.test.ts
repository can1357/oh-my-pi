// Integration test: a real daemon re-execs itself in place (same pid, new image) and must carry its
// `survive: "exec"` units across. Progress is observed by polling with a deadline.
//
// The upgrade seam: the daemon re-execs when a client's hello presents a build newer than its own
// (`compareDaemonBuilds`, server.ts `#upgrade`). `DaemonClient` always sends this process's own
// `daemonBuildId()`, so the newer/older clients here speak the documented wire protocol directly
// (hello line, then `{ id, op }` requests) with a chosen build string and this checkout's entry as
// `exe`, which is exactly what a newer install's client sends.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { closeDaemonClient, daemonClient, probeDaemon } from "../../src/daemon/client";
import { daemonEndpoint, daemonTokenPath, unitLogDir } from "../../src/daemon/paths";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonClient,
	type DaemonHello,
	type DaemonWelcome,
	GLOBAL_SCOPE,
	type ProcSpec,
	type UnitSnapshot,
} from "../../src/daemon/protocol";
import { resolveCliEntryCmd } from "../../src/subprocess/worker-client";
import { IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";

let harness: IsolatedDaemon;

beforeEach(async () => {
	harness = await IsolatedDaemon.create();
});

// Past the harness's 10s lock wait: a daemon stuck mid-exec is killed before the next test swaps
// `OMP_DAEMON_DIR`, instead of a timed-out teardown restoring the env and removing the dir under it.
afterEach(async () => {
	await harness.dispose();
}, 30_000);

function parentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name in process.env) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function shProc(script: string, pty: boolean): ProcSpec {
	return { application: "/bin/sh", args: ["-c", script], env: parentEnv(), cwd: harness.dir, pty };
}

/** A control connection that presents `build` in its hello. */
class WireClient {
	readonly welcome: DaemonWelcome;
	readonly closed: Promise<void>;
	readonly #conn: IpcConnection;
	readonly #responses: Map<string, { ok: boolean; result?: unknown; error?: string }>;

	private constructor(
		conn: IpcConnection,
		welcome: DaemonWelcome,
		closed: Promise<void>,
		responses: Map<string, { ok: boolean; result?: unknown; error?: string }>,
	) {
		this.#conn = conn;
		this.welcome = welcome;
		this.closed = closed;
		this.#responses = responses;
	}

	static async connect(build: string): Promise<WireClient> {
		const token = (await fs.readFile(daemonTokenPath(), "utf8")).trim();
		const conn = await IpcConnection.connect(daemonEndpoint(), { framing: "lines", timeoutMs: 2_000 });
		const responses = new Map<string, { ok: boolean; result?: unknown; error?: string }>();
		const welcome = Promise.withResolvers<DaemonWelcome>();
		const closed = Promise.withResolvers<void>();
		let welcomed = false;
		conn.start(
			line => {
				const message = JSON.parse(line) as Record<string, unknown>;
				if (!welcomed) {
					welcomed = true;
					if ("error" in message) welcome.reject(new Error(String(message.error)));
					else welcome.resolve(message as unknown as DaemonWelcome);
					return;
				}
				if (typeof message.id === "string") {
					responses.set(message.id, message as { ok: boolean; result?: unknown; error?: string });
				}
			},
			() => {
				if (!welcomed) welcome.reject(new Error("closed during hello"));
				closed.resolve();
			},
		);
		const hello: DaemonHello = {
			v: DAEMON_PROTOCOL_VERSION,
			token,
			client: { pid: process.pid, build, exe: resolveCliEntryCmd() },
		};
		conn.send(JSON.stringify(hello));
		return new WireClient(conn, await welcome.promise, closed.promise, responses);
	}

	async request<T>(op: Record<string, unknown>): Promise<T> {
		const id = crypto.randomUUID();
		this.#conn.send(JSON.stringify({ id, ...op }));
		const response = await waitFor(() => this.#responses.get(id), `${String(op.op)} response`);
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	}

	close(): void {
		this.#conn.destroy();
	}
}

async function logText(client: DaemonClient, id: string): Promise<string> {
	const logs = await client.request({ op: "logs", unit: id, lines: 1_000, head: false, follow: false, timeoutMs: 0 });
	return logs.text;
}

async function waitForLog(client: DaemonClient, id: string, needle: string): Promise<void> {
	await waitFor(async () => (await logText(client, id)).includes(needle), `${JSON.stringify(needle)} in unit output`);
}

async function byId(client: DaemonClient, id: string): Promise<UnitSnapshot> {
	return (await client.request({ op: "describe", unit: id })).unit;
}

/** Counter values of the `tick:N` lines in `text`, in log order. */
function ticks(text: string): number[] {
	const values: number[] = [];
	for (const line of text.split("\n")) {
		const match = /^tick:(\d+)\r?$/.exec(line);
		if (match) values.push(Number(match[1]));
	}
	return values;
}

async function lastTick(client: DaemonClient, id: string): Promise<number> {
	return ticks(await logText(client, id)).at(-1) ?? 0;
}

describe.skipIf(process.platform === "win32")("daemon in-place re-exec", () => {
	it("keeps exec-surviving units, their state and logs across an upgrade, and never downgrades", async () => {
		const client = await daemonClient();
		const daemonPid = client.welcome.daemon.pid;
		const firstStartedAt = client.welcome.daemon.startedAt;
		harness.track(daemonPid);

		const persist = { hold: "persist" as const };
		const counter = (
			await client.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "counter",
				proc: shProc('n=0; while read line; do n=$((n+1)); echo "$n:$line"; done', false),
				policy: { ...persist, survive: "exec" },
			})
		).unit;
		const pty = (
			await client.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "pty",
				proc: shProc('while read line; do echo "pty:$line"; done', true),
				policy: { ...persist, survive: "exec" },
			})
		).unit;
		const doomed = (
			await client.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "doomed",
				proc: shProc("exec sleep 600", false),
				policy: { ...persist, survive: "none" },
			})
		).unit;
		harness.track(...counter.pids, ...pty.pids, ...doomed.pids);

		await client.request({ op: "send", unit: counter.id, data: "a\n" });
		await waitForLog(client, counter.id, "1:a");
		await client.request({ op: "send", unit: pty.id, data: "before\n" });
		await waitForLog(client, pty.id, "pty:before");
		const counterLog = path.join(unitLogDir(counter.id), "output.log");
		const logInode = (await fs.stat(counterLog)).ino;
		// The shared client must not race the re-exec gap by spawning a second daemon.
		await closeDaemonClient();

		const newer = await WireClient.connect("999.0.0+1");
		try {
			expect(await newer.request<{ reexec: boolean }>({ op: "upgrade" })).toEqual({ reexec: true });
			await newer.closed;
		} finally {
			newer.close();
		}

		const after = await waitFor(() => probeDaemon(), "the re-exec'd daemon to answer");
		try {
			expect(after.welcome.daemon.pid).toBe(daemonPid);
			// A new image answered, not the old one.
			expect(after.welcome.daemon.startedAt).not.toBe(firstStartedAt);

			for (const before of [counter, pty]) {
				const unit = await byId(after, before.id);
				expect({ state: unit.state, pids: unit.pids, generation: unit.generation }).toEqual({
					state: "running",
					pids: before.pids,
					generation: before.generation,
				});
			}
			expect(["exited", "failed"]).toContain((await byId(after, doomed.id)).state);
			await waitFor(() => !isAlive(doomed.pids[0]), "the survive:none unit's process to exit");

			// The same shell process keeps counting: its pipes crossed the exec.
			await after.request({ op: "send", unit: counter.id, data: "b\n" });
			await waitForLog(after, counter.id, "2:b");
			expect((await fs.stat(counterLog)).ino).toBe(logInode);
			const logged = await fs.readFile(counterLog, "utf8");
			expect(logged.indexOf("1:a\n")).toBeGreaterThanOrEqual(0);
			expect(logged.indexOf("2:b\n")).toBeGreaterThan(logged.indexOf("1:a\n"));

			await after.request({ op: "send", unit: pty.id, data: "after\n" });
			await waitForLog(after, pty.id, "pty:after");

			const older = await WireClient.connect("0.0.1+1");
			try {
				expect(await older.request<{ reexec: boolean }>({ op: "upgrade" })).toEqual({ reexec: false });
				// Still the same image, still serving the older client.
				const ping = await older.request<{ pid: number; build: string }>({ op: "ping" });
				expect(ping.pid).toBe(daemonPid);
			} finally {
				older.close();
			}
			const still = await probeDaemon();
			try {
				expect(still?.welcome.daemon.startedAt).toBe(after.welcome.daemon.startedAt);
			} finally {
				still?.close();
			}
		} finally {
			after.close();
		}
	}, 90_000);

	it("loses and repeats no output of a streaming unit across the exec", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const policy = { hold: "persist" as const, survive: "exec" as const };
		const script = 'n=0; while :; do n=$((n+1)); echo "tick:$n"; sleep 0.002; done';
		const units: UnitSnapshot[] = [];
		for (const pty of [false, true]) {
			const { unit } = await client.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: pty ? "ticker-pty" : "ticker-pipe",
				proc: shProc(script, pty),
				policy,
			});
			harness.track(...unit.pids);
			units.push(unit);
		}
		for (const unit of units) await waitFor(async () => (await lastTick(client, unit.id)) >= 20, "ticks before");
		await closeDaemonClient();

		// Upgrade while both units keep printing.
		const newer = await WireClient.connect("999.0.0+1");
		try {
			expect(await newer.request<{ reexec: boolean }>({ op: "upgrade" })).toEqual({ reexec: true });
			await newer.closed;
		} finally {
			newer.close();
		}

		const after = await waitFor(() => probeDaemon(), "the re-exec'd daemon to answer");
		try {
			for (const unit of units) {
				const resumedAt = await lastTick(after, unit.id);
				// Output printed after the exec reaches the log too.
				await waitFor(async () => (await lastTick(after, unit.id)) >= resumedAt + 20, "ticks after");
			}
			for (const unit of units) {
				await after.request({ op: "stop", unit: unit.id, timeoutMs: 5_000 });
				await waitFor(
					async () => ["exited", "failed"].includes((await byId(after, unit.id)).state),
					"the unit to stop",
				);
			}
			for (const unit of units) {
				const values = ticks(await fs.readFile(path.join(unitLogDir(unit.id), "output.log"), "utf8"));
				expect(values.length).toBeGreaterThan(40);
				expect(values).toEqual(Array.from({ length: values.length }, (_, index) => index + 1));
			}
		} finally {
			after.close();
		}
	}, 90_000);
});
