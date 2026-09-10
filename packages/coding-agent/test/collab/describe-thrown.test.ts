import { describe, expect, it } from "bun:test";
import { describeThrown } from "@oh-my-pi/pi-coding-agent/collab/protocol";

describe("describeThrown", () => {
	it("renders a value nobody vouched for without throwing", () => {
		// Every one of these throws out of a bare `String()`, and the first three are
		// what a rejected promise can carry into a catch that only meant to log.
		let nested: unknown[] = [];
		const root = nested;
		for (let i = 0; i < 5_000; i++) {
			const next: unknown[] = [];
			nested.push(next);
			nested = next;
		}
		const hostile: unknown[] = [
			root,
			{
				toString() {
					throw new Error("no");
				},
			},
			{
				toString() {
					return {};
				},
				valueOf() {
					throw new Error("no");
				},
			},
		];
		for (const value of hostile) {
			expect(describeThrown(value, 512)).toBe("(unprintable error)");
		}
	});

	it("bounds what it renders and keeps an Error's own text", () => {
		expect(describeThrown(new Error("plain"), 512)).toBe("plain");
		// Read through `message`, so a hostile `toString` on the Error is never run.
		const trap = new Error("safe text");
		trap.toString = () => {
			throw new Error("never");
		};
		expect(describeThrown(trap, 512)).toBe("safe text");
		const huge = new Error("x".repeat(100_000));
		expect(describeThrown(huge, 512)).toHaveLength(513);
		expect(describeThrown(huge, 512).endsWith("…")).toBe(true);
		// A message that is not a string has nothing to render.
		const odd = new Error("ignored");
		(odd as unknown as { message: unknown }).message = {};
		expect(describeThrown(odd, 512)).toBe("(unprintable error)");
	});
});
