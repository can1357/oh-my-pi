/**
 * MCP long-poll waits: a server may hold a call open for as long as the work
 * takes — a person answering, a queue draining — without sending a byte.
 *
 * The runtime arms a socket idle timer on exactly that silence (five minutes by
 * default), and it is invisible to the MCP timeout surface: a request an
 * operator had deliberately given no deadline (`timeout: 0`) still died with
 * `TimeoutError` while the server was still working, and the answer it later
 * sent was lost. `mcpFetch` disables that timer, which makes the transports'
 * AbortSignals the only thing that can end a wait — over Streamable HTTP and
 * over the legacy SSE transport, whose answer arrives on a different socket
 * than the POST — so the cancellation paths are pinned here alongside the wait.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import * as mcpTimeout from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "mcp-idle-wait-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** Whole seconds, per `BUN_CONFIG_HTTP_IDLE_TIMEOUT`; the probe stalls well past it. */
const CHILD_IDLE_SECONDS = "1";
/** Bounds a wedged child: the probe stalls 7s and the idle wheel is coarse. */
const CHILD_KILL_MS = 45_000;
/** Leaves room for the kill bound to be the thing that reports a wedged child. */
const CHILD_TEST_MS = 60_000;
const DEADLINE_MS = 200;

interface StallingServer {
	server: Bun.Server<undefined>;
	/** Resolves once the server has the request and is deliberately silent. */
	arrived: Promise<void>;
	/** Let the pending request finish so the process is not left holding it. */
	release: () => void;
}

let stalled: StallingServer[] = [];

afterEach(() => {
	for (const { server, release } of stalled) {
		release();
		server.stop(true);
	}
	stalled = [];
	vi.restoreAllMocks();
});

/** A server that accepts a JSON-RPC POST and then says nothing until released. */
function stallingServer(): StallingServer {
	const arrived = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		// The client's idle timer is the subject; a server-side one would drop
		// the socket first and prove nothing.
		idleTimeout: 0,
		async fetch(request) {
			const body = (await request.json()) as { id: string | number };
			arrived.resolve();
			await gate.promise;
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { waited: true } });
		},
	});
	const entry: StallingServer = { server, arrived: arrived.promise, release: gate.resolve };
	stalled.push(entry);
	return entry;
}

/**
 * A legacy (2024-11-05) server: it names its POST endpoint at once, then holds
 * every POST open. `arrived` resolves when a POST is in the server's hands.
 */
function legacySseServer(): StallingServer {
	const arrived = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/sse") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			await request.json();
			arrived.resolve();
			await gate.promise;
			return new Response(null, { status: 202 });
		},
	});
	const entry: StallingServer = { server, arrived: arrived.promise, release: gate.resolve };
	stalled.push(entry);
	return entry;
}

async function connected(server: Bun.Server<undefined>, timeout: number): Promise<HttpTransport> {
	const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout });
	await transport.connect();
	return transport;
}

/**
 * State the deadline a transport resolves instead of inheriting it from
 * `OMP_MCP_TIMEOUT_MS`. A spy on the module the transports read keeps the run
 * hermetic without mutating any global; `vi.restoreAllMocks()` undoes it.
 */
function pinDeadline(ms: number): void {
	spyOn(mcpTimeout, "resolveMCPTimeoutMs").mockReturnValue(ms);
}

