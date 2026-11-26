import { describe, expect, it } from "bun:test";
import { jsx } from "@oh-my-pi/pi-tui";
import "../src/ui/styles/messages";
import { printRows } from "../src/ui/print-rows";
import { AsyncResult } from "../src/ui/transcript/messages/async-cards";
import type { FrameRenderer } from "../src/ui/transcript/messages/frame";

const BUILT_IN = "Background job completed";

function renderCard(renderer: FrameRenderer): string {
	const message = {
		role: "custom",
		customType: "async-result",
		content: "<system-notice>Background job bg_1 has completed.</system-notice>",
		display: true,
		timestamp: 0,
		details: {
			jobId: "bg_1",
			type: "bash",
			label: "npm test",
			durationMs: 1234,
		},
	} as Parameters<typeof AsyncResult>[0]["message"];
	return Bun.stripANSI(
		printRows(() => AsyncResult({ message, expanded: false, visible: true, renderer }), 120).join("\n"),
	);
}

describe("async-result message renderer (#14131)", () => {
	it("lets a registered renderer own the card", () => {
		const rendered = renderCard(() => jsx("text", { spans: [{ t: "EXTENSION CARD" }] }));
		expect(rendered).toContain("EXTENSION CARD");
		expect(rendered).not.toContain(BUILT_IN);
	});

	it("keeps the built-in card when the renderer throws", () => {
		const rendered = renderCard(() => {
			throw new Error("boom");
		});
		expect(rendered).toContain(BUILT_IN);
		expect(rendered).not.toContain("<system-notice>");
	});
});
