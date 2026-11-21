import { beforeAll, describe, expect, it } from "bun:test";
import { ReplyWriteComponent } from "@oh-my-pi/pi-tui/chat/reply-write";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function text(component: { render(width: number): readonly string[] }): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("ReplyWriteComponent", () => {
	it("draws streamed reply text as prose that grows with the args and seals with the result", () => {
		const reply = new ReplyWriteComponent();
		reply.updateArgs({ path: "out://", content: "Short answer: **yes**" });
		expect(text(reply)).toContain("Short answer: yes");
		expect(text(reply)).not.toContain("**");

		reply.updateArgs({ path: "out://", content: "Short answer: **yes**, the build passed." });
		reply.setArgsComplete();
		reply.updateResult({ content: [{ type: "text", text: "Shown to the user." }] });
		expect(text(reply)).toContain("the build passed.");
		// The model-facing result is not part of the reply.
		expect(text(reply)).not.toContain("Shown to the user.");
		expect(reply.isTranscriptBlockFinalized()).toBe(true);

		// Sealed history never changes.
		reply.updateArgs({ path: "out://", content: "rewritten" });
		expect(text(reply)).toContain("the build passed.");
	});

	it("shows a failed delivery's error under the reply text", () => {
		const reply = new ReplyWriteComponent();
		reply.updateArgs({ path: "out://", content: "Progress: 3/5 done" });
		reply.updateResult({ content: [{ type: "text", text: "out:// is disabled" }], isError: true });
		const output = text(reply);
		expect(output).toContain("Progress: 3/5 done");
		expect(output).toContain("out:// is disabled");
		expect(output.indexOf("Progress")).toBeLessThan(output.indexOf("out:// is disabled"));
	});

	it("stays on screen when the transcript hides tool activity", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		const reply = new ReplyWriteComponent();
		reply.updateArgs({ path: "out://", content: "Answer to your question" });
		container.addChild(reply);
		expect(text(container)).toContain("Answer to your question");
	});
});
