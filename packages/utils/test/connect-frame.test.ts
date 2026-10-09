import { describe, expect, test } from "bun:test";
import { frameConnectPayload, readConnectFrames } from "../src/connect-frame";

describe("Connect envelope streaming", () => {
	test("yields the first envelope while the source is still open and cancels on early return", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				value.enqueue(frameConnectPayload(Buffer.from("first")));
			},
			cancel() {
				cancelled = true;
			},
		});
		const iterator = readConnectFrames(source);
		expect((await iterator.next()).value?.payload.toString()).toBe("first");
		controller!.enqueue(frameConnectPayload(Buffer.from("second")));
		expect((await iterator.next()).value?.payload.toString()).toBe("second");
		await iterator.return(undefined);
		expect(cancelled).toBe(true);
	});

	test("reassembles split headers/payloads without duplicating the trailer", async () => {
		const bytes = Buffer.concat([
			frameConnectPayload(Buffer.from("hello")),
			frameConnectPayload(Buffer.from("{}"), 2),
		]);
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.subarray(i, i + 2));
				controller.close();
			},
		});
		const frames = [];
		for await (const frame of readConnectFrames(source)) frames.push([frame.flags, frame.payload.toString()]);
		expect(frames).toEqual([
			[0, "hello"],
			[2, "{}"],
		]);
	});

	test("rejects a truncated envelope rather than accepting a partial response", async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frameConnectPayload(Buffer.from("hello")).subarray(0, 8));
				controller.close();
			},
		});
		const iterator = readConnectFrames(source);
		await expect(iterator.next()).rejects.toThrow("truncated envelope");
	});

	test("rejects an excessive length from the header before reading its payload", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				const header = Buffer.alloc(5);
				header.writeUInt32BE(100, 1);
				controller.enqueue(header);
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readConnectFrames(source, 10).next()).rejects.toThrow("size limit");
		expect(cancelled).toBe(true);
	});
});
