import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import type { BunFile } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import * as mcpTimeout from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { JsonRpcNotification, JsonRpcRequest, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf, trackUnhandled } from "./helpers/rejection";

type Frame = JsonRpcRequest | JsonRpcNotification;
const FIXTURE = path.join(import.meta.dir, "fixtures", "cancellable-mcp.ts");
const DEADLINE_MS = 150;
const POLL_MS = 5;
// Generous bounds for loaded CI hosts: passing runs return as soon as the event happens.
const OBSERVE_MS = 5_000;
// A hung request never settles on its own, so settling within this bound proves the abort settled it.
const SETTLE_MS = 2_000;

// Real subprocess I/O and pipe backpressure must advance alongside the platform
// deadline; fake timers cannot drive those events. All polling and waits are bounded.
async function within<T>(promise: Promise<T>, ms = SETTLE_MS): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Request did not settle within ${ms}ms`)), ms);
	try {
		return await Promise.race([promise, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("StdioTransport cancellation", () => {
	let transport: StdioTransport | undefined;
	let tempDir: string;
	let logPath: string;
	let frameLog: BunFile;
	let resolveTimeout: Mock<typeof mcpTimeout.resolveMCPTimeoutMs>;
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cancellation-"));
		logPath = path.join(tempDir, "frames.jsonl");
		frameLog = Bun.file(logPath);
		await Bun.write(frameLog, "");
		// Each case opts into a deadline only for the request it exercises.
		resolveTimeout = spyOn(mcpTimeout, "resolveMCPTimeoutMs").mockImplementation(() => 0);
	});

	afterEach(async () => {
		try {
			await transport?.close();
		} finally {
			transport = undefined;
			vi.restoreAllMocks();
			await removeWithRetries(tempDir);
		}
	});

	async function start(config: Partial<MCPStdioServerConfig> = {}, mode = "normal"): Promise<StdioTransport> {
		transport = new StdioTransport({
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE, logPath, mode],
			...config,
			timeout: 0,
		});
		await transport.connect();
		if (mode === "normal") {
			await transport.request("initialize");
			await transport.notify("notifications/initialized");
		}
		return transport;
	}

	function armDeadline(): void {
		resolveTimeout.mockImplementationOnce(() => DEADLINE_MS);
	}

	async function frames(): Promise<Frame[]> {
		const text = await frameLog.text();
		return Bun.JSONL.parse(text.slice(0, text.lastIndexOf("\n") + 1)) as Frame[];
	}

	async function loggedUntil(predicate: (received: Frame[]) => boolean): Promise<Frame[]> {
		const deadline = performance.now() + OBSERVE_MS;
		let received: Frame[];
		do {
			received = await frames();
			if (predicate(received)) return received;
			await Bun.sleep(POLL_MS);
		} while (performance.now() < deadline);
		return received;
	}

	async function sentRequest(method: string, toolName?: string): Promise<JsonRpcRequest> {
		const matches = (frame: Frame) =>
			"id" in frame && frame.method === method && (toolName === undefined || frame.params?.name === toolName);
		const received = await loggedUntil(log => log.some(matches));
		const request = received.find(matches);
		expect(request).toHaveProperty("id");
		return request as JsonRpcRequest;
	}

	async function cancellations(): Promise<Frame[]> {
		return (await frames()).filter(frame => frame.method === "notifications/cancelled");
	}

	async function waitForCancellation(): Promise<Frame[]> {
		return (await loggedUntil(log => log.some(frame => frame.method === "notifications/cancelled"))).filter(
			frame => frame.method === "notifications/cancelled",
		);
	}

	async function echo(client: StdioTransport, text = "still connected"): Promise<void> {
		// Await before expect: on Bun 1.4.2 (Windows), `expect(pending).resolves` can stall while the
		// promise waits on subprocess I/O.
		expect(await client.request<unknown>("tools/call", { name: "echo", arguments: { text } })).toEqual({
			content: [{ type: "text", text }],
		});
	}

	it("rejects promptly with the abort reason and sends one cancellation with the numeric request id", async () => {
		const client = await start();
		const caller = new AbortController();
		const reason = new Error("private caller details must not reach the server");
		const outcome = client
			.request("tools/call", { name: "hang" }, { signal: caller.signal })
			.catch((error: unknown) => error);
		const original = await sentRequest("tools/call", "hang");
		caller.abort(reason);

		expect(await within(outcome)).toBe(reason);
		expect(typeof original.id).toBe("number");
		expect(await waitForCancellation()).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: original.id, reason: "Request cancelled by the client" },
			},
		]);
		await echo(client);
		expect(client.connected).toBe(true);
		expect(await cancellations()).toHaveLength(1);
	});

	it("preserves string request ids and maps a non-Error abort reason to Aborted", async () => {
		const client = await start({ requestIdFormat: "string" });
		const caller = new AbortController();
		const outcome = client
			.request("tools/call", { name: "hang" }, { signal: caller.signal })
			.catch((error: unknown) => error);
		const original = await sentRequest("tools/call", "hang");
		caller.abort("private non-Error reason");

		const error = await within(outcome);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "Aborted" });
		expect(typeof original.id).toBe("string");
		expect(await waitForCancellation()).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: original.id, reason: "Request cancelled by the client" },
			},
		]);
	});

	it("keeps the hard-deadline error and sends only one cancellation when the caller aborts later", async () => {
		const client = await start();
		const caller = new AbortController();
		armDeadline();
		const outcome = client
			.request("tools/call", { name: "hang" }, { signal: caller.signal })
			.catch((error: unknown) => error);
		const original = await sentRequest("tools/call", "hang");
		const error = await within(outcome);
		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "stdio",
			stage: "receive",
			failure: "timeout",
			message: `Request timeout after ${DEADLINE_MS}ms`,
			retryable: false,
		});
		caller.abort(new Error("too late"));
		expect(await waitForCancellation()).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: original.id, reason: `Request timed out after ${DEADLINE_MS}ms` },
			},
		]);
		await echo(client);
		expect(await cancellations()).toHaveLength(1);
		expect(await outcome).toBe(error);
	});

	it("clears the hard deadline after abort so it cannot send a second cancellation", async () => {
		const client = await start();
		const caller = new AbortController();
		const reason = new Error("cancel first");
		// Call through so these spies retain and expose the native timer handle.
		const nativeSetTimeout = globalThis.setTimeout;
		const nativeClearTimeout = globalThis.clearTimeout;
		const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(nativeSetTimeout);
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(nativeClearTimeout);
		let outcome: Promise<unknown> | undefined;
		try {
			armDeadline();
			outcome = client
				.request("tools/call", { name: "hang" }, { signal: caller.signal })
				.catch((error: unknown) => error);
			caller.abort(reason);

			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), DEADLINE_MS);
			const deadlineTimer = setTimeoutSpy.mock.results[0];
			if (deadlineTimer?.type !== "return") throw new Error("Expected the native hard-deadline timer");
			const deadlineHandle = deadlineTimer.value;
			expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineHandle);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		}

		if (!outcome) throw new Error("Expected the hanging request to start");
		const original = await sentRequest("tools/call", "hang");
		expect(await within(outcome)).toBe(reason);
		expect(await waitForCancellation()).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: original.id, reason: "Request cancelled by the client" },
			},
		]);
		// Cross the original deadline, then use a response as a barrier for all earlier frames.
		await Bun.sleep(DEADLINE_MS + POLL_MS);
		await echo(client);
		expect(await cancellations()).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: original.id, reason: "Request cancelled by the client" },
			},
		]);
		expect(client.connected).toBe(true);
	});

	it("writes neither the request nor a cancellation when the signal is already aborted", async () => {
		const client = await start();
		const caller = new AbortController();
		const reason = new Error("already cancelled");
		caller.abort(reason);
		await expect(client.request("tools/call", { name: "hang" }, { signal: caller.signal })).rejects.toBe(reason);
		await echo(client);
		expect((await frames()).filter(frame => frame.params?.name === "hang")).toEqual([]);
		expect(await cancellations()).toEqual([]);
	});

	it("does not cancel a request after its response already resolved", async () => {
		const client = await start();
		const caller = new AbortController();
		expect(
			await client.request<unknown>(
				"tools/call",
				{ name: "echo", arguments: { text: "answered" } },
				{ signal: caller.signal },
			),
		).toEqual({ content: [{ type: "text", text: "answered" }] });
		caller.abort(new Error("after response"));
		await echo(client);
		expect(await cancellations()).toEqual([]);
	});

	it("does not cancel a request after the server already rejected it", async () => {
		const client = await start();
		const caller = new AbortController();
		expect(await rejectionOf(client.request("unknown/method", undefined, { signal: caller.signal }))).toMatchObject({
			failure: "json_rpc",
			code: -32601,
		});
		caller.abort(new Error("after server error"));
		await echo(client);
		expect(await cancellations()).toEqual([]);
	});

	it("does not send cancellation after transport close settled a pending request", async () => {
		const client = await start();
		const caller = new AbortController();
		const outcome = client
			.request("tools/call", { name: "hang" }, { signal: caller.signal })
			.catch((error: unknown) => error);
		await sentRequest("tools/call", "hang");
		await client.close();
		const error = await within(outcome);
		expect(error).toMatchObject({ failure: "closed" });
		caller.abort(new Error("after close"));
		expect(await outcome).toBe(error);
		expect(await cancellations()).toEqual([]);
	});

	it.each(["abort", "deadline"] as const)("never sends cancellation for initialize settled by %s", async cause => {
		const client = await start({}, "hang-initialize");
		const caller = new AbortController();
		const reason = new Error("cancel initialization locally");
		if (cause === "deadline") armDeadline();
		const outcome = client
			.request("initialize", undefined, { signal: caller.signal })
			.catch((error: unknown) => error);
		await sentRequest("initialize");
		if (cause === "abort") caller.abort(reason);
		const error = await within(outcome);
		if (cause === "abort") expect(error).toBe(reason);
		else expect(error).toMatchObject({ failure: "timeout" });
		await echo(client);
		expect(await cancellations()).toEqual([]);
	});

	it("registers no waiter or cancellation when request serialization throws", async () => {
		const client = await start();
		const tracker = trackUnhandled();
		try {
			const caller = new AbortController();
			const params: Record<string, unknown> = { name: "hang" };
			params.circular = params;
			armDeadline();
			await expect(client.request("tools/call", params, { signal: caller.signal })).rejects.toBeInstanceOf(
				TypeError,
			);
			caller.abort(new Error("after serialization failed"));
			await Bun.sleep(DEADLINE_MS + POLL_MS);
			await echo(client);
			expect((await frames()).filter(frame => frame.params?.name === "hang")).toEqual([]);
			expect(await cancellations()).toEqual([]);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it.each(["throw", "reject", "reject-and-throw-on-flush"] as const)(
		"keeps cancellation write failure (%s) isolated from the caller and sibling requests",
		async failure => {
			const child = Bun.spawn([process.execPath, FIXTURE, logPath], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const spawn = spyOn(Bun, "spawn").mockReturnValue(child);
			let client: StdioTransport;
			try {
				client = await start();
			} finally {
				spawn.mockRestore();
			}
			const write = child.stdin.write.bind(child.stdin);
			const flush = child.stdin.flush.bind(child.stdin);
			const cancellationFailure = new Error("cancellation write failed");
			let cancelWrites = 0;
			let failFlush = false;
			spyOn(child.stdin, "write").mockImplementation(chunk => {
				if (typeof chunk === "string" && chunk.includes('"method":"notifications/cancelled"')) {
					cancelWrites++;
					if (failure === "throw") throw cancellationFailure;
					failFlush = failure === "reject-and-throw-on-flush";
					return Promise.reject(cancellationFailure);
				}
				return write(chunk);
			});
			spyOn(child.stdin, "flush").mockImplementation(() => {
				if (failFlush) {
					failFlush = false;
					throw cancellationFailure;
				}
				return flush();
			});
			let closes = 0;
			client.onClose = () => closes++;
			const tracker = trackUnhandled();
			try {
				const caller = new AbortController();
				const reason = new Error("original abort reason");
				const outcome = client
					.request("tools/call", { name: "hang" }, { signal: caller.signal })
					.catch((error: unknown) => error);
				await sentRequest("tools/call", "hang");
				caller.abort(reason);
				expect(await within(outcome)).toBe(reason);
				await echo(client);
				await Bun.sleep(0);
				expect(cancelWrites).toBe(1);
				expect(closes).toBe(0);
				expect(client.connected).toBe(true);
				expect(tracker.capture()).toEqual([]);
			} finally {
				tracker.release();
			}
		},
	);

	it("rejects promptly under stdin backpressure without an unhandled rejection or transport teardown", async () => {
		const client = await start({}, "no-read");
		// A fresh BunFile per poll: a reused handle can keep reporting a stale `exists()`.
		const readyPath = `${logPath}.ready`;
		const deadline = performance.now() + OBSERVE_MS;
		while (!(await Bun.file(readyPath).exists()) && performance.now() < deadline) await Bun.sleep(POLL_MS);
		expect(await Bun.file(readyPath).exists()).toBe(true);
		let closes = 0;
		client.onClose = () => closes++;
		const tracker = trackUnhandled();
		try {
			const caller = new AbortController();
			const reason = new Error("abort a parked write");
			const outcome = client
				.request(
					"tools/call",
					{ name: "hang", arguments: { text: "x".repeat(2 * 1024 * 1024) } },
					{ signal: caller.signal },
				)
				.catch((error: unknown) => error);
			caller.abort(reason);
			expect(await within(outcome)).toBe(reason);
			expect(closes).toBe(0);
			expect(client.connected).toBe(true);
			await client.close();
			await Bun.sleep(0);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});
