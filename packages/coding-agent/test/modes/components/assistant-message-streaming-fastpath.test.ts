import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Container, Markdown } from "@oh-my-pi/pi-tui";

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

	it("matches teardown for a single growing text block", () => {
		const reused = new AssistantMessageComponent();
		let text = "";
		for (const chunk of ["The ", "quick ", "brown ", "**fox** ", "jumps."]) {
			text += chunk;
			const m = msg([{ type: "text", text }]);
			reused.updateContent(m);
			expect(reused.render(W).join("\n")).toBe(teardownRender(m));
		}
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
