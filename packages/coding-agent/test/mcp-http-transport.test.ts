import { describe, expect, it } from "bun:test";
import { HttpTransport, MCPHttpResponseError } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/transports/http";
import {
	MCP_CLIENT_INFO,
	MCP_MODERN_PROTOCOL_VERSION,
	type MCPTransportProtocolConfiguration,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";

type FetchCall = {
	url: string;
	init: RequestInit;
};

const modernProtocol: MCPTransportProtocolConfiguration = {
	era: "modern",
	phase: "connected",
	version: MCP_MODERN_PROTOCOL_VERSION,
	clientInfo: MCP_CLIENT_INFO,
	clientCapabilities: {},
};

const legacyProtocol: MCPTransportProtocolConfiguration = {
	era: "legacy",
	phase: "connected",
	version: "2025-03-26",
};

function headersFrom(init: RequestInit): Headers {
	return new Headers(init.headers);
}

function jsonResponseForRequest(init: RequestInit, result: unknown = {}): Response {
	const request = JSON.parse(String(init.body)) as { id: string | number };
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
		headers: { "Content-Type": "application/json" },
	});
}

function sseResponse(messages: unknown[]): Response {
	return new Response(messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function withMockFetch<T>(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
	action: () => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch;
	try {
		return await action();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function modernTransport(): Promise<HttpTransport> {
	const transport = new HttpTransport({ type: "http", url: "https://mcp.example.test/mcp" });
	transport.configureProtocol(modernProtocol);
	await transport.connect();
	return transport;
}

describe("modern MCP Streamable HTTP transport", () => {
	it("writes matching stateless headers/body, mirrors validated tool parameters, and never starts session lifecycle traffic", async () => {
		const calls: FetchCall[] = [];
		await withMockFetch(
			(_url, init) => {
				calls.push({ url: "https://mcp.example.test/mcp", init });
				return jsonResponseForRequest(init, { ok: true });
			},
			async () => {
				const transport = await modernTransport();
				const toolName = "tool-世界";
				transport.registerToolHeaderMetadata([
					{
						toolName,
						parameters: [
							{ path: ["tenant"], headerName: "Tenant", valueType: "string" },
							{ path: ["enabled"], headerName: "Enabled", valueType: "boolean" },
						],
					},
				]);
				await transport.startSSEListener();
				await expect(
					transport.request("tools/call", {
						name: toolName,
						arguments: { tenant: "Hello, 世界", enabled: true },
					}),
				).resolves.toEqual({ ok: true });
				await transport.close();
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init.method).toBe("POST");
		const headers = headersFrom(calls[0]!.init);
		expect(headers.get("accept")).toBe("application/json, text/event-stream");
		expect(headers.get("mcp-protocol-version")).toBe(MCP_MODERN_PROTOCOL_VERSION);
		expect(headers.get("mcp-method")).toBe("tools/call");
		const encodedName = headers.get("mcp-name");
		expect(encodedName).toMatch(/^=\?base64\?.*\?=$/);
		expect(Buffer.from(encodedName!.slice(9, -2), "base64").toString("utf8")).toBe("tool-世界");
		const encodedTenant = headers.get("mcp-param-tenant");
		expect(encodedTenant).toMatch(/^=\?base64\?.*\?=$/);
		expect(Buffer.from(encodedTenant!.slice(9, -2), "base64").toString("utf8")).toBe("Hello, 世界");
		expect(headers.get("mcp-param-enabled")).toBe("true");
		expect(headers.get("mcp-session-id")).toBeNull();
		const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
		expect(body.method).toBe("tools/call");
		expect(body.params).toEqual({
			name: "tool-世界",
			arguments: { tenant: "Hello, 世界", enabled: true },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
			},
		});
	});

	it("rejects configured attempts to override MCP-owned modern headers", async () => {
		const transport = new HttpTransport({
			type: "http",
			url: "https://mcp.example.test/mcp",
			headers: { "Mcp-Method": "tools/call" },
		});
		transport.configureProtocol(modernProtocol);
		await transport.connect();
		await expect(transport.request("tools/list")).rejects.toThrow('Configured HTTP header "Mcp-Method" is reserved');
	});

	it("routes request-scoped SSE notifications before the matching final response", async () => {
		const notifications: Array<{ method: string; params: unknown }> = [];
		let requestCount = 0;
		await withMockFetch(
			(_url, init) => {
				requestCount += 1;
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 50 } },
					{ jsonrpc: "2.0", id: "invalid-server-request", method: "roots/list", params: {} },
					{ jsonrpc: "2.0", id: request.id, result: { done: true } },
				]);
			},
			async () => {
				const transport = await modernTransport();
				transport.onNotification = (method, params) => notifications.push({ method, params });
				transport.onRequest = async () => {
					throw new Error("Modern HTTP must not invoke the legacy server request handler");
				};
				await expect(transport.request("tools/list")).resolves.toEqual({ done: true });
			},
		);
		expect(notifications).toEqual([{ method: "notifications/progress", params: { progress: 50 } }]);
		expect(requestCount).toBe(1);
	});

	it("rejects a request stream that ends without a final response for its emitted ID", async () => {
		await withMockFetch(
			(_url, init) => sseResponse([{ jsonrpc: "2.0", id: `${JSON.parse(String(init.body)).id}-wrong`, result: {} }]),
			async () => {
				const transport = await modernTransport();
				await expect(transport.request("tools/list")).rejects.toThrow("No response received for request ID");
			},
		);
	});

	it("cancels only the aborted request-scoped SSE response stream", async () => {
		let streamCancelled = false;
		let requestCount = 0;
		const streamReading = Promise.withResolvers<void>();
		await withMockFetch(
			(_url, init) => {
				requestCount += 1;
				const request = JSON.parse(String(init.body)) as { id: string | number };
				if (requestCount === 1) {
					const body = new ReadableStream<Uint8Array>({
						pull() {
							streamReading.resolve();
							return new Promise<void>(() => {});
						},
						cancel() {
							streamCancelled = true;
						},
					});
					return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
				}
				return sseResponse([{ jsonrpc: "2.0", id: request.id, result: { second: true } }]);
			},
			async () => {
				const transport = await modernTransport();
				const abort = new AbortController();
				const first = transport.request("tools/list", undefined, { signal: abort.signal });
				await streamReading.promise;
				const second = transport.request("prompts/list");
				abort.abort(new DOMException("cancelled", "AbortError"));
				await expect(first).rejects.toThrow();
				await expect(second).resolves.toEqual({ second: true });
			},
		);
		expect(streamCancelled).toBeTrue();
	});

	it("keeps recognized modern HTTP errors modern and accepts only unrecognized 400 bodies as legacy fallback", async () => {
		const transport = await modernTransport();
		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32020, message: "Header mismatch" },
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			},
			async () => {
				let thrown: unknown;
				try {
					await transport.request("server/discover");
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(MCPHttpResponseError);
				expect(transport.classifyModernProbeFailure(thrown)).toEqual({
					kind: "modern-error",
					error: { code: -32020, message: "Header mismatch" },
				});
			},
		);
		expect(transport.classifyModernProbeFailure(new MCPHttpResponseError(400, "legacy failure"))).toEqual({
			kind: "legacy",
		});
		expect(transport.classifyModernProbeFailure(new MCPHttpResponseError(401, "unauthorized"))).toEqual({
			kind: "reject",
		});
		expect(transport.classifyModernProbeFailure(new Error("network unavailable"))).toEqual({ kind: "reject" });
	});

	it("advances only the opaque auth revision before retrying under rotated authorization", async () => {
		const observedRevisions: number[] = [];
		const authorizationHeaders: Array<string | null> = [];
		let calls = 0;
		await withMockFetch(
			(_url, init) => {
				calls += 1;
				authorizationHeaders.push(headersFrom(init).get("authorization"));
				if (calls === 1) return new Response("expired", { status: 401 });
				return jsonResponseForRequest(init, { refreshed: true });
			},
			async () => {
				const transport = new HttpTransport({
					type: "http",
					url: "https://mcp.example.test/mcp",
					headers: { Authorization: "Bearer stale" },
				});
				transport.configureProtocol(modernProtocol);
				await transport.connect();
				observedRevisions.push(transport.getAuthenticationContextRevision());
				transport.onAuthError = async () => {
					observedRevisions.push(transport.getAuthenticationContextRevision());
					return { Authorization: "Bearer fresh" };
				};
				await expect(transport.request("tools/list")).resolves.toEqual({ refreshed: true });
				observedRevisions.push(transport.getAuthenticationContextRevision());
			},
		);
		expect(authorizationHeaders).toEqual(["Bearer stale", "Bearer fresh"]);
		expect(observedRevisions).toEqual([0, 0, 1]);
	});

	it("advances the auth revision before retrying subscriptions/listen with rotated authorization", async () => {
		const authorizationHeaders: Array<string | null> = [];
		let calls = 0;
		await withMockFetch(
			(_url, init) => {
				calls += 1;
				authorizationHeaders.push(headersFrom(init).get("authorization"));
				if (calls === 1) return new Response("expired", { status: 401 });
				const request = JSON.parse(String(init.body)) as { id: string | number };
				const meta = { "io.modelcontextprotocol/subscriptionId": request.id };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: { _meta: meta, notifications: { toolsListChanged: true } },
					},
					{ jsonrpc: "2.0", id: request.id, result: { resultType: "complete", _meta: meta } },
				]);
			},
			async () => {
				const transport = new HttpTransport({
					type: "http",
					url: "https://mcp.example.test/mcp",
					headers: { Authorization: "Bearer stale" },
				});
				transport.configureProtocol(modernProtocol);
				await transport.connect();
				transport.onAuthError = async () => ({ Authorization: "Bearer fresh" });
				const listener = await transport.listen({ notifications: { toolsListChanged: true } });
				await expect(listener.acknowledged).resolves.toEqual({ toolsListChanged: true });
				await expect(listener.completion).resolves.toBeUndefined();
				expect(transport.getAuthenticationContextRevision()).toBe(1);
			},
		);
		expect(authorizationHeaders).toEqual(["Bearer stale", "Bearer fresh"]);
	});

	it("opens subscriptions/listen as its own metadata-framed POST and routes only after acknowledgment", async () => {
		const calls: FetchCall[] = [];
		const delivered: Array<{ method: string; params: unknown }> = [];
		await withMockFetch(
			(_url, init) => {
				calls.push({ url: "https://mcp.example.test/mcp", init });
				const request = JSON.parse(String(init.body)) as { id: string | number };
				const meta = { "io.modelcontextprotocol/subscriptionId": request.id };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: { _meta: meta, notifications: { toolsListChanged: true } },
					},
					{
						jsonrpc: "2.0",
						method: "notifications/tools/list_changed",
						params: { _meta: meta },
					},
					{
						jsonrpc: "2.0",
						id: request.id,
						result: { resultType: "complete", _meta: meta },
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen(
					{ notifications: { toolsListChanged: true, promptsListChanged: true } },
					{ onNotification: (method, params) => delivered.push({ method, params }) },
				);
				await expect(listener.acknowledged).resolves.toEqual({ toolsListChanged: true });
				await expect(listener.completion).resolves.toBeUndefined();
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.init.method).toBe("POST");
		const headers = headersFrom(calls[0]!.init);
		expect(headers.get("mcp-method")).toBe("subscriptions/listen");
		expect(headers.get("mcp-protocol-version")).toBe(MCP_MODERN_PROTOCOL_VERSION);
		expect(headers.get("mcp-session-id")).toBeNull();
		const body = JSON.parse(String(calls[0]?.init.body)) as {
			id: string | number;
			method: string;
			params: Record<string, unknown>;
		};
		expect(body.method).toBe("subscriptions/listen");
		expect(body.params).toEqual({
			notifications: { toolsListChanged: true, promptsListChanged: true },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
			},
		});
		expect(delivered.map(event => event.method)).toEqual(["notifications/tools/list_changed"]);
	});

	it("rejects a subscription notification delivered before acknowledgment", async () => {
		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/tools/list_changed",
						params: { _meta: { "io.modelcontextprotocol/subscriptionId": request.id } },
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen({ notifications: { toolsListChanged: true } });
				const acknowledgment = expect(listener.acknowledged).rejects.toThrow("before acknowledgment");
				const completion = expect(listener.completion).rejects.toThrow("before acknowledgment");
				await Promise.all([acknowledgment, completion]);
			},
		);
	});

	it("authorizes URI descendants on canonical path boundaries but rejects prefix lookalikes", async () => {
		const delivered: string[] = [];
		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							notifications: { resourceSubscriptions: ["file:///a", "file:///a/%7E"] },
						},
					},
					{
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							uri: "file:///a/child",
						},
					},
					{
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							uri: "file:///a/%7e/child",
						},
					},
					{
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
						},
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen(
					{ notifications: { resourceSubscriptions: ["file:///a", "file:///a/%7E"] } },
					{ onNotification: (_method, params) => delivered.push((params as { uri: string }).uri) },
				);
				await expect(listener.completion).resolves.toBeUndefined();
			},
		);
		expect(delivered).toEqual(["file:///a/child", "file:///a/%7e/child"]);

		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							notifications: { resourceSubscriptions: ["file:///a"] },
						},
					},
					{
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							uri: "file:///ab",
						},
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen({ notifications: { resourceSubscriptions: ["file:///a"] } });
				await expect(listener.completion).rejects.toThrow("unacknowledged notification");
			},
		);

		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							notifications: {
								resourceSubscriptions: ["https://user%7E:pass%7e@example.test/a?query=%7e#fragment%7E"],
							},
						},
					},
					{
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							uri: "https://user~:pass~@example.test/a/child?query=~#fragment~",
						},
					},
					{
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
						},
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen({
					notifications: {
						resourceSubscriptions: ["https://user%7E:pass%7e@example.test/a?query=%7e#fragment%7E"],
					},
				});
				await expect(listener.completion).resolves.toBeUndefined();
			},
		);

		await withMockFetch(
			(_url, init) => {
				const request = JSON.parse(String(init.body)) as { id: string | number };
				return sseResponse([
					{
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							notifications: { resourceSubscriptions: ["https://example.test/a?query=%2F"] },
						},
					},
					{
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: {
							_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
							uri: "https://example.test/a/child?query=/",
						},
					},
				]);
			},
			async () => {
				const transport = await modernTransport();
				const listener = await transport.listen({
					notifications: { resourceSubscriptions: ["https://example.test/a?query=%2F"] },
				});
				await expect(listener.completion).rejects.toThrow("unacknowledged notification");
			},
		);
	});
	it("demultiplexes concurrent listener IDs and cancellation closes only the selected response stream", async () => {
		const streamControllers = new Map<string | number, ReadableStreamDefaultController<Uint8Array>>();
		const cancelled = new Set<string | number>();
		const encoder = new TextEncoder();
		const calls: FetchCall[] = [];
		await withMockFetch(
			(_url, init) => {
				calls.push({ url: "https://mcp.example.test/mcp", init });
				const request = JSON.parse(String(init.body)) as { id: string | number };
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						streamControllers.set(request.id, controller);
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									jsonrpc: "2.0",
									method: "notifications/subscriptions/acknowledged",
									params: {
										_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
										notifications: { toolsListChanged: true },
									},
								})}\n\n`,
							),
						);
					},
					cancel() {
						cancelled.add(request.id);
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
			async () => {
				const transport = await modernTransport();
				const first = await transport.listen({ notifications: { toolsListChanged: true } });
				const delivered: string[] = [];
				const second = await transport.listen(
					{ notifications: { toolsListChanged: true } },
					{ onNotification: method => delivered.push(method) },
				);
				expect(first.requestId).not.toBe(second.requestId);
				await Promise.all([first.acknowledged, second.acknowledged]);

				await first.cancel();
				await expect(first.completion).resolves.toBeUndefined();
				await Bun.sleep(0);
				expect(cancelled.has(first.requestId)).toBeTrue();
				expect(cancelled.has(second.requestId)).toBeFalse();

				const secondController = streamControllers.get(second.requestId);
				expect(secondController).toBeDefined();
				secondController!.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/tools/list_changed",
							params: { _meta: { "io.modelcontextprotocol/subscriptionId": second.requestId } },
						})}\n\n`,
					),
				);
				secondController!.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							id: second.requestId,
							result: {
								resultType: "complete",
								_meta: { "io.modelcontextprotocol/subscriptionId": second.requestId },
							},
						})}\n\n`,
					),
				);
				secondController!.close();
				await expect(second.completion).resolves.toBeUndefined();
				expect(delivered).toEqual(["notifications/tools/list_changed"]);
			},
		);
		expect(calls).toHaveLength(2);
		expect(calls.every(call => call.init.method === "POST")).toBeTrue();
	});

	it("handles abort-at-registration for listen without hanging", async () => {
		const transport = await modernTransport();
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted-http"));

		await expect(
			transport.listen({ notifications: { toolsListChanged: true } }, { signal: controller.signal }),
		).rejects.toThrow("pre-aborted-http");
	});

	it("rejects malformed SSE envelope shape or mutual exclusivity violation on subscription stream", async () => {
		await withMockFetch(
			(_url, init) => {
				const body = JSON.parse(String(init.body)) as { id: string };
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						// Send initial ack
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									jsonrpc: "2.0",
									method: "notifications/subscriptions/acknowledged",
									params: {
										notifications: { toolsListChanged: true },
										_meta: { "io.modelcontextprotocol/subscriptionId": body.id },
									},
								})}\n\n`,
							),
						);
						// Send malformed message with both result and error
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: { resultType: "complete" },
									error: { code: -32600, message: "bad" },
								})}\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
			async () => {
				const transport = await modernTransport();
				const handle = await transport.listen({ notifications: { toolsListChanged: true } });
				await expect(handle.completion).rejects.toThrow("Invalid JSON-RPC 2.0 response shape");
			},
		);
	});

	it("preserves auth error diagnostics when refresh is unavailable", async () => {
		await withMockFetch(
			() => new Response("Unauthorized body diagnostic text", { status: 401 }),
			async () => {
				const transport = await modernTransport();
				transport.onAuthError = async () => null; // Refresh unavailable
				const handle = await transport.listen({ notifications: { toolsListChanged: true } });
				await expect(handle.completion).rejects.toThrow("Unauthorized body diagnostic text");
			},
		);
	});

	it("cancels non-SSE successful response body when text/event-stream is missing on listen", async () => {
		let bodyCancelled = false;
		await withMockFetch(
			() => {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"}'));
						controller.close();
					},
					cancel() {
						bodyCancelled = true;
					},
				});
				return new Response(stream, { headers: { "Content-Type": "application/json" } });
			},
			async () => {
				const transport = await modernTransport();
				const handle = await transport.listen({ notifications: { toolsListChanged: true } });
				await expect(handle.completion).rejects.toThrow("requires a text/event-stream response");
				expect(bodyCancelled).toBeTrue();
			},
		);
	});
});

describe("legacy HTTP adapter", () => {
	it("retains session GET and DELETE behavior only after explicit legacy configuration", async () => {
		const calls: FetchCall[] = [];
		await withMockFetch(
			(_url, init) => {
				calls.push({ url: "https://mcp.example.test/mcp", init });
				if (init.method === "POST") {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: {} }),
						{
							headers: { "Content-Type": "application/json", "Mcp-Session-Id": "legacy-session" },
						},
					);
				}
				return new Response(null, { status: 405 });
			},
			async () => {
				const transport = new HttpTransport({ type: "http", url: "https://mcp.example.test/mcp" });
				transport.configureProtocol(legacyProtocol);
				await transport.connect();
				await transport.request("initialize", { protocolVersion: "2025-03-26" });
				await transport.startSSEListener();
				await transport.close();
			},
		);
		expect(calls.map(call => call.init.method)).toEqual(["POST", "GET", "DELETE"]);
		expect(headersFrom(calls[1]!.init).get("mcp-session-id")).toBe("legacy-session");
		expect(headersFrom(calls[2]!.init).get("mcp-session-id")).toBe("legacy-session");
	});
});
