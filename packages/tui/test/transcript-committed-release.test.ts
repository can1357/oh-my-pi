import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Lexer, type Token } from "@oh-my-pi/pi-utils/marked";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { FramedMessageComponent } from "@oh-my-pi/pi-tui/chrome/message-frame";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { Box } from "@oh-my-pi/pi-tui/components/box";
import { Disclosure } from "@oh-my-pi/pi-tui/components/disclosure";
import { Row } from "@oh-my-pi/pi-tui/components/layout/row";
import { Stack } from "@oh-my-pi/pi-tui/components/layout/stack";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { Section } from "@oh-my-pi/pi-tui/components/section";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getMarkdownTheme, getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import * as themeModule from "@oh-my-pi/pi-tui/theme/theme";
import * as renderUtils from "@oh-my-pi/pi-tui/render/render-utils";
import * as sixel from "@oh-my-pi/pi-tui/render/sixel";
import { OutputPane } from "@oh-my-pi/pi-tui/render/output-pane";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { editToolRenderer } from "@oh-my-pi/pi-tui/tools/edit";
import { renderMCPResult, setMcpRenderMarkdownResults } from "@oh-my-pi/pi-tui/tools/mcp";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { becomesCollectible } from "./gc";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";

const frame = { tick: 0, now: 0 };

/** A block that counts cache releases and eager rebuilds separately. */
class ReleaseCountingBlock implements Component {
	releases = 0;
	invalidations = 0;
	readonly #rows: readonly string[];
	#finalized: boolean;

