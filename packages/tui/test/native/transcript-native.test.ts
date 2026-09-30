import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage, createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { CompactionSummaryMessageComponent } from "@oh-my-pi/pi-tui/chat/compaction-summary-message";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { LateDiagnosticsMessageComponent } from "@oh-my-pi/pi-tui/chat/late-diagnostics-message";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-tui/chat/stripped-tool-calls-placeholder";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { buildAsyncResultBlock, buildFileMentionBlock } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	setNativeRendering(false);
	stopSharedSpinnerTicker();
});

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], usage = USAGE): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp: 1,
	};
}

/** Viewer transcript entries: one generic (renderer-less) tool call and its result. */
function toolTranscript(): TranscriptEntryLike[] {
	return [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: assistant([{ type: "toolCall", id: "call-1", name: "lookup_thing", arguments: { q: "x" } }]),
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "lookup_thing",
				content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

async function startWith(build: (h: TspHarness) => void): Promise<TspHarness> {
	harness = await TspHarness.start();
	build(harness);
	await harness.render();
	return harness;
}

function opsSince(h: TspHarness, frameCount: number): TspOp[] {
	return h.frames.slice(frameCount).flatMap(frame => frame.ops);
}

describe("native transcript", () => {
	it("streams assistant text as appends to one md node that stops streaming when final", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		component.updateContent(assistant([{ type: "text", text: "Hello" }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: "Hello", stream: true });

		const before = h.frames.length;
		component.updateContent(assistant([{ type: "text", text: "Hello, streaming world" }]), { transient: true });
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["text", md!.id, "append", ", streaming world"]);

		component.updateContent(assistant([{ type: "text", text: "Hello, streaming world" }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		const final = h.byId(md!.id);
		expect(final?.p).toMatchObject({ text: "Hello, streaming world" });
		expect(final?.p).not.toHaveProperty("stream");
		expect(h.errors).toEqual([]);
	});

	it("mirrors a native toggle into the tool card and re-collapses it on a transcript-wide collapse", async () => {
		let builder: ChatTranscriptBuilder | undefined;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			builder.append(toolTranscript());
			h.tui.addChild(builder.container);
		});
		const cardNode = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
		expect(cardNode?.p).toMatchObject({ status: "done", collapsible: true, collapsed: true });

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: cardNode!.id, collapsed: false });
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: false });

		builder!.setExpanded(false);
		await h.render();
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: true });
		expect(h.errors).toEqual([]);
	});

	it("describes a custom tool (MCP) through the tool's own describe hooks", async () => {
		const tool = {
			name: "mcp__demo_lookup",
			label: "demo/lookup",
			description: "demo",
			parameters: {},
			execute: async () => ({ content: [] }),
			mergeCallAndResult: true,
			describeCall: () => ({ body: [text("call body")] }),
			describeResult: () => ({ body: [text("result body")] }),
		} as unknown as AgentTool;
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const component = new ToolExecutionComponent(
			"mcp__demo_lookup",
			{ q: "x" },
			{ useBuiltInRenderer: false },
			tool,
			ui,
		);
		const h = await startWith(h => h.tui.addChild(component));
		expect(h.find(node => node.k === "text" && node.p?.text === "call body")).toBeDefined();

		component.updateResult({ content: [{ type: "text", text: "raw" }], isError: false });
		await h.render();
		expect(h.find(node => node.k === "text" && node.p?.text === "result body")).toBeDefined();
		expect(h.find(node => node.k === "text" && node.p?.text === "call body")).toBeUndefined();
		expect(h.errors).toEqual([]);
		component.dispose();
	});

	it("settles finalized blocks and still delivers later changes to them", async () => {
		let builder: ChatTranscriptBuilder | undefined;
		const h = await startWith(h => {
			builder = new ChatTranscriptBuilder({ ui: h.tui, cwd: "/tmp", requestRender: () => h.tui.requestRender() });
			builder.append(toolTranscript());
			h.tui.addChild(builder.container);
		});
		const cardNode = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
		expect(opsSince(h, 0)).toContainEqual(["settle", cardNode!.id]);

		const before = h.frames.length;
		builder!.setExpanded(true);
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["set", cardNode!.id, expect.objectContaining({ collapsed: false })]);
		expect(h.byId(cardNode!.id)?.p).toMatchObject({ collapsed: false });
		expect(h.errors).toEqual([]);
	});

	it("schedules no repaint timers for spinners or the thinking pulse while a surface is live", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		let repaints = 0;
		const ui = {
			requestRender: () => repaints++,
			requestComponentRender: () => repaints++,
			resetDisplay: () => {},
		};
		// A generic tool whose call is still streaming would tick the shared spinner on the ANSI path.
		const tool = new ToolExecutionComponent("lookup_thing", { q: "x" }, {}, undefined, ui);
		tool.setExecutionStarted("call-1");
		const thinking = new AssistantMessageComponent(undefined, true, () => repaints++);
		thinking.updateContent(assistant([{ type: "thinking", thinking: "Weighing the options carefully." }]), {
			transient: true,
		});
		repaints = 0;
		try {
			vi.advanceTimersByTime(2_000);
			expect(repaints).toBe(0);
			expect(tool.describe().p).toMatchObject({ status: "running" });
		} finally {
			tool.dispose();
			thinking.dispose();
			vi.useRealTimers();
		}
	});

	it("describes every transcript block semantically: no rows fallback, ANSI styling or box glyphs", async () => {
		const h = await startWith(h => {
			const builder = new ChatTranscriptBuilder({
				ui: h.tui,
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
			});
			builder.append(toolTranscript());
			const container = builder.container;
			const user = new UserMessageComponent("Please **fix** the build");
			user.setReaction("👍");
			container.addChild(user);
			container.addChild(new CollapsedSyntheticMessageComponent("# Session update\nbody"));
			const reply = new AssistantMessageComponent(
				assistant([
					{ type: "thinking", thinking: "Considering the failing step." },
					{ type: "text", text: "Done. See `make`." },
				]),
			);
			reply.setCacheInvalidation({ reprocessedTokens: 50_000 });
			container.addChild(reply);
			const bash = new BashExecutionComponent("ls -la", h.tui);
			bash.appendOutput("\x1b[31mred\x1b[0m output\nsecond line");
			bash.setComplete(1, false);
			container.addChild(bash);
			const cell = new EvalExecutionComponent("print(1)", h.tui);
			cell.appendOutput("1\n");
			cell.setComplete(0, false);
			container.addChild(cell);
			container.addChild(
				new CompactionSummaryMessageComponent(
					createCompactionSummaryMessage("Summary text", 256_000, "2026-01-01"),
				),
			);
			container.addChild(
				new CustomMessageComponent(
					createCustomMessage("note", "Injected **context**", true, undefined, "2026-01-01"),
				),
			);
			container.addChild(
				new TtsrNotificationComponent([{ name: "no-sleep", description: "Never sleep\nin tests" }]),
			);
			container.addChild(new TodoReminderComponent([{ content: "Ship it", status: "pending" }], 1, 3));
			container.addChild(
				new LateDiagnosticsMessageComponent([
					{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["src/a.ts:1:1 [error] bad"] },
				]),
			);
			container.addChild(new StrippedToolCallsPlaceholder(2, true));
			container.addChild(
				buildAsyncResultBlock(
					createCustomMessage(
						"async-result",
						"done",
						true,
						{ jobId: "j1", type: "bash", durationMs: 1200 },
						"2026",
					),
				),
			);
			container.addChild(buildFileMentionBlock([{ path: "src/a.ts", content: "", lineCount: 3 }], 0));
			container.addChild(
				createAdvisorMessageCard({ notes: [{ note: "Check the cache", severity: "blocker" }] }, () => false, theme),
			);
			h.tui.addChild(container);
		});

		const offending: string[] = [];
		const visit = (node: TspNode): void => {
			if (node.k === "rows") offending.push(`rows fallback ${node.id}`);
			if (node.k !== "ansi") {
				const props = JSON.stringify(node.p ?? {});
				if (props.includes("\\u001b")) offending.push(`ANSI escape in ${node.k} ${node.id}: ${props}`);
				if (/[─│╭╮╰╯┌┐└┘]/.test(props)) offending.push(`box glyph in ${node.k} ${node.id}: ${props}`);
			}
			for (const child of node.c ?? []) visit(child);
		};
		visit(h.doc());
		expect(offending).toEqual([]);
		const roles = h.findAll(node => typeof node.p?.role === "string").map(node => node.p!.role);
		expect(roles).toEqual(
			expect.arrayContaining([
				"omp.tool.lookup_thing",
				"omp.user",
				"omp.user.synthetic",
				"omp.assistant",
				"omp.thinking",
				"omp.bash",
				"omp.eval",
				"omp.compaction",
				"omp.custom",
				"omp.notice.ttsr",
				"omp.notice.todo",
				"omp.diagnostics.late",
				"omp.marker.cache-miss",
				"omp.status-block",
				"omp.advisor",
			]),
		);
		expect(h.errors).toEqual([]);
	});
});
