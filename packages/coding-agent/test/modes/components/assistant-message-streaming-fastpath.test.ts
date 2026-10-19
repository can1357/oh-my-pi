import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

	it("keeps published thinking rows when a split fence or comment sentinel completes below them", () => {
		// A delta may end inside "```" or "<!-- -->". The prose fold then shows
		// the partial line as text, but once it completes the fold drops it and
		// appends its ellipsis to the line above — which must not be published yet.
		for (const tail of ["```ts\nlet y = 2;\n```", "<!-- -->\n\n```ts\nlet y = 2;\n```"]) {
			const thinking = `First thought.\n\nSecond thought.\n\n${tail}\n\nThird thought.\n\nStill going`;
			const component = new AssistantMessageComponent();
			for (let end = 1; end <= thinking.length; end++) {
				component.updateContent(msg([{ type: "thinking", thinking: thinking.slice(0, end) }]), { transient: true });
				const rows = trimBlankEdges(component.render(W));
				const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
				expect(rows.slice(0, stable.length)).toEqual([...stable]);
			}
			expect(component.getTranscriptStableRows().length).toBeGreaterThan(0);
		}
	});

	it("keeps retiring later blocks after a streamed block with a tab closes", () => {
		// While streaming, a block publishes Markdown's settled prefix (tabs
		// expanded); once the next block starts it publishes whole. Both must be
		// the same bytes, or every later snapshot stops extending the published one.
		const first = "Columns:\tname\tsize.\n\nSecond paragraph of the answer.\n\nThird paragraph.";
		const second = "Now reasoning about the next step.\n\nAnother paragraph here.\n\nAnd a closing line.";
		const component = new AssistantMessageComponent();
		const counts: number[] = [];
		const stream = (content: AssistantMessage["content"]) => {
			component.updateContent(msg(content), { transient: true });
			const rows = trimBlankEdges(component.render(W));
			const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
			expect(rows.slice(0, stable.length)).toEqual([...stable]);
			counts.push(stable.length);
		};
		for (let end = 1; end <= first.length; end++) stream([{ type: "text", text: first.slice(0, end) }]);
		const beforeSecond = counts.at(-1)!;
		expect(beforeSecond).toBeGreaterThan(0);
		for (let end = 1; end <= second.length; end++) {
			stream([
				{ type: "text", text: first },
				{ type: "thinking", thinking: second.slice(0, end) },
			]);
		}
		// The closed first block and the settled head of the second both retire.
		expect(counts.at(-1)!).toBeGreaterThan(beforeSecond + 2);
	});

	it("retires finished items of a list while it is still the streaming block", () => {
		const items = Array.from(
			{ length: 12 },
			(_, i) =>
				`- ITEM-${i + 1}: a **short** line about \`argv[0]\` and [a link](https://example.com) that wraps once the width gets narrow enough`,
		);
		const text = `Here is the list:\n\n${items.join("\n")}`;
		const component = new AssistantMessageComponent();
		let stable: readonly string[] = [];
		for (let end = 1; end <= text.length; end++) {
			component.updateContent(msg([{ type: "text", text: text.slice(0, end) }]), { transient: true });
			const rows = trimBlankEdges(component.render(W));
			stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
			expect(rows.slice(0, stable.length)).toEqual([...stable]);
		}
		expect(stable.some(row => row.includes("ITEM-11:"))).toBe(true);
		expect(stable.some(row => row.includes("ITEM-12:"))).toBe(false);
	});

	it("never publishes list rows that a later append or the final render changes", () => {
		const docs = [
			Array.from({ length: 12 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n"),
			"- one\n- two\n- three\n\n- four, now loose\n- five",
			"- one\n- two\n--- dashes\n- three",
			"1. one\n2. two\n2.5 percent\n3. three",
			"- one\n  - nested a\n  - nested b\n- two\n  continued two\n- three\n---\nafter",
			"- one\n- two\n# Heading\n\nTail paragraph",
			"- one\n- $$\n- x\n$$\n- three",
			"- one\n- two\n\\begin{align}\n- x\n\\end{align}\n- three",
			"* one\n* two\n- three\n- four",
			"$$\nx = 1\n\n- one\n- two\n- three\n$$",
			"- [foo]\n- second\n- [foo]: https://example.com\n- four",
			"- [Foo][] item\n- second\n  [foo]: https://example.com\n- third",
		];
		for (const doc of docs) {
			const text = `Intro.\n\n${doc}\n\nDone.`;
			const component = new AssistantMessageComponent();
			let published: readonly string[] = [];
			for (let end = 1; end <= text.length; end++) {
				component.updateContent(msg([{ type: "text", text: text.slice(0, end) }]), { transient: true });
				const rows = trimBlankEdges(component.render(W));
				const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
				expect(rows.slice(0, stable.length)).toEqual([...stable]);
				expect(stable.slice(0, published.length)).toEqual(published.slice(0, stable.length));
				if (stable.length > published.length) published = stable;
			}
			component.updateContent(msg([{ type: "text", text }]));
			component.markTranscriptBlockFinalized();
			expect(trimBlankEdges(component.render(W)).slice(0, published.length)).toEqual([...published]);
		}
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
