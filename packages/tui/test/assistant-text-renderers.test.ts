import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { AssistantTextRenderContext, AssistantTextRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { splitAssistantMessageToolTimeline } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { TspHarness } from "./native/tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
	vi.restoreAllMocks();
});

function assistant(content: AssistantMessage["content"], timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

/** Stretchtext in miniature: `{{short|long}}` draws `short`; an unclosed `{{…` is withheld while it streams. */
const stretch: AssistantTextRenderer = ({ text }) =>
	text.replace(/\{\{([^|}]*)\|[^}]*\}\}/g, "$1").replace(/\{\{[^}]*$/, "");

function component(renderers: readonly AssistantTextRenderer[], contentOffset = 0, message?: AssistantMessage) {
	return new AssistantMessageComponent(message, false, undefined, [], undefined, true, undefined, false, {
		renderers,
		contentOffset,
	});
}

const drawn = (target: AssistantMessageComponent) => Bun.stripANSI(target.render(80).join("\n"));

describe("assistant text renderers", () => {
	it("draws the renderer's markdown while the message keeps the text as written", () => {
		const message = assistant([{ type: "text", text: "Cache keys {{drift|drift when package.json changes}}." }]);
		const target = component([stretch], 0, message);

		expect(drawn(target)).toContain("Cache keys drift.");
		expect(drawn(target)).not.toContain("{{");
		expect(message.content[0]).toEqual({
			type: "text",
			text: "Cache keys {{drift|drift when package.json changes}}.",
		});
	});

	it("cannot change the stored message through the context it hands renderers", () => {
		const message = assistant([{ type: "text", text: "As written." }]);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const target = component(
			[
				context => {
					const block = context.message.content[0];
					if (block?.type === "text") block.text = "Edited.";
					return undefined;
				},
			],
			0,
			message,
		);
		expect(drawn(target)).toContain("As written.");
		expect(message.content[0]).toEqual({ type: "text", text: "As written." });
	});

	it("is called with the text so far on every streaming update and once more when final", () => {
		const calls: AssistantTextRenderContext[] = [];
		// An unclosed stretch shows as a placeholder that the closed one later replaces.
		const target = component([
			context => {
				calls.push(context);
				return stretch({ ...context, text: context.text.replace(/\{\{[^}]*$/, "(more)") });
			},
		]);
		const steps = ["A {{sh", "A {{short|lo", "A {{short|long}} tail"];
		const shown: string[] = [];
		for (const step of steps) {
			target.updateContent(assistant([{ type: "text", text: step }]), { transient: true });
			shown.push(drawn(target).trim());
		}
		target.updateContent(assistant([{ type: "text", text: steps[2]! }]));
		shown.push(drawn(target).trim());

		expect(calls.map(call => [call.text, call.streaming])).toEqual([
			[steps[0], true],
			[steps[1], true],
			[steps[2], true],
			[steps[2], false],
		]);
		// Output shorter than its input, then a frame that rewrites text already drawn instead of appending.
		expect(shown).toEqual(["A (more)", "A (more)", "A short tail", "A short tail"]);
	});

	it("treats a block sealed at a tool call as final, also for the transient updates that follow", () => {
		const streaming: boolean[] = [];
		const target = component([
			context => {
				streaming.push(context.streaming);
				return context.streaming ? "drafting" : "final";
			},
		]);
		const sealed = assistant([{ type: "text", text: "Reading the file first." }]);
		target.updateContent(sealed, { transient: true });
		target.markTranscriptBlockFinalized();
		// Tool-argument deltas keep updating the sealed block transiently.
		target.updateContent(sealed, { transient: true });

		expect(streaming).toEqual([true, false, false]);
		expect(drawn(target).trim()).toBe("final");
	});

	it("redraws with the renderers it is handed when the setting changes mid-reply, keeping its place in the reply", () => {
		const indexes: number[] = [];
		const recording: AssistantTextRenderer = context => {
			indexes.push(context.contentIndex);
			return stretch(context);
		};
		// A segment after a tool call: its first block is block 2 of the reply.
		const target = component([recording], 2);
		target.updateContent(assistant([{ type: "text", text: "A {{short|long}} tail" }]), { transient: true });
		expect(drawn(target).trim()).toBe("A short tail");

		target.setTextRenderers([]);
		expect(drawn(target).trim()).toBe("A {{short|long}} tail");
		indexes.length = 0;
		target.setTextRenderers([recording]);
		expect(drawn(target).trim()).toBe("A short tail");
		expect(new Set(indexes)).toEqual(new Set([2]));
	});

	it("keeps a reply in the live viewport instead of publishing rows a renderer may still rewrite", () => {
		const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} has settled.`).join("\n\n");
		const stream = (target: AssistantMessageComponent) => {
			for (let end = 20; end <= paragraphs.length; end += 20) {
				target.updateContent(assistant([{ type: "text", text: paragraphs.slice(0, end) }]), { transient: true });
				target.render(80);
			}
			return target.getTranscriptStableRows().length;
		};

		expect(stream(new AssistantMessageComponent())).toBeGreaterThan(0);
		expect(stream(component([({ text }) => text]))).toBe(0);
	});

	it("draws a throwing renderer's input and logs the failure once", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const broken: AssistantTextRenderer = () => {
			throw new Error("boom");
		};
		const target = component([broken, ({ text }) => `${text} (checked)`]);

		target.updateContent(assistant([{ type: "text", text: "Plain reply" }]), { transient: true });
		target.updateContent(assistant([{ type: "text", text: "Plain reply" }]));

		expect(drawn(target)).toContain("Plain reply (checked)");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("gives each block its index in the full reply when tool calls split it into segments", () => {
		const message = assistant([
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
			{ type: "text", text: "between" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
			{ type: "thinking", thinking: "hm" },
			{ type: "text", text: "after" },
		]);
		const seen = new Map<string, number>();
		const record: AssistantTextRenderer = ({ text, contentIndex }) => {
			seen.set(text, contentIndex);
			return undefined;
		};
		const timeline = splitAssistantMessageToolTimeline(message);
		component([record], 0, timeline.beforeTools);
		for (const [id, segment] of timeline.afterToolCalls)
			component([record], timeline.contentOffsets.get(id), segment);

		expect(Object.fromEntries(seen)).toEqual({ before: 0, between: 2, after: 5 });
	});

	it("redraws only the reply sent at the given timestamp, in the terminal and the native view", async () => {
		let open = false;
		const toggle: AssistantTextRenderer = ({ text }) =>
			text.replace(/\{\{([^|}]*)\|([^}]*)\}\}/g, (_, short: string, long: string) => (open ? long : short));
		const target = component([toggle]);
		harness = await TspHarness.start();
		harness.tui.addChild(target);
		target.updateContent(assistant([{ type: "text", text: "Read {{this|this whole paragraph}}." }], 42));
		target.markTranscriptBlockFinalized();
		await harness.render();
		const md = harness.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: "Read this." });

		open = true;
		expect(target.rerenderMessage(41)).toBe(false);
		expect(drawn(target)).toContain("Read this.");

		expect(target.rerenderMessage(42)).toBe(true);
		await harness.render();
		expect(drawn(target)).toContain("Read this whole paragraph.");
		expect(harness.byId(md!.id)?.p).toMatchObject({ text: "Read this whole paragraph." });

		// Collapsing shrinks text the terminal already holds.
		open = false;
		target.rerenderMessage(42);
		await harness.render();
		expect(harness.byId(md!.id)?.p).toMatchObject({ text: "Read this." });
		expect(harness.errors).toEqual([]);
	});
});
