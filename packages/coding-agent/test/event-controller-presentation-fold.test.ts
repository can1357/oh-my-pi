/**
 * Migrated bash/eval routes stopped emitting live
 * `tool_execution_update`s, so EventController folds `tool_presentation`
 * events into per-call accumulators and pushes cumulative card snapshots.
 *
 * Contracts under test:
 *  - The TUI card receives cumulative partial snapshots composed as
 *    `[stream.text, …displays, …facts]` (renderTuiPresentation ordering;
 *    status stays with the `tool_execution_end` path).
 *  - Scope guard: synthesis lives only in the display consumer — an
 *    ACP-bound subscriber watching the same event stream sees ZERO
 *    synthesized `tool_execution_update`s while the TUI gets snapshots.
 *  - Leak guard: folds clear at settled and at tool_execution_end.
 *  - Head-window cap: folded process text is bounded with an honest
 *    truncation marker (carried from day one; the feed cap is separate).
 */
import { describe, expect, it, vi } from "bun:test";
import type { ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	PRESENTATION_FOLD_HEAD_WINDOW_BYTES,
	ToolPresentationDisplayFold,
} from "@oh-my-pi/pi-coding-agent/modes/tool-presentation-fold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { renderDisplayOutput } from "@oh-my-pi/pi-coding-agent/presentation/projections";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Card result shape accepted by ToolExecutionComponent.updateResult. */
interface CardUpdate {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

function createFixture() {
	const chatContainer = new TranscriptContainer();
	const children = chatContainer.children;
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = {
		isInitialized: true,
		init: async () => {},
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		toolOutputExpanded: false,
		pendingTools,
		chatContainer,
		session: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		showWarning: vi.fn(),
		viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), children, pendingTools };
}

/**
 * Shared-bus harness: every emitted event fans out to the TUI controller AND
 * is recorded on `wire` — standing in for the raw stream an ACP-bound
 * subscriber consumes natively.
 */
function createBusHarness() {
	const { controller, children, pendingTools } = createFixture();
	const wire: AgentSessionEvent[] = [];
	const emit = async (event: AgentSessionEvent) => {
		wire.push(event);
		await controller.handleEvent(event);
	};
	return { controller, children, pendingTools, wire, emit };
}

/** Capture the snapshot text of every partial card update. */
function captureSnapshots(component: ToolExecutionComponent): string[] {
	const snapshots: string[] = [];
	vi.spyOn(component, "updateResult").mockImplementation((result: CardUpdate) => {
		snapshots.push(result.content[0]?.text ?? "");
	});
	return snapshots;
}

function startedEvent(toolCallId: string): AgentSessionEvent {
	return {
		type: "tool_presentation",
		toolCallId,
		toolName: "bash",
		event: { type: "started", call: { toolCallId, toolName: "bash", title: "ls -la", kind: "execute" } },
	};
}

