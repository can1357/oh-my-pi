import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeWithRetries } from "../../utils/src/temp";

const enc = new TextEncoder();

let previousDebugFlag: string | undefined;
let previousCwd: string;
let tempDir: string | undefined;

beforeEach(async () => {
	previousDebugFlag = Bun.env.PI_REQ_DEBUG;
	previousCwd = process.cwd();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-"));
	process.chdir(tempDir);
});

afterEach(async () => {
	clearCustomApis();
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.PI_REQ_DEBUG;
	else Bun.env.PI_REQ_DEBUG = previousDebugFlag;
	if (tempDir) await removeWithRetries(tempDir);
	tempDir = undefined;
});

function chunkedResponse(chunks: Uint8Array[]): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				controller.enqueue(chunks[index++]!);
			},
		}),
		{ status: 201, statusText: "Created", headers: { "x-request-id": "resp-1", "content-type": "text/plain" } },
	);
}

function splitResponseLog(bytes: Uint8Array): { headers: string; body: Uint8Array } {
	const separator = enc.encode("\r\n\r\n");
	let separatorIndex = -1;
	for (let i = 0; i <= bytes.length - separator.length; i++) {
		let matched = true;
		for (let j = 0; j < separator.length; j++) {
			if (bytes[i + j] !== separator[j]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			separatorIndex = i;
			break;
		}
	}
	expect(separatorIndex).toBeGreaterThanOrEqual(0);
	return {
		headers: new TextDecoder().decode(bytes.subarray(0, separatorIndex)),
		body: bytes.subarray(separatorIndex + separator.length),
	};
}

/** Find the latest rr-session-*.json written to the temp dir by PI_REQ_DEBUG
 * and derive its matching .res.log (rr-session-N.res.log, not .json.res.log). */
async function findDebugFiles(): Promise<{ requestPath: string; responsePath: string }> {
	const entries = await fs.readdir(tempDir!);
	const jsonFiles = entries.filter(f => /^rr-session-\d+\.json$/.test(f));
	expect(jsonFiles.length).toBeGreaterThan(0);
	jsonFiles.sort((a, b) => {
		const na = Number(a.match(/\d+/)![0]);
		const nb = Number(b.match(/\d+/)![0]);
		return na - nb;
	});
	const latest = jsonFiles[jsonFiles.length - 1]!;
	const id = latest.match(/\d+/)![0];
	return {
		requestPath: path.join(tempDir!, latest),
		responsePath: path.join(tempDir!, `rr-session-${id}.res.log`),
	};
}

describe("PI_REQ_DEBUG request/response recording", () => {
	it("writes nothing when the flag is disabled", async () => {
		delete Bun.env.PI_REQ_DEBUG;
		const fetchImpl: FetchImpl = async () => new Response("ok");
		const response = await transportFetch(debugModel(), fetchImpl)("https://provider.test/off", { method: "POST" });
		await response.text();
		expect(await fs.readdir(tempDir!)).toEqual([]);
	});

	it("records every fetch while the env flag is enabled", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		let calls = 0;
		const fetchImpl: FetchImpl = async () => {
			calls += 1;
			return new Response(calls === 1 ? "first" : "second", { headers: { "x-call": String(calls) } });
		};
		const wrapped = transportFetch(debugModel(), fetchImpl);

		const first = await wrapped("https://provider.test/first", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ first: true }),
		});
		await first.text();
		const second = await wrapped("https://provider.test/second", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ second: true }),
		});
		await second.text();

		expect(calls).toBe(2);
		const { requestPath, responsePath } = await findDebugFiles();
		const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;
		expect(request).toMatchObject({
			protocol: "http",
			method: "POST",
			url: "https://provider.test/second",
			body: { second: true },
		});
		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("x-call: 2");
		expect(new TextDecoder().decode(log.body)).toBe("second");
	});

	it("records request JSON before fetch and raw response bytes after headers", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		const responseBody = new Uint8Array([0x66, 0x69, 0x72, 0x73, 0x74, 0x00, 0xff, 0x0a]);
		const fetchImpl: FetchImpl = async () => chunkedResponse([responseBody.subarray(0, 5), responseBody.subarray(5)]);
		const wrapped = transportFetch(debugModel(), fetchImpl);

		const response = await wrapped("https://provider.test/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test-token" },
			body: JSON.stringify({ model: "debug-model", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBody);

		const { requestPath, responsePath } = await findDebugFiles();
		const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;
		expect(request).toMatchObject({
			protocol: "http",
			method: "POST",
			url: "https://provider.test/v1/messages",
			body: { model: "debug-model", messages: [{ role: "user", content: "hi" }] },
		});
		expect(request.headers).toMatchObject({ authorization: "Bearer test-token", "content-type": "application/json" });

		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("HTTP 201 Created");
		expect(log.headers).toContain("content-type: text/plain");
		expect(log.headers).toContain("x-request-id: resp-1");
		expect(log.body).toEqual(responseBody);
	});

	it("keeps the partial response log when the response body is cancelled", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		const firstChunk = enc.encode("partial");
		let sent = false;
		const fetchImpl: FetchImpl = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent) return;
						sent = true;
						controller.enqueue(firstChunk);
					},
				}),
				{ status: 201, statusText: "Created", headers: { "content-type": "text/plain" } },
			);
		const response = await transportFetch(debugModel(), fetchImpl)("https://provider.test/stream", {
			method: "POST",
		});

		const reader = response.body!.getReader();
		const firstRead = await reader.read();
		expect(firstRead.value).toEqual(firstChunk);
		await reader.cancel("turn aborted");

		const { responsePath } = await findDebugFiles();
		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("HTTP 201 Created");
		expect(log.body).toEqual(firstChunk);
	});

	it("wraps provider fetch options with request debug recording", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		const fetchMock: FetchImpl = async () => new Response("ok", { headers: { "x-debug": "yes" } });
		registerDebugApi();

		const events = stream(
			debugModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "key", fetch: fetchMock },
		);
		await events.result();

		const { requestPath, responsePath } = await findDebugFiles();
		const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;
		expect(request.url).toBe("https://provider.test/custom");
		expect(request.body).toEqual({ ok: true });
		const log = splitResponseLog(await fs.readFile(responsePath));
		expect(log.headers).toContain("x-debug: yes");
		expect(new TextDecoder().decode(log.body)).toBe("ok");
	});

	it("records one dump per request when streamSimple re-enters the request path for auth retry", async () => {
		Bun.env.PI_REQ_DEBUG = "1";
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response("ok");
		};
		registerDebugApi();

		// A resolver-form apiKey routes streamSimpleRequest through its retry
		// wrapper, which calls streamSimpleRequest again with the same options.
		const events = streamSimple(
			debugModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: async () => "key", fetch: fetchMock },
		);
		await events.result();

		expect(calls).toBe(1);
		const entries = await fs.readdir(tempDir!);
		expect(entries.filter(f => /^rr-session-\d+\.json$/.test(f))).toHaveLength(1);
	});
});

function debugModel(): Model {
	return buildModel({
		id: "debug-model",
		name: "Debug Model",
		api: "req-debug-test",
		provider: "test",
		baseUrl: "https://provider.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec);
}

/** Custom API whose only side effect is one POST through `options.fetch`. */
function registerDebugApi(): void {
	registerCustomApi("req-debug-test", (_model, _context, options) => {
		const events = new AssistantMessageEventStream();
		void (async () => {
			const fetchImpl = options?.fetch;
			if (!fetchImpl) throw new Error("missing fetch");
			const response = await fetchImpl("https://provider.test/custom", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ok: true }),
			});
			await response.text();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "test",
				api: "req-debug-test",
				model: "debug-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			events.end(message);
		})().catch(error => events.fail(error));
		return events;
	});
}
