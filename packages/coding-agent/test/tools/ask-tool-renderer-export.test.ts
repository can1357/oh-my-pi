import { describe, expect, it } from "bun:test";
import * as PiCodingAgent from "@oh-my-pi/pi-coding-agent";
import { askPresenter } from "../../src/ui/tools/ask";

/**
 * Issue #12680: extensions that shadow the built-in ask tool reach the
 * built-in ask presenter through the injected pi.pi namespace. Extensions
 * receive the root barrel of this package as pi.pi, so this pins the
 * re-export there.
 */
describe("askPresenter reachability from extensions (issue #12680)", () => {
	const namespace = PiCodingAgent as Record<string, unknown>;

	it("re-exports the ask presenter from the root barrel", () => {
		expect(namespace.askPresenter).toBe(askPresenter);
	});
});
