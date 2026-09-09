import { describe, expect, it } from "bun:test";
import { Ellipsis, truncateToWidth } from "@oh-my-pi/pi-tui/utils";

// Regression test for https://github.com/can1357/oh-my-pi/issues/848
//
// On Windows, rendering a saved write tool record crashed with:
//   Error: Failed to convert napi value Null into rust type `u8`
//       at truncateToWidth (unknown)
//       at renderContentPreview (...)
// and the related variant "Failed to convert napi value into rust type `bool`"
// at the same call site.
//
// Root cause: the `truncateToWidth` JS wrapper coerced optional ellipsis/pad
// arguments to literal `null` (`?? null`) before forwarding to the napi
// binding. napi-rs 3 accepts that on Linux/macOS but rejects it on the
// Windows prebuilt: the null hits the underlying `u8` (Ellipsis enum) /
// `bool` (pad) conversions instead of the `Option<T>` short-circuit. The
// wrapper must pass concrete defaults (matching the Rust `unwrap_or`s) so it
// never depends on the platform's null-handling for `Option<T>`. Likewise,
// `maxWidth` must not silently forward `null`/`undefined` into the required
// `u32` parameter — the wrapper must clamp it to a sane non-negative integer.
describe("issue #848: truncateToWidth wrapper rejects nullish napi inputs", () => {
	it("returns a string when ellipsisKind / pad are null", () => {
		const result = truncateToWidth("hello world", 80, null, null);
		expect(typeof result).toBe("string");
		expect(result).toBe("hello world");
	});

	it("maps a legacy empty-string ellipsis argument to omit ellipsis", () => {
		const result = truncateToWidth("hello world", 5, "" as unknown as Parameters<typeof truncateToWidth>[2]);
		expect(result).toBe("hello");
	});
	it("returns a string when ellipsisKind / pad are undefined", () => {
		const result = truncateToWidth("hello world", 80, undefined, undefined);
		expect(typeof result).toBe("string");
		expect(result).toBe("hello world");
	});

	it("does not throw a napi conversion error when maxWidth is null", () => {
		// Matches the resumed-render code path on Windows where a width derived
		// from terminal state can briefly be null/undefined. The wrapper must
		// degrade to an empty truncation rather than blowing up the renderer.
		const result = truncateToWidth("hello world", null as unknown as number, Ellipsis.Omit, null);
		expect(typeof result).toBe("string");
	});

	it("does not throw a napi conversion error when maxWidth is undefined", () => {
		const result = truncateToWidth("hello world", undefined as unknown as number, Ellipsis.Omit, null);
		expect(typeof result).toBe("string");
	});
});