	constructor(rows: readonly string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	invalidate(): void {
		this.invalidations++;
	}

	releaseRenderCaches(): void {
		this.releases++;
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

/** A settled block whose every cache hook throws, as a broken custom component might. */
class ThrowingHooksBlock implements Component {
	readonly #rows: readonly string[];

	constructor(rows: readonly string[]) {
		this.#rows = rows;
	}

	invalidate(): void {
		throw new Error("invalidate failed");
	}

	releaseRenderCaches(): void {
		throw new Error("release failed");
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const THINKING =
	"Checking how the **renderer** wraps a long reasoning paragraph so that the replay has to reflow it.\n\nA second paragraph keeps the frozen stream prefix non-empty.";
const ANSWER = [
	"## Result",
	"",
	"The committed block keeps its message, so a replay can rebuild every row it ever showed at any width.",
	"",
	"- first item with `inline code` and **bold** text that wraps at narrow widths",
	"- second item",
	"",
	"```ts",
	"export function retire(entry: Entry): void {",
	"\tentry.state = 'committed';",
	"}",
	"```",
	"",
	"Closing paragraph after the fence, long enough to wrap when the terminal narrows.",
].join("\n");

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

/** Stream the answer through transient updates, then finalize, the way the live event path does. */
function streamedAssistant(): AssistantMessageComponent {
	const component = new AssistantMessageComponent();
	for (const fraction of [0.3, 0.6]) {
		component.updateContent(assistantMessage(ANSWER.slice(0, Math.floor(ANSWER.length * fraction))), {
			transient: true,
		});
		component.render(80);
	}
	component.updateContent(assistantMessage(ANSWER));
	component.markTranscriptBlockFinalized();
	return component;
}

const WRITE_CONTENT = Array.from(
	{ length: 30 },
	(_, index) => `export const value${index} = compute(${index}, "row ${index}");`,
).join("\n");

const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const liveTools: ToolExecutionComponent[] = [];

/** A write whose content streamed in (populating the incremental preview) before its result settled. */
function streamedWrite(): ToolExecutionComponent {
	const component = new ToolExecutionComponent("write", { path: "src/values.ts" }, {}, undefined, ui);
	liveTools.push(component);
	for (const lines of [10, 20, 30]) {
		const content = WRITE_CONTENT.split("\n").slice(0, lines).join("\n");
		component.updateArgs({ path: "src/values.ts", content });
		component.render(80);
	}
	component.setArgsComplete();
	component.setExecutionStarted();
	component.render(80);
	component.updateResult(
		{ content: [{ type: "text", text: "Successfully wrote src/values.ts" }], details: {}, isError: false },
		false,
	);
	return component;
}

/** Commit every live block and return the exact rows the terminal received for them. */
function commitAll(transcript: TranscriptContainer, width: number): readonly string[] {
	transcript.renderViewport(width, 40, frame);
	const batch = transcript.peekFlushBatch(width);
	if (!batch) throw new Error("expected a retirement batch");
	transcript.acknowledgeFinalizedBatch(batch.id);
	expect(transcript.blockStates().every(state => state === "committed")).toBe(true);
	return batch.rows;
}

function replay(transcript: TranscriptContainer, width: number): readonly string[] {
	transcript.beginReplay();
	const batch = transcript.peekReplayBatch(width);
	if (!batch) throw new Error("expected a replay batch");
	transcript.acknowledgeFinalizedBatch(batch.id);
	return batch.rows;
}

/**
 * The replay contract for a committed block whose caches were released: the
 * same width reproduces the bytes already in native history, and a new width
 * matches what an identical never-committed block renders there.
 */
function expectReplayContract(committed: Component, twin: Component): void {
	const transcript = new TranscriptContainer();
	transcript.addChild(committed);
	const live = committed.render(80);
	// Control: a live block hands back its memoized rows by reference.
	expect(committed.render(80)).toBe(live);

	const retired = commitAll(transcript, 80);
	const afterCommit = committed.render(80);
	expect(afterCommit).not.toBe(live);
	expect(afterCommit).toEqual(live);

	expect(replay(transcript, 80)).toEqual(retired);
	expect(replay(transcript, 52)).toEqual([...trimBlankEdges(twin.render(52)), ""]);
	const beforeReplay = committed.render(80);
	expect(replay(transcript, 80)).toEqual(retired);
	const afterReplay = committed.render(80);
	expect(afterReplay).not.toBe(beforeReplay);
	expect(afterReplay).toEqual(beforeReplay);
}

describe("committed transcript blocks release render caches", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		for (const tool of liveTools) tool.stopAnimation();
		liveTools.length = 0;
		vi.restoreAllMocks();
		setMcpRenderMarkdownResults(false);
	});

	it("releases a block once when it commits and after every replay render, never while it is live", () => {
		const transcript = new TranscriptContainer();
		const settled = new ReleaseCountingBlock(["settled"], true);
		const active = new ReleaseCountingBlock(["active"], false);
		transcript.addChild(settled);
		transcript.addChild(active);
		transcript.renderViewport(80, 1, frame);

		const offered = transcript.peekFinalizedBatch(80, 1);
		if (!offered) throw new Error("expected a pressure retirement");
		// An unacknowledged offer can still be recomposed for a discarded frame.
		expect(settled.releases).toBe(0);
		transcript.acknowledgeFinalizedBatch(offered.id);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
		expect(settled.releases).toBe(1);

		replay(transcript, 60);
		expect(settled.releases).toBe(2);

		transcript.renderViewport(80, 10, frame);
		expect(active.releases).toBe(0);
		active.finalize();
		const final = transcript.peekFlushBatch(80);
		if (!final) throw new Error("expected the finalized block to retire");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(active.releases).toBe(1);
		expect(settled.releases).toBe(2);
		// Releasing is not a theme-change rebuild.
		expect(settled.invalidations + active.invalidations).toBe(0);
	});

	it("keeps committed caches through replay retries until the replay batch is acknowledged", () => {
		const transcript = new TranscriptContainer();
		const block = new ReleaseCountingBlock(["committed"], true);
		transcript.addChild(block);
		commitAll(transcript, 80);
		expect(block.releases).toBe(1);

		transcript.beginReplay();
		const offered = transcript.peekReplayBatch(80);
		if (!offered) throw new Error("expected a replay batch");
		expect(block.releases).toBe(1);
		expect(transcript.rerenderOfferedBatch(60)?.rows).toEqual(["committed", ""]);
		expect(block.releases).toBe(1);

		transcript.acknowledgeFinalizedBatch(offered.id);
		expect(block.releases).toBe(2);
	});

	it("releases committed caches when replay renders no rows to acknowledge", () => {
		const transcript = new TranscriptContainer();
		const block = new ReleaseCountingBlock([""], true);
		transcript.addChild(block);
		expect(commitAll(transcript, 80)).toEqual([]);
		expect(block.releases).toBe(1);

		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(block.releases).toBe(2);
	});

	it("never re-runs extension renderers when a block commits or replays", () => {
		const frameCalls = { count: 0 };
		const framed = () =>
			new FramedMessageComponent({
				role: "omp.note",
				message: { customType: "note", content: "" },
				customRenderer: () => {
					frameCalls.count++;
					return new Text("custom note body rendered by an extension, long enough to wrap when narrowed", 1, 0);
				},
			});
		const thinkingCalls = { count: 0 };
		const assistant = () =>
			new AssistantMessageComponent(assistantMessage(ANSWER), false, undefined, [
				context => {
					thinkingCalls.count++;
					return new Text(`extension view of thinking block ${context.thinkingIndex}`, 1, 0);
				},
			]);

		const committedFrame = framed();
		const committedAssistant = assistant();
		const twins = [framed(), assistant()];
		const built = { frame: frameCalls.count, thinking: thinkingCalls.count };
		const transcript = new TranscriptContainer();
		transcript.addChild(committedFrame);
		transcript.addChild(committedAssistant);

		const retired = commitAll(transcript, 80);
		expect(replay(transcript, 80)).toEqual(retired);
		const narrow = replay(transcript, 52);

		expect({ frame: frameCalls.count, thinking: thinkingCalls.count }).toEqual(built);
		expect(narrow).toEqual([
			...trimBlankEdges(twins[0]!.render(52)),
			"",
			...trimBlankEdges(twins[1]!.render(52)),
			"",
		]);
	});

	it("keeps the ledger consistent when a block's cache hooks throw", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new ThrowingHooksBlock(["broken"]));
		transcript.addChild(new ReleaseCountingBlock(["healthy"], true));
		expect(commitAll(transcript, 80)).toEqual(["broken", "", "healthy", ""]);
		expect(transcript.blockStates()).toEqual(["committed", "committed"]);

		// The frontier moved past both blocks: the next retirement carries only the new one.
		transcript.addChild(new ReleaseCountingBlock(["later"], true));
		expect(commitAll(transcript, 80)).toEqual(["later", ""]);
		expect(replay(transcript, 80)).toEqual(["broken", "", "healthy", "", "later", ""]);
		expect(replay(transcript, 60)).toEqual(["broken", "", "healthy", "", "later", ""]);
	});

	it("releases committed blocks after a full semantic render", async () => {
		const rendered: WeakRef<readonly string[]>[] = [];
		const block = new Container();
		block.addChild({
			render: () => {
				const rows = [`row ${rendered.length}`];
				rendered.push(new WeakRef(rows));
				return rows;
			},
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(block);
		commitAll(transcript, 80);

		expect(transcript.render(80)).toEqual([`row ${rendered.length - 1}`]);
		expect(await becomesCollectible(rendered.at(-1)!)).toBe(true);
		// The transcript stays live throughout, so only its blocks could have pinned the rows.
		expect(transcript.render(80)).toEqual([`row ${rendered.length - 1}`]);
	});

	it("replays a streamed assistant message byte-identically after release", () => {
		expectReplayContract(streamedAssistant(), streamedAssistant());
	});

	it("replays a streamed write tool card byte-identically after release", () => {
		expectReplayContract(streamedWrite(), streamedWrite());
	});

	it("releases ToolExecutionComponent sanitized output and formatted caches on retirement and replays byte-identically", async () => {
		const outputLines = Array.from(
			{ length: 28 },
			(_, index) => `line ${index}: build output with trailing detail that wraps on narrower terminals`,
		).join("\n");

		function settledBash(): ToolExecutionComponent {
			const component = new ToolExecutionComponent(
				"bash",
				{ command: "bun run build --filter=@oh-my-pi/pi-tui" },
				{},
				undefined,
				ui,
			);
			liveTools.push(component);
			component.setArgsComplete();
			component.setExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: `${outputLines}\n` }], isError: false }, false);
			return component;
		}

		function settledEval(withCells: boolean): ToolExecutionComponent {
			const component = new ToolExecutionComponent(
				"eval",
				{ code: "for i in range(5):\n    print('row', i, 'value' * 6)", language: "python" },
				{},
				undefined,
				ui,
			);
			liveTools.push(component);
			component.setArgsComplete();
			component.setExecutionStarted();
			component.updateResult(
				{
					content: [{ type: "text", text: `${outputLines}\n` }],
					details: withCells
						? {
								language: "python",
								cells: [
									{
										index: 0,
										language: "python",
										code: "for i in range(5):\n    print('row', i, 'value' * 6)",
										status: "complete",
										durationMs: 18,
										output: outputLines,
									},
								],
							}
						: { language: "python" },
					isError: false,
				},
				false,
			);
			return component;
		}

		function settledGeneric(): ToolExecutionComponent {
			const component = new ToolExecutionComponent(
				"custom_unregistered_tool",
				{ target: "alpha", verbose: true },
				{ useBuiltInRenderer: false },
				undefined,
				ui,
			);
			liveTools.push(component);
			component.setArgsComplete();
			component.setExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: `${outputLines}\n` }], isError: false }, false);
			return component;
		}

		expectReplayContract(settledBash(), settledBash());
		expectReplayContract(settledEval(false), settledEval(false));
		expectReplayContract(settledEval(true), settledEval(true));
		expectReplayContract(settledGeneric(), settledGeneric());

		// Prove ToolExecutionComponent.#textOutput is genuinely dropped on releaseRenderCaches()
		// (re-sanitized on a subsequent replay render, never while live caches hold) and custom
		// tool renderCall/renderResult callbacks are never re-invoked on retirement or resize replay.
		const origSanitize = sixel.sanitizeWithOptionalSixelPassthrough;
		let sanitizeCalls = 0;
		const sanitizeSpy = spyOn(sixel, "sanitizeWithOptionalSixelPassthrough").mockImplementation((text, sanitize) => {
			sanitizeCalls++;
			return origSanitize(text, sanitize);
		});
		try {
			const bashCard = settledBash();
			const initialRows = bashCard.render(80);
			const afterInitialSanitize = sanitizeCalls;
			expect(afterInitialSanitize).toBeGreaterThan(0);

			// Live width change reuses memoized #textOutput without re-sanitizing result text.
			bashCard.render(60);
			expect(sanitizeCalls).toBe(afterInitialSanitize);

			// Releasing caches drops #textOutput; re-rendering regenerates it on demand and matches byte-for-byte.
			bashCard.releaseRenderCaches();
			expect(bashCard.render(80)).toEqual(initialRows);
			expect(sanitizeCalls).toBeGreaterThan(afterInitialSanitize);
		} finally {
			sanitizeSpy.mockRestore();
		}

		// Generic fallback WidthAwareText drops its width-formatted string so rendered rows become collectible.
		const genericCard = settledGeneric();
		const genericTranscript = new TranscriptContainer();
		genericTranscript.addChild(genericCard);
		const liveGenericRef = new WeakRef(genericCard.render(80));
		const retiredGeneric = commitAll(genericTranscript, 80);
		expect(await becomesCollectible(liveGenericRef)).toBe(true);
		expect(replay(genericTranscript, 80)).toEqual(retiredGeneric);

		// Custom tool renderers must NOT have renderCall/renderResult re-invoked on retirement or replay.
		let renderCallCount = 0;
		let renderResultCount = 0;
		const customToolParameters = type({ q: "string" });
		const makeCustomTool = () => {
			const tool: AgentTool<typeof customToolParameters> = {
				name: "ext_tool",
				label: "ExtTool",
				description: "test",
				parameters: customToolParameters,
				execute: async () => ({ content: [] }),
				renderCall: () => {
					renderCallCount++;
					return new Text("ext call header that wraps cleanly when narrowed", 0, 0);
				},
				renderResult: () => {
					renderResultCount++;
					return new Text("ext result body that wraps cleanly when the terminal narrows", 0, 0);
				},
			};
			const component = new ToolExecutionComponent("ext_tool", { q: "x" }, {}, tool, ui);
			liveTools.push(component);
			component.setArgsComplete();
			component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
			return component;
		};

		const committedCustom = makeCustomTool();
		const callsAfterBuild = { call: renderCallCount, result: renderResultCount };
		const customTranscript = new TranscriptContainer();
		customTranscript.addChild(committedCustom);
		const retiredCustom = commitAll(customTranscript, 80);
		expect(replay(customTranscript, 80)).toEqual(retiredCustom);
		replay(customTranscript, 48);
		expect({ call: renderCallCount, result: renderResultCount }).toEqual(callsAfterBuild);
	});

	it("releases highlighted multi-line bash command caches on retirement and regenerates them on resize replay", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const multiLineScript = [
			"set -euo pipefail",
			"for pkg in packages/tui packages/agent packages/ai; do",
			'\tprintf "checking %s with extra flags that wrap on narrow terminals\\n" "$pkg"',
			'\tbun test "$pkg/test" --bail',
			"done",
		].join("\n");
		const outputLines = Array.from(
			{ length: 16 },
			(_, index) => `check ${index}: verified target output line that wraps across narrower widths`,
		).join("\n");

		function settledMultiLineBash(): ToolExecutionComponent {
			const component = new ToolExecutionComponent("bash", { command: multiLineScript }, {}, undefined, ui);
			liveTools.push(component);
			component.setArgsComplete();
			component.setExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: `${outputLines}\n` }], isError: false }, false);
			return component;
		}

		const highlightSpy = spyOn(themeModule, "highlightCode");
		try {
			// 1. Settled bash ToolExecutionComponent through commit retirement + resize replay.
			const committed = settledMultiLineBash();
			const twin = settledMultiLineBash();
			const transcript = new TranscriptContainer();
			transcript.addChild(committed);

			committed.render(80);
			const afterInitialHighlight = highlightSpy.mock.calls.length;
			expect(afterInitialHighlight).toBe(1);

			// Live width change reuses cached cmdLines without re-highlighting the script.
			committed.render(60);
			expect(highlightSpy.mock.calls.length).toBe(afterInitialHighlight);

			// Commit retires the card and clears cmdLines; resize replay re-highlights on demand and matches twin.
			const retired = commitAll(transcript, 80);
			const afterCommitHighlight = highlightSpy.mock.calls.length;

			expect(replay(transcript, 80)).toEqual(retired);
			expect(highlightSpy.mock.calls.length).toBe(afterCommitHighlight + 1);

			const twinNarrow = [...trimBlankEdges(twin.render(52)), ""];
			const beforeNarrowReplay = highlightSpy.mock.calls.length;
			expect(replay(transcript, 52)).toEqual(twinNarrow);
			expect(highlightSpy.mock.calls.length).toBe(beforeNarrowReplay + 1);

			// 2. Pending bashToolRenderer.renderCall card also releases cmdLines and regenerates on demand.
			const pendingOptions = { expanded: false, isPartial: true };
			const pendingCard = bashToolRenderer.renderCall({ command: multiLineScript }, pendingOptions, theme);
			const freshPendingNarrow = bashToolRenderer
				.renderCall({ command: multiLineScript }, pendingOptions, theme)
				.render(52);

			const beforePendingHighlight = highlightSpy.mock.calls.length;
			const pendingWide = pendingCard.render(80);
			expect(highlightSpy.mock.calls.length).toBe(beforePendingHighlight + 1);

			pendingCard.render(60);
			expect(highlightSpy.mock.calls.length).toBe(beforePendingHighlight + 1);

			pendingCard.releaseRenderCaches?.();
			expect(pendingCard.render(80)).toEqual(pendingWide);
			expect(highlightSpy.mock.calls.length).toBe(beforePendingHighlight + 2);

			pendingCard.releaseRenderCaches?.();
			expect(pendingCard.render(52)).toEqual(freshPendingNarrow);
			expect(highlightSpy.mock.calls.length).toBe(beforePendingHighlight + 3);
		} finally {
			highlightSpy.mockRestore();
		}
	});

	it("releases MCP Markdown rows hidden behind capped output and replays the result", async () => {
		setMcpRenderMarkdownResults(true);
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const rendered: WeakRef<readonly string[]>[] = [];
		const render = Markdown.prototype.render;
		const renderSpy = spyOn(Markdown.prototype, "render").mockImplementation(function (
			this: Markdown,
			width: number,
		) {
			const rows = render.call(this, width);
			rendered.push(new WeakRef(rows));
			return rows;
		});
		const output = Array.from(
			{ length: 40 },
			(_, index) => `Paragraph ${index}: **MCP content** wraps across rows.`,
		).join("\n\n");
		const result = { content: [{ type: "text", text: output }] };
		const options = { expanded: false, isPartial: false };
		const component = renderMCPResult(result, options, theme);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		const retired = commitAll(transcript, 80);
		renderSpy.mockClear();
		clearRenderCache();
		expect(await becomesCollectible(rendered.at(-1)!)).toBe(true);
		expect(replay(transcript, 80)).toEqual(retired);
		options.expanded = true;
		const expanded = replay(transcript, 35);
		const fresh = renderMCPResult(result, options, theme);
		expect(expanded).toEqual([...trimBlankEdges(fresh.render(35)), ""]);
	});

	it("rebuilds identical plain MCP rows after retirement while generic Text keeps its source", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const result = {
			content: [{ type: "text", text: JSON.stringify({ result: "a value wrapping at narrower widths", count: 3 }) }],
		};
		const options = { expanded: true, isPartial: false };
		const component = renderMCPResult(result, options, theme);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		const retired = commitAll(transcript, 80);
		expect(replay(transcript, 80)).toEqual(retired);
		expect(replay(transcript, 25)).toEqual([
			...trimBlankEdges(renderMCPResult(result, options, theme).render(25)),
			"",
		]);

		const text = new Text("semantic source that must remain available after releasing its rows", 0, 0);
		const rows = text.render(25);
		text.releaseRenderCaches();
		expect(text.render(25)).toEqual(rows);
	});

	it("reclaims OutputPane formatting on retirement without losing stream, expansion, or native state", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const formattedTexts: WeakRef<Text>[] = [];
		const renderedTexts = new WeakSet<Text>();
		const render = Text.prototype.render;
		const renderSpy = spyOn(Text.prototype, "render").mockImplementation(function (this: Text, width: number) {
			if (!renderedTexts.has(this)) {
				renderedTexts.add(this);
				formattedTexts.push(new WeakRef(this));
			}
			return render.call(this, width);
		});
		const options = {
			expanded: false,
			collapsedMaxLines: 2,
			styleLine: (line: string) => theme.fg("toolOutput", line),
		};
		const pane = new OutputPane(theme, options);
		pane.append("first line\r\nsecond line\nprogress\r");
		const transcript = new TranscriptContainer();
		transcript.addChild(pane);
		pane.render(80);
		const formattedChars = () => formattedTexts.reduce((sum, ref) => sum + (ref.deref()?.getText().length ?? 0), 0);
		expect(formattedChars()).toBeGreaterThan(0);
		const cx = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
		const native = pane.describe(cx);
		const retired = commitAll(transcript, 80);
		renderSpy.mockClear();
		expect(formattedChars()).toBe(0);
		expect(pane.getText()).toBe("first line\nsecond line\nprogress");
		expect(pane.describe(cx)).toBe(native);
		expect(replay(transcript, 80)).toEqual(retired);

		pane.append("\nlast output row that wraps in the expanded narrow viewport");
		pane.setExpanded(true);
		const fresh = new OutputPane(
			theme,
			{ ...options, expanded: true },
			"first line\nsecond line\nprogress\nlast output row that wraps in the expanded narrow viewport",
		);
		expect(pane.render(30)).toEqual(fresh.render(30));
		pane.append("\r");
		pane.releaseRenderCaches();
		pane.finish();
		fresh.setText("first line\nsecond line\nprogress\n");
		expect(pane.render(30)).toEqual(fresh.render(30));
	});

	it("collects parsed source from a retired assistant finalized in transient mode", async () => {
		const parsed: WeakRef<Token>[] = [];
		const blockTokens = Lexer.prototype.blockTokens;
		const lexSpy = spyOn(Lexer.prototype, "blockTokens").mockImplementation(function (this: Lexer, source, tokens) {
			const result = blockTokens.call(this, source, tokens);
			for (const token of result) {
				if (token.raw.startsWith("## Frozen reasoning")) parsed.push(new WeakRef(token));
			}
			return result;
		});
		const component = new AssistantMessageComponent();
		const message = assistantMessage("A tool call has closed this segment.");
		message.content = [
			{
				type: "text",
				text: "## Frozen reasoning\n\nA stable paragraph stays parsed during streaming.\n\nA tail paragraph.",
			},
		];
		message.stopReason = "toolUse";
		component.updateContent(message, { transient: true });
		component.render(80);
		component.markTranscriptBlockFinalized();
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		const retired = commitAll(transcript, 80);
		lexSpy.mockClear();
		if (parsed.length === 0) throw new Error("expected parsed reasoning tokens");
		for (const token of parsed) expect(await becomesCollectible(token)).toBe(true);
		expect(replay(transcript, 80)).toEqual(retired);
	});

	it("continues a transient Markdown stream after releasing its prefix and highlighting caches", () => {
		const theme = getMarkdownTheme();
		const source = "A frozen paragraph.\n\n```ts\nconst first = 1;\nconst tail =";
		const component = new Markdown(source, 0, 0, theme);
		component.transientRenderCache = true;
		const before = component.render(60);
		component.releaseRenderCaches();
		expect(component.transientRenderCache).toBe(true);
		expect(component.render(60)).toEqual(before);

		const next = `${source} 2;\nconst last = 3;\n\`\`\`\n\nA concluding paragraph.`;
		component.setText(next);
		const fresh = new Markdown(next, 0, 0, theme);
		fresh.transientRenderCache = true;
		expect(component.render(37)).toEqual(fresh.render(37));
		component.transientRenderCache = false;
		fresh.transientRenderCache = false;
		expect(component.render(37)).toEqual(fresh.render(37));
	});

	it("releases hidden nested detail rows while retaining the disclosure body and expansion state", async () => {
		const rendered: WeakRef<readonly string[]>[] = [];
		class DetailText extends Text {
			override render(width: number): readonly string[] {
				const rows = super.render(width);
				rendered.push(new WeakRef(rows));
				return rows;
			}
		}
		let bodyBuilds = 0;
		const disclosure = new Disclosure({
			summary: new Text("detail summary", 0, 0),
			expanded: true,
			body: () => {
				bodyBuilds++;
				const section = new Section({
					title: "details",
					ruleGlyph: "-",
					ruleWidth: "fill",
					body: new DetailText("Retained detail text wraps differently when the terminal width changes.", 0, 0),
				});
				const box = new Box(1, 0);
				box.addChild(section);
				return new Stack({ children: [{ content: new Row({ children: [{ content: box }] }) }] });
			},
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(disclosure);
		disclosure.render(80);
		disclosure.setExpanded(false);
		const retired = commitAll(transcript, 80);
		expect(await becomesCollectible(rendered[0]!)).toBe(true);
		expect(disclosure.expanded).toBe(false);
		expect(replay(transcript, 80)).toEqual(retired);
		disclosure.setExpanded(true);
		const narrow = replay(transcript, 30);
		expect(narrow.join("\n")).toContain("Retained detail text wraps");
		expect(bodyBuilds).toBe(1);
		expect(disclosure.expanded).toBe(true);
		expect(await becomesCollectible(rendered.at(-1)!)).toBe(true);
	});

	it("releases user bubble zone rows without losing reactions or replay framing", async () => {
		const user = new UserMessageComponent("A user prompt with enough text to wrap across narrow terminal rows.");
		user.setReaction("✅");
		const rendered = new WeakRef(user.render(80));
		const transcript = new TranscriptContainer();
		transcript.addChild(user);
		const retired = commitAll(transcript, 80);
		expect(await becomesCollectible(rendered)).toBe(true);
		expect(replay(transcript, 80)).toEqual(retired);
		expect(replay(transcript, 32).join("\n")).toContain("✅");
	});

	it("releases resized tail render rows while keeping committed history replayable", async () => {
		const rendered: WeakRef<readonly string[]>[] = [];
		const block = new Container();
		block.addChild({
			render: width => {
				const rows = [`tail rendered at ${width}`];
				rendered.push(new WeakRef(rows));
				return rows;
			},
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(block);
		commitAll(transcript, 80);
		expect(transcript.renderTail(50, 1)).toEqual(["tail rendered at 50"]);
		expect(await becomesCollectible(rendered.at(-1)!)).toBe(true);
		expect(replay(transcript, 80)).toEqual(["tail rendered at 80", ""]);
	});
});

describe("write renderer streaming preview state", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("stops retaining the incremental preview once a result renders", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected the dark theme");
		const args = { path: "src/values.ts", content: WRITE_CONTENT };
		const renderState = { expanded: false, isPartial: true, argsComplete: true };
		writeToolRenderer.renderCall(args, renderState, uiTheme)?.render(80);
		const preview = previewHighlightedLines(renderState);

		const result = { content: [{ type: "text", text: "Successfully wrote src/values.ts" }], details: {} };
		// ToolExecutionComponent hands both renderers the same mutable render state.
		renderState.isPartial = false;
		const rows = writeToolRenderer.renderResult(result, renderState, uiTheme, args).render(80);

		expect(await becomesCollectible(preview)).toBe(true);
		// renderState stays live for the re-render below, so only it could have kept the preview reachable.
		const fresh = writeToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, uiTheme, args)
			.render(80);
		expect(rows).toEqual(fresh);
		expect(writeToolRenderer.renderResult(result, renderState, uiTheme, args).render(80)).toEqual(fresh);
	});
});

