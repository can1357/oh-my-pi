import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { splitReaction } from "@oh-my-pi/pi-coding-agent/modes/components/reaction";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";

const W = 60;

function msg(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function plain(component: { render(width: number): readonly string[] }): string {
	return Bun.stripANSI(component.render(W).join("\n"))
		.split("\n")
		.map(row => row.trim())
		.join("\n")
		.trim();
}

/** The user bubble's top padding row, ANSI stripped; the badge lands here. */
function bubbleTopRow(user: UserMessageComponent): string {
	return Bun.stripANSI(user.render(W)[0]!);
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("splitReaction", () => {
	it("lifts a lone emoji line and keeps a still-growing emoji pending", () => {
		expect(splitReaction("👍\nSure.")).toEqual({ emoji: "👍", body: "Sure.", pending: false });
		expect(splitReaction("👨‍👩‍👧‍👦 \n\nok")).toEqual({ emoji: "👨‍👩‍👧‍👦", body: "\nok", pending: false });
		expect(splitReaction("👍🏽")).toEqual({ body: "👍🏽", pending: true });
		expect(splitReaction("")).toEqual({ body: "", pending: true });
	});

	it("treats anything but one emoji on the first line as prose", () => {
		expect(splitReaction("👍 done\nmore")).toEqual({ body: "👍 done\nmore", pending: false });
		expect(splitReaction("🙂🙂\n")).toEqual({ body: "🙂🙂\n", pending: false });
		expect(splitReaction("Hello")).toEqual({ body: "Hello", pending: false });
		expect(splitReaction("1. First")).toEqual({ body: "1. First", pending: false });
	});
});

describe("agent reactions in the transcript", () => {
	it("withholds the opening emoji while streaming, then badges the user bubble and strips it from the reply", () => {
		const transcript = new Container();
		const user = new UserMessageComponent("ship it?");
		transcript.addChild(user);
		const reply = new AssistantMessageComponent();
		reply.pickReactionTarget(transcript.children);
		transcript.addChild(reply);

		reply.updateContent(msg("🚀"), { transient: true });
		expect(plain(reply)).toBe("");
		expect(bubbleTopRow(user)).not.toContain("🚀");

		reply.updateContent(msg("🚀\n"), { transient: true });
		expect(bubbleTopRow(user)).toEndWith("🚀 ");
		expect(plain(reply)).toBe("");

		reply.updateContent(msg("🚀\nShipping now."), { transient: true });
		expect(plain(reply)).toBe("Shipping now.");

		reply.updateContent(msg("🚀\nShipping now."));
		reply.markTranscriptBlockFinalized();
		expect(plain(reply)).toBe("Shipping now.");
		expect(bubbleTopRow(user)).toEndWith("🚀 ");
		expect(Bun.stringWidth(bubbleTopRow(user))).toBe(W);
	});

	it("releases withheld text unchanged once the first line proves to be prose", () => {
		const transcript = new Container();
		const user = new UserMessageComponent("hi");
		transcript.addChild(user);
		const reply = new AssistantMessageComponent();
		reply.pickReactionTarget(transcript.children);

		reply.updateContent(msg("👍"), { transient: true });
		expect(plain(reply)).toBe("");
		reply.updateContent(msg("👍 looks good"), { transient: true });
		expect(plain(reply)).toBe("👍 looks good");
		expect(bubbleTopRow(user)).not.toContain("👍");
	});

	it("shows a finalized lone emoji with no newline as text, not a reaction", () => {
		const transcript = new Container();
		transcript.addChild(new UserMessageComponent("hi"));
		const reply = new AssistantMessageComponent();
		reply.pickReactionTarget(transcript.children);
		reply.updateContent(msg("👍"));
		expect(plain(reply)).toBe("👍");
	});

	it("rebuilds the badge from persisted text and looks past turn attachments to the bubble", () => {
		const transcript = new Container();
		const user = new UserMessageComponent("see @file");
		transcript.addChild(user);
		transcript.addChild(new Text("file mention block"));
		const reply = new AssistantMessageComponent(msg("✅\nDone."));
		reply.pickReactionTarget(transcript.children);
		expect(bubbleTopRow(user)).toEndWith("✅ ");
		expect(plain(reply)).toBe("Done.");
	});

	it("never reacts past an earlier reply: a post-tool continuation keeps its emoji line verbatim", () => {
		const transcript = new Container();
		const user = new UserMessageComponent("run tests");
		transcript.addChild(user);
		transcript.addChild(new AssistantMessageComponent(msg("Running.")));
		transcript.addChild(new Text("tool card"));
		const continuation = new AssistantMessageComponent(msg("🎉\nAll green."));
		continuation.pickReactionTarget(transcript.children);
		expect(bubbleTopRow(user)).not.toContain("🎉");
		expect(plain(continuation)).toBe("🎉\nAll green.");
	});
});
