import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type Component, TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";

const TOOL_CALL_A_ID = "toolu_mixed_text_order_a";
const TOOL_CALL_B_ID = "toolu_mixed_text_order_b";
const INTRO_MARKER = "INTRO TEXT BEFORE FIRST TOOL";
const TOOL_RESULT_A_MARKER = "TOOL RESULT FROM FIRST TOOL";
const MIDDLE_MARKER = "MIDDLE TEXT BETWEEN TOOL CALLS";
const TOOL_RESULT_B_MARKER = "TOOL RESULT FROM SECOND TOOL";
const FINAL_MARKER = "FINAL ANSWER AFTER SECOND TOOL";
const HIDDEN_BASH_COMMAND_MARKER = "HIDDEN BASH COMMAND MARKER";
const HIDDEN_BASH_FAILURE_MARKER = "HIDDEN BASH FAILURE MARKER";
const HIDDEN_READ_PATH_MARKER = "hidden-tool-activity.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

function lineContaining(lines: string[], marker: string): number {
	const index = lines.findIndex(line => line.includes(marker));
	if (index === -1) {
		throw new Error(`Rendered transcript did not contain ${marker}:\n${lines.join("\n")}`);
	}
	return index;
}

function createFixture(
	hideToolActivity = false,
	toolByName: (name: string) => AgentTool | undefined = () => undefined,
) {
	let hasDisplayableThinkingContent = false;
	const ctx = createInteractiveModeContext({
		session: { getToolByName: toolByName },
		hideToolActivity,
		noteDisplayableThinkingContent: vi.fn((message: AssistantMessage) => {
			const hasThinking = message.content.some(
				content => content.type === "thinking" && content.thinking.trim() !== "",
			);
			if (!hasThinking || hasDisplayableThinkingContent) return false;
			hasDisplayableThinkingContent = true;
			return true;
		}),
		lastAssistantUsage: zeroUsage(),
	});
	ctx.chatContainer.setToolActivityVisible(!hideToolActivity);

	return { controller: new EventController(ctx), chatContainer: ctx.chatContainer, ctx };
}

