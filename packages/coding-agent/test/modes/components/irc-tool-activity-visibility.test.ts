import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => initTheme());

const messages: CustomMessage[] = [
	{
		role: "custom",
		customType: "irc:incoming",
		content: "incoming coordination",
		details: { from: "Scout", message: "incoming coordination" },
		display: true,
		timestamp: 1,
	},
	{
		role: "custom",
		customType: "irc:autoreply",
		content: "automatic coordination",
		details: { to: "Scout", body: "automatic coordination" },
		display: true,
		timestamp: 2,
	},
	{
		role: "custom",
		customType: "irc:relay",
		content: "relayed coordination",
		details: { from: "Scout", to: "Builder", body: "relayed coordination" },
		display: true,
		timestamp: 3,
	},
	{
		role: "custom",
		customType: "irc:workpool",
		content: "pooled coordination",
		details: { pool: "Review", to: "Builder", mode: "dispatch", body: "pooled coordination" },
		display: true,
		timestamp: 4,
	},
];

const bodies = messages.map(message => message.content as string);

function expectCoordination(text: string, visible: boolean): void {
	for (const body of bodies) {
		if (visible) expect(text).toContain(body);
		else expect(text).not.toContain(body);
	}
}

describe("IRC tool activity visibility", () => {
	it("hides live cards, including arrivals while hidden, without hiding conversation", async () => {
		const ctx = createInteractiveModeContext({ settings: Settings.isolated() });
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
		const controller = new EventController(ctx);
		const render = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		ctx.chatContainer.addChild(new Text("Conversation remains visible", 0, 0));
		try {
			await controller.handleEvent({ type: "irc_message", message: messages[0]! });
			expect(render()).toContain(bodies[0]!);
			ctx.chatContainer.setToolActivityVisible(false);
			for (const message of messages.slice(1)) await controller.handleEvent({ type: "irc_message", message });
			expectCoordination(render(), false);
			expect(render()).toContain("Conversation remains visible");
			ctx.chatContainer.setToolActivityVisible(true);
			expectCoordination(render(), true);
		} finally {
			controller.dispose();
			ctx.chatContainer.dispose();
		}
	});

	it("replays stored IRC cards hidden and reveals them on toggle", () => {
		const entries: TranscriptEntryLike[] = messages.map((message, index) => ({
			type: "custom_message",
			id: String(index),
			parentId: index === 0 ? null : String(index - 1),
			timestamp: new Date(message.timestamp).toISOString(),
			customType: message.customType,
			content: message.content,
			details: message.details,
			display: true,
		}));
		const builder = new ChatTranscriptBuilder({
			ui: new TUI(new VirtualTerminal()),
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const render = () => Bun.stripANSI(builder.container.render(120).join("\n"));
		try {
			builder.container.setToolActivityVisible(false);
			builder.rebuild(entries.slice(0, 2));
			builder.append(entries.slice(2));
			expect(render()).toBe("");
			builder.container.setToolActivityVisible(true);
			expectCoordination(render(), true);
		} finally {
			builder.dispose();
		}
	});
});
