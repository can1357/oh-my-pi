import type { ServerWebSocket } from "bun";

export type ResponsesSocket = ServerWebSocket<{ id: number }>;
export type ResponsesWireEvent = Record<string, unknown>;

export function textEvents(text: string, id: string): ResponsesWireEvent[] {
	const item = {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [item],
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

export function toolEvents(name: string, args: string, id: string, callId: string): ResponsesWireEvent[] {
	const item = {
		type: "function_call",
		id: `fc_${id}`,
		call_id: callId,
		name,
		arguments: args,
		status: "completed",
	};
	return [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, arguments: "", status: "in_progress" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [item],
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

export function send(socket: ResponsesSocket, events: readonly ResponsesWireEvent[]): void {
	for (const event of events) socket.send(JSON.stringify(event));
}

export function sse(events: readonly ResponsesWireEvent[]): Response {
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Pure loopback wire fixture: no provider state, policy overrides, or test registration. */
export function endpoint(
	behavior?: (socket: ResponsesSocket, body: Record<string, unknown>, index: number) => void,
	setup?: {
		port?: number;
		rejectUpgrade?: (request: Request) => Response | undefined | Promise<Response | undefined>;
		upgradeHeaders?: Record<string, string>;
		httpResponse?: (body: Record<string, unknown>, index: number) => Response | undefined;
	},
) {
	const requests: Array<{ connection: number; body: Record<string, unknown> }> = [];
	const upgrades: Array<{ path: string; headers: Headers }> = [];
	const httpRequests: Array<Record<string, unknown>> = [];
	const sockets = new Map<number, ResponsesSocket>();
	const waiters: Array<{ kind: "ws" | "http" | "closed"; count: number; resolve: () => void }> = [];
	let opened = 0;
	let closed = 0;
	function notify(): void {
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			const current = waiter.kind === "ws" ? requests.length : waiter.kind === "http" ? httpRequests.length : closed;
			if (current >= waiter.count) {
				waiters.splice(i, 1);
				waiter.resolve();
			}
		}
	}
	function waitFor(kind: "ws" | "http" | "closed", minimum: number): Promise<void> {
		const current = kind === "ws" ? requests.length : kind === "http" ? httpRequests.length : closed;
		if (current >= minimum) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter = { kind, count: minimum, resolve };
		waiters.push(waiter);
		// A failure bound, not a guessed scheduling delay; only actual wire events resolve the barrier.
		const timer = setTimeout(() => reject(new Error(`Missing ${kind} wire barrier ${minimum}`)), 15_000);
		return promise.finally(() => {
			clearTimeout(timer);
			const index = waiters.indexOf(waiter);
			if (index >= 0) waiters.splice(index, 1);
		});
	}
	const server = Bun.serve<{ id: number }>({
		hostname: "127.0.0.1",
		port: setup?.port ?? 0,
		async fetch(request, server) {
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				upgrades.push({ path: new URL(request.url).pathname, headers: request.headers });
				if (setup?.rejectUpgrade) {
					const rejection = await setup.rejectUpgrade(request);
					if (rejection) return rejection;
				}
				if (server.upgrade(request, { data: { id: ++opened }, headers: setup?.upgradeHeaders })) return undefined;
				return new Response("Upgrade failed", { status: 400 });
			}
			const body = (await request.json()) as Record<string, unknown>;
			httpRequests.push(body);
			const response =
				setup?.httpResponse?.(body, httpRequests.length) ??
				sse(textEvents("HTTP", `resp_http_${httpRequests.length}`));
			notify();
			return response;
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.id, socket);
			},
			message(socket, message) {
				const body = JSON.parse(String(message)) as Record<string, unknown>;
				requests.push({ connection: socket.data.id, body });
				if (behavior) behavior(socket, body, requests.length);
				else send(socket, textEvents("WS", `resp_${requests.length}`));
				notify();
			},
			close(socket) {
				sockets.delete(socket.data.id);
				closed++;
				notify();
			},
		},
	});
	return {
		server,
		requests,
		upgrades,
		httpRequests,
		sockets,
		waitForRequests: (minimum: number) => waitFor("ws", minimum),
		waitForHttpRequests: (minimum: number) => waitFor("http", minimum),
		waitForClosed: (minimum: number) => waitFor("closed", minimum),
	};
}
