import { describe, expect, it } from "bun:test";
import type { RawSseEvent } from "@oh-my-pi/pi-ai/types";
import { notifyRawSseEvent } from "@oh-my-pi/pi-ai/utils/sse-debug";

describe("notifyRawSseEvent", () => {
	it("dispatches diagnostic events without cloning raw lines", () => {
		const raw = ["event: message", "data: hello"];
		let observed: RawSseEvent | undefined;

		notifyRawSseEvent(
			event => {
				observed = event;
			},
			{ event: "message", data: "hello", raw },
		);

		expect(observed).toEqual({ event: "message", data: "hello", raw });
		expect(observed?.raw).toBe(raw);
	});

	it("keeps observer failures diagnostic-only", () => {
		expect(() =>
			notifyRawSseEvent(
				() => {
					throw new Error("observer failed");
				},
				{ event: "message", data: "hello", raw: ["event: message", "data: hello"] },
			),
		).not.toThrow();
	});

	it("is a no-op when no observer is installed", () => {
		expect(() => notifyRawSseEvent(undefined, { event: null, data: "{}", raw: ["data: {}"] })).not.toThrow();
	});
});
