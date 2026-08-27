import { describe, expect, it, spyOn } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import {
	parseJsonlLenient,
	readJsonl,
	readLines,
	readSseEvents,
	readSseJson,
	type ServerSentEvent,
} from "@oh-my-pi/pi-utils/stream";

const encoder = new TextEncoder();

async function runStringTransform(transform: TransformStream<string, string>, chunks: string[]): Promise<string[]> {
	const readable = new ReadableStream<string>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

	const reader = readable.pipeThrough(transform).getReader();
	const output: string[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		output.push(value);
	}
	return output;
}

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const output: T[] = [];
	for await (const item of iter) output.push(item);
	return output;
}

describe("sanitizeText", () => {
	it("strips ANSI and normalizes CR", () => {
		const input = "\u001b[31mred\u001b[0m\r\n";
		expect(sanitizeText(input)).toBe("red\n");
	});
});

describe("readLines", () => {
	it("splits lines across chunks without newlines", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("alpha\nbe"));
				controller.enqueue(encoder.encode("ta\ngam"));
				controller.enqueue(encoder.encode("ma"));
				controller.close();
			},
		});

		const output: string[] = [];
		const dec = new TextDecoder();
		for await (const line of readLines(readable)) {
			output.push(dec.decode(line));
		}

		expect(output).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("abortableSource (via readLines)", () => {
	it("cancels the source and stops yielding when aborted mid-stream", async () => {
		let cancelReason: unknown;
		let cancelled = false;
		const controller = new AbortController();
		const readable = new ReadableStream<Uint8Array>({
			start(streamController) {
				// One complete line, then leave the stream open so the next read blocks.
				streamController.enqueue(encoder.encode("alpha\n"));
			},
			cancel(reason) {
				cancelled = true;
				cancelReason = reason;
			},
		});

		const dec = new TextDecoder();
		const iter = readLines(readable, controller.signal)[Symbol.asyncIterator]();

		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(dec.decode(first.value as Uint8Array)).toBe("alpha");

		controller.abort("timeout");
		const next = await iter.next();

		expect(next.done).toBe(true);
		expect(cancelled).toBe(true);
		expect(cancelReason).toBe("timeout");
	});

	it("cancels the source when the consumer breaks early", async () => {
		let cancelled = false;
		const readable = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encoder.encode("alpha\n"));
				streamController.enqueue(encoder.encode("beta\n"));
				// Stays open: only a `break` (not EOF) should trigger cancel.
			},
			cancel() {
				cancelled = true;
			},
		});

		const dec = new TextDecoder();
		const lines: string[] = [];
		for await (const line of readLines(readable)) {
			lines.push(dec.decode(line));
			break;
		}

		expect(lines).toEqual(["alpha"]);
		expect(cancelled).toBe(true);
	});
});

describe("readJsonl", () => {
	it("parses JSONL across chunk boundaries", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
				controller.enqueue(encoder.encode('2}\n{"c":3}\n'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	it("parses trailing line without newline", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"z":9}'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ z: 9 }]);
	});
});

describe("createSanitizerStream", () => {
	it("sanitizes text chunks", async () => {
		const transform = new TransformStream<string, string>({
			transform(chunk, controller) {
				controller.enqueue(sanitizeText(chunk));
			},
		});
		const output = await runStringTransform(transform, ["\u001b[34mhi\u001b[0m\r\n"]);

		expect(output).toEqual(["hi\n"]);
	});
});

describe("parseJsonlLenient", () => {
	it("parses valid JSONL", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{"a":2}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	it("skips malformed lines and continues", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{bad json}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 3 }]);
	});

	it("returns empty array for empty input", () => {
		expect(parseJsonlLenient("")).toEqual([]);
	});

	it("handles input without trailing newline", () => {
		const result = parseJsonlLenient<{ x: number }>('{"x":42}');
		expect(result).toEqual([{ x: 42 }]);
	});
});

describe("readSseJson", () => {
	it("parses data lines and stops at [DONE]", async () => {
		const chunks = [
			encoder.encode('data: {"a":1}\n\n'),
			encoder.encode("event: ping\ndata: \n\n"),
			encoder.encode('data: {"b":2}\r\n\r\n'),
			encoder.encode("data: [DONE]\n\n"),
			encoder.encode('data: {"c":3}\n\n'),
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports raw events to diagnostic observers without changing parsed output", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message\ndata: {"a":1}\n\n'),
			encoder.encode("event: done\ndata: [DONE]\n\n"),
		]);
		const observed: ServerSentEvent[] = [];

		const output = await collectAsync(readSseJson(stream, undefined, event => observed.push(event)));

		expect(output).toEqual([{ a: 1 }]);
		expect(observed.map(event => event.event)).toEqual(["message", "done"]);
		expect(observed[0].raw).toEqual(["event: message", 'data: {"a":1}']);
	});

	it("flushes a trailing event without the closing blank line", async () => {
		const chunks = [encoder.encode('data: {"c":3}')];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ c: 3 }]);
	});

	it("handles data lines split across chunks", async () => {
		const chunks = [encoder.encode('data: {"a"'), encoder.encode(":1}\n\n")];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }]);
	});

	it("completes cleanly when the final data chunk is truncated JSON", async () => {
		const testCases = [
			'data: {"b":2',
			'data: {"id":"x", "na',
			'data: {"id":"x", "name"',
			'data: {"id":"x", "name":',
			'data: {"id":"x", "name": "y',
			'data: {"id":"x",',
			"data: [1,2,",
			'data: {"s":"n',
			'data: {"n',
			'data: {"s":"abc\\',
			'data: {"s":"\\u12',
		];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});

	it("completes cleanly when the final data chunk is cut inside a JSON literal at EOF", async () => {
		const testCases = ['data: {"finish_reason":nul', 'data: {"ok":tru', "data: [fal"];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});

	it("throws SyntaxError when a middle data chunk is malformed JSON", async () => {
		const chunks = [encoder.encode('data: {"a":1\n\n'), encoder.encode('data: {"b":2}\n\n')];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		await expect(collectAsync(readSseJson(stream))).rejects.toThrow(SyntaxError);
	});

	it("throws SyntaxError when a final event is not JSON-container-shaped", async () => {
		// Non-object/array final events are not recoverable as a truncated stream tail
		// and still surface as errors (e.g. provider error text, bare scalars).
		const testCases = ["data: Internal Server Error", 'data: "an unterminated string', "data: 42 then junk"];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			await expect(collectAsync(readSseJson(stream))).rejects.toThrow(SyntaxError);
		}
	});

	it("stops cleanly on a container-shaped final event that fails strict parse", async () => {
		// Lenient recovery: any object/array-shaped final event JSON.parse rejects is
		// treated as a cut-off or lightly malformed stream tail and ends iteration after
		// the last valid event, rather than throwing.
		const testCases = [
			'data: {"b":2,}', // trailing comma
			"data: [{]", // mismatched closer
			'data: {"b" 2}', // missing colon
			"data: {unterminated}", // bareword body
			'data: {"b": true garbage', // trailing garbage after a value
			'data: {"b":1 "c":2', // missing comma
			'data: {"b": ]', // mismatched closer
			'data: {"b": @', // invalid character
		];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});
});

function bytesStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("readSseEvents", () => {
	it("dispatches events on blank-line boundaries", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message_start\ndata: {"id":1}\n\n'),
			encoder.encode("event: message_stop\ndata: {}\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => e.event)).toEqual(["message_start", "message_stop"]);
		expect(events.map(e => e.data)).toEqual(['{"id":1}', "{}"]);
	});

	it("decodes all complete lines in a source chunk as one batch", async () => {
		const decodeSpy = spyOn(TextDecoder.prototype, "decode");
		try {
			const stream = bytesStreamFromChunks([encoder.encode("event: first\ndata: 1\n\nevent: second\ndata: 2\n\n")]);
			const events = await collectAsync(readSseEvents(stream));

			expect(events.map(event => event.data)).toEqual(["1", "2"]);
			expect(decodeSpy).toHaveBeenCalledTimes(1);
		} finally {
			decodeSpy.mockRestore();
		}
	});

	it("joins multiple data: lines with newlines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: chunk\ndata: line1\ndata: line2\ndata: line3\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("chunk");
		expect(evt.data).toBe("line1\nline2\nline3");
	});

	it("skips comment lines but preserves them in raw", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": keep-alive\nevent: ping\ndata: ok\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("ping");
		expect(evt.data).toBe("ok");
		expect(evt.raw).toEqual([": keep-alive", "event: ping", "data: ok"]);
	});

	it("does not carry pure comment keepalives into the next event raw lines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": keepalive\n\nevent: ping\ndata: ok\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.raw).toEqual(["event: ping", "data: ok"]);
	});

	it("yields control-only id/retry events for reconnecting transports", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("id: stream-1\nretry: 25\n\n")]);
		const events = await collectAsync(readSseEvents(stream));

		expect(events).toEqual([
			{
				event: null,
				data: "",
				raw: ["id: stream-1", "retry: 25"],
				id: "stream-1",
				retry: 25,
			},
		] satisfies ServerSentEvent[]);
	});

	it("strips a single optional space after the field colon (and only one)", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event:  spaced\ndata:  body\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe(" spaced");
		expect(evt.data).toBe(" body");
	});

	it("handles CRLF line terminators", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => `${e.event}=${e.data}`)).toEqual(["a=1", "b=2"]);
	});

	it("recovers when a chunk boundary splits inside a field name", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode("eve"),
			encoder.encode("nt: split\nda"),
			encoder.encode("ta: payload\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("split");
		expect(events[0].data).toBe("payload");
	});

	it("recovers when a chunk boundary splits inside a multi-byte UTF-8 sequence", async () => {
		// "héllo" → bytes for 'é' are 0xC3 0xA9; split between them.
		const full = encoder.encode("data: héllo\n\n");
		const split = full.indexOf(0xc3) + 1;
		const stream = bytesStreamFromChunks([full.subarray(0, split), full.subarray(split)]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.data).toBe("héllo");
	});

	it("flushes a pending event even without the trailing blank line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: trailing\ndata: tail\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toEqual([
			{ event: "trailing", data: "tail", raw: ["event: trailing", "data: tail"] },
		] satisfies ServerSentEvent[]);
	});

	it("treats a tail without any newline as a complete final line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: x\ndata: y")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("x");
		expect(events[0].data).toBe("y");
	});

	it("survives a one-byte-per-chunk drip feed without quadratic blowup", async () => {
		// The legacy decoder rebuilt the entire string buffer per line and was
		// O(n²) in this case. Should now complete in well under a second.
		const lines: string[] = [];
		for (let i = 0; i < 2000; i++) {
			lines.push(`event: e${i}`, `data: ${i}`, "");
		}
		const payload = encoder.encode(`${lines.join("\n")}\n`);
		const oneByteChunks = Array.from(payload, byte => Uint8Array.of(byte));
		const stream = bytesStreamFromChunks(oneByteChunks);
		const start = performance.now();
		const events = await collectAsync(readSseEvents(stream));
		const elapsed = performance.now() - start;
		expect(events).toHaveLength(2000);
		expect(events[1999].event).toBe("e1999");
		expect(events[1999].data).toBe("1999");
		// Generous bound: the previous quadratic implementation needed >5s here.
		expect(elapsed).toBeLessThan(2000);
	});
});
