import { describe, expect, it } from "bun:test";
import { applyExtensionFlags, type ExtensionFlagSink } from "../src/cli/extension-flags";

class FakeExtensionFlagSink implements ExtensionFlagSink {
	#values = new Map<string, boolean | string>();

	get values(): ReadonlyMap<string, boolean | string> {
		return this.#values;
	}

	getFlags(): Map<string, { type: "boolean" | "string" }> {
		return new Map<string, { type: "boolean" | "string" }>([
			["foo", { type: "boolean" }],
			["bar", { type: "string" }],
		]);
	}

	getToolNames(): readonly string[] {
		return [];
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.#values.set(name, value);
	}
}

describe("extension flag dispatch", () => {
	it("stops scanning raw argv at the end-of-options marker", () => {
		const sink = new FakeExtensionFlagSink();

		const args = applyExtensionFlags(sink, ["--", "--foo", "bar"]);

		expect(sink.values.size).toBe(0);
		expect(args?.messages).toEqual(["--foo", "bar"]);
	});

	it("keeps -- as end-of-options after a string extension flag", () => {
		const sink = new FakeExtensionFlagSink();

		const args = applyExtensionFlags(sink, ["--bar", "--", "--foo", "bar"]);

		expect(sink.values.has("bar")).toBe(false);
		expect(sink.values.size).toBe(0);
		expect(args?.messages).toEqual(["--foo", "bar"]);
	});
});
