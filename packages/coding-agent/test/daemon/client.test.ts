// Integration tests: every case drives a real daemon process in a private runtime
// dir (see test/fixtures/daemon-harness.ts); state is observed by polling with a deadline.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { procmgr } from "@oh-my-pi/pi-utils";
import { closeDaemonClient, daemonClient, probeDaemon } from "../../src/daemon/client";
import { daemonTokenPath } from "../../src/daemon/paths";
import {
	type DaemonClient,
	type DaemonCompletionEvent,
	GLOBAL_SCOPE,
	type ProcSpec,
	type UnitSnapshot,
} from "../../src/daemon/protocol";
import { daemonLockHeld, IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";

const SHELL = process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh";

let harness: IsolatedDaemon;

beforeEach(async () => {
	harness = await IsolatedDaemon.create();
});

afterEach(async () => {
	await harness.dispose();
});

function parentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name in process.env) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function shProc(script: string): ProcSpec {
	return { application: SHELL, args: ["-c", script], env: parentEnv(), cwd: harness.dir, pty: false };
}

async function describeUnit(client: DaemonClient, id: string): Promise<UnitSnapshot> {
	return (await client.request({ op: "describe", unit: id })).unit;
}

/** Collects a child's stdout and resolves lines as they arrive. */
class LineReader {
	readonly #lines: string[] = [];
	#buffer = "";

	constructor(stream: ReadableStream<Uint8Array>) {
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				this.#buffer += decoder.decode(chunk, { stream: true });
				let newline = this.#buffer.indexOf("\n");
				while (newline >= 0) {
					this.#lines.push(this.#buffer.slice(0, newline));
					this.#buffer = this.#buffer.slice(newline + 1);
					newline = this.#buffer.indexOf("\n");
				}
			}
		})().catch(() => {
			// The child was killed mid-read; `next()` times out naming what was missing.
		});
	}

	async next(what: string): Promise<string> {
		const line = await waitFor(() => this.#lines.shift(), what, 30_000);
		return line;
	}
}

