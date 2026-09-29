import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { countElements } from "./test-utils";
import "./transcript-dom-shim";
import { followTranscriptTail, Transcript, updateTranscriptTailLock } from "../src/components/transcript/Transcript";
import { GuestClient } from "../src/lib/client";
import type { ActiveTool } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	stream?: AssistantMessage;
	streamDone?: boolean;
	working: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={props.stream ?? null}
			streamDone={props.streamDone ?? true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
		/>,
	);
}

describe("Transcript live tool rendering", () => {
	it("keeps active tool output collapsed instead of inserting it into the chat automatically", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, { ...activeTool(), partialResult: "private tool detail" }]]),
			working: true,
		});
		expect(countElements(html, '.tr-activity-head[aria-expanded="false"]')).toBe(1);
		expect(countElements(html, ".tv-card")).toBe(0);
		expect(countElements(html, '[role="status"]')).toBe(1);
		expect(html).not.toContain("private tool detail");
	});

	it("shows streamed and executed intents in one status without changing the reasoning prose", () => {
		const client = new GuestClient(`roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`, "reader");
		client.applyFrameForTest({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "intent-session", timestamp: "2026-09-27T00:00:00Z", cwd: "/work" },
			state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
			agents: [],
			entryCount: 0,
		});
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		const reasoning: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Keep **this reasoning** intact." }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "toolUse",
			timestamp: 42,
		};
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: reasoning } });
		const before = renderToStaticMarkup(<Transcript {...client.getSnapshot()} />);
		expect(countElements(before, ".tr-think strong")).toBe(1);
		expect(countElements(before, ".tr-think [role=status]")).toBe(0);
		const call: AssistantMessage = {
			...reasoning,
			content: [
				...reasoning.content,
				{
					type: "toolCall",
					id: "intent-read",
					name: "read",
					arguments: { i: "Inspecting the stream boundary..." },
				},
			],
		};
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: call } });
		const drafting = renderToStaticMarkup(<Transcript {...client.getSnapshot()} />);
		expect(drafting).toContain("Inspecting the stream boundary");
		expect(countElements(drafting, ".tr-think strong")).toBe(1);
		expect(countElements(drafting, "[role=status]")).toBe(1);
		expect(countElements(drafting, ".tv-card")).toBe(0);
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "intent-read",
				toolName: "read",
				args: { path: "actual.ts" },
				intent: "Reading the corrected resource",
			},
		});
		const running = renderToStaticMarkup(<Transcript {...client.getSnapshot()} />);
		expect(running).toContain("Reading the corrected resource");
		expect(running).not.toContain("Inspecting the stream boundary");
		expect(countElements(running, ".tr-think strong")).toBe(1);
		expect(countElements(running, ".tv-card")).toBe(0);
		client.applyFrameForTest({ t: "event", event: { type: "agent_end" } });
		expect(countElements(renderToStaticMarkup(<Transcript {...client.getSnapshot()} />), "[role=status]")).toBe(0);
		client.close();
	});
});

describe("Transcript reasoning segments", () => {
	it("shows streamed Markdown immediately and puts measured time below it when tools start, including history replay", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "**Inspect the retry path**\n\nCheck `relay.ts`.\n\n- Keep fatal errors terminal.",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "toolUse",
			timestamp: 1,
		};
		const streaming = renderTranscript({ stream: message, streamDone: false, working: true });
		expect(countElements(streaming, '.tr-think[aria-busy="true"] .tr-md strong')).toBe(1);
		expect(countElements(streaming, ".tr-think .tr-md code")).toBe(1);
		expect(countElements(streaming, ".tr-think .tr-md li")).toBe(1);
		expect(countElements(streaming, ".tr-think button")).toBe(0);
		expect(countElements(streaming, ".tr-think-time")).toBe(0);

		const executing: AssistantMessage = {
			...message,
			thinkingMs: { 0: 2350 },
			content: [
				...message.content,
				{ type: "toolCall", id: "read-retry", name: "read", arguments: { path: "relay.ts" } },
			],
		};
		const liveTool = renderTranscript({ stream: executing, streamDone: false, working: true });
		const replay = renderTranscript({
			entries: [
				{ type: "message", id: "reasoned", parentId: null, timestamp: "2026-09-27T00:00:00Z", message: executing },
			],
			working: false,
		});
		for (const html of [liveTool, replay]) {
			expect(countElements(html, '.tr-think[aria-busy="false"] .tr-md strong')).toBe(1);
			expect(countElements(html, ".tr-think-time")).toBe(1);
			expect(html).toContain("Thought for 2 seconds");
			expect(html.indexOf("Keep fatal errors terminal.")).toBeLessThan(html.indexOf("Thought for 2 seconds"));
			expect(html.indexOf("Thought for 2 seconds")).toBeLessThan(html.indexOf('class="tr-activity'));
			expect(countElements(html, ".tr-activity .tr-think")).toBe(0);
		}
	});

	it("keeps untimed history visible without inventing a duration and preserves provider-redacted reasoning", () => {
		const html = renderTranscript({
			stream: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "**Previously recorded reasoning**" },
					{ type: "redactedThinking", data: "opaque-not-display-text" },
				],
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "stop",
				timestamp: 1,
			},
			working: false,
		});
		expect(countElements(html, ".tr-think .tr-md strong")).toBe(1);
		expect(countElements(html, ".tr-think-time")).toBe(0);
		expect(countElements(html, ".tr-think-redacted")).toBe(1);
		expect(html).not.toContain("opaque-not-display-text");
	});
});