describe("EventController mixed assistant text/tool rendering", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "display.smoothStreaming": false, "display.cacheMissMarker": true },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("finalizes and removes an orphaned streaming component on the next message_start", async () => {
		// Regression: a stream that died between message_start and message_end
		// (transport drop, hook throw) left its component live in the transcript.
		// One unfinalized block at the retirement frontier blocks history commits
		// for everything after it, so the whole transcript tail stayed in the
		// mutable viewport in pressure mode (no separators, compacted blocks).
		const { controller, chatContainer } = createFixture();

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage([{ type: "thinking", thinking: "**dead attempt**" }]),
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const orphan = chatContainer.children.at(-1) as Component & {
			isTranscriptBlockFinalized(): boolean;
		};
		expect(orphan.isTranscriptBlockFinalized()).toBe(false);

		// Retry attempt streams a fresh message without the dead one ever ending.
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		expect(chatContainer.children).not.toContain(orphan);
		expect(orphan.isTranscriptBlockFinalized()).toBe(true);
	});

	it("renders assistant text segments in order around two tool results from one mixed message", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCallA: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "contract_probe_b",
			arguments: { value: "b" },
		};
		const started = assistantMessage([]);
		const withFirstToolCall = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCallA]);
		const withSecondToolCall = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
		]);
		const completed = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withFirstToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: toolCallA,
				partial: withFirstToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "message_update",
			message: withSecondToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: toolCallB,
				partial: withSecondToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const liveLines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		expect(lineContaining(liveLines, INTRO_MARKER)).toBeLessThan(lineContaining(liveLines, MIDDLE_MARKER));
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			args: { value: "a" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			args: { value: "b" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			result: { content: [{ type: "text", text: TOOL_RESULT_B_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: completed } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const lines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		const introLine = lineContaining(lines, INTRO_MARKER);
		const toolResultALine = lineContaining(lines, TOOL_RESULT_A_MARKER);
		const middleLine = lineContaining(lines, MIDDLE_MARKER);
		const toolResultBLine = lineContaining(lines, TOOL_RESULT_B_MARKER);
		const finalLine = lineContaining(lines, FINAL_MARKER);

		expect(introLine).toBeLessThan(toolResultALine);
		expect(toolResultALine).toBeLessThan(middleLine);
		expect(lines.filter(line => line.includes(MIDDLE_MARKER))).toHaveLength(1);
		expect(middleLine).toBeLessThan(toolResultBLine);
		expect(toolResultBLine).toBeLessThan(finalLine);
	});

	it("uses the canonical mounted-tool renderer live and after transcript rebuild", async () => {
		const githubTool: AgentTool = {
			name: "github",
			label: "GitHub",
			description: "GitHub test tool",
			parameters: type({}),
			execute: async () => ({ content: [] }),
		};
		const toolByName = (name: string) => (name === "github" ? githubTool : undefined);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_mounted_github",
			name: "github",
			arguments: { op: "repo_view", repo: "can1357/oh-my-pi" },
		};
		const streaming = assistantMessage([toolCall]);

		const live = createFixture(false, toolByName);
		await live.controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await live.controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(Bun.stripANSI(live.chatContainer.render(120).join("\n"))).toContain("GitHub Repo can1357/oh-my-pi");

		const executionOnly = createFixture(false, toolByName);
		await executionOnly.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(Bun.stripANSI(executionOnly.chatContainer.render(120).join("\n"))).toContain(
			"GitHub Repo can1357/oh-my-pi",
		);

		const rebuilt = createFixture(false, toolByName);
		const rebuiltHelpers = new UiHelpers(rebuilt.ctx);
		rebuilt.ctx.addMessageToChat = (message, options) => rebuiltHelpers.addMessageToChat(message, options);
		rebuiltHelpers.renderSessionContext({
			messages: [streaming],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		expect(Bun.stripANSI(rebuilt.chatContainer.render(120).join("\n"))).toContain("GitHub Repo can1357/oh-my-pi");

		// Presentation resolves the renderer by name; the tool call itself is untouched.
		expect(toolCall.name).toBe("github");
	});

	it("keeps assistant text streaming while hiding bash failures and grouped read activity", async () => {
		const { controller, chatContainer } = createFixture(true);
		const bashCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "bash",
			arguments: { command: `printf '${HIDDEN_BASH_COMMAND_MARKER}'` },
		};
		const readCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "read",
			arguments: { path: HIDDEN_READ_PATH_MARKER },
		};
		const started = assistantMessage([]);
		const streaming = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			bashCall,
			{ type: "text", text: MIDDLE_MARKER },
			readCall,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: readCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			args: bashCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			result: { content: [{ type: "text", text: HIDDEN_BASH_FAILURE_MARKER }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			result: { content: [{ type: "text", text: "read result must stay hidden" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: streaming } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain(INTRO_MARKER);
		expect(rendered).toContain(MIDDLE_MARKER);
		expect(rendered).toContain(FINAL_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_COMMAND_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_FAILURE_MARKER);
		expect(rendered).not.toContain(HIDDEN_READ_PATH_MARKER);
	});

	it("does not recreate a completed grouped read when later thinking arrives", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-completed-stable",
			name: "read",
			arguments: { path: "stable-completed-read.ts" },
		};
		const withRead = assistantMessage([{ type: "thinking", thinking: "planning the read" }, readCall]);
		const withLaterThinking = assistantMessage([
			{ type: "thinking", thinking: "planning the read" },
			readCall,
			{ type: "thinking", thinking: "more reasoning after the read finished" },
		]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withRead,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: readCall, partial: withRead },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: "read",
			result: { content: [{ type: "text", text: "file contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(ctx.pendingTools.size).toBe(0);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(1);

		await controller.handleEvent({
			type: "message_update",
			message: withLaterThinking,
			assistantMessageEvent: { type: "thinking_delta", delta: "more", contentIndex: 2, partial: withLaterThinking },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(groups).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("stable-completed-read.ts");
	});

	it("settles a grouped read whose result arrives before the streamed card", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-result-before-card",
			name: "read",
			arguments: { path: "result-before-card.ts" },
		};
		const streaming = assistantMessage([readCall]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: "read",
			result: { content: [{ type: "text", text: "held read body" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(0);
		expect(ctx.pendingTools.size).toBe(0);

		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: readCall, partial: streaming },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(groups).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(groups[0]!.render(120).join("\n"))).toContain("result-before-card.ts");
	});

	it("finalizes closed inter-tool reasoning so multiple completed greps can retire", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const greps = [1, 2, 3].map(n => ({
			call: {
				type: "toolCall" as const,
				id: `grep-mixed-${n}`,
				name: "grep",
				arguments: { pattern: `pattern-${n}` },
			},
			result: `GREP_RESULT_${n}_UNIQUE`,
			thinking: `REASONING_AFTER_GREP_${n}`,
		}));

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "REASONING_BEFORE_TOOLS" }];
		for (const grep of greps) {
			content.push(grep.call);
			const withTool = assistantMessage([...content]);
			await controller.handleEvent({
				type: "message_update",
				message: withTool,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: content.length - 1,
					toolCall: grep.call,
					partial: withTool,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: grep.call.id,
				toolName: "grep",
				result: { content: [{ type: "text", text: grep.result }] },
				isError: false,
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
			content.push({ type: "thinking", thinking: grep.thinking });
			const withThinking = assistantMessage([...content]);
			await controller.handleEvent({
				type: "message_update",
				message: withThinking,
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: grep.thinking,
					contentIndex: content.length - 1,
					partial: withThinking,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
		}

		expect(ctx.pendingTools.size).toBe(0);
		const assistants = chatContainer.children.filter(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		const tools = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(tools).toHaveLength(3);
		for (const tool of tools) {
			expect(tool.isTranscriptBlockFinalized()).toBe(true);
		}
		expect(assistants.length).toBeGreaterThanOrEqual(3);
		for (const assistant of assistants.slice(0, -1)) {
			expect(assistant.isTranscriptBlockFinalized()).toBe(true);
		}
		expect(assistants.at(-1)!.isTranscriptBlockFinalized()).toBe(false);

		const flushed = Bun.stripANSI(chatContainer.peekFlushBatch(120)?.rows.join("\n") ?? "");
		expect(flushed).toContain("GREP_RESULT_1_UNIQUE");
		expect(flushed).toContain("GREP_RESULT_2_UNIQUE");
	});

	for (const arrival of ["early", "buffered"] as const) {
		it(`renders inline images from ${arrival} held read results`, async () => {
			const protocol = Object.getOwnPropertyDescriptor(TERMINAL, "imageProtocol")!;
			Object.defineProperty(TERMINAL, "imageProtocol", { value: null });
			try {
				const { controller, chatContainer, ctx } = createFixture();
				cfgTerminalShowImages.set(ctx.settings, true);
				const readCall: ToolCall = {
					type: "toolCall",
					id: `read-image-${arrival}`,
					name: "read",
					arguments: { path: "pixel.png" },
				};
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: readCall.id,
					toolName: "read",
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
						},
					],
					isError: false,
					timestamp: 1,
				};
				if (arrival === "buffered") {
					ctx.session.agent.getPendingToolResults = () => [result];
					controller.resetTranscriptAnchors();
				}
				await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
				if (arrival === "early") {
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId: readCall.id,
						toolName: "read",
						result,
						isError: false,
					});
				}
				const message = assistantMessage([{ type: "text", text: "Inspecting the sample image." }, readCall]);
				const update: Extract<AgentSessionEvent, { type: "message_update" }> = {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: readCall, partial: message },
				};
				await controller.handleEvent(update);
				await controller.handleEvent(update);
				const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
				expect(rendered.match(/\[Image: image\/png\]/g)).toHaveLength(1);
				expect(ctx.pendingTools.size).toBe(0);
			} finally {
				Object.defineProperty(TERMINAL, "imageProtocol", protocol);
			}
		});
	}

	it("preserves the cache baseline when auto compaction starts", async () => {
		const { controller, ctx } = createFixture();
		const warm: Usage = {
			...zeroUsage(),
			input: 1_000,
			cacheRead: 830_000,
			totalTokens: 831_000,
		};
		ctx.lastAssistantUsage = warm;

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		} as Extract<AgentSessionEvent, { type: "auto_compaction_start" }>);

		expect(ctx.lastAssistantUsage).toBe(warm);
	});

	it("preserves the cache baseline when auto compaction ends without a rewrite", async () => {
		const { controller, ctx } = createFixture();
		const warm: Usage = {
			...zeroUsage(),
			input: 1_000,
			cacheRead: 830_000,
			totalTokens: 831_000,
		};
		ctx.lastAssistantUsage = warm;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: true,
			result: undefined,
			skipped: false,
			willRetry: false,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(ctx.lastAssistantUsage).toBe(warm);
	});

	it("clears the cache baseline after the auto-shake partial rebuild", async () => {
		const { controller, ctx } = createFixture();
		const warm: Usage = {
			...zeroUsage(),
			input: 1_000,
			cacheRead: 830_000,
			totalTokens: 831_000,
		};
		ctx.lastAssistantUsage = warm;
		vi.spyOn(ctx, "rebuildChatFromMessages").mockImplementation(() => {
			ctx.lastAssistantUsage = warm;
		});

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "shake",
			errorMessage: "still over the threshold",
			skipped: false,
			aborted: false,
			willRetry: false,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(ctx.lastAssistantUsage).toBeUndefined();
	});

	it("clears the cache baseline after the compaction rebuild reseeds it", async () => {
		const { controller, ctx } = createFixture();
		const preCompactionUsage: Usage = {
			...zeroUsage(),
			input: 1_000,
			cacheRead: 830_000,
			totalTokens: 831_000,
		};
		ctx.lastAssistantUsage = preCompactionUsage;
		vi.spyOn(ctx, "rebuildChatFromMessages").mockImplementation(() => {
			// Simulate the replay reseeding the live baseline from a kept
			// pre-compaction assistant.
			ctx.lastAssistantUsage = preCompactionUsage;
		});

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: {} as never,
			aborted: false,
			willRetry: false,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(ctx.lastAssistantUsage).toBeUndefined();
	});

	it("keeps a real miss after a no-op end and starts a new baseline after a committed rewrite", async () => {
		const { controller, ctx } = createFixture();
		const warm: Usage = {
			...zeroUsage(),
			input: 2,
			cacheRead: 50_000,
			cacheWrite: 900,
			totalTokens: 50_902,
		};
		const cold: Usage = {
			...zeroUsage(),
			input: 100,
			cacheRead: 0,
			cacheWrite: 51_000,
			totalTokens: 51_100,
		};
		const setCacheInvalidation = vi.spyOn(AssistantMessageComponent.prototype, "setCacheInvalidation");

		// A no-op end (aborted/cancelled) must preserve the baseline, so the next
		// genuinely cold turn still renders the marker.
		ctx.lastAssistantUsage = warm;
		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: true,
			result: undefined,
			skipped: false,
			willRetry: false,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);
		await controller.handleEvent({
			type: "message_start",
			message: assistantMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: { ...assistantMessage([]), usage: cold },
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(setCacheInvalidation).toHaveBeenCalledTimes(1);
		expect(setCacheInvalidation).toHaveBeenCalledWith({ reprocessedTokens: 51_100 });

		// A committed rewrite drops the old baseline: the first turn seeds the
		// new one, and only a later warm->cold transition renders the marker.
		setCacheInvalidation.mockClear();
		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: {} as never,
			aborted: false,
			willRetry: false,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);
		await controller.handleEvent({
			type: "message_start",
			message: assistantMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: { ...assistantMessage([]), usage: warm },
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(setCacheInvalidation).not.toHaveBeenCalled();

		await controller.handleEvent({
			type: "message_start",
			message: assistantMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: { ...assistantMessage([]), usage: cold },
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(setCacheInvalidation).toHaveBeenCalledTimes(1);
	});
});
