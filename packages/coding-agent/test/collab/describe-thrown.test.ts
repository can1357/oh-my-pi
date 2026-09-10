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
		const throwingGetter = new Error("ignored");
		Object.defineProperty(throwingGetter, "message", {
			get() {
				throw new Error("no");
			},
		});
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
			// A `message` getter that throws: read through, not around.
			throwingGetter,
			// A Proxy whose every trap throws, which is the general case of the above.
			new Proxy(
				{},
				{
					get() {
						throw new Error("no");
					},
					has() {
						throw new Error("no");
					},
				},
			),
		];
		for (const value of hostile) {
			expect(describeThrown(value, 512)).toBe("(unprintable error)");
		}
	});

	it("renders the primitives that do convert, rather than calling them unprintable", () => {
		// The fallback is for values that cannot be rendered, not for values that are
		// not strings — reporting `null` as unprintable would lose what was thrown.
		expect(describeThrown(null, 512)).toBe("null");
		expect(describeThrown(undefined, 512)).toBe("undefined");
		expect(describeThrown(42, 512)).toBe("42");
		expect(describeThrown(10n, 512)).toBe("10");
		expect(describeThrown(false, 512)).toBe("false");
		// `String(symbol)` is the explicit exception to symbol coercion and returns a
		// description; it is `${symbol}` that throws, which is why this uses the call.
		expect(describeThrown(Symbol("s"), 512)).toBe("Symbol(s)");
		// An empty conversion carries nothing, so it takes the fallback.
		expect(describeThrown("", 512)).toBe("(unprintable error)");
	});

	it("bounds a conversion that is not an Error at all", () => {
		// The Error path reads `message`; everything else goes through `String`, and
		// that output needs the same ceiling.
		const huge = { toString: () => "y".repeat(100_000) };
		const rendered = describeThrown(huge, 512);
		expect(rendered).toHaveLength(513);
		expect(rendered.endsWith("…")).toBe(true);
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
