/**
 * The sandbox host protocol against a host started as a plain (unsandboxed) subprocess: what the
 * parent sees through `SandboxHostConnection` / `SandboxedShell` regardless of containment.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxChild } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	SandboxedShell,
	SandboxHostConnection,
	SandboxRunTrace,
	sandboxHostArgv,
} from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import {
	type PtyRunResult,
	type ShellFilesystem,
	ShellFsFileType,
	type ShellFsRequest,
	type ShellFsResponse,
	type ShellRunResult,
} from "@oh-my-pi/pi-natives";
import { isShellTrace } from "@oh-my-pi/pi-wire";

/** A host process that is not contained: the protocol is the same either way. */
async function startPlainHost(): Promise<{
	connection: SandboxHostConnection;
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
}> {
	const child = Bun.spawn({ cmd: sandboxHostArgv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	return { connection: await SandboxHostConnection.connect(child), child };
}

/** A scripted stand-in for a host process: tests push its stdout lines and read what it was sent. */
function fakeHost(): { child: SandboxChild; emit(line: string): void; nextWrite(): Promise<string> } {
	const stdout = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stdout.writable.getWriter();
	const encoder = new TextEncoder();
	const exited = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let written = Promise.withResolvers<string>();
	return {
		child: {
			// No process: the connection's descendant kill must not touch any real pid.
			pid: 0,
			stdin: {
				write: data => {
					written.resolve(typeof data === "string" ? data : new TextDecoder().decode(data));
					written = Promise.withResolvers<string>();
				},
				flush: () => {},
				end: () => {},
			},
			stdout: stdout.readable,
			stderr: new ReadableStream({ start: controller => controller.close() }),
			exited: exited.promise,
			get exitCode() {
				return exitCode;
			},
			kill: () => {
				exitCode = 137;
				exited.resolve(137);
			},
		},
		emit: line => void writer.write(encoder.encode(`${line}\n`)),
		nextWrite: () => written.promise,
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function newShell(connection: SandboxHostConnection): SandboxedShell {
	return new SandboxedShell(Promise.resolve(connection), { options: {} });
}

async function run(
	shell: SandboxedShell,
	command: string,
	extra?: { filesystem?: ShellFilesystem; trace?: SandboxRunTrace; cwd?: string },
): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean }> {
	let output = "";
	const result = await shell.run({ command, ...extra }, (error, chunk) => {
		if (!error) output += chunk;
	});
	return { output, exitCode: result.exitCode, cancelled: result.cancelled };
}

/** Starts `command` (which must print before blocking); `started` settles on its first output. */
function startRun(shell: SandboxedShell, command: string): { result: Promise<ShellRunResult>; started: Promise<void> } {
	const started = Promise.withResolvers<void>();
	const result = shell.run({ command }, () => started.resolve());
	return { result, started: started.promise };
}

/** In-memory `mem://box/` filesystem: one binary file to read, one file to write. */
function memoryFilesystem(content: Uint8Array): { filesystem: ShellFilesystem; written: () => Uint8Array } {
	const writes: Uint8Array[] = [];
	const respond = (request: ShellFsRequest): ShellFsResponse => {
		const target = request.path ?? "";
		switch (request.op) {
			case "metadata":
			case "symlinkMetadata":
				if (target.endsWith("out.bin")) return { error: { code: "ENOENT" } };
				return { metadata: { fileType: ShellFsFileType.File, size: content.length, mode: 0o644 } };
			case "fileMetadata":
				return { metadata: { fileType: ShellFsFileType.File, size: content.length, mode: 0o644 } };
			case "open":
				return { handle: target.endsWith("out.bin") ? 2 : 1 };
			case "read": {
				const offset = Number(request.offset ?? 0n);
				return {
					data: request.handle === 1 ? content.subarray(offset, offset + (request.length ?? 0)) : new Uint8Array(),
				};
			}
			case "write":
				writes.push(new Uint8Array(request.data ?? new Uint8Array()));
				return { written: request.data?.length ?? 0 };
			case "close":
			case "flush":
				return {};
			default:
				return { error: { code: "ENOTSUP" } };
		}
	};
	return {
		filesystem: { nativeLocalPaths: true, handler: async (_error, request) => respond(request) },
		written: () => Buffer.concat(writes),
	};
}

describe("sandbox host protocol (plain subprocess)", () => {
	let host: { connection: SandboxHostConnection; child: Bun.Subprocess<"pipe", "pipe", "pipe"> };
	let tmp: string;

	beforeAll(async () => {
		host = await startPlainHost();
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-host-")));
	});

	afterAll(() => {
		host.connection.kill("test done");
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("keeps cd and export state across runs of one shell", async () => {
		const shell = newShell(host.connection);
		expect((await run(shell, `cd ${tmp} && export OMP_HOST_TEST=kept`)).exitCode).toBe(0);
		const second = await run(shell, 'pwd; echo "$OMP_HOST_TEST"');
		expect(second.output).toBe(`${tmp}\nkept\n`);
	});

	it("streams chunks while the run is still in flight", async () => {
		const shell = newShell(host.connection);
		const arrivals: { chunk: string; at: number }[] = [];
		const result = await shell.run({ command: "echo first; sleep 0.6; echo second" }, (error, chunk) => {
			if (!error) arrivals.push({ chunk, at: performance.now() });
		});
		const settledAt = performance.now();
		expect(result.exitCode).toBe(0);
		expect(arrivals.map(a => a.chunk).join("")).toBe("first\nsecond\n");
		expect(settledAt - arrivals[0].at).toBeGreaterThan(300);
	});

	it("relays trace snapshots", async () => {
		const shell = newShell(host.connection);
		const trace = new SandboxRunTrace();
		expect(trace.version()).toBe(-1);
		await run(shell, "echo traced", { trace });
		expect(trace.version()).toBeGreaterThanOrEqual(0);
		const snapshot: unknown = JSON.parse(trace.snapshot());
		expect(isShellTrace(snapshot)).toBe(true);
	});

	it("reports live pids during a run and none after", async () => {
		const shell = newShell(host.connection);
		const running = startRun(shell, "echo go; /bin/sleep 1");
		await running.started;
		// The host pushes pid changes on its own poll cadence; wait for that report, bounded.
		let seen: number[] = [];
		for (let i = 0; i < 40 && seen.length === 0; i++) {
			await Bun.sleep(25);
			seen = shell.pids();
		}
		expect(seen.length).toBeGreaterThan(0);
		await running.result;
		expect(shell.pids()).toEqual([]);
	});

	it("aborts a running command", async () => {
		const shell = newShell(host.connection);
		const started = performance.now();
		const running = startRun(shell, "echo go; sleep 30");
		await running.started;
		await shell.abort();
		const result = await running.result;
		expect(result.cancelled).toBe(true);
		expect(performance.now() - started).toBeLessThan(10_000);
		// The shell stays usable after an abort.
		expect((await run(shell, "echo after")).output).toBe("after\n");
	});

	it("isolates a fork's state from its parent", async () => {
		const shell = newShell(host.connection);
		await run(shell, "export OMP_FORK_TEST=parent");
		const fork = shell.fork();
		expect((await run(fork, 'echo "$OMP_FORK_TEST"; export OMP_FORK_TEST=child')).output).toBe("parent\n");
		expect((await run(shell, 'echo "$OMP_FORK_TEST"')).output).toBe("parent\n");
		expect((await run(fork, 'echo "$OMP_FORK_TEST"')).output).toBe("child\n");
	});

	it("bridges URL paths to the parent's filesystem, binary bytes intact both ways", async () => {
		const shell = newShell(host.connection);
		const memory = memoryFilesystem(Uint8Array.from([0x68, 0x69, 0x00, 0xff, 0x0a]));
		const result = await run(shell, "od -An -tx1 mem://box/in.bin; printf 'x\\0y\\377' > mem://box/out.bin", {
			filesystem: memory.filesystem,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("68 69 00 ff 0a");
		expect([...memory.written()]).toEqual([0x78, 0x00, 0x79, 0xff]);
	});

	it("counts live background jobs", async () => {
		const shell = newShell(host.connection);
		// An external process: the builtin `sleep` runs in-process and leaves no job child.
		await run(shell, "/bin/sleep 2 &");
		expect(await shell.liveBackgroundJobCount()).toBe(1);
	});

	it("relays a PTY: output, exit status, and a terminal on stdout", async () => {
		const { connection } = host;
		const data: string[] = [];
		const exit = Promise.withResolvers<PtyRunResult>();
		connection.attachPty(9001, {
			onData: chunk => data.push(chunk),
			onExit: (result, error) => (error ? exit.reject(new Error(error)) : exit.resolve(result)),
			onFail: exit.reject,
		});
		const started = await connection.request({
			op: "pty.start",
			pty: 9001,
			start: { command: "if [ -t 1 ]; then echo tty; else echo notty; fi; exit 3", cols: 80, rows: 24 },
		});
		expect(started.pid).toBeGreaterThan(0);
		const result = await exit.promise;
		expect(result.exitCode).toBe(3);
		expect(data.join("")).toContain("tty");
		expect(data.join("")).not.toContain("notty");
	});

	it("delivers PTY input and reports a killed PTY as cancelled", async () => {
		const { connection } = host;
		const data: string[] = [];
		const firstExit = Promise.withResolvers<PtyRunResult>();
		connection.attachPty(9002, {
			onData: chunk => data.push(chunk),
			onExit: result => firstExit.resolve(result),
			onFail: firstExit.reject,
		});
		await connection.request({
			op: "pty.start",
			pty: 9002,
			start: { command: 'read x; echo "got:$x"', cols: 80, rows: 24 },
		});
		connection.notify({ op: "pty.write", pty: 9002, data: "hello\n" });
		expect((await firstExit.promise).exitCode).toBe(0);
		expect(data.join("")).toContain("got:hello");

		const killedExit = Promise.withResolvers<PtyRunResult>();
		connection.attachPty(9003, {
			onData: () => {},
			onExit: result => killedExit.resolve(result),
			onFail: killedExit.reject,
		});
		await connection.request({ op: "pty.start", pty: 9003, start: { command: "sleep 30", cols: 80, rows: 24 } });
		await connection.request({ op: "pty.kill", pty: 9003 });
		expect((await killedExit.promise).cancelled).toBe(true);
	});
});

describe("sandbox host connection", () => {
	it("refuses a host speaking another protocol version", async () => {
		const fake = fakeHost();
		const connecting = SandboxHostConnection.connect(fake.child);
		fake.emit(JSON.stringify({ ev: "ready", version: 999 }));
		await expect(connecting).rejects.toThrow(/speaks protocol 999/);
	});

	it("kills the connection and rejects in-flight calls on an invalid line", async () => {
		for (const garbage of ["not json", JSON.stringify({ ev: "shell.chunk" }), JSON.stringify(null)]) {
			const fake = fakeHost();
			const connecting = SandboxHostConnection.connect(fake.child);
			fake.emit(JSON.stringify({ ev: "ready", version: 1 }));
			const connection = await connecting;
			const pending = connection.request({ op: "shell.jobs", shell: 1 });
			fake.emit(garbage);
			await expect(pending).rejects.toThrow(/invalid message/);
			expect(connection.closed).toBe(true);
		}
	});

	it("answers a filesystem request of a run without a filesystem with ENOTSUP", async () => {
		const fake = fakeHost();
		const connecting = SandboxHostConnection.connect(fake.child);
		fake.emit(JSON.stringify({ ev: "ready", version: 1 }));
		const connection = await connecting;
		const requestSent = fake.nextWrite();
		void connection.request({ op: "shell.jobs", shell: 1 }).catch(() => {});
		await requestSent;
		const replySent = fake.nextWrite();
		fake.emit(JSON.stringify({ ev: "fs.request", id: 1, req: 7, request: { op: "metadata", path: "mem://x" } }));
		const reply = JSON.parse(await replySent);
		expect(reply).toMatchObject({ op: "fs.reply", req: 7, response: { error: { code: "ENOTSUP" } } });
		connection.kill("test done");
	});

	it("never runs a command cancelled while its host was starting", async () => {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-host-cancel-")));
		const marker = path.join(tmp, "ran");
		const starting = Promise.withResolvers<SandboxHostConnection>();
		const shell = new SandboxedShell(starting.promise, { options: {} });
		const running = shell.run({ command: `touch ${marker}` });
		const aborting = shell.abort();
		const { connection } = await startPlainHost();
		starting.resolve(connection);
		await aborting;
		expect((await running).cancelled).toBe(true);
		// One more round trip: had the run been sent, it would have finished before this one.
		expect(await new SandboxedShell(starting.promise, { options: {} }).run({ command: "true" })).toMatchObject({
			exitCode: 0,
		});
		expect(fs.existsSync(marker)).toBe(false);
		connection.kill("test done");
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("sandbox host lifecycle", () => {
	it("exits on its own once stdin closes", async () => {
		const { connection, child } = await startPlainHost();
		connection.retire();
		expect(await child.exited).toBe(0);
		expect(connection.closed).toBe(true);
	});

	it("ends its background jobs' processes when its parent goes away (stdin closes)", async () => {
		const { connection, child } = await startPlainHost();
		const pid = Number((await run(newShell(connection), "/bin/sleep 300 & echo $!")).output.trim());
		expect(isAlive(pid)).toBe(true);
		// Not `retire()`: that kills the descendants from the parent side. Only the host's own shutdown runs here.
		child.stdin.end();
		expect(await child.exited).toBe(0);
		for (let i = 0; i < 40 && isAlive(pid); i++) await Bun.sleep(25);
		expect(isAlive(pid)).toBe(false);
	});

	for (const end of ["kill", "retire"] as const) {
		it(`ends a background job's process when the host is ${end === "kill" ? "killed" : "retired"}`, async () => {
			const { connection, child } = await startPlainHost();
			const shell = newShell(connection);
			const pid = Number((await run(shell, "/bin/sleep 300 & echo $!")).output.trim());
			expect(isAlive(pid)).toBe(true);
			if (end === "kill") connection.kill("test done");
			else connection.retire();
			await child.exited;
			// The tree kill signals synchronously; reaping by init may lag a moment.
			for (let i = 0; i < 40 && isAlive(pid); i++) await Bun.sleep(25);
			expect(isAlive(pid)).toBe(false);
		});
	}

	it("rejects an in-flight run when the host is killed", async () => {
		const { connection, child } = await startPlainHost();
		const shell = newShell(connection);
		const running = startRun(shell, "echo go; sleep 30");
		await running.started;
		child.kill("SIGKILL");
		await expect(running.result).rejects.toThrow(/Sandbox host exited unexpectedly/);
		// Later calls on the dead host fail the same way instead of hanging.
		await expect(run(shell, "echo late")).rejects.toThrow(/Sandbox host exited unexpectedly/);
	});

	it(
		"kills a host that does not stop an aborted command",
		async () => {
			const { connection, child } = await startPlainHost();
			const shell = newShell(connection);
			const running = startRun(shell, "echo go; sleep 30");
			await running.started;
			// A stopped host cannot answer: the abort's settle grace (real time, in the client) runs out.
			child.kill("SIGSTOP");
			await shell.abort();
			await expect(running.result).rejects.toThrow(/did not stop the aborted command/);
			expect(connection.closed).toBe(true);
			// The plain child got SIGTERM, which a stopped process holds pending; reap it.
			child.kill("SIGKILL");
			await child.exited;
		},
		{ timeout: 20_000 },
	);
});
