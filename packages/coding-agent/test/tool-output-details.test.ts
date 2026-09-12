import { beforeAll, describe, expect, it } from "bun:test";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, requestComponentRender() {}, clearInlineImages() {} } as unknown as TUI;

function bashCard(command: string, output: string): ToolExecutionComponent {
	const card = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	card.updateResult({ content: [{ type: "text", text: output }], details: { exitCode: 0 } }, false);
	return card;
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

describe("tool output details", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("folds a settled card into its one-line call summary and back", () => {
		const card = bashCard("ls -la", "total 0\nfile-a\nfile-b\n");
		try {
			const full = plain(card.render(120));
			expect(full).toContain("ls -la");
			expect(full).toContain("file-a");

			card.setToolOutputDetailsHidden(true);
			const folded = card.render(120);
			expect(folded).toHaveLength(1);
			expect(plain(folded)).toContain("ls -la");
			expect(plain(folded)).not.toContain("file-a");

			card.setToolOutputDetailsHidden(false);
			const restored = plain(card.render(120));
			expect(restored).toContain("file-a");
		} finally {
			card.stopAnimation();
		}
	});

	it("folds cards that enter a container after the setting", () => {
		const container = new TranscriptContainer();
		container.setToolOutputDetailsHidden(true);
		const card = bashCard("ls -la", "file-a\n");
		try {
			container.addChild(card);
			expect(card.render(120)).toHaveLength(1);
		} finally {
			card.stopAnimation();
		}
	});

	it("folds cards already in the transcript", () => {
		const container = new TranscriptContainer();
		const card = bashCard("ls -la", "file-a\n");
		try {
			container.addChild(card);
			expect(card.render(120).length).toBeGreaterThan(1);

			container.setToolOutputDetailsHidden(true);
			expect(card.render(120)).toHaveLength(1);
		} finally {
			card.stopAnimation();
		}
	});

	it("drops read content previews but keeps the read rows", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "/tmp/example.ts" }, "read-0");
		group.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }] }, false, "read-0");

		const withPreview = plain(group.render(120));
		expect(withPreview).toContain("line 1");
		expect(withPreview).toContain("example.ts");

		group.setToolOutputDetailsHidden(true);
		const folded = plain(group.render(120));
		expect(folded).toContain("example.ts");
		expect(folded).not.toContain("line 1");
	});
});