describe("daemon client", () => {
	it("converges two processes that start at once with no daemon on one daemon", async () => {
		const fixture = path.join(import.meta.dir, "..", "fixtures", "daemon-client-pid.ts");
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, fixture], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: parentEnv() }),
		);
		try {
			const readers = children.map(child => new LineReader(child.stdout));
			// Both are loaded and waiting before either may dial: the start really races.
			for (const reader of readers) expect(await reader.next("child ready")).toBe("ready");
			for (const child of children) {
				child.stdin.write("go\n");
				await child.stdin.flush();
			}
			const answers = await Promise.all(
				readers.map(
					async reader => JSON.parse(await reader.next("daemon pid")) as { pid?: number; error?: string },
				),
			);
			for (const answer of answers) if (answer.pid !== undefined) harness.track(answer.pid);
			expect(answers.map(answer => answer.error)).toEqual([undefined, undefined]);
			expect(answers[0].pid).toBe(answers[1].pid!);

			const probe = await probeDaemon();
			try {
				expect(probe?.welcome.daemon.pid).toBe(answers[0].pid!);
			} finally {
				probe?.close();
			}
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map(child => child.exited));
		}
	}, 60_000);

	it("starts the daemon outside the spawning process's cwd", async () => {
		// The shared daemon outlives its spawner; holding a project dir as cwd blocks removing it on Windows.
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "omp-proj-"));
		const fixture = path.join(import.meta.dir, "..", "fixtures", "daemon-host-cwd.ts");
		try {
			const child = Bun.spawn([process.execPath, fixture], {
				cwd: project,
				stdout: "pipe",
				stderr: "ignore",
				env: parentEnv(),
			});
			const answer = JSON.parse((await new Response(child.stdout).text()).trim()) as {
				pid?: number;
				error?: string;
			};
			await child.exited;
			if (answer.pid !== undefined) harness.track(answer.pid);
			expect(answer.error).toBeUndefined();
			const daemonCwd = await Bun.file(path.join(harness.dir, "daemon-cwd")).text();
			expect(await fs.realpath(daemonCwd)).toBe(await fs.realpath(harness.dir));
		} finally {
			await fs.rm(project, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects a client holding the wrong token at once instead of retrying until the start timeout", async () => {
		const first = await daemonClient();
		const daemonPid = first.welcome.daemon.pid;
		harness.track(daemonPid);
		// Keeps the daemon from idling out while the shared client is replaced.
		const keep = await probeDaemon();
		expect(keep).toBeDefined();
		await closeDaemonClient();
		const realToken = await fs.readFile(daemonTokenPath(), "utf8");
		try {
			await fs.writeFile(daemonTokenPath(), "not-the-daemon-token");
			// A retry loop would end in the 10s "did not answer" error instead of the daemon's verdict.
			await expect(daemonClient()).rejects.toThrow(/authentication failed/);
			// Nothing replaced the daemon that refused the token.
			const ping = await keep!.request({ op: "ping" });
			expect(ping.pid).toBe(daemonPid);
		} finally {
			await fs.writeFile(daemonTokenPath(), realToken);
			keep?.close();
		}
	}, 60_000);

	it("probeDaemon resolves undefined and starts nothing when no daemon runs", async () => {
		expect(await probeDaemon()).toBeUndefined();
		// No token is created for a daemon that may not exist.
		expect(await Bun.file(daemonTokenPath()).exists()).toBe(false);

		// A token left by an exited daemon: probing dials once and still spawns nothing.
		await fs.writeFile(daemonTokenPath(), "stale-token", { mode: 0o600 });
		expect(await probeDaemon()).toBeUndefined();
		// A spawned daemon would take the lock well within this window.
		const deadline = Date.now() + 1_500;
		while (Date.now() < deadline) {
			expect(daemonLockHeld()).toBe(false);
			await Bun.sleep(50);
		}
	}, 30_000);

	it("rejects an aborted open and releases the lease its late answer grants", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const key = "abort-open";
		const ref = { kind: "proc", scope: GLOBAL_SCOPE, key };
		const controller = new AbortController();
		const opening = client.open(
			{
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key,
				proc: { ...shProc("read line; echo READY; exec sleep 60"), ready: { log: "^READY", timeoutMs: 30_000 } },
				policy: { hold: "leases", idleMs: 0 },
			},
			controller.signal,
		);
		const started = await waitFor(async () => {
			const { units } = await client.request({ op: "list", kind: "proc" });
			return units.find(unit => unit.key === key && unit.pids.length > 0);
		}, "unit launch");
		harness.track(...started.pids);
		controller.abort();
		// Not created earlier: Bun's `expect(promise).rejects` drives the event loop until the promise settles.
		await expect(opening).rejects.toThrow(/aborted/);

		// Readiness answers the abandoned open; the client must give the granted lease back.
		await client.request({ op: "send", unit: ref, data: "go\n" });
		// This client's connection stays open: only a released lease lets `idleMs: 0` stop the unit.
		await waitFor(async () => {
			const unit = await describeUnit(client, started.id);
			return unit.state === "exited" || unit.state === "failed";
		}, "the unleased unit to stop");
		await waitFor(() => !isAlive(started.pids[0]), "the unit process to exit");
	}, 60_000);

	it("fires onReconnect and redelivers an unacked completion after the daemon is killed", async () => {
		const client = await daemonClient();
		const firstPid = client.welcome.daemon.pid;
		harness.track(firstPid);
		let reconnects = 0;
		const removeReconnect = client.onReconnect(() => {
			reconnects++;
		});
		const deliveries: { event: DaemonCompletionEvent; daemonPid: number }[] = [];
		const removeSink = client.onCompletion("owner-reconnect", event => {
			deliveries.push({ event, daemonPid: client.welcome.daemon.pid });
			// The first delivery stays unacked.
			if (deliveries.length === 1) throw new Error("sink failed before ack");
		});
		try {
			// Requests on one connection are handled in order: the subscription is in place after this.
			await client.request({ op: "ping" });
			// Leased: an unleased `idleMs: 0` unit is stopped as idle at once, and a stopped unit reports no completion.
			await client.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "completes",
				owner: "owner-reconnect",
				proc: shProc("exit 3"),
			});
			await waitFor(() => deliveries.length >= 1, "first completion delivery");
			// Crash the daemon with the completion unacked and no request in flight.
			process.kill(firstPid, "SIGKILL");
			const redelivered = await waitFor(
				() => deliveries.find(delivery => delivery.daemonPid !== firstPid),
				"redelivery from the respawned daemon",
				40_000,
			);
			harness.track(redelivered.daemonPid);
			expect(reconnects).toBeGreaterThanOrEqual(1);
			expect(redelivered.event.completionId).toBe(deliveries[0].event.completionId);
			expect(redelivered.event.unit.key).toBe("completes");
			expect(redelivered.event.unit.exitCode).toBe(3);
		} finally {
			removeSink();
			removeReconnect();
		}
	}, 60_000);

	it("tunnels bytes sent immediately after attach to a proc unit and its output back", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const { unit } = await client.open({ kind: "proc", scope: GLOBAL_SCOPE, key: "cat", proc: shProc("exec cat") });
		harness.track(...unit.pids);
		const tunnel = await client.attach(unit.id);
		try {
			// Written before any reader is installed on either side.
			tunnel.send("first line\n");
			tunnel.send(new TextEncoder().encode("second line\n"));
			let received = "";
			const decoder = new TextDecoder();
			tunnel.start(
				chunk => {
					received += decoder.decode(chunk, { stream: true });
				},
				() => {},
			);
			await waitFor(() => received.includes("second line\n"), "echoed tunnel bytes");
			expect(received).toBe("first line\nsecond line\n");
		} finally {
			tunnel.close();
		}
	}, 60_000);
});