describe("Transcript activity folding", () => {
	function assistant(id: string, content: AssistantMessage["content"]): SessionEntry {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-07-09T00:00:00Z",
			message: {
				role: "assistant",
				content,
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "stop",
				timestamp: 1,
			},
		};
	}
	function toolResult(id: string, toolCallId: string, toolName: string): SessionEntry {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-07-09T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		};
	}

	it("packs at most three tool calls per work block and keeps reasoning out of them", () => {
		const entries: SessionEntry[] = [
			assistant("a1", [
				{ type: "text", text: "Looking into it." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "skill://tdd/SKILL.md" } },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/a.ts" } },
			]),
			toolResult("r1", "c1", "read"),
			toolResult("r2", "c2", "read"),
			assistant("a2", [
				{ type: "thinking", thinking: "now edit it" },
				{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/a.ts" } },
			]),
			toolResult("r3", "c3", "edit"),
			assistant("a3", [
				{ type: "toolCall", id: "c4", name: "edit", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: "c5", name: "bash", arguments: { command: "bun test" } },
				{ type: "toolCall", id: "c6", name: "probe_tool", arguments: {} },
			]),
			toolResult("r4", "c4", "edit"),
			toolResult("r5", "c5", "bash"),
			toolResult("r6", "c6", "probe_tool"),
			assistant("a4", [{ type: "text", text: "Fixed the bug." }]),
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--assistant")).toBe(1);
		expect(countElements(html, ".tr-activity")).toBe(3);
		expect(countElements(html, ".tv-card")).toBe(0);
		expect(countElements(html, ".tr-activity .tr-think")).toBe(0);
		expect(countElements(html, ".tr-think")).toBe(1);
		const order = [
			"Looking into it.",
			"Used skill tdd, read 1 file",
			'class="tr-think"',
			"Edited 1 file, ran 1 command",
			"Used probe_tool",
			"Fixed the bug.",
		].map(text => html.indexOf(text));
		expect(order.every(index => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("folds an injected skill prompt to its name and args, hiding the expanded skill body", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "skill-1",
				parentId: null,
				timestamp: "2026-07-09T00:00:00Z",
				customType: "skill-prompt",
				content: "# Diagnose\n\nSKILL-BODY-MARKER",
				details: { name: "diagnose", path: "/skills/diagnose/SKILL.md", args: "buffer growth" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(html).toContain("diagnose");
		expect(html).toContain("buffer growth");
		expect(html).not.toContain("SKILL-BODY-MARKER");
	});
});

describe("Transcript subagent traffic", () => {
	it("renders a task call as a subagent card with one row per spawned agent, outside work blocks", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "spawn",
				parentId: null,
				timestamp: "2026-07-09T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
						{
							type: "toolCall",
							id: "t1",
							name: "task",
							arguments: {
								tasks: [
									{ id: "Probe", description: "probe the relay" },
									{ id: "Sweep", description: "sweep the docs" },
								],
							},
						},
					],
					model: "test/model",
					usage: assistantUsage(),
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "spawn-result",
				parentId: "spawn",
				timestamp: "2026-07-09T00:00:01Z",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "task",
					content: [{ type: "text", text: "Spawned 2 agents" }],
					details: {
						results: [{ id: "Sweep", exitCode: 1, durationMs: 4_000 }],
						progress: [{ id: "Probe", status: "running" }],
					},
					isError: false,
					timestamp: 2,
				},
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-subagents")).toBe(1);
		expect(countElements(html, ".tr-activity .tr-subagents")).toBe(0);
		expect(countElements(html, ".tr-subagent")).toBe(2);
		expect(countElements(html, ".tr-subagent-state--running")).toBe(1);
		expect(countElements(html, ".tr-subagent-state--failed")).toBe(1);
		expect(html).toContain("probe the relay");
		expect(html).toContain("Read 1 file");
	});

	it("shows a background job result as a compact row, hiding the model-facing envelope until opened", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "job-1",
				parentId: null,
				timestamp: "2026-07-09T00:00:00Z",
				customType: "async-result",
				content:
					'<system-notice>\nBackground job Sweep has completed. Resume your work using the result below.\n<task-result id="Sweep" agent="task" status="aborted" duration="2s">\n<abort-reason>budget hit</abort-reason>\n<output>\nJOB-OUTPUT-MARKER\n</output>\n</task-result>\n</system-notice>',
				details: { jobs: [{ jobId: "Sweep", type: "task", durationMs: 2_000 }] },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-job")).toBe(1);
		expect(html).toContain("was aborted");
		expect(html).toContain("2.0s");
		expect(html).not.toContain("task-result");
		expect(html).not.toContain("JOB-OUTPUT-MARKER");
	});

	it("shows an inter-agent message as attributed chat without the IRC envelope", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "irc-1",
				parentId: null,
				timestamp: "2026-07-09T00:00:00Z",
				customType: "irc:incoming",
				content: "<irc>\nIncoming IRC message from agent `Probe`:\n\nfound **0** duplicates\n</irc>",
				details: { from: "Probe", message: "found **0** duplicates" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-irc .tr-md strong")).toBe(1);
		expect(html).toContain("Probe");
		expect(html).not.toContain("Incoming IRC message");
	});

	it("renders parent steering and custom IRC with the same attribution in main and task transcripts", () => {
		const body = "Please inspect **both paths** and `client.ts`.\n\nKeep the response concise.";
		const envelope = `[Wait interrupted by message]\n<irc from="parent" agent="Main">\n${body}\n</irc>`;
		const parent: SessionEntry = {
			type: "message",
			id: "parent-irc",
			parentId: null,
			timestamp: "2026-09-28T00:00:00Z",
			message: { role: "user", content: envelope, timestamp: 1 },
		};
		const custom: SessionEntry = {
			type: "custom_message",
			id: "custom-irc",
			parentId: null,
			timestamp: parent.timestamp,
			customType: "irc:incoming",
			display: true,
			content: "model-facing wrapper",
			details: { from: "Main", message: body },
		};
		for (const compact of [false, true]) {
			for (const entry of [parent, custom]) {
				const html = renderToStaticMarkup(
					<Transcript
						entries={[entry]}
						stream={null}
						streamDone
						activeTools={new Map()}
						working={false}
						compact={compact}
						recipientName="Worker"
					/>,
				);
				expect(countElements(html, ".tr-irc .tr-md strong")).toBe(1);
				expect(countElements(html, ".tr-irc .tr-md code")).toBe(1);
				expect(countElements(html, ".tr-prompt")).toBe(0);
				expect(html).toContain('class="tr-irc-from">Main');
				expect(html).toContain('class="tr-irc-to">Worker');
				expect(html).toContain("Keep the response concise.");
				expect(html).not.toContain("Wait interrupted by message");
				expect(html).not.toContain("&lt;irc");
			}
		}
	});

	it("preserves parent IRC content blocks, attachments, and literal tags inside the body", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "parent-blocks",
				parentId: null,
				timestamp: "2026-09-28T00:00:00Z",
				message: {
					role: "user",
					timestamp: 1,
					content: [
						{ type: "text", text: '[Wait interrupted by message]\r\n<irc from="parent" agent="' },
						{
							type: "text",
							text: 'Main">\r\nThe literal `</irc>` must stay. <img src=x onerror="alert(1)">\r\n</irc>',
						},
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
				},
			},
		];
		const html = renderTranscript({ entries, working: false });
		expect(countElements(html, ".tr-irc")).toBe(1);
		expect(countElements(html, ".tr-irc .tr-md code")).toBe(1);
		expect(html).toContain("&lt;/irc&gt;");
		expect(countElements(html, ".tr-irc img")).toBe(1);
		expect(html).toContain("data:image/png;base64,aW1hZ2U=");
		expect(countElements(html, "[onerror]")).toBe(0);
	});

	it("does not reinterpret quoted, incomplete, or unrelated IRC-like user text", () => {
		const envelope = '[Wait interrupted by message]\n<irc from="parent" agent="Main">\nhello\n</irc>';
		const entries: SessionEntry[] = [
			`Explain this:\n${envelope}`,
			`\`\`\`text\n${envelope}\n\`\`\``,
			'[Wait interrupted by message]\n<irc from="parent" agent="Main">\nunclosed',
			'[Wait interrupted by message]\n<irc from="peer" agent="Main">\nhello\n</irc>',
		].map((content, index) => ({
			type: "message",
			id: `ordinary-${index}`,
			parentId: null,
			timestamp: "2026-09-28T00:00:00Z",
			message: { role: "user", content, timestamp: index },
		}));
		const html = renderTranscript({ entries, working: false });
		expect(countElements(html, ".tr-prompt")).toBe(4);
		expect(countElements(html, ".tr-irc")).toBe(0);
		expect(html).toContain("unclosed");
		expect(html).toContain("Explain this:");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("Transcript tail-follow scroll operations", () => {
	it("restores tail-follow when a connection becomes live", () => {
		const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
		const lock = { current: false };

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_000);

		element.scrollTop = 600;
		updateTranscriptTailLock(element, lock);
		expect(lock.current).toBe(false);

		element.scrollHeight = 1_200;
		followTranscriptTail(element, lock);
		expect(element.scrollTop).toBe(600);

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_200);
	});
});

describe("Transcript windowing", () => {
	it("mounts only the newest 100 entries and offers the rest", () => {
		const entries: SessionEntry[] = Array.from({ length: 250 }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `message-${i}-end`, timestamp: i },
		}));

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user")).toBe(100);
		expect(html).toContain("message-249-end");
		expect(html).toContain("message-150-end");
		expect(html).not.toContain("message-149-end");
		expect(html).toContain("show 150 earlier");
	});
});
