import { describe, expect, it } from "bun:test";
import { BoundedJsonReadError, readBoundedBody, readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";

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
	it("keeps exactly the head up to the cap and reports whether the body continued", async () => {
		const head = await readBoundedBody(chunked(["abc", "", "defg", "hij"]), 5);
		expect(new TextDecoder().decode(head?.bytes)).toBe("abcde");
		expect(head?.truncated).toBe(true);
		const whole = await readBoundedBody(chunked(["abc", "de"]), 5);
		expect(new TextDecoder().decode(whole?.bytes)).toBe("abcde");
		expect(whole?.truncated).toBe(false);
	});

	it("rejects oversized JSON, cancelling the body when Content-Length already exceeds the cap", async () => {
		const streamed = await readBoundedJson(chunked(['{"a":', '"bcdef"}']), 5).catch(caught => caught);
		expect((streamed as BoundedJsonReadError).kind).toBe("size");

		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { headers: { "content-length": "1000" } });
		const error = await readBoundedJson(response, 5).catch(caught => caught);
		expect(error).toBeInstanceOf(BoundedJsonReadError);
		expect((error as BoundedJsonReadError).kind).toBe("size");
		expect(cancelled).toBe(true);
	});

	it("stops waiting on a stalled body once the signal aborts", async () => {
		const controller = new AbortController();
		const read = readBoundedBody(chunked(["partial"], { close: false }), 64, { signal: controller.signal });
		controller.abort(new Error("deadline"));
		await expect(read).rejects.toThrow("deadline");
	});
});
