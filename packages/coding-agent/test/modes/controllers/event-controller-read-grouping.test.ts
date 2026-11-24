/**
 * Read-group accretion across assistant completions.
 *
 * Reasoning models (and codex-style providers) frequently emit one `read` per
 * completion as `[thinking?, toolCall]` rather than batching parallel calls.
 * The transcript should still collapse an uninterrupted run of those reads into
 * a single read group; a completion that renders visible
 * content (non-empty text/thinking) is the only thing that breaks the run, so a
 * fresh group starts after it.
 *
 * Regression: every completion used to reset the active group at `message_start`,
 * so consecutive single-read completions never grouped (each rendered as its own
 * one-entry block).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AssistantView, InteractiveModeContext, PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isSettled } from "@oh-my-pi/pi-tui";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { blockText } from "../../helpers/transcript-text";

import { cfgDisplayShowTokenUsage, cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

type Block = AssistantMessage["content"][number];

function read(path: string): Block {
	return { type: "toolCall", id: `read-${path}`, name: "read", arguments: { path } } as Block;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): Block {
	return { type: "toolCall", id, name, arguments: args } as Block;
}

function thinking(text: string): Block {
	return { type: "thinking", thinking: text } as Block;
}

function assistantMessage(content: Block[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createFixture() {
	const ctx = createInteractiveModeContext();
	return { controller: new EventController(ctx), ctx };
}

/** Drive one assistant completion: message_start then a single full message_update. */
async function streamCompletion(controller: EventController, content: Block[]): Promise<void> {
	const message = assistantMessage(content);
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
}

function readGroups(ctx: InteractiveModeContext): PendingTool[] {
	const groups: PendingTool[] = [];
	for (const block of ctx.shell.transcript.blocks()) {
		const entry = ctx.transcriptEntry(block);
		if (entry?.kind === "tool" && entry.tool.group) groups.push(entry.tool);
	}
	return groups;
}

function assistants(ctx: InteractiveModeContext): AssistantView[] {
	const views: AssistantView[] = [];
	for (const block of ctx.shell.transcript.blocks()) {
		const entry = ctx.transcriptEntry(block);
		if (entry?.kind === "assistant") views.push(entry.view);
	}
	return views;
}

function header(group: PendingTool): string {
	return (
		blockText(group.block)
			.split("\n")
			.find(line => line.trim() !== "") ?? ""
	);
}

/** Blocks drawing the usage of the test's request (1234 in → `1.2K`). */
function usageBlocks(ctx: InteractiveModeContext) {
	return ctx.shell.transcript.blocks().filter(block => blockText(block).includes("1.2K"));
}

