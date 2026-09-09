import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveStdioSpawnCommand, StdioTransport, terminateStdioProcess } from "../../../src/mcp/transports/stdio";

describe("resolveStdioSpawnCommand", () => {
	it("hides Windows executable MCP servers when the host has no console", async () => {
		// Hidden so a console-app child does not allocate a visible window when
		// OMP is launched without a terminal console (#3536).
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: false },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
			detached: false,
		});
	});

	it("inherits an attached Windows console instead of forcing CREATE_NO_WINDOW", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: true },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: false,
			detached: false,
		});
	});

	it("keeps Darwin stdio MCP servers attached so TCC Apple Events prompts can resolve", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "xcrun", args: ["mcpbridge"] },
				{ cwd: process.cwd(), env: {}, platform: "darwin" },
			),
		).resolves.toEqual({
			cmd: ["xcrun", "mcpbridge"],
			detached: false,
		});
	});

	it("detaches off-Windows MCP servers so terminal job-control signals cannot stop them", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			detached: true,
		});
	});
});

describe("StdioTransport.connect", () => {
	it("passes argv as Bun.spawn's first argument and process options as the second", async () => {
		const cwd = process.cwd();
		const envValue = "stdio-spawn-shape";
		const argv = [process.execPath, "-e", "process.exit(0)"];
		const transport = new StdioTransport({
			command: argv[0],
			args: argv.slice(1),
			cwd,
			env: {
				OMP_STDIO_SPAWN_SHAPE: envValue,
			},
		});
		const spawnSpy = spyOn(Bun, "spawn");

		try {
			await transport.connect();

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const call = spawnSpy.mock.calls[0];
			if (!call) throw new Error("expected StdioTransport.connect() to spawn exactly one subprocess");

			const [spawnArgv, spawnOptions] = call;
			expect(spawnArgv).toEqual(argv);
			expect(spawnOptions).toEqual(
				expect.objectContaining({
					cwd,
					detached: !(process.platform === "darwin" || process.platform === "win32"),
					env: expect.objectContaining({
						OMP_STDIO_SPAWN_SHAPE: envValue,
					}),
					stderr: "pipe",
					stdin: "pipe",
					stdout: "pipe",
					windowsHide: process.platform === "win32" ? expect.any(Boolean) : undefined,
				}),
			);
		} finally {
			await transport.close();
			spawnSpy.mockRestore();
		}
	});
});

// Regression for #3945: request() awaited stdin.write/flush, so a child that
// stops draining stdin would park the async fn past the timeout timer and past
// `return promise`, orphaning the deferred rejection and hanging the caller
// forever. `sleep` is POSIX-only, so the check is scoped to non-Windows hosts.
describe.skipIf(process.platform === "win32")("StdioTransport request write stall", () => {
	it("rejects with the timeout error when the child never drains stdin", async () => {
		const timeoutMs = 100;
		const orphaned: Error[] = [];
		const captureOrphan = (reason: unknown) => {
			if (reason instanceof Error) orphaned.push(reason);
		};
		process.on("unhandledRejection", captureOrphan);

		// `sleep 60` accepts a stdin pipe but never reads it; a 1 MB payload
		// overruns the OS pipe buffer plus any FileSink JS-side buffering, so
		// Bun's write() returns a Promise that only settles if the child reads.
		const transport = new StdioTransport({
			command: "sleep",
			args: ["60"],
			timeout: timeoutMs,
		});

		try {
			await transport.connect();

			const bigParam = "x".repeat(1024 * 1024);
			const started = performance.now();
			const outcome = await transport.request("tools/call", { name: "noop", arguments: { blob: bigParam } }).then(
				() => ({ kind: "resolved" as const }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);
			const elapsedMs = performance.now() - started;

			expect(outcome.kind).toBe("rejected");
			if (outcome.kind !== "rejected") return;
			if (!(outcome.error instanceof Error)) {
				throw new Error(`expected Error rejection, got ${String(outcome.error)}`);
			}
			expect(outcome.error.message).toContain(`Request timeout after ${timeoutMs}ms`);
			// Generous ceiling: bare rejection latency plus room for slow CI. The
			// pre-fix behavior was an unbounded hang, not a slightly-late reject.
			expect(elapsedMs).toBeLessThan(timeoutMs + 1500);
			expect(orphaned).toEqual([]);
		} finally {
			process.off("unhandledRejection", captureOrphan);
			await transport.close();
		}
	}, 8000);
});

// `kill(pid, 0)` succeeds for a zombie too: a grandchild whose parent (the
// killed leader) is gone sits as <defunct> until whatever reaps orphans
// (init/subreaper) gets around to it — which can lag on some hosts. A
// zombie already received and honored the group SIGKILL; it is just not
// harvested yet, so treating it as "still alive" would make the group-kill
// assertions below flaky rather than testing what they claim to test.
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
	const state = result.stdout.toString().trim();
	return result.exitCode === 0 && state.length > 0 && !state.startsWith("Z");
}

