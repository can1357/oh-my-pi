import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";

/** Minimal transcript block whose finalized state is fixed at construction. */
class StubBlock implements Component {
	constructor(private readonly finalized: boolean) {}
	render(): string[] {
		return ["below"];
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

function successResult() {
	return { content: [{ type: "text", text: "x" }], isError: false };
}

describe("ReadToolGroupComponent transcript freezing", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		vi.restoreAllMocks();
	});

	afterAll(() => resetSettingsForTest());

	// Regression: a parallel sibling tool finalizes the read group (breaks the
	// run) and appends a block below it before the read's result lands. On
	// ED3-risk terminals the container froze the group at its pending preview, so
	// the late success result never repainted — the read stuck on "⏳ Read <path>".
	it("repaints a late read result instead of freezing the pending preview", () => {
		const tc = new TranscriptContainer();
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "/tmp/example.ts:280-345" }, "id1");
		tc.addChild(group);
		tc.render(120); // Frame 1: group is the live (pending) block.

		// Sibling tool starts: group is closed to new entries and a non-finalized
		// block is appended below it, all before the read result arrives.
		group.finalize();
		tc.addChild(new StubBlock(false));
		tc.render(120); // Frame 2: group would cross out of the live region.

		group.updateResult(successResult(), false, "id1"); // Late result.

		const out = Bun.stripANSI(tc.render(120).join("\n"));
		expect(out).toContain("Read /tmp/example.ts:280-345");
		expect(out).toContain(themeModule.theme.status.enabled);
		expect(out).not.toContain(themeModule.theme.status.pending);
	});

	// The finalization seam the TranscriptContainer keys off of.
	it("stays live until pending entries settle, then reports finalized", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "/tmp/a.ts" }, "id1");

		// Open run → never finalized.
		expect(group.isTranscriptBlockFinalized()).toBe(false);

		// Closed run but the read is still in flight → stay live so the result can
		// still repaint.
		group.finalize();
		expect(group.isTranscriptBlockFinalized()).toBe(false);

		// Result settled → safe to freeze.
		group.updateResult(successResult(), false, "id1");
		expect(group.isTranscriptBlockFinalized()).toBe(true);
	});

	// Turn-end safety: a read that never delivers a result (aborted turn) must not
	// pin the live region forever. seal() forces it terminal.
	it("seals a never-resolved pending read so it can freeze", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "/tmp/a.ts" }, "id1");
		group.finalize();
		expect(group.isTranscriptBlockFinalized()).toBe(false);

		group.seal();
		expect(group.isTranscriptBlockFinalized()).toBe(true);
	});
});
