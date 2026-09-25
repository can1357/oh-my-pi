/**
 * Child-process probe for MCP long-poll waits: a server that takes the call and
 * then sends nothing at all for `STALL_MS` — the shape of a tool call waiting
 * on a person, a queue, or a long job.
 *
 * Runs in its own process because the boundary under test is the runtime's
 * socket idle timer: five minutes by default, configured once per process
 * through `BUN_CONFIG_HTTP_IDLE_TIMEOUT` (whole seconds). The parent test
 * shortens it there, so the production boundary is reachable in seconds without
 * mutating the environment of a suite that runs in parallel.
 *
 * Four waits race the same silence:
 *
 * - `control` is a bare `fetch` with none of the MCP fetch policy. It reports
 *   whether this Bun version honours the shortened process default.
 * - `unlocked` and `originLocked` are Streamable HTTP requests across both
 *   fetch calls in `mcpFetch` — the plain one, and the manual-redirect one an
 *   origin-locked server takes. The answer comes back on the POST.
 * - `legacySse` is the 2024-11-05 transport, where the silence falls on a
 *   different socket: the POST is accepted with `202` at once and the answer
 *   arrives later over the long-lived GET stream. An idle timer on that GET
 *   kills the answer while the POST looks perfectly healthy.
 *
 * Prints one JSON line as the whole of its protocol with the parent.
 */
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";

/** Fixed, and comfortably past the shortened idle default plus its wheel granularity. */
const STALL_MS = 7_000;

type Leg = { outcome: "resolved"; result: unknown } | { outcome: "threw"; name: string; message: string };

async function leg(run: () => Promise<unknown>): Promise<Leg> {
	try {
		return { outcome: "resolved", result: await run() };
	} catch (error) {
		return {
			outcome: "threw",
			name: error instanceof Error ? error.name : typeof error,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

const encoder = new TextEncoder();
/** The id of the JSON-RPC call posted to the legacy endpoint, answered over the stream. */
const posted = Promise.withResolvers<string | number>();

/**
 * The legacy stream: name the POST endpoint immediately, then go silent for the
 * whole stall before the answer. The endpoint event is the last byte the client
 * sees until then, so it is that silence the idle timer measures.
 */
function legacyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
			void (async () => {
				const [id] = await Promise.all([posted.promise, Bun.sleep(STALL_MS)]);
				const answer = { jsonrpc: "2.0", id, result: { waited: true } };
				try {
					controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(answer)}\n\n`));
					controller.close();
				} catch {
					// The client gave up and cancelled the stream; nothing to send it.
				}
			})();
		},
	});
}

const server = Bun.serve({
	port: 0,
	// The client's idle timer is the subject; a server-side one would drop the
	// socket first and the run would prove nothing.
	idleTimeout: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/sse") {
			return new Response(legacyStream(), { headers: { "Content-Type": "text/event-stream" } });
		}
		if (pathname === "/messages") {
			const body = (await request.json()) as { id: string | number };
			posted.resolve(body.id);
			// Accepted, not answered: the answer belongs to the GET stream.
			return new Response(null, { status: 202 });
		}
		const body = (await request.json()) as { id: string | number };
		await Bun.sleep(STALL_MS);
		return Response.json({ jsonrpc: "2.0", id: body.id, result: { waited: true } });
	},
});
const base = `http://127.0.0.1:${server.port}`;
const url = `${base}/mcp`;
// The configuration an operator reaches for when waits are long: no
// client-side MCP deadline at all.
const unlocked = new HttpTransport({ type: "http", url, timeout: 0 });
const originLocked = new HttpTransport({ type: "http", url, timeout: 0, headerPolicy: "origin-locked" });
const legacy = new LegacySseTransport({ type: "sse", url: `${base}/sse`, timeout: 0 });

try {
	await Promise.all([unlocked.connect(), originLocked.connect(), legacy.connect()]);
	const [control, plain, locked, sse] = await Promise.all([
		leg(async () => {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "control", method: "tools/call", params: {} }),
			});
			return await response.json();
		}),
		leg(() => unlocked.request("tools/call")),
		leg(() => originLocked.request("tools/call")),
		leg(() => legacy.request("tools/call")),
	]);
	process.stdout.write(`${JSON.stringify({ control, unlocked: plain, originLocked: locked, legacySse: sse })}\n`);
} finally {
	// Closing the legacy transport aborts its GET stream; the HTTP transports
	// wait for their own in-flight fetches before the port goes away.
	await Promise.all([unlocked.close(), originLocked.close(), legacy.close()]);
	server.stop(true);
}