// Regression for #5578: `close()` used a bare `this.#process.kill()` (direct
// SIGTERM, no wait, no escalate, no process-group signal), so a detached
// session-leader child (or a grandchild it spawned) that ignores/traps
// SIGTERM survived host exit and became an orphan pinned to PID 1 on Linux.
// `sleep`/`bun`/POSIX signal semantics are exercised directly here rather
// than through `StdioTransport.connect()`, because `connect()` derives
// `detached` from `resolveStdioSpawnCommand()`, which is tied to the host's
// real `process.platform` — a POSIX detached session cannot be reproduced
// end-to-end through `connect()` on a non-Linux dev/CI host, but a real
// detached process group can still be spawned directly on any POSIX host.
describe.skipIf(process.platform === "win32")("terminateStdioProcess", () => {
	const TEST_TERM_GRACE_MS = 50;
	it("escalates a detached child that traps SIGTERM to SIGKILL", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-kill-solo-"));
		const scriptPath = path.join(tempDir, "child.mjs");
		const readyPath = path.join(tempDir, "ready");
		await fs.writeFile(
			scriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(readyPath)}, '1');`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, scriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		try {
			// Wait for the child to actually register its SIGTERM handler before
			// signaling it: signaling too early races the child's startup and
			// hits the default (terminate) action instead of exercising the trap.
			for (let i = 0; i < 100; i++) {
				try {
					await fs.access(readyPath);
					break;
				} catch {
					await Bun.sleep(20);
				}
			}

			const started = performance.now();
			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			const elapsedMs = performance.now() - started;

			expect(proc.signalCode).toBe("SIGKILL");
			// The injected test grace preserves the production transition without
			// making this subprocess boundary test sleep for the full 1s window.
			expect(elapsedMs).toBeGreaterThanOrEqual(TEST_TERM_GRACE_MS - 15);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 5000);

	it("reaches a SIGTERM-trapping grandchild through the group SIGKILL, not just the direct child", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-group-kill-"));
		const grandchildScriptPath = path.join(tempDir, "grandchild.mjs");
		const parentScriptPath = path.join(tempDir, "parent.mjs");
		const grandchildPidPath = path.join(tempDir, "grandchild.pid");

		// Grandchild also traps SIGTERM, so only an unrestricted SIGKILL to the
		// whole group — not a signal to the direct (parent) child alone — can
		// reach and stop it.
		await fs.writeFile(
			grandchildScriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		await fs.writeFile(
			parentScriptPath,
			[
				"process.on('SIGTERM', () => {});",
				`Bun.spawn([process.execPath, ${JSON.stringify(grandchildScriptPath)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);

		const proc = Bun.spawn([process.execPath, parentScriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});

		try {
			// Polls real wall-clock time rather than an event/promise: the
			// grandchild process is a real external OS process writing to a real
			// file, with no in-process signal this test can `await` directly.
			let grandchildPid: number | undefined;
			for (let i = 0; i < 100 && grandchildPid === undefined; i++) {
				try {
					grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
				} catch {
					await Bun.sleep(20);
				}
			}
			if (grandchildPid === undefined) throw new Error("grandchild never reported its pid");
			expect(processExists(grandchildPid)).toBe(true);

			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			expect(proc.signalCode).toBe("SIGKILL");

			// The group SIGKILL is delivered to every member simultaneously, but
			// give the kernel a brief window to finish reaping before asserting.
			let grandchildAlive = processExists(grandchildPid);
			for (let i = 0; i < 25 && grandchildAlive; i++) {
				await Bun.sleep(20);
				grandchildAlive = processExists(grandchildPid);
			}
			expect(grandchildAlive).toBe(false);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 8000);

	it("still reaps a SIGTERM-trapping grandchild after the detached leader exits cooperatively", async () => {
		// Regression: the leader exiting within the SIGTERM grace window used to
		// be treated as proof the whole process group was gone, so `close()`
		// returned early and never delivered a group SIGKILL — leaving exactly
		// the orphaned grandchild this change is meant to reap. Unlike the
		// group-SIGKILL test above, the leader here does NOT trap SIGTERM, so
		// it exits promptly on its own; only the grandchild ignores signals.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-leader-exit-group-kill-"));
		const grandchildScriptPath = path.join(tempDir, "grandchild.mjs");
		const parentScriptPath = path.join(tempDir, "parent.mjs");
		const grandchildPidPath = path.join(tempDir, "grandchild.pid");

		await fs.writeFile(
			grandchildScriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		// No SIGTERM handler here: the default action (terminate) fires as soon
		// as the group SIGTERM lands, well inside TERM_GRACE_MS.
		await fs.writeFile(
			parentScriptPath,
			[
				`Bun.spawn([process.execPath, ${JSON.stringify(grandchildScriptPath)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);

		const proc = Bun.spawn([process.execPath, parentScriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});

		try {
			let grandchildPid: number | undefined;
			for (let i = 0; i < 100 && grandchildPid === undefined; i++) {
				try {
					grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
				} catch {
					await Bun.sleep(20);
				}
			}
			if (grandchildPid === undefined) throw new Error("grandchild never reported its pid");
			expect(processExists(grandchildPid)).toBe(true);

			const started = performance.now();
			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			const elapsedMs = performance.now() - started;

			// The leader exits on the initial SIGTERM (no trap), so this must not
			// block for the ~1s TERM grace window before sweeping the group.
			expect(elapsedMs).toBeLessThan(700);

			let grandchildAlive = processExists(grandchildPid);
			for (let i = 0; i < 25 && grandchildAlive; i++) {
				await Bun.sleep(20);
				grandchildAlive = processExists(grandchildPid);
			}
			expect(grandchildAlive).toBe(false);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 8000);

	it("never attempts a process-group signal when the transport did not spawn detached", async () => {
		const proc = Bun.spawn(["bun", "-e", "await Bun.sleep(60_000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: false,
		});
		const killSpy = spyOn(process, "kill");
		try {
			await terminateStdioProcess(proc, false);
			await proc.exited;

			// Only the direct-child `Subprocess.kill()` path may run; the global
			// `process.kill()` (used exclusively for the negative-pid group
			// signal) must never be reached.
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 5000);
});

describe.skipIf(process.platform === "win32")("StdioTransport.close teardown", () => {
	it("closes a well-behaved child promptly without escalating to SIGKILL", async () => {
		const transport = new StdioTransport({
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});
		try {
			await transport.connect();
			const started = performance.now();
			await transport.close();
			const elapsedMs = performance.now() - started;

			// No SIGTERM trap => the child dies almost immediately; close() must
			// not block for the full ~1s TERM grace window before returning.
			expect(elapsedMs).toBeLessThan(700);
		} finally {
			await transport.close();
		}
	}, 5000);
});

describe.skipIf(process.platform === "win32")("StdioTransport request ids", () => {
	/** Echoes each request back with the JSON type the server actually observed for `id`. */
	const ECHO_OBSERVED_ID = `for await (const line of console) {
		const message = JSON.parse(line);
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { idType: typeof message.id, id: message.id } }) + "\\n");
	}`;

	async function observeIds(requestIdFormat: "string" | "number" | undefined, methods: string[]) {
		const transport = new StdioTransport({ command: "bun", args: ["-e", ECHO_OBSERVED_ID], requestIdFormat });
		try {
			await transport.connect();
			const observed: { idType: string; id: unknown }[] = [];
			for (const method of methods) observed.push(await transport.request(method));
			return observed;
		} finally {
			await transport.close();
		}
	}

	it("sends integer ids by default", async () => {
		// The MCP ecosystem norm; integer-only decoders like Apple's `xcrun
		// mcpbridge` (#7053) work without configuration.
		expect(await observeIds(undefined, ["first", "second"])).toEqual([
			{ idType: "number", id: 1 },
			{ idType: "number", id: 2 },
		]);
	}, 15000);

	it("sends snowflake strings for servers opting into string ids", async () => {
		const [observed] = await observeIds("string", ["probe"]);

		expect(observed.idType).toBe("string");
	}, 15000);
});
