import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	resolveStdioSpawnCommand,
	StdioTransport,
	writeFrame,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/transports/stdio";

describe("resolveStdioSpawnCommand", () => {
	it("resolves bare Windows commands through PATHEXT and wraps .cmd shims with cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--mcp""`,
			]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers a project-local .cmd shim over a same-named global one when no path segment is given", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cwd-"));
		const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-global-"));
		try {
			const localShim = path.join(projectDir, "server.cmd");
			const globalShim = path.join(globalDir, "server.cmd");
			await Bun.write(localShim, "@echo off\r\nrem local\r\n");
			await Bun.write(globalShim, "@echo off\r\nrem global\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "server.cmd", args: ["serve"] },
				{
					cwd: projectDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: globalDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `""${localShim}" "serve""`]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
			await fs.rm(globalDir, { recursive: true, force: true });
		}
	});

	it("launches npm .cmd shims through node so CodeGraph owns the stdio pipes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-codegraph-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			const entry = path.join(tempDir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["node", entry, "serve", "--mcp"]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps non-node cmd-shim wrappers on the cmd.exe path instead of mislaunching them via node", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pyshim-"));
		try {
			const shim = path.join(tempDir, "pyserver.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\python.exe" (',
					'  SET "_prog=%dp0%\\python.exe"',
					") ELSE (",
					'  SET "_prog=python"',
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\pyserver\\cli.py" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "pyserver.cmd", args: ["serve"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `""${shim}" "serve""`]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("escapes percent-delimited args before routing .cmd shims through cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-percent-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--header", "Authorization=%TOKEN%"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--header" "Authorization=^%TOKEN^%""`,
			]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("escapes quoted JSON args before routing .cmd shims through cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-quotes-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["--config", '{"a":"b&c|d"}'] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "--config" "{^"a^":^"b&c|d^"}""`,
			]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves extension-less absolute Windows paths to the sibling .cmd shim", async () => {
		// Mirrors npm's Windows shim layout: bare `codegraph` (shebang script),
		// `codegraph.cmd` (cmd.exe wrapper), and `codegraph.ps1` siblings under
		// %AppData%\Roaming\npm. uv_spawn rejects the extensionless script;
		// the resolver must promote the bare absolute path to its `.cmd`
		// sibling so the launch succeeds (see #2174). The test rig pins
		// PATHEXT to a single lowercase extension so the candidate filename
		// matches the file we create on the case-sensitive test host.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-abs-"));
		try {
			const bare = path.join(tempDir, "codegraph");
			const shim = `${bare}.cmd`;
			await Bun.write(bare, "#!/bin/sh\n");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: bare, args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--mcp""`,
			]);
			expect(result.windowsHide).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("wraps explicit Windows .cmd commands with cmd.exe while preserving quoted argv", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "C:\\Users\\me\\AppData\\Roaming\\npm",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/s",
			"/c",
			`""codegraph.cmd" "serve" "--mcp""`,
		]);
		expect(result.windowsHide).toBe(true);
	});

	it("leaves non-Windows commands untouched", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
			{ cwd: "/", env: {}, platform: "linux" },
		);

		expect(result.cmd).toEqual(["codegraph", "serve", "--mcp"]);
		expect(result.windowsHide).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// writeFrame — the seam that catches synchronous FileSink throws AND neutralizes
// asynchronous (Promise) rejections, so the async `notify` / `#sendResponse` /
// `request` paths never let an un-awaited broken-pipe rejection escape as a fatal
// unhandled rejection. See issue #1710 and its async follow-up.
// ---------------------------------------------------------------------------

