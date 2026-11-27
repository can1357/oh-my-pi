import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantView, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { splitReaction } from "@oh-my-pi/pi-coding-agent/session/transcript/reaction";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { blockText } from "../../helpers/transcript-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

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

function user(text: string, extra: Record<string, unknown> = {}): AgentMessage {
	return { role: "user", content: text, timestamp: 0, ...extra } as AgentMessage;
}

/** A transcript over a fixture context: messages drawn by the real presenter. */
function transcript(): {
	ctx: InteractiveModeContext;
	rows(): string[];
	/** The user bubble's top padding row (where the badge lands). */
	bubbleTop(): string;
	reply(view: AssistantView): string;
} {
	const ctx = createInteractiveModeContext({ settings: Settings.isolated() });
	const rows = () => renderTranscript(ctx, W);
	return {
		ctx,
		rows,
		bubbleTop: () => rows()[0] ?? "",
		reply: view => blockText(view.block, W).trim(),
	};
}

describe("splitReaction", () => {
	it("lifts an opening emoji and consumes following whitespace", () => {
		expect(splitReaction("👍\nSure.")).toEqual({ emoji: "👍", body: "Sure.", pending: false });
		expect(splitReaction("👍 Sure.")).toEqual({ emoji: "👍", body: "Sure.", pending: false });
		expect(splitReaction("👍   Sure.")).toEqual({ emoji: "👍", body: "Sure.", pending: false });
		expect(splitReaction("👍Sure.")).toEqual({ emoji: "👍", body: "Sure.", pending: false });
		expect(splitReaction("👨‍👩‍👧‍👦 \n\nok")).toEqual({ emoji: "👨‍👩‍👧‍👦", body: "\nok", pending: false });
		expect(splitReaction("👍🏽")).toEqual({ emoji: "👍🏽", body: "", pending: false });
		expect(splitReaction("👍 done\nmore")).toEqual({ emoji: "👍", body: "done\nmore", pending: false });
		expect(splitReaction("🙂🙂\n")).toEqual({ emoji: "🙂", body: "🙂\n", pending: false });
		expect(splitReaction("")).toEqual({ body: "", pending: true });
		expect(splitReaction("   ")).toEqual({ body: "   ", pending: true });
		expect(splitReaction("🇺")).toEqual({ body: "🇺", pending: true });
		expect(splitReaction("👨\u200D")).toEqual({ body: "👨\u200D", pending: true });
	});

	it("treats non-emoji text as prose", () => {
		expect(splitReaction("Hello")).toEqual({ body: "Hello", pending: false });
		expect(splitReaction("1. First")).toEqual({ body: "1. First", pending: false });
	});
});

describe("agent reactions in the transcript", () => {
	it("badges the user bubble on the opening emoji and strips it from the reply", () => {
		const t = transcript();
		t.ctx.presentMessage(user("ship it?"));
		const reply = t.ctx.presentAssistant();
		reply.transient.set(true);

		reply.message.set(msg("🚀"));
		expect(t.reply(reply)).toBe("");
		expect(t.bubbleTop()).toEndWith("🚀");

		reply.message.set(msg("🚀 Shipping now."));
		expect(t.reply(reply)).toBe("Shipping now.");
		expect(t.bubbleTop()).toEndWith("🚀");

		reply.transient.set(false);
		reply.finalized.set(true);
		expect(t.reply(reply)).toBe("Shipping now.");
		expect(t.bubbleTop()).toEndWith("🚀");
	});

	it("withholds incomplete emoji sequences while streaming", () => {
		const t = transcript();
		t.ctx.presentMessage(user("hi"));
		const reply = t.ctx.presentAssistant();
		reply.transient.set(true);

		reply.message.set(msg("🇺"));
		expect(t.reply(reply)).toBe("");
		expect(t.bubbleTop()).not.toContain("🇺");

		reply.message.set(msg("🇺🇸 sounds good"));
		expect(t.reply(reply)).toBe("sounds good");
		expect(t.bubbleTop()).toEndWith("🇺🇸");
	});

	it("badges a finalized lone emoji with no newline and strips it from the reply", () => {
		const t = transcript();
		t.ctx.presentMessage(user("hi"));
		const reply = t.ctx.presentAssistant(msg("👍"));
		expect(t.reply(reply)).toBe("");
		expect(t.bubbleTop()).toEndWith("👍");
	});

	it("rebuilds the badge from persisted text and looks past turn attachments to the bubble", () => {
		const t = transcript();
		t.ctx.presentMessage(user("see @file"));
		t.ctx.present(() => jsx("text", { text: "file mention block" }));
		const reply = t.ctx.presentAssistant(msg("✅ Done."));
		expect(t.bubbleTop()).toEndWith("✅");
		expect(t.reply(reply)).toBe("Done.");
	});

	it("never reacts past an earlier reply: a post-tool continuation keeps its emoji verbatim", () => {
		const t = transcript();
		t.ctx.presentMessage(user("run tests"));
		t.ctx.presentAssistant(msg("Running."));
		t.ctx.present(() => jsx("text", { text: "tool card" }));
		const continuation = t.ctx.presentAssistant(msg("🎉 All green."));
		expect(t.bubbleTop()).not.toContain("🎉");
		expect(t.reply(continuation)).toBe("🎉 All green.");
	});
});
