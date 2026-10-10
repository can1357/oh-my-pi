import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { AssistantTextDisplayRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, Markdown, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const W = 100;

function msg(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
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
		...extra,
	};
}

/** Render `m` on a brand-new component, which always takes the teardown path. */
function teardownRender(m: AssistantMessage): string {
	const fresh = new AssistantMessageComponent();
	fresh.updateContent(m);
	return fresh.render(W).join("\n");
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

// Contract: the streaming fast path (a component reused across updateContent
// calls, which reuses Markdown children via setText) MUST render byte-identical
// output to the teardown path (a fresh component that rebuilds every child) for
// the same message — at every step. If they ever diverge, the optimization
// silently corrupts the transcript.
describe("AssistantMessageComponent streaming fast path", () => {
	it("replays retired thinking prefixes after cache eviction, reflow, and finalization", () => {
		const component = new AssistantMessageComponent();
		const widths = [36, W];
		const prefixes: Array<{ count: number; rows: readonly string[][] }> = [];
		let thinking = "";
		for (let step = 0; step < 80; step++) {
			thinking += `Paragraph ${step} has **emphasis** and enough words to wrap at narrow widths.\n\n`;
			component.updateContent(msg([{ type: "thinking", thinking: `${thinking}Pending paragraph` }]), {
				transient: true,
			});
			component.render(W);
			const count = component.getTranscriptStableRows().length;
			if (count > (prefixes.at(-1)?.count ?? 0)) {
				prefixes.push({
					count,
					rows: widths.map(width => [...component.renderTranscriptStableRows(count, width)]),
				});
			}
		}
		expect(prefixes.length).toBeGreaterThan(64);
		const keys = component.getTranscriptStableRows().map(row => row.key);
		expect(keys.reduce((length, key) => length + key.length, 0)).toBeLessThan(keys.length * 32);
		component.updateContent(
			msg([
				{ type: "thinking", thinking },
				{ type: "text", text: "Final answer" },
			]),
		);
		component.markTranscriptBlockFinalized();
		for (const prefix of prefixes) {
			for (const [index, width] of widths.entries()) {
				expect(component.renderTranscriptStableRows(prefix.count, width)).toEqual(prefix.rows[index]);
			}
		}
		expect(component.getTranscriptStableRows().map(row => row.key)).toEqual(keys);
	});

	it("keeps earlier block boundaries immutable when later thinking blocks grow or revise", () => {
		const component = new AssistantMessageComponent();
		const first = "First reasoning paragraph.\n\nSecond paragraph.\n\nStill thinking";
		component.updateContent(msg([{ type: "thinking", thinking: first }]), { transient: true });
		component.render(W);
		const firstCount = component.getTranscriptStableRows().length;
		expect(firstCount).toBeGreaterThan(0);
		const firstRows = [...component.renderTranscriptStableRows(firstCount, 40)];
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: first },
			{ type: "thinking", thinking: "Another block.\n\nMore reasoning.\n\nPending" },
		];
		component.updateContent(msg(content), { transient: true });
		component.render(W);
		const count = component.getTranscriptStableRows().length;
		expect(count).toBeGreaterThan(firstCount);
		const rows = [...component.renderTranscriptStableRows(count, 40)];
		component.updateContent(msg([{ type: "thinking", thinking: `Rewritten ${first}` }]), { transient: true });
		component.render(W);
		expect(component.getTranscriptStableRows()).toHaveLength(count);
		component.renderTranscriptStableRows(count, 60);
		component.renderTranscriptStableRows(count, 80);
		expect(component.renderTranscriptStableRows(firstCount, 40)).toEqual(firstRows);
		expect(component.renderTranscriptStableRows(count, 40)).toEqual(rows);
		component.setHideThinkingBlock(true);
		component.resetTranscriptStableRows();
		component.updateContent(msg(content), { transient: true });
		component.render(W);
		expect(component.getTranscriptStableRows()).toEqual([]);
		expect(component.renderTranscriptStableRows(count, 40)).toEqual([]);
		component.markTranscriptBlockFinalized();
	});

	it("matches teardown output across a growing thinking + text stream", () => {
		const reused = new AssistantMessageComponent();
		const thinking = "Reasoning about the **problem** with `code` and a list:\n- a\n- b";
		const steps = [
			"He",
			"Hello, ",
			"Hello, world.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.",
			"Hello, world.\n\n## Heading\n\nSome `inline` and **bold** text.\n\n```ts\nconst x = 1;\n```",
		];
		for (const text of steps) {
			const m = msg([
				{ type: "thinking", thinking },
				{ type: "text", text },
			]);
			reused.updateContent(m);
			expect(reused.render(W).join("\n")).toBe(teardownRender(m));
		}
	});

	it("does not render dot-only reasoning placeholders", () => {
		const rendered = teardownRender(
			msg([
				{ type: "thinking", thinking: ". . .", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
			]),
		);

		expect(rendered).toContain("answer");
		expect(rendered).not.toContain(". . .");
	});

	it("repairs Gemini's lone closing fence when the streamed turn becomes final", () => {
		const text = `=== PACED IP ROTATION SOAK RESULTS ===
Average Latency: 1,240 ms
\`\`\`

---

### Production Deployment Status

| Workload | Pod Status |
| :--- | :--- |
| google-scraper | **1/1 Running** |`;
		const message = msg([{ type: "text", text }]);
		const component = new AssistantMessageComponent();

		component.updateContent(message, { transient: true });
		expect(Bun.stripANSI(component.render(W).join("\n"))).toContain("| :--- | :--- |");

		component.updateContent(message);
		const finalized = Bun.stripANSI(component.render(W).join("\n"));
		expect(finalized).not.toContain("| :--- | :--- |");
		expect(finalized).toContain("google-scraper");
		expect(finalized).toContain("1/1 Running");
	});

	// Regression: theme/symbol changes reach the component via invalidate()
	// (InteractiveMode clears the markdown render cache and invalidates the
	// tree). Reused fast-path children captured getMarkdownTheme() at
	// construction, so invalidate() MUST drop them and rebuild — otherwise a
	// theme switch keeps rendering stale symbols until the message shape
	// changes. Child identity is the load-bearing mechanism here: a kept
	// instance is exactly a kept stale theme.
	it("invalidate() rebuilds Markdown children instead of reusing fast-path state", () => {
		const collectMarkdown = (component: Container): Markdown[] => {
			const found: Markdown[] = [];
			const walk = (node: Component): void => {
				if (node instanceof Markdown) found.push(node);
				if (node instanceof Container) for (const child of node.children) walk(child);
			};
			walk(component);
			return found;
		};

		const reused = new AssistantMessageComponent();
		reused.updateContent(msg([{ type: "text", text: "Hello **world**, part one." }]));
		reused.updateContent(msg([{ type: "text", text: "Hello **world**, part one and two." }]));
		const before = collectMarkdown(reused);
		expect(before.length).toBeGreaterThan(0);

		// Sanity: a same-shape streaming update reuses the children (fast path on).
		reused.updateContent(msg([{ type: "text", text: "Hello **world**, part one, two, three." }]));
		const streamed = collectMarkdown(reused);
		expect(streamed.length).toBe(before.length);
		for (let i = 0; i < streamed.length; i++) {
			expect(streamed[i]).toBe(before[i]);
		}

		reused.invalidate();
		const rebuilt = collectMarkdown(reused);
		expect(rebuilt.length).toBe(before.length);
		for (let i = 0; i < rebuilt.length; i++) {
			expect(rebuilt[i]).not.toBe(before[i]);
		}
	});

	// Regression: #fastPathItems are keyed by raw content index, but a
	// `redactedThinking` block is not rendered. If one appears mid-stream it
	// shifts the indices of the visible blocks; the shape key must reflect that
	// (or the fast path must fail closed) so children are not mis-targeted.
	it("matches teardown when a redactedThinking block shifts indices mid-stream", () => {
		const reused = new AssistantMessageComponent();
		const a = msg([
			{ type: "thinking", thinking: "step one details here" },
			{ type: "text", text: "answer one" },
		]);
		reused.updateContent(a);
		expect(reused.render(W).join("\n")).toBe(teardownRender(a));

		// A redactedThinking block appears at index 0, pushing thinking->1, text->2.
		const b = msg([
			{ type: "redactedThinking", data: "opaque-blob" },
			{ type: "thinking", thinking: "step two with more detail" },
			{ type: "text", text: "answer two is longer now" },
		]);
		reused.updateContent(b);
		expect(reused.render(W).join("\n")).toBe(teardownRender(b));
	});

	it("matches teardown when an error trailer appears after streamed text", () => {
		const reused = new AssistantMessageComponent();
		const ok = msg([{ type: "text", text: "partial answer in progress" }]);
		reused.updateContent(ok);
		expect(reused.render(W).join("\n")).toBe(teardownRender(ok));

		const errored = msg([{ type: "text", text: "partial answer in progress" }], {
			stopReason: "error",
			errorMessage: "upstream 502",
		});
		reused.updateContent(errored);
		expect(reused.render(W).join("\n")).toBe(teardownRender(errored));
	});

	it("matches teardown when a block visibility toggles (empty -> non-empty)", () => {
		const reused = new AssistantMessageComponent();
		// First an empty trailing text block (not rendered), then it gains content.
		const empty = msg([
			{ type: "thinking", thinking: "thinking out loud" },
			{ type: "text", text: "" },
		]);
		reused.updateContent(empty);
		expect(reused.render(W).join("\n")).toBe(teardownRender(empty));

		const filled = msg([
			{ type: "thinking", thinking: "thinking out loud" },
			{ type: "text", text: "now there is an answer" },
		]);
		reused.updateContent(filled);
		expect(reused.render(W).join("\n")).toBe(teardownRender(filled));
	});

	it("matches fresh live output across hidden thinking emptiness transitions and reveal", () => {
		const reused = new AssistantMessageComponent(undefined, true);
		const latestReasoning = "Latest canonical reasoning";
		try {
			// A comment is raw-nonempty but display-empty; whitespace is canonically empty.
			// Neither transition may leave the live pulse missing or stale.
			for (const thinking of ["", "<!-- -->", " \n", latestReasoning]) {
				const message = msg([
					{ type: "text", text: "Visible answer" },
					{ type: "thinking", thinking },
				]);
				const fresh = new AssistantMessageComponent(undefined, true);
				try {
					reused.updateContent(message, { transient: true });
					fresh.updateContent(message, { transient: true });
					expect(reused.render(W).join("\n")).toBe(fresh.render(W).join("\n"));
				} finally {
					fresh.dispose();
				}
			}

			reused.setHideThinkingBlock(false);
			reused.invalidate();
			const revealed = Bun.stripANSI(reused.render(W).join("\n"));
			expect(revealed).toContain(latestReasoning);
			expect(revealed).toContain("Visible answer");
		} finally {
			reused.dispose();
		}
	});

	it("does not re-format an already-display thinking block (rawThinking set)", () => {
		// buildDisplayMessage emits a thinking block whose `thinking` is already the
		// formatted display text and stamps the original under `rawThinking`.
		// resolveThinkingDisplay must treat `thinking` as display-ready and NOT
		// re-run the fence-stripping formatter — otherwise the fenced content
		// ("keep me") is stripped a second time.
		const m = msg([
			{
				type: "thinking",
				thinking: "Visible\n```\nkeep me\n```",
				rawThinking: "raw",
			},
		] as unknown as AssistantMessage["content"]);
		const component = new AssistantMessageComponent();
		component.updateContent(m);
		const rendered = Bun.stripANSI(component.render(W).join("\n"));
		expect(rendered).toContain("keep me");
	});
});