describe("writeFrame", () => {
	it("writes and flushes, returning true on success", () => {
		const sink = {
			writes: [] as string[],
			flushed: 0,
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, '{"k":1}\n')).toBe(true);
		expect(sink.writes).toEqual(['{"k":1}\n']);
		expect(sink.flushed).toBe(1);
	});

	it("returns false when write() throws synchronously (broken pipe)", () => {
		const sink = {
			flushed: 0,
			write() {
				throw new Error("EPIPE: broken pipe, write");
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.flushed).toBe(0);
	});

	it("returns false when flush() throws after a successful write", () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				throw new Error("EPIPE: broken pipe, flush");
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.writes).toEqual(["anything\n"]);
	});

	it("does not propagate non-Error throws either", () => {
		const sink = {
			write() {
				throw "string-thrown-non-error";
			},
			flush() {},
		};

		expect(writeFrame(sink, "x")).toBe(false);
	});

	it("returns true and neutralizes an asynchronous write rejection (broken pipe surfaced as a Promise)", async () => {
		const sink = {
			flushed: 0,
			write() {
				return Promise.reject(new Error("EPIPE: broken pipe, write"));
			},
			flush() {
				this.flushed++;
			},
		};

		const tracker = trackUnhandled();
		try {
			// No synchronous throw, so the frame is "accepted"; the async rejection
			// must be neutralized rather than escaping as an unhandled rejection.
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("returns true and neutralizes an asynchronous flush rejection", async () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				return Promise.reject(new Error("EPIPE: broken pipe, flush"));
			},
		};

		const tracker = trackUnhandled();
		try {
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — end-to-end behavior against a real subprocess that
// exits before or while a notification is sent. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink observes a closed pipe.
//   2. A failed write tears the transport down (`onClose` fires) and surfaces
//      a rejection to the caller when the platform reports one synchronously.
//
// On platforms where the pipe accepts the write, read-loop EOF still closes the
// transport. The request/response parsing path is covered separately; this test
// intentionally avoids requiring subprocess stdout because Bun's test runner can
// hand stdout-writing child processes an unusable fd on some hosts.
// ---------------------------------------------------------------------------

function trackUnhandled(): { release: () => unknown[]; capture: () => unknown[] } {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	return {
		release: () => {
			process.off("unhandledRejection", listener);
			return seen.slice();
		},
		capture: () => seen.slice(),
	};
}

describe("StdioTransport.notify", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("rejects synchronously when called before connect()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("rejects with 'Transport not connected' after close()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		await transport.connect();
		await transport.close();

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("does not surface unhandled rejections when the subprocess exits before notify settles", async () => {
		const tracker = trackUnhandled();
		const closed = Promise.withResolvers<void>();
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});
		transport.onClose = () => {
			closed.resolve();
		};

		try {
			await transport.connect();
			const notify = transport.notify("notifications/initialized").catch((error: unknown) => {
				expect(error).toBeInstanceOf(Error);
			});

			await closed.promise;
			await notify;
			await Promise.resolve();

			expect(tracker.capture()).toEqual([]);
			expect(transport.connected).toBe(false);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.close — authoritative resource teardown that must keep
// cleaning up the subprocess and read loop even when `#handleClose()` has
// already flipped `#connected` (read-loop EOF, or a notify() write failure
// in the connectToServer() failure path). See PR #1711 follow-up.
//
// Bun's parent-side stdout reader only sees EOF when the subprocess
// actually exits, so the "subprocess closed its stdout but stayed alive"
// state we'd love to test directly cannot be reproduced through a real
// subprocess on this platform. Instead we exercise the post-handleClose
// code path via the natural read-loop-EOF route and pair it with explicit
// idempotency checks; the reviewer-flagged leak surfaces on Windows where
// the notify() write actually throws.
// ---------------------------------------------------------------------------

describe("StdioTransport.close", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("completes cleanup when called after the read loop has already torn down", async () => {
		// Subprocess exits cleanly; the read loop sees EOF and fires
		// `#handleClose()`, flipping `#connected` to false. `close()` then
		// runs in exactly the state the reviewer flagged — `#connected`
		// already false, `#process` and `#readLoop` still set — and must
		// still null them out instead of early-returning.
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();

		// Wait for the read loop to observe EOF and fire #handleClose.
		for (let i = 0; i < 100 && transport.connected; i++) {
			await Bun.sleep(10);
		}
		expect(transport.connected).toBe(false);
		expect(closeCount).toBe(1);

		// Must not throw and must not re-fire onClose.
		await transport.close();
		expect(closeCount).toBe(1);

		// Second close is a no-op too — every resource is already released.
		await transport.close();
		expect(closeCount).toBe(1);
	});

	it("is idempotent — repeat close() calls fire onClose exactly once", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();
		await transport.close();
		await transport.close();
		await transport.close();

		expect(closeCount).toBe(1);
		expect(transport.connected).toBe(false);
	});
});

type CapturedFrame = {
	jsonrpc?: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
};

const STDIO_CAPTURE_FIXTURE = path.join(import.meta.dir, "fixtures", "mcp-stdio-capture.mjs");

async function readCapturedFrames(frameLog: string): Promise<CapturedFrame[]> {
	let contents: string;
	try {
		contents = await fs.readFile(frameLog, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return contents
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line) as CapturedFrame);
}

async function waitForCapturedFrames(
	frameLog: string,
	predicate: (frames: CapturedFrame[]) => boolean,
): Promise<CapturedFrame[]> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const frames = await readCapturedFrames(frameLog);
		if (predicate(frames)) return frames;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for captured stdio frames in ${frameLog}`);
}

describe("StdioTransport negotiated protocol behavior", () => {
	let transport: StdioTransport | undefined;
	let tempDir: string | undefined;
	let frameLog: string;

	async function connectCaptureServer(timeout?: number, extraEnv: Record<string, string> = {}): Promise<void> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-protocol-"));
		frameLog = path.join(tempDir, "frames.jsonl");
		transport = new StdioTransport({
			type: "stdio",
			command: "node",
			args: [STDIO_CAPTURE_FIXTURE],
			env: { OMP_TEST_FRAME_LOG: frameLog, ...extraEnv },
			...(timeout === undefined ? {} : { timeout }),
		});
		await transport.connect();
	}

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("diagnoses but never dispatches or answers a server request in modern state", async () => {
		await connectCaptureServer();
		transport?.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		expect(transport?.getProtocolConfiguration()).toEqual({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});

		let requestCalls = 0;
		transport!.onRequest = async () => {
			requestCalls++;
			return { roots: [{ uri: "file:///forbidden" }] };
		};
		const violation = Promise.withResolvers<Error>();
		transport!.onError = error => violation.resolve(error);

		await transport!.notify("fixture/emit-server-request");
		const reported = await Promise.race([
			violation.promise,
			Bun.sleep(2_000).then(() => {
				throw new Error("Timed out waiting for modern server-request violation");
			}),
		]);
		await Bun.sleep(50);

		const frames = await readCapturedFrames(frameLog);
		expect(reported.message).toContain("modern server sent client request");
		expect(requestCalls).toBe(0);
		expect(frames.some(frame => frame.id === "fixture-server-request")).toBe(false);
	});

	it("retains legacy server-request dispatch and writes the roots response", async () => {
		await connectCaptureServer();
		transport?.configureProtocol({
			era: "legacy",
			phase: "connected",
			version: "2025-03-26",
		});
		let requestCalls = 0;
		transport!.onRequest = async method => {
			requestCalls++;
			expect(method).toBe("roots/list");
			return { roots: [{ uri: "file:///legacy-root" }] };
		};

		await transport!.notify("fixture/emit-server-request");
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(frame => frame.id === "fixture-server-request"),
		);
		const response = frames.find(frame => frame.id === "fixture-server-request");

		expect(requestCalls).toBe(1);
		expect(response).toEqual({
			jsonrpc: "2.0",
			id: "fixture-server-request",
			result: { roots: [{ uri: "file:///legacy-root" }] },
		});
	});

	it("sends exactly one cancellation frame for an explicitly aborted in-flight request", async () => {
		await connectCaptureServer();
		const controller = new AbortController();
		const reason = new Error("caller stopped request");
		const request = transport!.request("fixture/hold", {}, { signal: controller.signal });
		const sentFrames = await waitForCapturedFrames(frameLog, frames =>
			frames.some(frame => frame.method === "fixture/hold"),
		);
		const requestId = sentFrames.find(frame => frame.method === "fixture/hold")?.id;

		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
		await waitForCapturedFrames(frameLog, frames =>
			frames.some(frame => frame.method === "notifications/cancelled" && frame.params?.requestId === requestId),
		);
		await Bun.sleep(50);

		const cancellations = (await readCapturedFrames(frameLog)).filter(
			frame => frame.method === "notifications/cancelled" && frame.params?.requestId === requestId,
		);
		expect(cancellations).toHaveLength(1);
		expect(cancellations[0]?.params).toEqual({ requestId });
	});

	it("sends exactly one cancellation frame when a sent request times out", async () => {
		await connectCaptureServer(30);
		const request = transport!.request("fixture/hold");
		const outcome = request.catch((error: unknown) => error);
		const sentFrames = await waitForCapturedFrames(frameLog, frames =>
			frames.some(frame => frame.method === "fixture/hold"),
		);
		const requestId = sentFrames.find(frame => frame.method === "fixture/hold")?.id;

		expect(await outcome).toEqual(new Error("Request timeout after 30ms"));
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(frame => frame.method === "notifications/cancelled" && frame.params?.requestId === requestId),
		);
		expect(
			frames.filter(frame => frame.method === "notifications/cancelled" && frame.params?.requestId === requestId),
		).toHaveLength(1);
	});

	it("preserves a pre-abort reason without sending any frame", async () => {
		await connectCaptureServer();
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);

		await expect(transport!.request("fixture/hold", {}, { signal: controller.signal })).rejects.toBe(reason);
		await Bun.sleep(50);

		expect(await readCapturedFrames(frameLog)).toEqual([]);
	});

	it("does not cancel when a response wins the response-abort race", async () => {
		await connectCaptureServer();
		const controller = new AbortController();
		const request = transport!.request<{ ok: boolean }>("fixture/respond", {}, { signal: controller.signal });
		const abortAfterResponse = request.then(() => controller.abort(new Error("too late")));

		await expect(request).resolves.toEqual({ ok: true });
		await abortAfterResponse;
		await Bun.sleep(50);

		const frames = await readCapturedFrames(frameLog);
		const requestId = frames.find(frame => frame.method === "fixture/respond")?.id;
		expect(
			frames.filter(frame => frame.method === "notifications/cancelled" && frame.params?.requestId === requestId),
		).toHaveLength(0);
	});

	it("keeps cancellation best-effort and nonfatal when the child closes its input pipe", async () => {
		const tracker = trackUnhandled();
		try {
			await connectCaptureServer();
			const controller = new AbortController();
			const reason = new Error("abort after pipe close");
			const request = transport!.request("fixture/close-input", {}, { signal: controller.signal });
			await waitForCapturedFrames(frameLog, frames => frames.some(frame => frame.method === "fixture/close-input"));
			await Bun.sleep(100);

			controller.abort(reason);
			await expect(request).rejects.toBe(reason);
			await Bun.sleep(100);

			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("frames modern subscriptions/listen metadata, honors the acknowledged subset, and closes gracefully", async () => {
		await connectCaptureServer(undefined, { OMP_TEST_ACK_TOOLS_ONLY: "1" });
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const delivered: string[] = [];
		const listener = await transport!.listen(
			{ notifications: { toolsListChanged: true, promptsListChanged: true } },
			{ onNotification: method => delivered.push(method) },
		);

		await expect(listener.acknowledged).resolves.toEqual({ toolsListChanged: true });
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(frame => frame.method === "subscriptions/listen"),
		);
		const listenFrame = frames.find(frame => frame.method === "subscriptions/listen");
		expect(listenFrame?.id).toBe(listener.requestId);
		expect(listenFrame?.params).toEqual({
			notifications: { toolsListChanged: true, promptsListChanged: true },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": { name: "stdio-test", version: "1" },
			},
		});

		await transport!.notify("fixture/emit-subscription", { requestId: listener.requestId });
		await transport!.notify("fixture/close-subscription", { requestId: listener.requestId });
		await expect(listener.completion).resolves.toBeUndefined();
		expect(delivered).toEqual(["notifications/tools/list_changed"]);
	});

	it("rejects a stdio subscription event delivered before its acknowledgment", async () => {
		await connectCaptureServer();
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const listener = await transport!.listen({
			notifications: { resourceSubscriptions: ["fixture://before-ack"] },
		});
		const acknowledgment = expect(listener.acknowledged).rejects.toThrow("before acknowledgment");
		const completion = expect(listener.completion).rejects.toThrow("before acknowledgment");
		await Promise.all([acknowledgment, completion]);
	});

	it("demultiplexes concurrent stdio listener IDs, cancels exactly one, and ignores its stale events", async () => {
		await connectCaptureServer();
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const firstEvents: string[] = [];
		const secondEvents: string[] = [];
		const transportEvents: string[] = [];
		transport!.onNotification = method => transportEvents.push(method);
		const first = await transport!.listen(
			{ notifications: { toolsListChanged: true } },
			{ onNotification: method => firstEvents.push(method) },
		);
		const second = await transport!.listen(
			{ notifications: { toolsListChanged: true } },
			{ onNotification: method => secondEvents.push(method) },
		);
		expect(first.requestId).not.toBe(second.requestId);
		await Promise.all([first.acknowledged, second.acknowledged]);

		await transport!.notify("fixture/emit-subscription", { requestId: second.requestId });
		await Bun.sleep(20);
		expect(firstEvents).toEqual([]);
		expect(secondEvents).toEqual(["notifications/tools/list_changed"]);

		await first.cancel();
		await expect(first.completion).resolves.toBeUndefined();
		await transport!.notify("fixture/emit-subscription", { requestId: first.requestId });
		await Bun.sleep(20);
		expect(firstEvents).toEqual([]);
		expect(transportEvents).toEqual([]);

		await transport!.notify("fixture/close-subscription", { requestId: second.requestId });
		await expect(second.completion).resolves.toBeUndefined();
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === first.requestId,
			),
		);
		expect(
			frames.filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === first.requestId,
			),
		).toHaveLength(1);
		expect(
			frames.filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === second.requestId,
			),
		).toHaveLength(0);
	});

	it("cancels exactly once and releases an acknowledged listener when its callback throws", async () => {
		await connectCaptureServer();
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const listener = await transport!.listen(
			{ notifications: { resourceSubscriptions: ["file:///a"] } },
			{
				onNotification: () => {
					throw new Error("delivery failed");
				},
			},
		);
		await expect(listener.acknowledged).resolves.toEqual({ resourceSubscriptions: ["file:///a"] });

		await transport!.notify("fixture/emit-subscription", {
			requestId: listener.requestId,
			notificationMethod: "notifications/resources/updated",
			uri: "file:///a/child",
		});
		await expect(listener.completion).rejects.toThrow("delivery failed");
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		);
		expect(
			frames.filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		).toHaveLength(1);

		await transport!.notify("fixture/emit-subscription", {
			requestId: listener.requestId,
			notificationMethod: "notifications/resources/updated",
			uri: "file:///a/another-child",
		});
		await Bun.sleep(20);
		expect(
			(await readCapturedFrames(frameLog)).filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		).toHaveLength(1);
	});

	it("cancels after a callback failure racing the initial listener write", async () => {
		await connectCaptureServer(undefined, { OMP_TEST_EMIT_SUBSCRIPTION_DURING_LISTEN_WRITE: "1" });
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const listener = await transport!.listen(
			{ notifications: { toolsListChanged: true } },
			{
				onNotification: () => {
					throw new Error("delivery failed during initial write");
				},
			},
		);
		await expect(listener.completion).rejects.toThrow("delivery failed during initial write");
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		);
		expect(
			frames.filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		).toHaveLength(1);
	});

	it("completes close within bounded interval even if child process does not exit on stdin end", async () => {
		const t = new StdioTransport({
			command: "node",
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		await t.connect();
		const start = Date.now();
		await t.close();
		const duration = Date.now() - start;
		expect(duration).toBeLessThan(3500);
		expect(t.connected).toBeFalse();
	});

	it("sends notifications/cancelled before dropping state when listener experiences protocol failure after reaching server", async () => {
		await connectCaptureServer();
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const listener = await transport!.listen(
			{ notifications: { toolsListChanged: true } },
			{ onNotification: () => {} },
		);
		await expect(listener.acknowledged).resolves.toEqual({ toolsListChanged: true });
		// Inject a protocol failure (unacknowledged notification method)
		await transport!.notify("fixture/emit-subscription", {
			requestId: listener.requestId,
			notificationMethod: "notifications/prompts/list_changed", // not acknowledged
		});
		await expect(listener.completion).rejects.toThrow("received unacknowledged notification");
		const frames = await waitForCapturedFrames(frameLog, captured =>
			captured.some(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		);
		expect(
			frames.filter(
				frame => frame.method === "notifications/cancelled" && frame.params?.requestId === listener.requestId,
			),
		).toHaveLength(1);
	});

	it("handles abort-at-registration for listen and request without hanging", async () => {
		await connectCaptureServer();
		transport!.configureProtocol({
			era: "modern",
			phase: "connected",
			version: "2026-07-28",
			clientInfo: { name: "stdio-test", version: "1" },
			clientCapabilities: {},
		});
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));

		await expect(
			transport!.listen({ notifications: { toolsListChanged: true } }, { signal: controller.signal }),
		).rejects.toThrow("pre-aborted");

		await expect(transport!.request("tools/list", undefined, { signal: controller.signal })).rejects.toThrow(
			"pre-aborted",
		);
	});
});
