import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { MessageRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const BUILT_IN = "Background job completed";

function renderReplay(renderer: MessageRenderer): string {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: process.cwd(),
		requestRender: vi.fn(),
		getMessageRenderer: () => renderer,
	});
	const message = {
		role: "custom",
		customType: "async-result",
		content: "<system-notice>Background job bg_1 has completed.</system-notice>",
		display: true,
		details: { jobId: "bg_1", type: "bash", label: "npm test", durationMs: 1234 },
	} as unknown as AgentMessage;
	builder.rebuild([
		{ type: "message", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), message } as never,
	]);
	return builder.container.children.map(child => child.render(120).join("\n")).join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("async-result message renderer (#14131)", () => {
	it("lets a registered renderer own the card", () => {
		const rendered = renderReplay(() => new Text("EXTENSION CARD"));
		expect(rendered).toContain("EXTENSION CARD");
		expect(rendered).not.toContain(BUILT_IN);
	});

	it("keeps the built-in card when the renderer throws", () => {
		const rendered = renderReplay(() => {
			throw new Error("boom");
		});
		expect(rendered).toContain(BUILT_IN);
		expect(rendered).not.toContain("<system-notice>");
	});
});