describe("EventController tool_presentation fold", () => {
	it("composes cumulative snapshots [stream.text, …displays, …facts] onto the live card", async () => {
		await initTheme(false);
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const h = createBusHarness();

		await h.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		const component = h.children[h.children.length - 1] as ToolExecutionComponent;
		const snapshots = captureSnapshots(component);
		expect(snapshots.length).toBe(0);

		await h.emit(startedEvent("t1"));
		// No snapshot before anything observable has been folded.
		expect(snapshots.length).toBe(0);

		const producer = new ToolPresentationStream(
			streamId("s:t1"),
			event => void h.emit({ type: "tool_presentation", toolCallId: "t1", toolName: "bash", event }),
		);
		producer.appendTerminal("hello ");
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { answer: 42 } }] });
		producer.appendTerminal("world");
		producer.fact({ kind: "notice", text: "mind the gap" });
		await Promise.resolve();

		expect(snapshots.length).toBe(4);
		// Cumulative: every snapshot is a complete view, growing monotonically.
		expect(snapshots[0]).toContain("hello");
		expect(snapshots[0]).not.toContain("display");
		expect(snapshots[1]).toContain("display[1]");
		expect(snapshots[2]).toContain("hello world");
		expect(snapshots[2]).not.toContain("mind the gap");
		expect(snapshots[3]).toContain("hello world");
		expect(snapshots[3]).toContain("display[1]");
		expect(snapshots[3]).toContain("42");
		expect(snapshots[3].indexOf("hello world")).toBeLessThan(snapshots[3].indexOf("display[1]"));
		expect(snapshots[3].indexOf("display[1]")).toBeLessThan(snapshots[3].indexOf("mind the gap"));
	});

	it("scope guard: ACP-bound subscriber sees zero synthesized updates while TUI gets snapshots", async () => {
		await initTheme(false);
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const h = createBusHarness();

		await h.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } });
		const component = h.children[h.children.length - 1] as ToolExecutionComponent;
		const snapshots = captureSnapshots(component);

		const producer = new ToolPresentationStream(
			streamId("s:t2"),
			event => void h.emit({ type: "tool_presentation", toolCallId: "t2", toolName: "bash", event }),
		);
		await h.emit(startedEvent("t2"));
		producer.appendTerminal("chunk one\n");
		producer.appendTerminal("chunk two\n");
		producer.fact({ kind: "notice", text: "note" });
		await Promise.resolve();

		// TUI display consumer: cumulative snapshots landed on the card.
		expect(snapshots.length).toBeGreaterThanOrEqual(2);
		// ACP-bound subscriber: the shared bus carried only genuine events —
		// no synthesized `tool_execution_update` was ever injected.
		const synthesizedUpdates = h.wire.filter(event => event.type === "tool_execution_update");
		expect(synthesizedUpdates.length).toBe(0);
		expect(h.wire.filter(event => event.type === "tool_presentation").length).toBe(4);

		component.seal();
	});

	it("clears the fold at settled and settles the card via tool_execution_end (leak guard)", async () => {
		await initTheme(false);
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const h = createBusHarness();

		await h.emit({ type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: { command: "ls" } });
		const component = h.children[h.children.length - 1] as ToolExecutionComponent;
		const updateSpy = vi.spyOn(component, "updateResult");

		const producer = new ToolPresentationStream(
			streamId("s:t3"),
			event => void h.emit({ type: "tool_presentation", toolCallId: "t3", toolName: "bash", event }),
		);
		await h.emit(startedEvent("t3"));
		producer.appendTerminal("payload\n");
		await Promise.resolve();
		expect(updateSpy).toHaveBeenCalledTimes(1);

		// Settled stops folding and drops the accumulator…
		await h.emit({
			type: "tool_presentation",
			toolCallId: "t3",
			toolName: "bash",
			event: { type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		});
		expect(updateSpy).toHaveBeenCalledTimes(1);

		// …and the real result settles the card through the end path.
		await h.emit({
			type: "tool_execution_end",
			toolCallId: "t3",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		});
		expect(h.pendingTools.has("t3")).toBe(false);
		for (const call of updateSpy.mock.calls.slice(0, -1)) expect(call[1]).toBe(true);
		expect(updateSpy.mock.calls.at(-1)?.[1]).toBe(false);

		component.seal();
	});
});

describe("ToolPresentationDisplayFold head-window cap", () => {
	function foldEvents(events: readonly ToolPresentationEvent[], headWindowBytes?: number): string {
		const fold = new ToolPresentationDisplayFold(headWindowBytes);
		for (const event of events) fold.append(event);
		return fold.snapshotText();
	}

	it("bounds process text at the explicit cap and appends an honest truncation marker", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId("cap"), event => events.push(event));
		producer.appendTerminal("abcdefghijklmnop");
		producer.appendTerminal("qrst");
		const text = foldEvents(events, 16);
		expect(text).toContain("abcdefghijklmnop");
		expect(text).not.toContain("qrst");
		expect(text).toContain("truncated");
		expect(text).toContain("4 bytes not shown");

		// Latched: later chunks keep counting as elided, never re-enter the head.
		producer.appendTerminal("more");
		expect(foldEvents(events, 16)).toContain("8 bytes not shown");
	});

	it("drops displays over the item budget and marks the omission in the snapshot", () => {
		const fold = new ToolPresentationDisplayFold(PRESENTATION_FOLD_HEAD_WINDOW_BYTES, { itemLimit: 1 });
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId("display-count"), event => events.push(event));
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { kept: 1 } }] });
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { dropped: 2 } }] });
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { dropped: 3 } }] });
		for (const event of events) fold.append(event);

		const text = fold.snapshotText();
		expect(text).toContain('"kept": 1');
		expect(text).not.toContain("dropped");
		expect(text).toContain("2 display outputs over the display budget not shown");
	});

	it("drops displays over the rendered-byte budget instead of retaining them", () => {
		const kept = { kind: "sequence", items: [{ kind: "json", value: { kept: 1 } }] } as const;
		const keptBytes = Buffer.byteLength(renderDisplayOutput(kept), "utf-8");
		// Budget fits exactly the first display and nothing more.
		const fold = new ToolPresentationDisplayFold(PRESENTATION_FOLD_HEAD_WINDOW_BYTES, { maxBytes: keptBytes });
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId("display-bytes"), event => events.push(event));
		producer.declareDisplay(kept);
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { oversized: "x".repeat(64) } }] });
		for (const event of events) fold.append(event);

		const text = fold.snapshotText();
		expect(text).toContain('"kept": 1');
		expect(text).not.toContain("oversized");
		expect(text).toContain("1 display output over the display budget not shown");
	});

	it("defaults to the 1 MiB live-display head window", () => {
		expect(PRESENTATION_FOLD_HEAD_WINDOW_BYTES).toBe(1024 * 1024);
	});
});