describe("EventController read-group accretion", () => {
	it("collapses a run of single-read completions into one group (mixed/empty thinking)", async () => {
		const { controller, ctx } = createFixture();

		// Mirrors the reported session: first read carries reasoning, the rest have
		// empty or absent thinking. None of them should break the run. Distinct files
		// keep one aggregated row per read so the count reflects the run size.
		await streamCompletion(controller, [thinking("Considering performance optimizations"), read("a.ts:180-250")]);
		await streamCompletion(controller, [thinking(""), read("b.ts:1-120")]);
		await streamCompletion(controller, [read("c.ts:1-220")]);
		await streamCompletion(controller, [read("d.ts:450-535")]);

		const groups = readGroups(ctx);
		expect(groups.length).toBe(1);
		expect(header(groups[0]!)).toContain("Read (4)");
	});

	it("nests a read-only completion's usage inside the active group", async () => {
		cfgDisplayShowTokenUsage.set(settings, true);
		const { controller, ctx } = createFixture();
		const message = assistantMessage([thinking("Reviewing the target"), read("usage.ts:1-50")]);
		message.usage = {
			input: 1234,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1241,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		message.timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();

		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);

		const [group] = readGroups(ctx);
		expect(group).toBeDefined();
		expect(usageBlocks(ctx)).toEqual([group!.block]);
	});

	it("keeps usage standalone when visible content follows a read", async () => {
		cfgDisplayShowTokenUsage.set(settings, true);
		const { controller, ctx } = createFixture();
		const message = assistantMessage([read("usage.ts:1-50"), thinking("Read complete")]);
		message.usage = {
			input: 1234,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1241,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		message.timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();

		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);

		const [group] = readGroups(ctx);
		expect(group).toBeDefined();
		const usage = usageBlocks(ctx);
		expect(usage).toHaveLength(1);
		expect(usage[0]).not.toBe(group!.block);
	});

	it("starts a fresh group after standalone usage for a mixed-tool turn ending in read", async () => {
		cfgDisplayShowTokenUsage.set(settings, true);
		const { controller, ctx } = createFixture();
		const message = assistantMessage([toolCall("bash", "bash-mixed", { command: "true" }), read("first.ts:1-50")]);
		message.usage = {
			input: 1234,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1241,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		message.timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();

		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);
		await streamCompletion(controller, [read("second.ts:1-50")]);

		const groups = readGroups(ctx);
		expect(groups).toHaveLength(2);
		const blocks = ctx.shell.transcript.blocks();
		const firstGroupIndex = blocks.indexOf(groups[0]!.block);
		const usageIndex = blocks.indexOf(usageBlocks(ctx)[0]!);
		const secondGroupIndex = blocks.indexOf(groups[1]!.block);
		expect(firstGroupIndex).toBeLessThan(usageIndex);
		expect(usageIndex).toBeLessThan(secondGroupIndex);
	});

	it("starts a new group after a completion that renders visible reasoning", async () => {
		const { controller, ctx } = createFixture();

		await streamCompletion(controller, [read("a.ts:1-50")]);
		await streamCompletion(controller, [read("b.ts:1-50")]);
		// Visible reasoning is a separator: the next reads form a distinct group.
		await streamCompletion(controller, [thinking("Now let me check the other files"), read("c.ts:1-40")]);
		await streamCompletion(controller, [read("d.ts:1-40")]);

		const groups = readGroups(ctx);
		expect(groups.length).toBe(2);
		expect(header(groups[0]!)).toContain("Read (2)");
		expect(header(groups[1]!)).toContain("Read (2)");
	});

	it("keeps the active group repaintable until it is finalized", async () => {
		const { controller, ctx } = createFixture();

		await streamCompletion(controller, [read("a.ts:1-50")]);
		const [group] = readGroups(ctx);
		// While it is the active run the block must stay in the live region so its
		// header can re-layout from `Read <path>` to `Read (N)` on risk terminals.
		expect(isSettled(group!.block.node)).toBe(false);

		// Settle the read so the group has no in-flight result. A finalized group
		// only commits to native scrollback once its pending entries resolve, so an
		// unsettled read would keep it live even after the run breaks.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "read-a.ts:1-50",
			toolName: "read",
			result: { content: [{ type: "text", text: "x" }], isError: false },
			isError: false,
		} as AgentSessionEvent);
		expect(isSettled(group!.block.node)).toBe(false);

		// A visible-reasoning completion breaks the run and finalizes the prior group.
		await streamCompletion(controller, [thinking("done exploring"), read("b.ts:1-50")]);
		expect(isSettled(group!.block.node)).toBe(true);
	});

	it("keeps live read images on the reply that issued the read, shown or not", async () => {
		cfgTerminalShowImages.override(Settings.instance, false);
		const { controller, ctx } = createFixture();
		const toolCall = read("hidden.png");
		await streamCompletion(controller, [toolCall]);
		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			mimeType: "image/png",
		};
		const id = toolCall.type === "toolCall" ? toolCall.id : "";

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "read",
			result: { content: [image], isError: false },
			isError: false,
		} as AgentSessionEvent);

		// The reply holds the image whatever the visibility; the display flag decides whether it draws.
		const [assistant] = assistants(ctx);
		expect(assistant).toBeDefined();
		expect(assistant!.toolResultImages.peek().get(id)).toEqual([image]);
	});
});
