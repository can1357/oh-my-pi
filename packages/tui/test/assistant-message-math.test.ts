import { afterEach, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { setMarkdownMathRendering } from "../src/components/markdown";
import { ImageBudget, withImageRenderContext } from "../src/components/image";
import { releaseMathImageOwner, withMathImageOwner } from "../src/components/math-image";
import { setMathImageRenderer } from "../src/math-image-renderer";
import { ImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { initThemeSync } from "../src/theme/theme";
import { setTranscriptActionHandler } from "../src/chat/transcript-actions";
const protocol = TERMINAL.imageProtocol;
afterEach(() => {
	setMathImageRenderer(undefined);
	setMarkdownMathRendering(false);
	TERMINAL.imageProtocol = protocol;
});
it("repaints completed assistant math without changing copied source", async () => {
	initThemeSync();
	TERMINAL.imageProtocol = ImageProtocol.Kitty;
	setMarkdownMathRendering(true);
	const source = "before\n\n$$x+y=1$$\n\nafter";
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private $z+q=2$" },
			{ type: "text", text: source },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
	const done = Promise.withResolvers<void>();
	const budget = new ImageBudget(16, () => {});
	const component = new AssistantMessageComponent(message, false, () => done.resolve());
	component.updateContent(message, { transient: true });
	setMathImageRenderer({
		id: "assistant-contract",
		render: async () => ({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="1ex" height="1ex"><rect width="10" height="10" fill="white"/></svg>',
			widthEx: 1,
			heightEx: 1,
		}),
	});
	const render = () =>
		withImageRenderContext({ budget, requestRender: () => done.resolve() }, () =>
			withMathImageOwner(
				component,
				() => done.resolve(),
				() => component.render(80),
			),
		);
	try {
		expect(render().join("\n")).toContain("x+y=1");
		await done.promise;
		const ready = render();
		expect(ready.join("\n")).not.toContain("x+y=1");
		expect(ready.join("\n")).toContain("z+q=2");
		const image = ready.find(row => TERMINAL.isImageLine(row));
		expect(image).toBeDefined();
		let copied = "";
		setTranscriptActionHandler(action => {
			if (action.act === "copy") copied = action.text;
		});
		component.handleNativeEvent({ type: "action", key: "copy", act: "copy-answer", mods: [] });
		expect(copied).toBe(source);
		component.updateContent(
			{
				...message,
				content: [
					{ type: "thinking", thinking: "private $z+q=2$" },
					{ type: "text", text: source + " more" },
				],
			},
			{ transient: true },
		);
		expect(render().find(row => TERMINAL.isImageLine(row))).toBe(image);
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "private $z+q=2$" },
			{ type: "text", text: source },
		]);
	} finally {
		releaseMathImageOwner(component);
		setTranscriptActionHandler(undefined);
	}
});
