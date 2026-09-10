import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantTextDecorator } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { splitAssistantMessageToolTimeline } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";

const W = 100;
const ESC = "\u001b";
const NUL = "\u0000";
const TAB = "\t";

function msg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

/** Record every token handed to `decorate`, passing the prose through unchanged. */
function recordingDecorator(): { decorator: AssistantTextDecorator; seen: Array<{ text: string; index: number }> } {
	const seen: Array<{ text: string; index: number }> = [];
	return {
		seen,
		decorator: {
			decorate(text, context) {
				seen.push({ text, index: context.contentIndex });
				return text;
			},
		},
	};
}

function component(
	message: AssistantMessage | undefined,
	decorators: AssistantTextDecorator[],
	contentIndexOffset = 0,
): AssistantMessageComponent {
	return new AssistantMessageComponent(
		message,
		false,
		undefined,
		[],
		undefined,
		true,
		undefined,
		decorators,
		contentIndexOffset,
	);
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

describe("assistant text decorators", () => {
	describe("input contract", () => {
		it("passes plain prose even when the live transcript paints assistant text", () => {
			const { decorator, seen } = recordingDecorator();
			const comp = component(undefined, [decorator]);
			// The live transcript installs an SGR foreground transform on the same
			// Markdown; decoration must still see the author's words, and Markdown's
			// own style probe (a NUL sentinel) must never reach a decorator either.
			comp.setTextColorTransform(text => `${ESC}[38;5;42m${text}${ESC}[39m`);
			comp.updateContent(msg([{ type: "text", text: "read this safely" }]));
			const rendered = comp.render(W).join("\n");

			expect(seen.length).toBeGreaterThan(0);
			for (const { text } of seen) {
				expect(text).not.toContain(ESC);
				expect(text).not.toContain(NUL);
			}
			expect(seen.some(entry => entry.text.includes("read this safely"))).toBe(true);
			// The color transform still paints the decorated result.
			expect(rendered).toContain(`${ESC}[38;5;42m`);
		});

		it("never hands code spans or fenced code to a decorator", () => {
			const { decorator, seen } = recordingDecorator();
			const text = "call `configure(x)` first\n\n```ts\nconst secret = 1;\n```\n\nthen ship";
			const comp = component(msg([{ type: "text", text }]), [decorator]);
			const rendered = Bun.stripANSI(comp.render(W).join("\n"));

			const inputs = seen.map(entry => entry.text).join("");
			expect(inputs).not.toContain("configure(x)");
			expect(inputs).not.toContain("const secret = 1;");
			expect(inputs).toContain("call ");
			// Code survives verbatim in the output.
			expect(rendered).toContain("configure(x)");
			expect(rendered).toContain("const secret = 1;");
		});

		it("reports the original content index for post-tool segments", () => {
			const message = msg([
				{ type: "text", text: "starting now" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				{ type: "text", text: "finished cleanly" },
			]);
			const timeline = splitAssistantMessageToolTimeline(message);
			const segment = timeline.afterToolCalls.get("call_1");
			expect(segment?.contentOffset).toBe(2);

			const before = recordingDecorator();
			component(timeline.beforeTools, [before.decorator]).render(W);
			expect(before.seen.length).toBeGreaterThan(0);
			expect(before.seen.every(entry => entry.index === 0)).toBe(true);

			const after = recordingDecorator();
			component(segment?.message, [after.decorator], segment?.contentOffset).render(W);
			expect(after.seen.length).toBeGreaterThan(0);
			expect(after.seen.every(entry => entry.index === 2)).toBe(true);
		});

		it("keeps offsets stable across back-to-back tool calls", () => {
			const message = msg([
				{ type: "toolCall", id: "a", name: "bash", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
				{ type: "text", text: "tail text" },
			]);
			const timeline = splitAssistantMessageToolTimeline(message);
			expect(timeline.afterToolCalls.get("a")).toBeUndefined();
			expect(timeline.afterToolCalls.get("b")?.contentOffset).toBe(2);
		});
	});

	describe("output sanitization", () => {
		it("normalizes tabs a decorator introduces", () => {
			const comp = component(msg([{ type: "text", text: "before after" }]), [
				{ decorate: text => text.replace(" ", `${TAB}gap${TAB}`) },
			]);
			const rendered = comp.render(W).join("\n");

			expect(rendered).not.toContain(TAB);
			expect(Bun.stripANSI(rendered)).toContain("gap");
		});

		it("survives hostile decorator output", () => {
			const cases: Array<(text: string) => string> = [
				() => "",
				text => text.repeat(200),
				() => "unicode: \u{1F642}́ ünïcödé",
				text => `${text}\n\ninjected`,
				() => NUL,
			];
			for (const decorate of cases) {
				const comp = component(msg([{ type: "text", text: "stay alive" }]), [{ decorate }]);
				expect(() => comp.render(W)).not.toThrow();
			}
		});
	});

	describe("failure isolation", () => {
		it("renders the original prose when decorate throws", () => {
			const comp = component(msg([{ type: "text", text: "original prose" }]), [
				{
					decorate() {
						throw new Error("extension bug");
					},
				},
			]);

			expect(Bun.stripANSI(comp.render(W).join("\n"))).toContain("original prose");
		});

		it("keeps the surviving links when one decorator throws mid-chain", () => {
			const comp = component(msg([{ type: "text", text: "chain" }]), [
				{ decorate: text => `[${text}]` },
				{
					decorate() {
						throw new Error("second decorator bug");
					},
				},
				{ decorate: text => `${text}!` },
			]);

			expect(Bun.stripANSI(comp.render(W).join("\n"))).toContain("[chain]!");
		});

		it("does not abort construction when onDidChange throws", () => {
			let healthyListenerRegistered = false;
			let comp: AssistantMessageComponent | undefined;

			expect(() => {
				comp = component(msg([{ type: "text", text: "still visible" }]), [
					{
						decorate: text => text,
						onDidChange() {
							throw new Error("subscription bug");
						},
					},
					{
						decorate: text => text,
						onDidChange() {
							healthyListenerRegistered = true;
							return () => {};
						},
					},
				]);
			}).not.toThrow();

			expect(healthyListenerRegistered).toBe(true);
			expect(Bun.stripANSI(comp?.render(W).join("\n") ?? "")).toContain("still visible");
		});

		it("runs every unsubscriber even when one throws", () => {
			let secondUnsubscribed = false;
			const comp = component(msg([{ type: "text", text: "disposable" }]), [
				{
					decorate: text => text,
					onDidChange: () => () => {
						throw new Error("unsubscribe bug");
					},
				},
				{
					decorate: text => text,
					onDidChange: () => () => {
						secondUnsubscribed = true;
					},
				},
			]);

			expect(() => comp.dispose()).not.toThrow();
			expect(secondUnsubscribed).toBe(true);
		});
	});

	describe("streaming state", () => {
		it("repaints every prose block when the turn stops streaming", () => {
			const content: AssistantMessage["content"] = [
				{ type: "text", text: "first block" },
				{ type: "text", text: "second block" },
			];
			const comp = component(undefined, [
				{ decorate: (text, { transient }) => (transient ? `~${text}~` : `=${text}=`) },
			]);

			comp.updateContent(msg(content), { transient: true });
			const streaming = Bun.stripANSI(comp.render(W).join("\n"));
			expect(streaming).toContain("~first block~");
			expect(streaming).toContain("~second block~");

			// Source text is unchanged at finalize — only the transient flag flips,
			// so a cached earlier block would keep its streaming presentation.
			comp.updateContent(msg(content), { transient: false });
			const settled = Bun.stripANSI(comp.render(W).join("\n"));
			expect(settled).toContain("=first block=");
			expect(settled).toContain("=second block=");
			expect(settled).not.toContain("~");
		});
	});
});