describe("retired edit and write formatting", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const diff = "@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n const stable = true;";
	const result = { content: [{ type: "text", text: "completed" }], details: { diff } };
	const args = { path: "src/values.ts", content: WRITE_CONTENT };

	/** Counts formatter runs behind `cachedRenderedString` while `build`'s card renders, releases, and re-renders. */
	async function formatsAcrossRelease(build: (theme: Theme) => Component | undefined) {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const format = renderUtils.cachedRenderedString;
		let formats = 0;
		spyOn(renderUtils, "cachedRenderedString").mockImplementation((cache, theme, expanded, salt, content, render) =>
			format(cache, theme, expanded, salt, content, () => {
				formats++;
				return render();
			}),
		);
		const component = build(theme);
		if (!component) throw new Error("expected a card");
		const rows = component.render(80);
		const before = formats;
		expect(before).toBeGreaterThan(0);
		component.releaseRenderCaches?.();
		expect(component.render(80)).toEqual(rows);
		return { before, after: formats };
	}

	// Write previews highlight without regard to width; re-highlighting every committed card on each resize replay
	// froze replay for seconds, so release keeps them.
	for (const { name, build } of [
		{
			name: "write call",
			build: (theme: Theme) => writeToolRenderer.renderCall(args, { expanded: true, isPartial: true }, theme),
		},
		{
			name: "write result",
			build: (theme: Theme) =>
				writeToolRenderer.renderResult(
					{ ...result, details: {} },
					{ expanded: true, isPartial: false },
					theme,
					args,
				),
		},
	]) {
		it(`keeps released ${name} highlighting and preserves its rows`, async () => {
			const { before, after } = await formatsAcrossRelease(build);
			expect(after).toBe(before);
		});
	}

	it("recomputes a released width-keyed edit call preview and preserves its rows", async () => {
		const { before, after } = await formatsAcrossRelease(theme =>
			editToolRenderer.renderCall(
				{ path: "src/values.ts", previewDiff: diff },
				{
					expanded: true,
					isPartial: true,
					renderContext: {
						perFileDiffPreview: [
							{ path: "src/values.ts", diff },
							{ path: "src/other.ts", diff: diff.replace("value", "other") },
						],
					},
				},
				theme,
			),
		);
		expect(after).toBeGreaterThan(before);
	});

	it("re-wraps a released edit result without re-highlighting its diff", async () => {
		let highlights = 0;
		const renderDiff = (text: string) => {
			highlights++;
			return text;
		};
		const { before, after } = await formatsAcrossRelease(theme =>
			editToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false, renderContext: { renderDiff } },
				theme,
				args,
			),
		);
		expect(after).toBeGreaterThan(before);
		expect(highlights).toBe(1);
	});

	it("drops a released write call's incremental highlighter state", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("expected the dark theme");
		const renderState = { expanded: false, isPartial: true, argsComplete: true };
		const card = writeToolRenderer.renderCall(args, renderState, theme);
		if (!card) throw new Error("expected the write call card");
		const rows = card.render(80);
		const preview = previewHighlightedLines(renderState);
		card.releaseRenderCaches?.();
		expect(await becomesCollectible(preview)).toBe(true);
		expect(card.render(80)).toEqual(rows);
	});
});

/**
 * The highlighted rows the streaming write preview keeps on the shared render
 * state. The state lives under a module-private symbol, so find it by shape.
 */
function previewHighlightedLines(renderState: object): WeakRef<object> {
	const carrier = renderState as Record<symbol, { highlightedLines?: unknown } | undefined>;
	for (const key of Object.getOwnPropertySymbols(renderState)) {
		const lines = carrier[key]?.highlightedLines;
		if (Array.isArray(lines) && lines.length > 0) return new WeakRef(lines);
	}
	throw new Error("expected the streaming call render to keep highlighted preview rows");
}

describe("Container.invalidate", () => {
	it("stops pinning the rows its children last rendered", async () => {
		const rendered: WeakRef<readonly string[]>[] = [];
		const container = new Container();
		container.addChild({
			render: () => {
				const rows = [`row ${rendered.length}`];
				rendered.push(new WeakRef(rows));
				return rows;
			},
		});
		container.render(40);
		container.invalidate();

		expect(await becomesCollectible(rendered[0]!)).toBe(true);
		// The container stays live throughout, so only its own memo could have pinned the rows.
		expect(container.render(40)).toEqual(["row 1"]);
	});
});
