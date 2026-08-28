import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});

/**
 * Transcript = filler + target + tail. The target's first line is always
 * "TARGET BLOCK LINE" with optional extra lines; target sits above the
 * viewport when `tail` is tall.
 */
async function setup(fillerLines: number, tailLines: number, targetLines = 1) {
	const terminal = new VirtualTerminal(80, 32);
	const composer = new Composer({ preferences: COMPOSER_DEFAULTS, terminal });
	composer.start();
	const transcript = new TranscriptContainer();
	const filler = new Text(Array.from({ length: fillerLines }, (_, i) => `filler line ${i}`).join("\n"), 1, 0);
	const target = new Text(
		Array.from({ length: targetLines }, (_, i) => (i === 0 ? "TARGET BLOCK LINE" : `target line ${i}`)).join("\n"),
		1,
		0,
	);
	const tail = new Text(Array.from({ length: tailLines }, (_, i) => `tail line ${i}`).join("\n"), 1, 0);
	transcript.addChild(filler);
	transcript.addChild(target);
	transcript.addChild(tail);
	composer.setRuntimeChildren([transcript]);
	return { composer, target };
}

describe("Composer transcript reveal", () => {
	it("scrolls the viewport to a block that scrolled out of the recent output", async () => {
		const { composer, target } = await setup(5, 60);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 2" });
		const frame = composer.renderFrame({ columns: 80, rows: 32 });

		expect(frame.history).toBeUndefined();
		expect(composer.hasTranscriptReveal()).toBe(true);
		const viewport = frame.viewport.join("\n");
		expect(viewport).toContain("TARGET BLOCK LINE");
		expect(viewport).toContain("Copied code block 1 of 2 — press any key to return to the live view");
		expect(viewport).not.toContain("tail line 59"); // rows after the block are not written
		expect(frame.viewport.length).toBeLessThanOrEqual(32);
	});

	it("shows a short block whole, as low as possible (bottom-anchored)", async () => {
		const { composer, target } = await setup(5, 60, 1);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 2" });
		const frame = composer.renderFrame({ columns: 80, rows: 32 });

		const content = frame.viewport;
		const hintIndex = content.findIndex(row => row.includes("press any key to return"));
		expect(hintIndex).toBeGreaterThan(0);
		// The block's only row sits directly above the hint — as low as possible.
		expect(content[hintIndex - 1] ?? "").toContain("TARGET BLOCK LINE");
	});

	it("anchors a too-tall block's top at the top of the viewport", async () => {
		const { composer, target } = await setup(5, 60, 60);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 2" });
		const frame = composer.renderFrame({ columns: 80, rows: 32 });

		expect(frame.viewport[0] ?? "").toContain("TARGET BLOCK LINE");
		// The block's tail and the rows after it are not shown.
		expect(frame.viewport.join("\n")).not.toContain("target line 59");
		expect(frame.viewport.join("\n")).toContain("press any key to return to the live view");
	});

	it("keeps the peek when the block sits behind post-transcript chrome", () => {
		// Regression: the visibility test used the full terminal height, so a
		// block inside the transcript's last `after` rows was classified as
		// visible even though the editor/status below the transcript hide it.
		// 10-row frame, 5-row HUD after the transcript: the old test dropped
		// the peek (blockStart 5 >= full.length - 10), the fixed one reveals.
		const terminal = new VirtualTerminal(80, 10);
		const composer = new Composer({ preferences: COMPOSER_DEFAULTS, terminal });
		composer.start();
		const transcript = new TranscriptContainer();
		const filler = new Text(Array.from({ length: 5 }, (_, i) => `filler line ${i}`).join("\n"), 1, 0);
		const target = new Text("TARGET BLOCK LINE", 1, 0);
		const tail = new Text(Array.from({ length: 9 }, (_, i) => `tail line ${i}`).join("\n"), 1, 0);
		const hud = new Text(Array.from({ length: 5 }, (_, i) => `hud line ${i}`).join("\n"), 1, 0);
		transcript.addChild(filler);
		transcript.addChild(target);
		transcript.addChild(tail);
		composer.setRuntimeChildren([transcript, hud]);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 1" });
		const frame = composer.renderFrame({ columns: 80, rows: 10 });

		expect(composer.hasTranscriptReveal()).toBe(true);
		expect(frame.viewport.join("\n")).toContain("TARGET BLOCK LINE");
	});

	it("restores the live tail on dismiss", async () => {
		const { composer, target } = await setup(5, 60);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 2" });
		expect(composer.hasTranscriptReveal()).toBe(true);
		composer.setTranscriptReveal(undefined);
		expect(composer.hasTranscriptReveal()).toBe(false);
	});

	it("the reveal frame's last row is the hint", async () => {
		const { composer, target } = await setup(5, 60);

		composer.setTranscriptReveal({ component: target, label: "Copied code block 1 of 2" });
		const frame = composer.renderFrame({ columns: 80, rows: 32 });
		const last = frame.viewport[frame.viewport.length - 1] ?? "";
		expect(last).toContain("press any key to return to the live view");
	});
});
