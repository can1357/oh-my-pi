/**
 * A read group stays live (unsettled, so the terminal keeps repainting it
 * instead of retiring it to scrollback) until the turn seals it: a parallel
 * sibling appended below it must not freeze it at its pending row before a
 * late read result lands.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isSettled, jsx } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

function successResult() {
	return { content: [{ type: "text", text: "x" }], isError: false };
}

describe("read group transcript settling", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => resetSettingsForTest());

	// Regression: a parallel sibling tool broke the read run and appended a block
	// below it before the read's result landed; the group froze at its pending
	// preview and the read stuck on "⏳ Read <path>".
	it("repaints a late read result after a sibling block lands below it", () => {
		const ctx = createInteractiveModeContext();
		const reads = ctx.presentReadGroup();
		reads.updateArgs({ path: "/tmp/example.ts:280-345" }, "id1");
		ctx.present(() => jsx("text", { spans: [{ t: "below" }] }), { live: true });

		reads.updateResult(successResult(), false, "id1");

		const out = renderTranscript(ctx).join("\n");
		expect(out).toContain("Read /tmp/example.ts:280-345");
		expect(out).toContain(currentTheme().symbols.symbol("status.success"));
		expect(out).not.toContain(currentTheme().symbols.symbol("status.pending"));
	});

	it("stays live while reads settle and settles once sealed", () => {
		const ctx = createInteractiveModeContext();
		const reads = ctx.presentReadGroup();
		reads.updateArgs({ path: "/tmp/a.ts" }, "id1");
		expect(isSettled(reads.block.node)).toBe(false);

		// A settled read does not close the group: a later read in the run may still join.
		reads.updateResult(successResult(), false, "id1");
		expect(isSettled(reads.block.node)).toBe(false);

		reads.seal();
		expect(isSettled(reads.block.node)).toBe(true);
	});

	// Turn-end safety: a read that never delivers a result (aborted turn) must not
	// pin the live region forever.
	it("seals a never-resolved pending read so it can settle", () => {
		const ctx = createInteractiveModeContext();
		const reads = ctx.presentReadGroup();
		reads.updateArgs({ path: "/tmp/a.ts" }, "id1");
		expect(isSettled(reads.block.node)).toBe(false);

		reads.seal();
		expect(isSettled(reads.block.node)).toBe(true);
	});
});
