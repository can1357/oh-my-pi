#!/usr/bin/env bun
/**
 * Test fixture: a minimal Streamable HTTP MCP server whose availability can be
 * flipped. While "down" it closes its GET SSE streams (the client sees the
 * transport end, like a process restart) and answers every request with 503;
 * back "up" it is a fresh generation with new session ids, like a server that
 * has just been redeployed.
 *
 * Doubles as the manual reproduction for the reconnect schedule. Standalone:
 *
 *   bun packages/coding-agent/test/fixtures/flaky-http-mcp.ts   # port 8766
 *   curl -XPOST 127.0.0.1:8766/down   # restarting
 *   curl -XPOST 127.0.0.1:8766/up     # back
 *
 * Point an `http` MCP server at http://127.0.0.1:8766/mcp; every `initialize`
 * the server receives is printed, so a reconnect is visible without logs.
 */

export interface FlakyHttpMcpServer {
	readonly url: string;
	/** Number of `initialize` requests answered, across generations. */
	readonly initializes: number;
	/** Number of POST requests (one per connection attempt) refused with 503 while down. */
	readonly refusals: number;
	/** Text the `ping` tool answers with for the current generation. */
	readonly pong: string;
	setDown(down: boolean): void;
	stop(): void;
}

export function startFlakyHttpMcpServer(
	options: { port?: number; log?: (line: string) => void } = {},
): FlakyHttpMcpServer {
	const log = options.log ?? (() => {});
	const state = { down: false, generation: 1, initializes: 0, refusals: 0 };
	const closeStream = new Set<() => void>();

	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: "127.0.0.1",
		// Bun closes an idle response after 10 s by default; an SSE stream that
		// carries no events is idle by design.
		idleTimeout: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/down") {
				setDown(true);
				return new Response("down\n");
			}
			if (pathname === "/up") {
				setDown(false);
				return new Response("up\n");
			}
			if (state.down) {
				if (request.method === "POST") state.refusals += 1;
				return new Response("restarting", { status: 503 });
			}
			if (request.method === "GET") {
				let close = () => {};
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						// Flush the headers: a stream with no bytes yet leaves the
						// client's fetch() unresolved and the loss undetectable.
						controller.enqueue(new TextEncoder().encode(": connected\n\n"));
						close = () => {
							closeStream.delete(close);
							try {
								controller.close();
							} catch {
								// already closed by the client
							}
						};
						closeStream.add(close);
					},
					cancel() {
						closeStream.delete(close);
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (request.method === "DELETE") return new Response(null, { status: 200 });
			if (request.method !== "POST") return new Response(null, { status: 405 });

			const message = (await request.json()) as { id?: number | string; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			switch (message.method) {
				case "initialize":
					state.initializes += 1;
					log(`initialize #${state.initializes} (generation ${state.generation})`);
					result = {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "flaky", version: String(state.generation) },
					};
					break;
				case "tools/list":
					result = {
						tools: [
							{
								name: "ping",
								description: "Answers with the server generation",
								inputSchema: { type: "object", properties: {} },
							},
						],
					};
					break;
				case "tools/call":
					result = { content: [{ type: "text", text: pong() }] };
					break;
			}
			return Response.json(
				{ jsonrpc: "2.0", id: message.id, result },
				{ headers: { "Mcp-Session-Id": `g${state.generation}-${state.initializes}` } },
			);
		},
	});

	function pong(): string {
		return `pong from generation ${state.generation}`;
	}

	function setDown(down: boolean): void {
		if (down === state.down) return;
		state.down = down;
		if (down) {
			for (const close of closeStream) close();
			closeStream.clear();
			log("DOWN");
		} else {
			state.generation += 1;
			log(`UP as generation ${state.generation}`);
		}
	}

	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		get initializes() {
			return state.initializes;
		},
		get refusals() {
			return state.refusals;
		},
		get pong() {
			return pong();
		},
		setDown,
		stop: () => {
			for (const close of closeStream) close();
			closeStream.clear();
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	const flaky = startFlakyHttpMcpServer({
		port: Number(Bun.env.PORT ?? 8766),
		log: line => console.log(`[flaky ${new Date().toISOString().slice(11, 19)}] ${line}`),
	});
	console.log(`[flaky] listening on ${flaky.url}; POST /down and /up on the same host to flip it`);
}
