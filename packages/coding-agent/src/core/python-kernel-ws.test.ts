import { describe, expect, it } from "bun:test";
import { deserializeWebSocketMessage, type JupyterMessage, serializeWebSocketMessage } from "./python-kernel";

const encoder = new TextEncoder();

function buildFrame(message: Omit<JupyterMessage, "buffers">, buffers: Uint8Array[] = []): ArrayBuffer {
	const msgBytes = encoder.encode(JSON.stringify(message));
	const offsetCount = 1 + buffers.length;
	const headerSize = 4 + offsetCount * 4;

	let totalSize = headerSize + msgBytes.length;
	for (const buffer of buffers) {
		totalSize += buffer.length;
	}

	const frame = new ArrayBuffer(totalSize);
	const view = new DataView(frame);
	const bytes = new Uint8Array(frame);

	view.setUint32(0, offsetCount, true);
	view.setUint32(4, headerSize, true);
	bytes.set(msgBytes, headerSize);

	let offset = headerSize + msgBytes.length;
	for (let i = 0; i < buffers.length; i++) {
		view.setUint32(4 + (i + 1) * 4, offset, true);
		bytes.set(buffers[i], offset);
		offset += buffers[i].length;
	}

	return frame;
}

describe("deserializeWebSocketMessage", () => {
	it("parses offset tables and buffers", () => {
		const message = {
			channel: "iopub",
			header: {
				msg_id: "msg-1",
				session: "session-1",
				username: "omp",
				date: "2024-01-01T00:00:00Z",
				msg_type: "stream",
				version: "5.5",
			},
			parent_header: {},
			metadata: {},
			content: { text: "hello" },
		};
		const buffer = new Uint8Array([1, 2, 3]);
		const frame = buildFrame(message, [buffer]);

		const parsed = deserializeWebSocketMessage(frame);

		expect(parsed).not.toBeNull();
		expect(parsed?.header.msg_id).toBe("msg-1");
		expect(parsed?.content).toEqual({ text: "hello" });
		expect(parsed?.buffers?.[0]).toEqual(buffer);
	});

	it("returns null for invalid frames", () => {
		const headerSize = 8;
		const bytes = encoder.encode("not-json");
		const frame = new ArrayBuffer(headerSize + bytes.length);
		const view = new DataView(frame);
		const data = new Uint8Array(frame);
		view.setUint32(0, 1, true);
		view.setUint32(4, headerSize, true);
		data.set(bytes, headerSize);

		expect(deserializeWebSocketMessage(frame)).toBeNull();
		const emptyFrame = new ArrayBuffer(4);
		new DataView(emptyFrame).setUint32(0, 0, true);
		expect(deserializeWebSocketMessage(emptyFrame)).toBeNull();
	});
});

describe("serializeWebSocketMessage", () => {
	it("round trips message payloads", () => {
		const message: JupyterMessage = {
			channel: "shell",
			header: {
				msg_id: "msg-2",
				session: "session-2",
				username: "omp",
				date: "2024-02-01T00:00:00Z",
				msg_type: "execute_request",
				version: "5.5",
			},
			parent_header: { parent: "root" },
			metadata: { tag: "meta" },
			content: { code: "print('hi')" },
			buffers: [new Uint8Array([9, 8, 7])],
		};

		const frame = serializeWebSocketMessage(message);
		const parsed = deserializeWebSocketMessage(frame);

		expect(parsed).not.toBeNull();
		expect(parsed?.header.msg_type).toBe("execute_request");
		expect(parsed?.content).toEqual({ code: "print('hi')" });
		expect(parsed?.buffers?.[0]).toEqual(new Uint8Array([9, 8, 7]));
	});
});
