import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockHandler, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

const STREAM_ROUTES = [
	{
		format: "openai-chat",
		path: "/v1/chat/completions",
		body: { model: "mock/stream-log", messages: [{ role: "user", content: "hi" }], stream: true },
	},
	{
		format: "pi-native",
		path: "/v1/pi/stream",
		body: {
			modelId: "mock/stream-log",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			stream: true,
		},
	},
];

interface GatewayHarness {
	url: string;
	mock: MockModel;
	close(): Promise<void>;
}

async function bootGateway(): Promise<GatewayHarness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stream-log-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
	const mock = createMockModel({ provider: "openrouter", id: "mock/stream-log" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-test-token"],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		mock,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/** Streams one reply through every route; returns each route's format with its response's request id. */
async function streamEachRoute(gw: GatewayHarness, reply: MockHandler): Promise<Array<[string, string | null]>> {
	const requests: Array<[string, string | null]> = [];
	for (const route of STREAM_ROUTES) {
		gw.mock.push(reply);
		const res = await fetch(`${gw.url}${route.path}`, {
			method: "POST",
			headers: { Authorization: "Bearer gw-test-token", "Content-Type": "application/json" },
			body: JSON.stringify(route.body),
		});
		expect(res.status).toBe(200);
		await res.text();
		requests.push([route.format, res.headers.get("x-request-id")]);
	}
	return requests;
}

type LogCall = [message: string, context?: Record<string, unknown>];

function logsFor(
	spy: { mock: { calls: LogCall[] } },
	message: string,
	requestId: string | null,
): Array<Record<string, unknown> | undefined> {
	return spy.mock.calls
		.filter(([logged, fields]) => logged === message && fields?.requestId === requestId)
		.map(([, fields]) => fields);
}

describe("auth-gateway streamed reply settle log", () => {
	it("logs info with the stop reason when a streamed reply finishes", async () => {
		const gw = await bootGateway();
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			for (const [format, requestId] of await streamEachRoute(gw, { content: ["done"] })) {
				const finished = logsFor(info, "auth-gateway stream finished", requestId);
				expect(finished).toHaveLength(1);
				expect(finished[0]).toMatchObject({
					format,
					resolvedProvider: "openrouter",
					resolvedModel: "mock/stream-log",
					stopReason: "stop",
					durationMs: expect.any(Number),
				});
				expect(warn.mock.calls.filter(([, fields]) => fields?.requestId === requestId)).toHaveLength(0);
			}
		} finally {
			await gw.close();
		}
	});

	it("warns with the request id and upstream error when a streamed reply ends in an error", async () => {
		const gw = await bootGateway();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			// Text already reached the client when the upstream connection dropped.
			const reply = {
				content: ["partial answer"],
				stopReason: "error" as const,
				errorMessage: "The socket connection was closed unexpectedly",
			};
			for (const [format, requestId] of await streamEachRoute(gw, reply)) {
				const ended = logsFor(warn, "auth-gateway stream ended early", requestId);
				expect(ended).toHaveLength(1);
				expect(ended[0]).toMatchObject({
					format,
					resolvedProvider: "openrouter",
					resolvedModel: "mock/stream-log",
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
					durationMs: expect.any(Number),
				});
			}
		} finally {
			await gw.close();
		}
	});

	it("warns with the request id and error when a streamed reply fails without a final message", async () => {
		const gw = await bootGateway();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			// A throwing handler makes the mock provider fail the stream, so `result()` rejects.
			const reply: MockHandler = () => {
				throw new Error("transport exploded");
			};
			for (const [format, requestId] of await streamEachRoute(gw, reply)) {
				const failed = logsFor(warn, "auth-gateway stream failed", requestId);
				expect(failed).toEqual([{ requestId, format, error: "transport exploded" }]);
				expect(logsFor(warn, "auth-gateway stream ended early", requestId)).toHaveLength(0);
			}
		} finally {
			await gw.close();
		}
	});
});
