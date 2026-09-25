import { describe, expect, it } from "bun:test";
import * as PiCodingAgent from "@oh-my-pi/pi-coding-agent";
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";

/**
 * Issue #12680: 0d6dbd32 moved the ask renderer into @oh-my-pi/pi-tui, so
 * extensions that shadow the built-in ask tool can no longer reach the native
 * renderer through the injected pi.pi namespace. Extensions receive the root
 * barrel of this package as pi.pi, so this pins the re-export there.
 */
describe("askToolRenderer reachability from extensions (issue #12680)", () => {
	const namespace = PiCodingAgent as Record<string, unknown>;

	it("re-exports the ask renderer from the root barrel", () => {
		expect(namespace.askToolRenderer).toBe(askToolRenderer);
	});

	it("carries the render surface shadow-ask extensions consumed before the pi-tui migration", () => {
		const renderer = namespace.askToolRenderer as typeof askToolRenderer | undefined;
		expect(renderer).toBeDefined();
		expect(typeof renderer?.renderCall).toBe("function");
		expect(typeof renderer?.renderResult).toBe("function");
		expect(renderer?.mergeCallAndResult).toBe(true);
	});
});
