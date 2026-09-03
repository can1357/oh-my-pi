/**
 * Contract: a turn ending in a provider error surfaces one warn-level log
 * carrying `provider`/`model`/`errorMessage`/`errorStatus`/`errorId`, so
 * recurring provider stream failures are diagnosable from the main log alone
 * (issue #6177). Non-error stops must not emit it.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { logProviderTurnError } from "../../src/session/messages";

function makeMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor",
		provider: "cursor",
		model: "composer-2.5",
		usage: {} as AssistantMessage["usage"],
		stopReason: "error",
		timestamp: 1,
		...overrides,
	};
}

describe("logProviderTurnError", () => {
	const events: logger.LogEvent[] = [];
	const dispose = logger.registerLogSink(event => events.push(event));

	afterEach(() => {
		events.length = 0;
	});
	afterAll(() => dispose());

	it("emits a warn log with the provider error fields for stopReason:error", () => {
		logProviderTurnError(
			makeMessage({
				errorMessage: "stream stall: idle watchdog fired",
				errorStatus: 500,
				errorId: 42,
			}),
		);

		const warn = events.find(e => e.level === "warn" && e.message === "agent turn ended with provider error");
		expect(warn).toBeDefined();
		expect(warn?.context).toMatchObject({
			provider: "cursor",
			model: "composer-2.5",
			errorMessage: "stream stall: idle watchdog fired",
			errorStatus: 500,
			errorId: 42,
		});
	});

	it("does not emit for a successful stop", () => {
		logProviderTurnError(makeMessage({ stopReason: "stop", errorMessage: undefined }));
		expect(events.some(e => e.message === "agent turn ended with provider error")).toBe(false);
	});
});
