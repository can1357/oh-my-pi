import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import { ToolAbortError, throwIfAborted } from "../../src/tools/tool-errors";

describe("tool abort errors", () => {
	it("wraps non-ToolAbortError abort reasons as ToolAbortError while preserving marked cause chains", () => {
		const controller = new AbortController();
		const reason = postmortem.markExpectedCleanupError(new Error("browser run ended"));
		controller.abort(reason);

		let caught: unknown;
		try {
			throwIfAborted(controller.signal);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ToolAbortError);
		expect((caught as Error).cause).toBe(reason);
		expect(postmortem.isExpectedCleanupError(caught)).toBe(true);
	});
});
