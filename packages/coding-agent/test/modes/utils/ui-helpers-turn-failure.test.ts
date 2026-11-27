import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});
describe("UiHelpers.showError turn failure", () => {
	it("registers a failsTurn error notice as a failure entry", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showError("Retry failed after 3 attempts: overloaded", { failsTurn: true });

		const block = ctx.shell.transcript.blocks().at(-1);
		expect(block).toBeDefined();
		expect(ctx.transcriptEntry(block!)).toEqual({ kind: "failure" });
	});

	it("leaves turn outcomes alone for a plain error", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showError("Plan file not found");

		const blocks = ctx.shell.transcript.blocks();
		expect(blocks).toHaveLength(1);
		expect(ctx.transcriptEntry(blocks[0]!)).toBeUndefined();
	});
});
