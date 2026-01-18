import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type KernelDisplayOutput, PythonKernel } from "./python-kernel";
import { PYTHON_PRELUDE } from "./python-prelude";

type JupyterMessage = {
	channel: string;
	header: {
		msg_id: string;
		session: string;
		username: string;
		date: string;
		msg_type: string;
		version: string;
	};
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
	buffers?: Uint8Array[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeMessage(msg: JupyterMessage): ArrayBuffer {
	const msgText = JSON.stringify({
		channel: msg.channel,
		header: msg.header,
		parent_header: msg.parent_header,
		metadata: msg.metadata,
		content: msg.content,
	});
	const msgBytes = textEncoder.encode(msgText);
	const buffers = msg.buffers ?? [];
	const offsetCount = 1 + buffers.length;
	const headerSize = 4 + offsetCount * 4;
	let totalSize = headerSize + msgBytes.length;
	for (const buffer of buffers) {
		totalSize += buffer.length;
	}
	const result = new ArrayBuffer(totalSize);
	const view = new DataView(result);
	const bytes = new Uint8Array(result);
	view.setUint32(0, offsetCount, true);
	let offset = headerSize;
	view.setUint32(4, offset, true);
	bytes.set(msgBytes, offset);
	offset += msgBytes.length;
	buffers.forEach((buffer, index) => {
		view.setUint32(4 + (index + 1) * 4, offset, true);
		bytes.set(buffer, offset);
		offset += buffer.length;
	});
	return result;
}

function decodeMessage(data: ArrayBuffer): JupyterMessage {
	const view = new DataView(data);
	const offsetCount = view.getUint32(0, true);
	const offsets: number[] = [];
	for (let i = 0; i < offsetCount; i++) {
		offsets.push(view.getUint32(4 + i * 4, true));
	}
	const msgStart = offsets[0];
	const msgEnd = offsets.length > 1 ? offsets[1] : data.byteLength;
	const msgBytes = new Uint8Array(data, msgStart, msgEnd - msgStart);
	const msgText = textDecoder.decode(msgBytes);
	return JSON.parse(msgText) as JupyterMessage;
}

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static lastInstance: FakeWebSocket | null = null;
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	onopen?: () => void;
	onmessage?: (event: { data: ArrayBuffer }) => void;
	onerror?: (event: unknown) => void;
	onclose?: () => void;
	readonly url: string;
	readonly sent: (ArrayBuffer | string)[] = [];
	private handleSend: ((data: ArrayBuffer | string) => void) | null = null;
	private pendingMessages: (ArrayBuffer | string)[] = [];

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.lastInstance = this;
		queueMicrotask(() => this.onopen?.());
	}

	setSendHandler(handler: (data: ArrayBuffer | string) => void) {
		this.handleSend = handler;
		for (const msg of this.pendingMessages) {
			handler(msg);
		}
		this.pendingMessages = [];
	}

	send(data: ArrayBuffer | string) {
		this.sent.push(data);
		if (this.handleSend) {
			this.handleSend(data);
		} else {
			this.pendingMessages.push(data);
		}
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe("PythonKernel (external gateway)", () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		process.env.OMP_PYTHON_GATEWAY_URL = "http://gateway.test";
		process.env.OMP_PYTHON_SKIP_CHECK = "1";
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			process.env[key] = value;
		}
		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;
		FakeWebSocket.lastInstance = null;
		vi.restoreAllMocks();
	});

	it("executes code via websocket stream and display data", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-1" }), { status: 201 });
			}
			if (url.includes("/api/kernels/") && init?.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			return new Response("", { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const responseQueue: Array<(msgId: string, ws: FakeWebSocket) => void> = [];
		responseQueue.push((msgId, ws) => {
			const reply: JupyterMessage = {
				channel: "shell",
				header: {
					msg_id: "reply-1",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "execute_reply",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: { status: "ok", execution_count: 1 },
			};
			const status: JupyterMessage = {
				channel: "iopub",
				header: {
					msg_id: "status-1",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "status",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: { execution_state: "idle" },
			};
			ws.onmessage?.({ data: encodeMessage(reply) });
			ws.onmessage?.({ data: encodeMessage(status) });
		});
		responseQueue.push((msgId, ws) => {
			const stream: JupyterMessage = {
				channel: "iopub",
				header: {
					msg_id: "stream-1",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "stream",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: { text: "hello\n" },
			};
			const display: JupyterMessage = {
				channel: "iopub",
				header: {
					msg_id: "display-1",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "execute_result",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: {
					data: {
						"text/plain": "result",
						"application/json": { answer: 42 },
					},
				},
			};
			const reply: JupyterMessage = {
				channel: "shell",
				header: {
					msg_id: "reply-2",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "execute_reply",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: { status: "ok", execution_count: 2 },
			};
			const status: JupyterMessage = {
				channel: "iopub",
				header: {
					msg_id: "status-2",
					session: "session",
					username: "omp",
					date: new Date().toISOString(),
					msg_type: "status",
					version: "5.5",
				},
				parent_header: { msg_id: msgId },
				metadata: {},
				content: { execution_state: "idle" },
			};
			ws.onmessage?.({ data: encodeMessage(stream) });
			ws.onmessage?.({ data: encodeMessage(display) });
			ws.onmessage?.({ data: encodeMessage(reply) });
			ws.onmessage?.({ data: encodeMessage(status) });
		});

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler((data) => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const handler = responseQueue.shift();
			if (!handler) {
				throw new Error(`Unexpected message: ${msg.header.msg_type}`);
			}
			handler(msg.header.msg_id, ws);
		});

		const kernel = await kernelPromise;
		const chunks: string[] = [];
		const displays: KernelDisplayOutput[] = [];

		const result = await kernel.execute("print('hello')", {
			onChunk: (text) => {
				chunks.push(text);
			},
			onDisplay: (output) => {
				displays.push(output);
			},
		});

		expect(result.status).toBe("ok");
		expect(chunks.join("")).toContain("hello");
		expect(chunks.join("")).toContain("result");
		expect(displays).toEqual([{ type: "json", data: { answer: 42 } }]);

		await kernel.shutdown();
		expect(fetchMock).toHaveBeenCalledWith("http://gateway.test/api/kernels/kernel-1", {
			method: "DELETE",
			headers: {},
		});
	});

	it("marks kernel dead after repeated ping failures", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-2" }), { status: 201 });
			}
			if (url.includes("/api/kernels/kernel-2") && !init?.method) {
				throw new Error("ping failed");
			}
			return new Response("", { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const responseQueue: Array<(msgId: string, ws: FakeWebSocket) => void> = [
			(msgId, ws) => {
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { status: "ok", execution_count: 1 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
			},
		];

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler((data) => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const handler = responseQueue.shift();
			if (!handler) {
				throw new Error(`Unexpected message: ${msg.header.msg_type}`);
			}
			handler(msg.header.msg_id, ws);
		});

		const kernel = await kernelPromise;
		const firstPing = await kernel.ping(1);
		const secondPing = await kernel.ping(1);

		expect(firstPing).toBe(false);
		expect(secondPing).toBe(false);
		expect(kernel.isAlive()).toBe(false);

		await kernel.shutdown();
	});

	it("initializes the IPython prelude", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-3" }), { status: 201 });
			}
			return new Response("", { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const responseQueue: Array<(msgId: string, ws: FakeWebSocket) => void> = [
			(msgId, ws) => {
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { status: "ok", execution_count: 1 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
			},
		];

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler((data) => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const handler = responseQueue.shift();
			if (!handler) {
				throw new Error(`Unexpected message: ${msg.header.msg_type}`);
			}
			expect(msg.content.code).toBe(PYTHON_PRELUDE);
			handler(msg.header.msg_id, ws);
		});

		const kernel = await kernelPromise;
		expect(kernel.isAlive()).toBe(true);
		await kernel.shutdown();
	});

	it("introspects prelude helpers", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-4" }), { status: 201 });
			}
			return new Response("", { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const docs = [
			{
				name: "read",
				signature: "(path, limit=None)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const payload = JSON.stringify(docs);

		const responseQueue: Array<(msgId: string, ws: FakeWebSocket) => void> = [
			(msgId, ws) => {
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { status: "ok", execution_count: 1 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-prelude",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
			},
			(msgId, ws) => {
				const stream: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "stream-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "stream",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { text: `${payload}\n` },
				};
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { status: "ok", execution_count: 2 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msgId },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(stream) });
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
			},
		];

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler((data) => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const handler = responseQueue.shift();
			if (!handler) {
				throw new Error(`Unexpected message: ${msg.header.msg_type}`);
			}
			if (msg.content.code !== PYTHON_PRELUDE) {
				expect(String(msg.content.code)).toContain("__omp_prelude_docs__");
			}
			handler(msg.header.msg_id, ws);
		});

		const kernel = await kernelPromise;
		const result = await kernel.introspectPrelude();
		expect(result).toEqual(docs);
		await kernel.shutdown();
	});
});

// TODO: add coverage for gateway process exit handling once PythonKernel exposes a test hook.
