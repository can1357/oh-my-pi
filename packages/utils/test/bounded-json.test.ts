import { describe, expect, it } from "bun:test";
import { BoundedJsonReadError, readBoundedBytes } from "@oh-my-pi/pi-utils/bounded-json";

function chunked(chunks: string[], { close = true } = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (close) controller.close();
		},
	});
	return new Response(body);
}

describe("bounded body reads", () => {
	it("keeps exactly the head up to the cap when truncating, and rejects an oversized body otherwise", async () => {
		const head = await readBoundedBytes(chunked(["abc", "", "defg", "hij"]), 5, { truncate: true });
		expect(new TextDecoder().decode(head)).toBe("abcde");
		const whole = await readBoundedBytes(chunked(["abc", "de"]), 5);
		expect(new TextDecoder().decode(whole)).toBe("abcde");

		const error = await readBoundedBytes(chunked(["abc", "def"]), 5).catch(caught => caught);
		expect(error).toBeInstanceOf(BoundedJsonReadError);
		expect((error as BoundedJsonReadError).kind).toBe("size");
	});

	it("cancels the body when Content-Length already exceeds the cap", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { headers: { "content-length": "1000" } });
		const error = await readBoundedBytes(response, 5).catch(caught => caught);
		expect((error as BoundedJsonReadError).kind).toBe("size");
		expect(cancelled).toBe(true);
	});

	it("stops waiting on a stalled body once the signal aborts", async () => {
		const controller = new AbortController();
		const read = readBoundedBytes(chunked(["partial"], { close: false }), 64, { signal: controller.signal });
		controller.abort(new Error("deadline"));
		await expect(read).rejects.toThrow("deadline");
	});
});