describe("AssistantMessageComponent text display projection", () => {
	it("projects mixed prose without modifying source messages or tool arguments, including redraws and late images", () => {
		const source = msg(
			[
				{ type: "text", text: "English introduction" },
				{ type: "thinking", thinking: "Original reasoning" },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "source.ts" } },
				{ type: "text", text: "English conclusion" },
			],
			{ usage: { ...msg([]).usage, output: 7, totalTokens: 7 } },
		);
		const snapshot = JSON.stringify(source);
		for (const block of source.content) {
			if (block.type === "toolCall") Object.freeze(block.arguments);
			Object.freeze(block);
		}
		Object.freeze(source.content);
		Object.freeze(source.usage);
		Object.freeze(source);
		const renderer: AssistantTextDisplayRenderer = text => ({
			text: text === "English introduction" ? "中文开场" : "中文结论",
		});
		const component = new AssistantMessageComponent(source, false, undefined, [], undefined, true, undefined, [
			() => undefined,
			renderer,
			() => ({ text: "不应覆盖已选中的显示结果" }),
		]);
		const imageProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		try {
			component.invalidate();
			component.setToolResultImages("read-1", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
			const rendered = Bun.stripANSI(component.render(W).join("\n"));
			expect(rendered).toContain("中文开场");
			expect(rendered).toContain("中文结论");
			expect(rendered).toContain("Original reasoning");
			expect(rendered).toContain("[Image: image/png]");
			expect(rendered).not.toContain("English introduction");
			expect(rendered).not.toContain("English conclusion");
			expect(rendered).not.toContain("不应覆盖已选中的显示结果");
			expect(JSON.stringify(source)).toBe(snapshot);
		} finally {
			setTerminalImageProtocol(imageProtocol);
		}
	});

	it("withholds projected prose from immutable history until its canonical replacement is ready", () => {
		let complete = false;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, undefined, [
			() =>
				complete
					? { text: "最终中文答案" }
					: { text: "等待转换的首段。\n\n等待转换的次段。\n\n仍在处理", pending: true },
		]);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		const source = msg([{ type: "text", text: "English paragraph.\n\nMore English.\n\nPartial answer" }]);
		component.updateContent(source, { transient: true });
		const live = Bun.stripANSI(transcript.renderViewport(80, 20, { now: 0, tick: 0 }).join("\n"));
		expect(live).toContain("等待转换的首段");
		expect(live).not.toContain("English");
		expect(component.hasPendingTextDisplay()).toBe(true);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		complete = true;
		component.updateContent(source);
		component.markTranscriptBlockFinalized();
		expect(component.hasPendingTextDisplay()).toBe(false);
		const retired = Bun.stripANSI(transcript.peekFlushBatch(80)?.rows.join("\n") ?? "");
		expect(retired).toContain("最终中文答案");
		expect(retired).not.toContain("等待转换");
		expect(retired).not.toContain("English");
	});

	it("settles an abandoned pending display as a visible failure instead of blocking transcript retirement", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, undefined, [
			() => ({ text: "等待文本显示", pending: true }),
		]);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		component.updateContent(msg([{ type: "text", text: "Private English source" }]), { transient: true });
		component.markTranscriptBlockFinalized();
		expect(component.hasPendingTextDisplay()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		const retired = Bun.stripANSI(transcript.peekFlushBatch(80)?.rows.join("\n") ?? "");
		expect(retired).toContain("显示失败");
		expect(retired).not.toContain("等待文本显示");
		expect(retired).not.toContain("Private English source");
	});

	it("contains a synchronous display failure without leaking source prose or leaving the block live", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, undefined, [
			() => {
				throw new Error("Private English renderer exception");
			},
		]);
		component.updateContent(msg([{ type: "text", text: "Private English source" }]), { transient: true });
		component.markTranscriptBlockFinalized();
		const rendered = Bun.stripANSI(component.render(W).join("\n"));
		expect(rendered).toContain("显示失败");
		expect(rendered).not.toContain("Private English");
		expect(component.hasPendingTextDisplay()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});
});