describe("MCP waits that outlast the socket idle timer", () => {
	it(
		"delivers the answer on every MCP transport after a silence past the runtime's idle default",
		async () => {
			// The idle default is per-process, so the boundary is shortened in a
			// child rather than in this suite's environment.
			const proc = Bun.spawn([process.execPath, PROBE_PATH], {
				cwd: REPO_ROOT,
				env: {
					...process.env,
					BUN_CONFIG_HTTP_IDLE_TIMEOUT: CHILD_IDLE_SECONDS,
					// Pin the configuration under test so an inherited override
					// cannot give the probe a deadline of its own.
					OMP_MCP_TIMEOUT_MS: "0",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			// Real timer on purpose: the subject is another process's socket clock,
			// which fake timers cannot drive. Kill rather than only fail — a wedged
			// child would otherwise outlive the test holding its port and sockets.
			const watchdog = setTimeout(() => proc.kill(), CHILD_KILL_MS);
			let stdout: string;
			let stderr: string;
			let exitCode: number;
			try {
				[stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
			} finally {
				clearTimeout(watchdog);
				proc.kill();
			}
			expect(exitCode, stderr).toBe(0);
			const probe = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;

			// Bun 1.3 honours the shortened process default; Bun 1.4 currently
			// ignores it. Accept only those two concrete control outcomes so the
			// transport assertions remain portable without mistaking another
			// control failure for proof of the regression.
			const control = probe.control;
			if (control && typeof control === "object" && "outcome" in control && control.outcome === "threw") {
				expect(control).toMatchObject({ outcome: "threw", name: "TimeoutError" });
			} else {
				expect(control).toEqual({
					outcome: "resolved",
					result: { jsonrpc: "2.0", id: "control", result: { waited: true } },
				});
			}

			// Both `mcpFetch` paths — plain, and the manual-redirect one an
			// origin-locked server takes — outlive the silence.
			expect(probe.unlocked).toEqual({ outcome: "resolved", result: { waited: true } });
			expect(probe.originLocked).toEqual({ outcome: "resolved", result: { waited: true } });

			// The legacy transport puts the silence on its GET stream while the
			// POST returns `202` at once, so a healthy-looking POST is no evidence
			// the answer will ever arrive. It must survive the same silence.
			expect(probe.legacySse).toEqual({ outcome: "resolved", result: { waited: true } });
		},
		CHILD_TEST_MS,
	);

	it("lets caller cancellation end a wait that was given no deadline", async () => {
		pinDeadline(0);
		const { server, arrived } = stallingServer();
		const transport = await connected(server, 0);
		const caller = new AbortController();
		try {
			const settled = transport.request("tools/call", undefined, { signal: caller.signal }).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			await arrived;
			caller.abort();

			const error = await settled;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("AbortError");
		} finally {
			await transport.close();
		}
	});

	it("ends a wait that was given no deadline when the transport closes", async () => {
		pinDeadline(0);
		const { server, arrived } = stallingServer();
		const transport = await connected(server, 0);
		const settled = transport.request("tools/call").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await arrived;

		await transport.close();

		const error = await settled;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});

	it("ends every legacy SSE POST that was given no deadline when the transport closes", async () => {
		// The legacy transport answers over the GET stream, so a POST it is still
		// holding is invisible to the pending-response map: `notify` has no entry
		// there at all. Without a lifecycle signal its promise never settles.
		pinDeadline(0);
		const { server, arrived } = legacySseServer();
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/sse`,
			timeout: 0,
		});
		await transport.connect();
		const notified = transport.notify("notifications/initialized").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		const requested = transport.request("tools/call").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await arrived;

		await transport.close();

		const notifyError = await notified;
		expect(notifyError).toBeInstanceOf(Error);
		expect((notifyError as Error).name).toBe("AbortError");
		// And the waiter is told it was closed, not that a deadline it never had
		// expired.
		const requestError = await requested;
		expect(requestError).toBeInstanceOf(Error);
		expect((requestError as Error).name).toBe("AbortError");
	});

	it("still fails a silent wait at the configured MCP deadline", async () => {
		pinDeadline(DEADLINE_MS);
		const { server } = stallingServer();
		const transport = await connected(server, DEADLINE_MS);
		try {
			await expect(transport.request("tools/call")).rejects.toMatchObject({
				transport: "http",
				stage: "send",
				failure: "timeout",
				retryable: false,
			});
		} finally {
			await transport.close();
		}
	});
});
