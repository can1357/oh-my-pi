import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnManagedChild } from "@oh-my-pi/pi-coding-agent/daemon/children";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { McpStdioSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { resolveStdioSpawnCommand, StdioUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/stdio-upstream";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf, trackUnhandled } from "../helpers/rejection";
import { FIXTURES, isAlive, realDeps, stdioSpec } from "./upstream-support";

type Frame = Record<string, unknown>;

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
});

/** The `.cmd` wrapper npm's cmd-shim writes for a package binary run by `prog`. */
function npmShim(prog: string, target: string): string {
	return [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		`IF EXIST "%dp0%\\${prog}.exe" (`,
		`  SET "_prog=%dp0%\\${prog}.exe"`,
		") ELSE (",
		`  SET "_prog=${prog}"`,
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${target}" %*`,
		"",
	].join("\r\n");
}

describe("resolveStdioSpawnCommand", () => {
	/** A Windows lookup on this host: `.cmd` is the only PATHEXT entry so candidates match the files written here. */
	function windows(cwd: string, searchPath: string, signal?: AbortSignal) {
		return { cwd, env: { PATH: searchPath, PATHEXT: ".cmd" }, platform: "win32" as const, signal };
	}

	it("resolves a bare Windows command through PATH and PATHEXT to the full path of its .cmd shim", async () => {
		// CreateProcess only ever appends `.exe`, so a bare `codegraph` would not find `codegraph.cmd`.
		const project = await tempDir("omp-mcp-stdio-cwd-");
		const globalBin = await tempDir("omp-mcp-stdio-path-");
		const shim = path.join(globalBin, "codegraph.cmd");
		await Bun.write(shim, "@echo off\r\n");

		const argv = await resolveStdioSpawnCommand("codegraph", ["serve", "--mcp"], windows(project, globalBin));

		expect(argv).toEqual([shim, "serve", "--mcp"]);
	});

	it("prefers a project-local .cmd shim over a same-named one on PATH", async () => {
		const project = await tempDir("omp-mcp-stdio-cwd-");
		const globalBin = await tempDir("omp-mcp-stdio-path-");
		const localShim = path.join(project, "server.cmd");
		await Bun.write(localShim, "@echo off\r\nrem local\r\n");
		await Bun.write(path.join(globalBin, "server.cmd"), "@echo off\r\nrem global\r\n");

		const argv = await resolveStdioSpawnCommand("server.cmd", ["serve"], windows(project, globalBin));

		expect(argv).toEqual([localShim, "serve"]);
	});

	it("promotes an extension-less absolute Windows path to its sibling .cmd shim", async () => {
		// npm's layout: a shebang script `codegraph` next to `codegraph.cmd`; only the latter can be launched.
		const dir = await tempDir("omp-mcp-stdio-abs-");
		const bare = path.join(dir, "codegraph");
		await Bun.write(bare, "#!/bin/sh\n");
		await Bun.write(`${bare}.cmd`, "@echo off\r\n");

		const argv = await resolveStdioSpawnCommand(bare, ["serve", "--mcp"], windows(dir, ""));

		expect(argv).toEqual([`${bare}.cmd`, "serve", "--mcp"]);
	});

	it("launches an npm shim whose interpreter is node as the node invocation it wraps", async () => {
		// Through the shim, cmd.exe would own the pipes instead of the server process.
		const dir = await tempDir("omp-mcp-stdio-shim-");
		await Bun.write(
			path.join(dir, "codegraph.cmd"),
			npmShim("node", "node_modules\\@colbymchenry\\codegraph\\npm-shim.js"),
		);

		const argv = await resolveStdioSpawnCommand("codegraph.cmd", ["serve", "--mcp"], windows(dir, dir));

		expect(argv).toEqual([
			"node",
			path.join(dir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js"),
			"serve",
			"--mcp",
		]);
	});

	it("keeps npx.cmd a batch launch even though its shim wraps node", async () => {
		// npm relies on the shim's environment for `npx`; unwrapping it breaks package resolution.
		const dir = await tempDir("omp-mcp-stdio-npx-");
		const shim = path.join(dir, "npx.cmd");
		await Bun.write(shim, npmShim("node", "node_modules\\npm\\bin\\npx-cli.js"));

		const argv = await resolveStdioSpawnCommand("npx", ["-y", "mcp-gdb"], windows(dir, dir));

		expect(argv).toEqual([shim, "-y", "mcp-gdb"]);
	});

	it("keeps a shim whose interpreter is not node a batch launch instead of running its target with node", async () => {
		const dir = await tempDir("omp-mcp-stdio-pyshim-");
		const shim = path.join(dir, "pyserver.cmd");
		await Bun.write(shim, npmShim("python", "node_modules\\pyserver\\cli.py"));

		const argv = await resolveStdioSpawnCommand("pyserver.cmd", ["serve"], windows(dir, dir));

		expect(argv).toEqual([shim, "serve"]);
	});

	it("passes a Windows command the lookup cannot find as given, so the spawn reports it missing", async () => {
		const dir = await tempDir("omp-mcp-stdio-missing-");
		const missing = path.join(dir, "missing-server");

		expect(await resolveStdioSpawnCommand(missing, ["serve"], windows(dir, ""))).toEqual([missing, "serve"]);
		expect(await resolveStdioSpawnCommand("npx", ["-y", "pkg"], windows(dir, ""))).toEqual(["npx", "-y", "pkg"]);
	});

	it("rejects a Windows batch launch whose command or arguments would truncate the cmd.exe command line", async () => {
		const dir = await tempDir("omp-mcp-stdio-batch-");
		for (const bad of ["a\0b", "a\rb", "a\nb"]) {
			expect(await rejectionOf(resolveStdioSpawnCommand("server.cmd", [bad], windows(dir, "")))).toEqual(
				new Error("Windows batch MCP command and arguments cannot contain NUL, CR, or LF characters"),
			);
		}
		expect(
			await rejectionOf(resolveStdioSpawnCommand("C:\\work\\ser\rver.cmd", ["serve"], windows(dir, ""))),
		).toEqual(new Error("Windows batch MCP command and arguments cannot contain NUL, CR, or LF characters"));
	});

	it("stops the Windows lookup with the abort reason when the caller gives up", async () => {
		const dir = await tempDir("omp-mcp-stdio-abort-");
		await Bun.write(path.join(dir, "server.cmd"), "@echo off\r\n");
		const reason = new Error("nobody is waiting");

		const lookup = resolveStdioSpawnCommand("server", [], windows(dir, dir, AbortSignal.abort(reason)));

		expect(await rejectionOf(lookup)).toBe(reason);
	});

	it("leaves the command alone on other platforms, where the OS resolves it", async () => {
		const dir = await tempDir("omp-mcp-stdio-posix-");
		await Bun.write(path.join(dir, "codegraph.cmd"), "@echo off\r\n");

		const argv = await resolveStdioSpawnCommand("codegraph", ["serve", "--mcp"], {
			cwd: dir,
			env: { PATH: dir, PATHEXT: ".cmd" },
			platform: "linux",
		});

		expect(argv).toEqual(["codegraph", "serve", "--mcp"]);
	});
});

describe("StdioUpstream", () => {
	const upstreams: StdioUpstream[] = [];

	afterEach(async () => {
		for (const upstream of upstreams.splice(0)) await upstream.close();
	});

	function upstreamOf(spec: McpStdioSpec): StdioUpstream {
		const upstream = new StdioUpstream(spec);
		upstreams.push(upstream);
		return upstream;
	}

	/** A server that is `code` run by bun. */
	function inline(code: string): McpStdioSpec {
		return stdioSpec("-e", [code]);
	}

	/** Leaves when its stdin closes, like a well-behaved stdio server. */
	const UNTIL_STDIN_CLOSES = "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();";
	/** Runs `reaction` once the first request line arrived, with the parsed request as `request`. */
	function onFirstRequest(reaction: string): string {
		return `process.stdin.once('data', data => { const request = JSON.parse(String(data).split('\\n')[0]); ${reaction} }); process.stdin.resume();`;
	}

	it("continues the id sequence of an adopted child, so request ids and progress tokens stay unique", async () => {
		// Answers every request with the id and progress token it carried.
		const spec = inline(
			"require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { id: request.id, token: request.params._meta?.progressToken ?? null } })); }).on('close', () => process.exit(0));",
		);
		const upstream = upstreamOf(spec);
		const child = spawnManagedChild({
			application: spec.command,
			args: spec.args,
			env: spec.spawnEnv,
			cwd: spec.cwd,
		});

		upstream.adopt(child, { remainder: "", lastId: 41 });

		expect(await upstream.request<unknown>("tools/call", { name: "any" }, { onProgress: () => {} })).toEqual({
			id: 42,
			token: 42,
		});
		expect(await upstream.request<unknown>("tools/call", { name: "any" })).toEqual({ id: 43, token: null });
		expect(upstream.snapshot()?.state.lastId).toBe(43);
	});

	it("refuses to send before a child exists and after it was closed, as nothing was written", async () => {
		const upstream = upstreamOf(inline(UNTIL_STDIN_CLOSES));
		const unsent = { transport: "stdio", failure: "closed", retryable: true, message: "Transport not connected" };

		expect(await rejectionOf(upstream.notify("noop"))).toMatchObject(unsent);
		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject(unsent);

		await upstream.connect(realDeps().spawn);
		await upstream.close();

		expect(await rejectionOf(upstream.notify("noop"))).toMatchObject(unsent);
		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject(unsent);
	});

	it("survives a child that exits while a notification is being written", async () => {
		// A broken pipe once escaped as an unhandled rejection and took the whole process down.
		const tracker = trackUnhandled();
		try {
			const upstream = upstreamOf(inline("process.exit(0)"));
			const closed = Promise.withResolvers<void>();
			upstream.onClose = closed.resolve;

			await upstream.connect(realDeps().spawn);
			await upstream.notify("notifications/initialized").catch(() => {});
			await closed.promise;
			// One macrotask for a rejection nobody observed to be reported.
			await Bun.sleep(0);

			expect(upstream.connected).toBe(false);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("names the exit code in the failure of a request the subprocess died on", async () => {
		const upstream = upstreamOf(inline(onFirstRequest("process.exit(23);")));
		await upstream.connect(realDeps().spawn);

		const error = await rejectionOf(upstream.request("tools/list"));

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			retryable: false,
			code: 23,
			message: "MCP subprocess exited with code 23 before responding",
		});
	});

	it.skipIf(process.platform === "win32")(
		"names the signal in the failure of a request the subprocess was killed on",
		async () => {
			const upstream = upstreamOf(inline(onFirstRequest("process.kill(process.pid, 'SIGKILL');")));
			await upstream.connect(realDeps().spawn);

			const error = await rejectionOf(upstream.request("tools/list"));

			expect(error).toBeInstanceOf(MCPTransportError);
			expect(error).toMatchObject({
				transport: "stdio",
				stage: "receive",
				failure: "eof",
				retryable: false,
				code: os.constants.signals.SIGKILL,
				message: `MCP subprocess was killed by signal ${os.constants.signals.SIGKILL} before responding`,
			});
		},
	);

	it("skips stdout lines that are not JSON and still delivers the response behind them", async () => {
		// Servers print banners and stray logs on stdout; they are not messages.
		const upstream = upstreamOf(
			inline(
				onFirstRequest(
					"console.log('Server ready {not-json'); console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }));",
				),
			),
		);
		await upstream.connect(realDeps().spawn);

		expect(await upstream.request<unknown>("tools/list")).toEqual({ tools: [] });
	});

	it("rejects a response whose error member is not a JSON-RPC error as malformed", async () => {
		const upstream = upstreamOf(
			inline(onFirstRequest("console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: 'boom' }));")),
		);
		await upstream.connect(realDeps().spawn);

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({
			transport: "stdio",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});

	it("fires onClose once when the child exits by itself, and not again when closed afterwards", async () => {
		const upstream = upstreamOf(inline("process.exit(0)"));
		const closed = Promise.withResolvers<void>();
		let closes = 0;
		upstream.onClose = () => {
			closes++;
			closed.resolve();
		};

		await upstream.connect(realDeps().spawn);
		await closed.promise;
		expect(upstream.connected).toBe(false);

		await upstream.close();
		await upstream.close();

		expect(closes).toBe(1);
		expect(await upstream.exited).toEqual({ code: 0, signal: undefined, stderr: "" });
	});

	it("shuts a server down by closing its stdin, and repeated close() calls fire onClose once", async () => {
		const deps = realDeps();
		const upstream = upstreamOf(inline("process.stdin.on('end', () => process.exit(7)); process.stdin.resume();"));
		let closes = 0;
		upstream.onClose = () => closes++;
		await upstream.connect(deps.spawn);

		await Promise.all([upstream.close(), upstream.close()]);
		await upstream.close();

		// The server's own exit code: no signal was needed.
		expect(await upstream.exited).toEqual({ code: 7, signal: undefined, stderr: "" });
		expect(closes).toBe(1);
		expect(upstream.connected).toBe(false);
		expect(isAlive(deps.pids[0])).toBe(false);
	});

	// POSIX only: Windows terminates on the first signal whatever the handler says.
	it.skipIf(process.platform === "win32")(
		"escalates to SIGKILL when the child ignores both end-of-input and SIGTERM",
		async () => {
			const dir = await tempDir("omp-mcp-stdio-escalate-");
			const ready = path.join(dir, "ready");
			const deps = realDeps();
			const upstream = upstreamOf(
				inline(
					`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1'); setInterval(() => {}, 60_000);`,
				),
			);
			await upstream.connect(deps.spawn);
			// Closing before the handler is registered would let the default action end the child.
			while (!(await Bun.file(ready).exists())) await Bun.sleep(10);

			await upstream.close();

			expect(await upstream.exited).toMatchObject({ signal: os.constants.signals.SIGKILL });
			expect(isAlive(deps.pids[0])).toBe(false);
			await upstream.close();
		},
		8_000,
	);

	describe("cancellation", () => {
		const CANCELLABLE = path.join(FIXTURES, "cancellable-mcp.ts");
		let logPath: string;

		beforeEach(async () => {
			logPath = path.join(await tempDir("omp-mcp-stdio-cancel-"), "frames.jsonl");
			await Bun.write(logPath, "");
		});

		/** The fixture, which logs every frame it reads and never answers a `hang` call. */
		async function start(mode = "normal", overrides: Partial<McpStdioSpec> = {}): Promise<StdioUpstream> {
			const upstream = upstreamOf({ ...stdioSpec(CANCELLABLE, [logPath, mode]), ...overrides });
			await upstream.connect(realDeps().spawn);
			return upstream;
		}

		/** Every complete frame the server has read so far. */
		async function frames(): Promise<Frame[]> {
			const text = await Bun.file(logPath).text();
			return text
				.slice(0, text.lastIndexOf("\n") + 1)
				.split("\n")
				.filter(line => line.length > 0)
				.map((line): Frame => JSON.parse(line));
		}

		async function cancellations(): Promise<Frame[]> {
			return (await frames()).filter(frame => frame.method === "notifications/cancelled");
		}

		function isHangCall(frame: Frame): boolean {
			return frame.method === "tools/call" && JSON.stringify(frame.params).includes('"hang"');
		}

		/**
		 * Answered only after the server read everything written before it, so
		 * the frame log is complete up to this call when it returns.
		 */
		async function barrier(upstream: StdioUpstream): Promise<void> {
			expect(
				await upstream.request<unknown>("tools/call", { name: "echo", arguments: { text: "still serving" } }),
			).toEqual({
				content: [{ type: "text", text: "still serving" }],
			});
		}

		it("does not spawn a child when the caller aborts while the command is being resolved", async () => {
			const deps = realDeps();
			const upstream = upstreamOf(stdioSpec(CANCELLABLE, [logPath]));
			const caller = new AbortController();
			const reason = new Error("cancelled");

			const connecting = upstream.connect(deps.spawn, caller.signal);
			caller.abort(reason);

			expect(await rejectionOf(connecting)).toBe(reason);
			expect(deps.pids).toEqual([]);
			expect(upstream.connected).toBe(false);
		});

		it("rejects with the abort reason and tells the server once, by the request's numeric id", async () => {
			const upstream = await start();
			const caller = new AbortController();
			const reason = new Error("private caller details must not reach the server");
			const hanging = upstream.request("tools/call", { name: "hang" }, { signal: caller.signal });
			await barrier(upstream);

			caller.abort(reason);

			expect(await rejectionOf(hanging)).toBe(reason);
			await barrier(upstream);
			const sent = (await frames()).find(isHangCall);
			expect(typeof sent?.id).toBe("number");
			expect(await cancellations()).toEqual([
				{
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: sent?.id, reason: "Request cancelled by the client" },
				},
			]);
			expect(upstream.connected).toBe(true);
		});

		it("cancels by the string id a server asked for, and reports a non-Error abort reason as Aborted", async () => {
			const upstream = await start("normal", { requestIdFormat: "string" });
			const caller = new AbortController();
			const hanging = upstream.request("tools/call", { name: "hang" }, { signal: caller.signal });
			await barrier(upstream);

			caller.abort("private non-Error reason");

			expect(await rejectionOf(hanging)).toEqual(new Error("Aborted"));
			await barrier(upstream);
			const sent = (await frames()).find(isHangCall);
			expect(typeof sent?.id).toBe("string");
			expect((await cancellations()).map(frame => frame.params)).toEqual([
				{ requestId: sent?.id, reason: "Request cancelled by the client" },
			]);
		});

		it("writes neither the request nor a cancellation when the signal is already aborted", async () => {
			const upstream = await start();
			const reason = new Error("already cancelled");

			const refused = upstream.request("tools/call", { name: "hang" }, { signal: AbortSignal.abort(reason) });

			expect(await rejectionOf(refused)).toBe(reason);
			await barrier(upstream);
			expect((await frames()).filter(isHangCall)).toEqual([]);
			expect(await cancellations()).toEqual([]);
		});

		it("does not cancel a request the server already answered or rejected", async () => {
			const upstream = await start();
			const caller = new AbortController();
			await upstream.request(
				"tools/call",
				{ name: "echo", arguments: { text: "answered" } },
				{ signal: caller.signal },
			);
			expect(
				await rejectionOf(upstream.request("unknown/method", undefined, { signal: caller.signal })),
			).toMatchObject({
				failure: "json_rpc",
				code: -32601,
			});

			caller.abort(new Error("after both settled"));

			await barrier(upstream);
			expect(await cancellations()).toEqual([]);
		});

		it("fails a pending request as closed and not replayable; aborting it afterwards is harmless", async () => {
			const upstream = await start();
			const caller = new AbortController();
			const outcome = rejectionOf(upstream.request("tools/call", { name: "hang" }, { signal: caller.signal }));
			await barrier(upstream);

			await upstream.close();
			const error = await outcome;
			// A listener still attached here would write to a child that is gone.
			caller.abort(new Error("after close"));

			expect(error).toMatchObject({ transport: "stdio", failure: "closed", retryable: false });
			expect(upstream.connected).toBe(false);
		});

		it("never sends a cancellation for initialize, which the handshake era forbids cancelling", async () => {
			const upstream = await start("hang-initialize");
			const caller = new AbortController();
			const reason = new Error("cancel initialization locally");
			const initializing = upstream.request("initialize", undefined, { signal: caller.signal });
			await barrier(upstream);

			caller.abort(reason);

			expect(await rejectionOf(initializing)).toBe(reason);
			await barrier(upstream);
			expect(await cancellations()).toEqual([]);
		});

		it("rejects an aborted request at once while the server is not reading, without tearing the upstream down", async () => {
			const upstream = await start("no-read");
			while (!(await Bun.file(`${logPath}.ready`).exists())) await Bun.sleep(5);
			let closes = 0;
			upstream.onClose = () => closes++;
			const tracker = trackUnhandled();
			try {
				const caller = new AbortController();
				const reason = new Error("abort a parked write");
				// Far more than a pipe holds: most of the request is still queued when the abort lands.
				const parked = upstream.request(
					"tools/call",
					{ name: "hang", arguments: { text: "x".repeat(2 * 1024 * 1024) } },
					{ signal: caller.signal },
				);

				caller.abort(reason);

				expect(await rejectionOf(parked)).toBe(reason);
				expect(closes).toBe(0);
				expect(upstream.connected).toBe(true);
				await upstream.close();
				await Bun.sleep(0);
				expect(tracker.capture()).toEqual([]);
			} finally {
				tracker.release();
			}
		});
	});
});
