/**
 * Read-group accretion across assistant completions.
 *
 * Reasoning models (and codex-style providers) frequently emit one `read` per
 * completion as `[thinking?, toolCall]` rather than batching parallel calls.
 * The transcript should still collapse an uninterrupted run of those reads into
 * a single {@link ReadToolGroupComponent}; a completion that renders visible
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
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type Component, Image, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

const originalImageProtocol = TERMINAL.imageProtocol;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
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
	const chatContainer = new TranscriptContainer();
	const sessionMock = { getToolByName: () => undefined, hasBuiltInTool: () => true, extensionRunner: undefined };
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		settings: { get: () => false },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearTransientSessionUi: () => {},
		session: sessionMock,
		sessionManager: { getCwd: () => process.cwd() },
		viewSession: sessionMock,
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), chatContainer };
}

/** Drive one assistant completion: message_start then a single full message_update. */
async function streamCompletion(controller: EventController, content: Block[]): Promise<void> {
	const message = assistantMessage(content);
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
}

function readGroups(chatContainer: TranscriptContainer): ReadToolGroupComponent[] {
	return chatContainer.children.filter((c): c is ReadToolGroupComponent => c instanceof ReadToolGroupComponent);
}

function header(group: ReadToolGroupComponent): string {
	return Bun.stripANSI(group.render(120).join("\n")).split("\n")[0] ?? "";
}

function hasImageComponent(component: Component): boolean {
	if (component instanceof Image) return true;
	if (!("children" in component) || !Array.isArray(component.children)) return false;
	return component.children.some(child => hasImageComponent(child));
}

describe("EventController read-group accretion", () => {
	it("collapses a run of single-read completions into one group (mixed/empty thinking)", async () => {
		const { controller, chatContainer } = createFixture();

		// Mirrors the reported session: first read carries reasoning, the rest have
		// empty or absent thinking. None of them should break the run. Distinct files
		// keep one aggregated row per read so the count reflects the run size.
		await streamCompletion(controller, [thinking("Considering performance optimizations"), read("a.ts:180-250")]);
		await streamCompletion(controller, [thinking(""), read("b.ts:1-120")]);
		await streamCompletion(controller, [read("c.ts:1-220")]);
		await streamCompletion(controller, [read("d.ts:450-535")]);

		const groups = readGroups(chatContainer);
		expect(groups.length).toBe(1);
		expect(header(groups[0]!)).toContain("Read (4)");
	});

	it("nests a read-only completion's usage inside the active group", async () => {
		settings.set("display.showTokenUsage", true);
		const { controller, chatContainer } = createFixture();
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

		const [group] = readGroups(chatContainer);
		expect(group).toBeDefined();
		const usageBlocks = chatContainer.children.filter(component =>
			Bun.stripANSI(component.render(120).join("\n")).includes("2026-01-02 03:04:05"),
		);
		expect(usageBlocks).toEqual([group!]);
	});

	it("keeps usage standalone when visible content follows a read", async () => {
		settings.set("display.showTokenUsage", true);
		const { controller, chatContainer } = createFixture();
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

		const [group] = readGroups(chatContainer);
		expect(group).toBeDefined();
		const usageBlocks = chatContainer.children.filter(component =>
			Bun.stripANSI(component.render(120).join("\n")).includes("2026-01-02 03:04:05"),
		);
		expect(usageBlocks).toHaveLength(1);
		expect(usageBlocks[0]).not.toBe(group!);
	});

	it("starts a fresh group after standalone usage for a mixed-tool turn ending in read", async () => {
		settings.set("display.showTokenUsage", true);
		const { controller, chatContainer } = createFixture();
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

		const groups = readGroups(chatContainer);
		expect(groups).toHaveLength(2);
		const firstGroupIndex = chatContainer.children.indexOf(groups[0]!);
		const usageIndex = chatContainer.children.findIndex(component =>
			Bun.stripANSI(component.render(120).join("\n")).includes("2026-01-02 03:04:05"),
		);
		const secondGroupIndex = chatContainer.children.indexOf(groups[1]!);
		expect(firstGroupIndex).toBeLessThan(usageIndex);
		expect(usageIndex).toBeLessThan(secondGroupIndex);
	});

	it("starts a new group after a completion that renders visible reasoning", async () => {
		const { controller, chatContainer } = createFixture();

		await streamCompletion(controller, [read("a.ts:1-50")]);
		await streamCompletion(controller, [read("b.ts:1-50")]);
		// Visible reasoning is a separator: the next reads form a distinct group.
		await streamCompletion(controller, [thinking("Now let me check the other files"), read("c.ts:1-40")]);
		await streamCompletion(controller, [read("d.ts:1-40")]);

		const groups = readGroups(chatContainer);
		expect(groups.length).toBe(2);
		expect(header(groups[0]!)).toContain("Read (2)");
		expect(header(groups[1]!)).toContain("Read (2)");
	});

	it("keeps the active group repaintable until it is finalized", async () => {
		const { controller, chatContainer } = createFixture();

		await streamCompletion(controller, [read("a.ts:1-50")]);
		const [group] = readGroups(chatContainer);
		// While it is the active run the block must stay in the live region so its
		// header can re-layout from `Read <path>` to `Read (N)` on risk terminals.
		expect(group!.isTranscriptBlockFinalized()).toBe(false);

		// Settle the read so the group has no in-flight result. A finalized group
		// only commits to native scrollback once its pending entries resolve, so an
		// unsettled read would keep it live even after the run breaks.
		group!.updateResult({ content: [{ type: "text", text: "x" }], isError: false }, false, "read-a.ts:1-50");
		expect(group!.isTranscriptBlockFinalized()).toBe(false);

		// A visible-reasoning completion breaks the run and finalizes the prior group.
		await streamCompletion(controller, [thinking("done exploring"), read("b.ts:1-50")]);
		expect(group!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("retains live read images while hidden so the visibility toggle can reveal them", async () => {
		Settings.instance.override("terminal.showImages", false);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const { controller, chatContainer } = createFixture();
		const toolCall = read("hidden.png");
		await streamCompletion(controller, [toolCall]);
		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			mimeType: "image/png",
		};

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: toolCall.type === "toolCall" ? toolCall.id : "",
			toolName: "read",
			result: { content: [image], isError: false },
			isError: false,
		} as AgentSessionEvent);

		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		expect(hasImageComponent(assistant!)).toBe(false);
		assistant?.setImagesVisible(true);
		expect(hasImageComponent(assistant!)).toBe(true);
	});
});
