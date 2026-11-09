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
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-tui/chat/stripped-tool-calls-placeholder";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setInternalUrlSchemeHost } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { buildAsyncResultBlock, buildFileMentionBlock } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { card, node, text } from "@oh-my-pi/pi-tui/native/describe";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	messageBlock,
	onTranscriptPresentationRedrawn,
	PresentedBlock,
	presentNative,
	setTranscriptPresenters,
} from "@oh-my-pi/pi-tui/chat/transcript-presentation";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Container } from "@oh-my-pi/pi-tui/tui";

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

/** Viewer transcript entries: a tool call whose wire name aliases a canonical registry entry. */
function aliasToolTranscript(): TranscriptEntryLike[] {
	return [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: assistant([{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "ls -la" } }]),
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "shell",
				content: [{ type: "text", text: "file-a\nfile-b" }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

/** Viewer transcript entries: an aliased write call whose target is a reply-scoped out:// URL. */
function aliasReplyWriteTranscript(): TranscriptEntryLike[] {
	return [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "xd://write",
					arguments: { path: "out://final", content: "Rebuild answer: 42" },
				},
			]),
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "xd://write",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

/** Viewer transcript entries: an aliased read call plus its result as a separate message. */
function aliasReadTranscript(): TranscriptEntryLike[] {
	return [
		{
			type: "message",
			id: "a2",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: assistant([
				{ type: "toolCall", id: "call-2", name: "xd://read", arguments: { path: "/tmp/rebuild-target.ts" } },
			]),
		},
		{
			type: "message",
			id: "r2",
			parentId: "a2",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "xd://read",
				content: [{ type: "text", text: "const rebuilt = true;\n" }],
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

	it("streams a table row to the terminal only once its line ends", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const table = "| PR | Who |\n|---|---|\n| [#1](https://example.com/pull/1) | a |";
		component.updateContent(assistant([{ type: "text", text: `${table}\n| [#2](https://exa` }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: table, stream: true });

		// A finished last row is sent once its newline arrives and stays sent while a tool call streams after it.
		const before = h.frames.length;
		const row = "\n| [#2](https://example.com/pull/2) | b |";
		component.updateContent(
			assistant([
				{ type: "text", text: `${table}${row}\n` },
				{ type: "toolCall", id: "call-1", name: "lookup_thing", arguments: {} },
			]),
			{ transient: true },
		);
		await h.render();
		expect(opsSince(h, before)).toContainEqual(["text", md!.id, "append", row]);

		const full = `${table}${row}\n| [#3](https://ex`;
		component.updateContent(assistant([{ type: "text", text: full }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.byId(md!.id)?.p).toMatchObject({ text: full });
		expect(h.errors).toEqual([]);
	});

	it("streams an open link as its closed form, fixing only the tail as the URL grows", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const prose = "See [the docs](https://ex";
		component.updateContent(assistant([{ type: "text", text: prose }]), { transient: true });
		await h.render();
		const md = h.find(node => node.k === "md");
		expect(md?.p).toMatchObject({ text: `${prose})`, stream: true });

		const before = h.frames.length;
		component.updateContent(assistant([{ type: "text", text: `${prose}ample.com` }]), { transient: true });
		await h.render();
		// Only the new URL text crosses the wire: the guessed `)` stays in place behind it.
		expect(opsSince(h, before)).toEqual([["splice", md!.id, prose.length, 0, "ample.com"]]);

		const full = `${prose}ample.com) and more`;
		component.updateContent(assistant([{ type: "text", text: full }]));
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.byId(md!.id)?.p).toMatchObject({ text: full });
		expect(h.errors).toEqual([]);
	});

	it("hands the terminal session-resolved targets for relative links once the segment closes", async () => {
		const component = new AssistantMessageComponent();
		const h = await startWith(h => h.tui.addChild(component));
		const source = [
			"| Board | Shot |",
			"|---|---|",
			"| 10×10 | [Open screenshot](artifacts/10x10.png) |",
			"",
			"See [the log][log] and [the crop](crop.png).",
			"Code `[x](artifacts/10x10.png)` stays, [web](https://x.dev) and [gone](missing.md) too.",
			"",
			"[log]: logs/run.txt",
		].join("\n");
		component.updateContent(assistant([{ type: "text", text: source }]), { transient: true });
		await h.render();
		expect(h.find(node => node.k === "md")?.p).toMatchObject({ text: source, stream: true });

		const wt = "file:///C:/Users/me/.omp/wt/cr2-43939c6";
		component.updateContent(assistant([{ type: "text", text: source }]));
		component.setLinkTargets(
			new Map([
				["artifacts/10x10.png", `${wt}/artifacts/10x10.png`],
				["logs/run.txt", `${wt}/logs/run.txt`],
				["crop.png", `${wt}/crop(1).png`],
			]),
		);
		component.markTranscriptBlockFinalized();
		await h.render();
		expect(h.find(node => node.k === "md")?.p).toMatchObject({
			text: [
				"| Board | Shot |",
				"|---|---|",
				`| 10×10 | [Open screenshot](${wt}/artifacts/10x10.png) |`,
				"",
				`See [the log][log] and [the crop](<${wt}/crop(1).png>).`,
				"Code `[x](artifacts/10x10.png)` stays, [web](https://x.dev) and [gone](missing.md) too.",
				"",
				`[log]: ${wt}/logs/run.txt`,
			].join("\n"),
		});
		expect(h.errors).toEqual([]);
	});

	it("keeps submitted skill text visible when the prompt is collapsed", async () => {
		const component = new SkillMessageComponent({
			role: "custom",
			customType: "skill-prompt",
			content: "Loaded SKILL.md instructions",
			display: true,
			attribution: "user",
			timestamp: 1,
			details: {
				name: "grill-with-docs",
				path: "/tmp/SKILL.md",
				lineCount: 3,
				prompt: "/skill:grill-with-docs Organize the project foundation",
			},
		});
		const h = await startWith(h => h.tui.addChild(component));
		const card = h.find(node => node.p?.role === "omp.skill");
		expect(card?.p).not.toHaveProperty("collapsible");
		expect(card?.c?.find(child => child.k === "md")?.p).toMatchObject({
			text: "Organize the project foundation",
		});
		const prompt = h.find(node => node.p?.role === "omp.skill.prompt");
		expect(prompt?.p).toMatchObject({ collapsible: true, collapsed: true });
		expect(prompt?.c).toBeUndefined();

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: prompt!.id, collapsed: false });
		expect(h.byId(prompt!.id)?.p).toMatchObject({ collapsed: false });
		expect(h.byId(prompt!.id)?.c?.[0]?.p).toMatchObject({ text: "Loaded SKILL.md instructions" });

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: prompt!.id, collapsed: true });
		expect(h.byId(prompt!.id)?.p).toMatchObject({ collapsed: true });
		expect(h.byId(prompt!.id)?.c).toBeUndefined();
		expect(h.byId(card!.id)?.c?.find(child => child.k === "md")?.p).toMatchObject({
			text: "Organize the project foundation",
		});
		expect(h.errors).toEqual([]);
	});

	it("keeps diagnostics an edit card absorbed visible when a presenter registered later hides the card", async () => {
		// Regression guard: diagnostics routed into the card before any presenter existed, then
		// hidden with it once a presenter hid the card.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("write", { path: "src/a.ts", content: "x" }, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		try {
			const h = await startWith(h => {
				tool.setArgsComplete("call-1");
				tool.setExecutionStarted("call-1");
				tool.updateResult({ content: [{ type: "text", text: "Wrote 1 line" }], isError: false });
				transcript.addChild(tool);
				h.tui.addChild(transcript);
			});
			expect(
				tool.attachLateDiagnostics([{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["bad"] }]),
			).toBe(true);
			await h.render();
			expect(h.find(node => node.p?.role === "omp.diagnostics.late")).toBeUndefined();

			setTranscriptPresenters([block => (block.type === "toolCall" ? "hidden" : undefined)]);
			tool.refreshTranscriptPresentation();
			await h.render();
			const late = h.find(node => node.p?.role === "omp.diagnostics.late");
			expect(late).toBeDefined();
			expect(late?.p).not.toMatchObject({ hidden: true });

			// `display.hideToolActivity` hides them like the card they came from.
			transcript.setToolActivityVisible(false);
			await h.render();
			const hiddenLate = h.find(node => node.p?.role === "omp.diagnostics.late");
			expect(hiddenLate === undefined || hiddenLate.p?.hidden === true).toBe(true);
		} finally {
			setTranscriptPresenters([]);
			tool.dispose();
		}
	});

	it("draws a replayed transcript without the extension presenters", async () => {
		// Regression guard: an overlay's replay (another agent's history, the link browser, rewind,
		// /copy) handed to the main transcript's presenters, which hid or compacted calls there.
		setTranscriptPresenters([block => (block.type === "toolCall" ? "hidden" : undefined)]);
		try {
			const h = await startWith(h => {
				const builder = new ChatTranscriptBuilder({
					ui: h.tui,
					cwd: "/tmp",
					requestRender: () => h.tui.requestRender(),
				});
				builder.append(toolTranscript());
				h.tui.addChild(builder.container);
			});
			const card = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.lookup_thing");
			expect(card).toBeDefined();
			expect(card?.p).not.toMatchObject({ hidden: true });
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("draws a replayed transcript's `!` runs and messages without the extension presenters", () => {
		// Regression guard: a replay (link browser, rewind, transcript viewer) drawing its message
		// and event blocks through the main session's presenters while its tool cards draw stock.
		setTranscriptPresenters([block => (block.type === "message" ? "hidden" : undefined)]);
		try {
			const entries: TranscriptEntryLike[] = [
				{
					type: "message",
					id: "b1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					message: {
						role: "bashExecution",
						command: "echo viewer-run",
						output: "VIEWER-OUT",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: 1,
					},
				},
			];
			const builder = new ChatTranscriptBuilder({
				ui: { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} } as never,
				cwd: "/tmp",
				requestRender: () => {},
			});
			builder.append(entries);
			expect(Bun.stripANSI(builder.container.render(80).join("\n"))).toContain("echo viewer-run");
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("reports a message block whose presentation changed under rows it already drew", () => {
		// Regression guard: a `!` run or message block in terminal scrollback (never drawn again)
		// keeping its stale rows there after its data changed outside a refresh (a `!` run recorded).
		setTranscriptPresenters([
			block =>
				block.type === "message" && block.message.role === "custom" && block.message.customType === "late"
					? "hidden"
					: "compact",
		]);
		const redrawn: unknown[] = [];
		const unsubscribe = onTranscriptPresentationRedrawn(owner => redrawn.push(owner));
		try {
			const message = createCustomMessage("early", "body", true, undefined, "2026-01-01");
			const block = new PresentedBlock(new CustomMessageComponent(message), messageBlock(message));
			block.render(80);
			expect(redrawn).toEqual([]);

			block.setBlock(messageBlock({ ...message, customType: "late" }));
			expect(redrawn).toEqual([block]);
		} finally {
			unsubscribe();
			setTranscriptPresenters([]);
		}
	});

	it("keeps a skill whose prompt the user opened in Tern full when a presenter later hides it", () => {
		// Regression guard: the skill's `prompt` disclosure is a nested toggle, so the wrapper missed
		// the user's expansion and a later hidden/compact answer folded the opened prompt away.
		let answer: "full" | "hidden" = "full";
		setTranscriptPresenters([block => (block.type === "message" ? answer : undefined)]);
		try {
			const message = createCustomMessage(
				"skill-prompt",
				"SKILL-PROMPT-TEXT",
				true,
				{ name: "unslop", path: "/s/SKILL.md", lineCount: 1 },
				"2026-01-01",
			);
			const block = new PresentedBlock(new SkillMessageComponent(message as never), messageBlock(message));
			expect(block.render(80).length).toBeGreaterThan(0);

			block.handleNativeEvent({ type: "toggle", key: "prompt", collapsed: false });
			answer = "hidden";
			block.refreshTranscriptPresentation();
			expect(Bun.stripANSI(block.render(80).join("\n"))).toContain("SKILL-PROMPT-TEXT");
			const cx = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
			expect(JSON.stringify(block.describe(cx))).toContain("SKILL-PROMPT-TEXT");
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("draws a wrapped block that paints its own rows as those rows", async () => {
		// Regression guard: the wrapper asking `inner.describe()` directly, so a Container subclass
		// that overrides render but inherits the column description lost its rows in Tern.
		class PaintedRows extends Container {
			override render(): readonly string[] {
				return ["PAINTED-ROW"];
			}
		}
		const message = createCustomMessage("painted", "body", true, undefined, "2026-01-01");
		const h = await startWith(h => h.tui.addChild(new PresentedBlock(new PaintedRows(), messageBlock(message))));
		const rows = h.find(node => node.k === "rows");
		expect(JSON.stringify(rows?.p)).toContain("PAINTED-ROW");
	});

	it("renders an aliased wire-named tool call through the canonical renderer", async () => {
		const bashTool = {
			name: "bash",
			label: "Bash",
			description: "demo",
			parameters: {},
		} as unknown as AgentTool;
		const h = await startWith(h => {
			const builder = new ChatTranscriptBuilder({
				ui: h.tui,
				getTool: name => (name === "shell" ? bashTool : undefined),
				isBuiltInTool: name => name === "bash",
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
			});
			builder.append(aliasToolTranscript());
			h.tui.addChild(builder.container);
		});
		// The wire name never keys the card; the canonical registry name does.
		expect(h.find(node => node.k === "tool" && node.p?.role === "omp.tool.shell")).toBeUndefined();
		const card = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.bash");
		expect(card?.p).toMatchObject({ name: "bash", status: "done" });
		// The canonical bash renderer described the call; the generic fallback would not.
		expect(h.find(node => node.k === "code" && node.p?.role === "omp.tool.bash.command")?.p).toMatchObject({
			text: "ls -la",
		});
		expect(h.errors).toEqual([]);
	});

	it("rebuilds an aliased reply-scoped write as prose, not a tool card", async () => {
		setInternalUrlSchemeHost({
			spec: scheme => (scheme === "out" ? { selectors: "none", write: { scope: "reply" } } : undefined),
			specs: () => new Map([["out", { selectors: "none", write: { scope: "reply" } }]]),
		});
		const writeTool = {
			name: "write",
			label: "Write",
			description: "demo",
			parameters: {},
		} as unknown as AgentTool;
		const h = await startWith(h => {
			const builder = new ChatTranscriptBuilder({
				ui: h.tui,
				getTool: name => (name === "xd://write" ? writeTool : undefined),
				isBuiltInTool: name => name === "write",
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
			});
			builder.append(aliasReplyWriteTranscript());
			h.tui.addChild(builder.container);
		});
		// The wire name resolves to canonical `write`, so the reply-scoped target
		// draws as assistant prose; a tool card would mean the reply-write check
		// never saw the canonical name.
		expect(h.find(node => node.k === "tool")).toBeUndefined();
		expect(h.find(node => node.k === "md")?.p).toMatchObject({ text: "Rebuild answer: 42" });
		expect(h.errors).toEqual([]);
	});

	it("keeps an aliased read result in the collapsed read group", async () => {
		const readTool = {
			name: "read",
			label: "Read",
			description: "demo",
			parameters: {},
		} as unknown as AgentTool;
		const h = await startWith(h => {
			const builder = new ChatTranscriptBuilder({
				ui: h.tui,
				getTool: name => (name === "xd://read" ? readTool : undefined),
				isBuiltInTool: name => name === "read",
				cwd: "/tmp",
				requestRender: () => h.tui.requestRender(),
			});
			builder.append(aliasReadTranscript());
			h.tui.addChild(builder.container);
		});
		// The result resolved to canonical `read`, so the group materializes and
		// settles (one file renders as the group's inline read row); a wire-name
		// check would discard the result with no read node at all.
		const group = h.find(node => node.k === "tool" && node.p?.role === "omp.tool.read");
		expect(group?.p).toMatchObject({ status: "done", collapsible: false });
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

	it("keeps a streaming write open until it settles, then folds it like a finished thought", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const content = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const tool = new ToolExecutionComponent("write", { path: "src/a.ts", content }, {}, undefined, ui);
		try {
			expect(tool.describe().p).toMatchObject({ status: "pending", collapsible: true, collapsed: false });
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			expect(tool.describe().p).toMatchObject({ status: "running", collapsed: false });
			tool.updateResult({ content: [{ type: "text", text: "Wrote 40 lines" }], isError: false });
			expect(tool.describe().p).toMatchObject({ status: "done", collapsed: true });
		} finally {
			tool.dispose();
		}
	});

	it("keeps a finished todo call's checklist open", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("todo", { op: "start", task: "lex" }, {}, undefined, ui);
		try {
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			tool.updateResult({
				content: [{ type: "text", text: "ok" }],
				details: {
					storage: "memory",
					phases: [{ name: "Build", tasks: [{ content: "lex", status: "in_progress" }] }],
				},
				isError: false,
			});
			expect(tool.describe().p).toMatchObject({ status: "done", collapsible: true, collapsed: false });
		} finally {
			tool.dispose();
		}
	});

	it("folds a presenter's compact call into one inline row showing every presenter row, and opens the full card on toggle", () => {
		// Regression guard: Tern clipping a multi-row compact call to its first row, or its toggle
		// leaving the compact row in place instead of the full card.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui);
		setTranscriptPresenters([
			block =>
				block.type === "toolCall"
					? { compact: { label: "worker", rows: ["row one", "row two", "row three"] } }
					: undefined,
		]);
		try {
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			tool.updateResult({ content: [{ type: "text", text: "hi" }], isError: false });
			// A terminal that draws `tool` nodes, as Tern does.
			const cx = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
			const compact = tool.describe(cx);
			expect(compact.p).toMatchObject({ frame: "inline", collapsed: true, preview: { lines: 3 }, target: "worker" });
			expect(compact.c).toHaveLength(1);
			expect(JSON.stringify(compact.c)).toContain("row three");

			tool.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
			const full = tool.describe(cx);
			// omp's own bash card is an inline row too: tell them apart by the presenter's label.
			expect(full.p).not.toMatchObject({ target: "worker" });
			expect(JSON.stringify(full)).not.toContain("row one");
		} finally {
			setTranscriptPresenters([]);
			tool.dispose();
		}
	});

	it("sends a presenter's compact label and rows as single sanitized lines, so the preview shows every row", () => {
		// Regression guard: a row with a line break overran `preview.lines` and clipped the last row;
		// tabs and ANSI from raw tool output reached Tern verbatim.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui);
		setTranscriptPresenters([
			block =>
				block.type === "toolCall"
					? {
							compact: {
								label: "work\ner\t\x1b[31mred",
								rows: ["a\nb", [{ t: "c\td\x1b[1m", s: "muted" }], "last"],
							},
						}
					: undefined,
		]);
		try {
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			tool.updateResult({ content: [{ type: "text", text: "hi" }], isError: false });
			const cx = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
			const compact = tool.describe(cx);
			expect(compact.p).toMatchObject({ preview: { lines: 3 } });
			const label = JSON.stringify(compact.p);
			const body = JSON.stringify(compact.c);
			for (const sent of [label, body]) {
				expect(sent).not.toContain("\\t");
				expect(sent).not.toContain("\\u001b");
			}
			expect(label).not.toContain("\\n");
			const bodyText = (compact.c ?? []).flatMap(child =>
				"k" in child && child.k === "text" ? (child.p?.spans ?? []).map(part => part.t) : [],
			);
			expect(bodyText.join("").split("\n")).toHaveLength(3);
			expect(bodyText.join("")).toContain("last");
		} finally {
			setTranscriptPresenters([]);
			tool.dispose();
		}
	});

	it("keeps a compact tool row toggleable when the full drawing has no body", () => {
		// Regression guard: a bodiless tool folded to a row with no toggle, so its full drawing was unreachable.
		const full = node("tool", { name: "read", title: "Read", target: "src/a.ts", status: "done" });
		const compact = presentNative(full, { mode: "compact", label: "worker", rows: [] }, { role: "r", title: "Read" });
		expect(compact.p).toMatchObject({ collapsible: true, collapsed: true, target: "worker" });
	});

	it("sanitizes a non-tool block's own head target when compact", () => {
		// Regression guard: raw call input (tabs, ANSI, line breaks) reaching the compact card's head.
		const full = card({ role: "r" }, [text("body")]);
		const compact = presentNative(
			full,
			{ mode: "compact", rows: [] },
			{
				role: "r",
				title: "Bash",
				target: "echo\thi\x1b[31m\nnext",
			},
		);
		const head = JSON.stringify(compact.p);
		expect(head).not.toContain("\\t");
		expect(head).not.toContain("\\u001b");
		expect(head).not.toContain("\\n");
	});

	describe("a compact call in the terminal", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		function compactCall(rows: string[]): ToolExecutionComponent {
			setTranscriptPresenters([
				block => (block.type === "toolCall" ? { compact: { label: "JOB", rows } } : undefined),
			]);
			const tool = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui);
			tool.setArgsComplete("call-1");
			tool.setExecutionStarted("call-1");
			return tool;
		}

		it("keeps a plain-string row's spacing", () => {
			// Regression guard: whitespace runs in a string row collapsing (alignment, quoted values).
			const tool = compactCall(['x = "a  b"', "\tindented"]);
			try {
				const drawn = Bun.stripANSI(tool.render(80).join("\n"));
				expect(drawn).toContain('x = "a  b"');
				expect(drawn).toContain("     indented");
			} finally {
				setTranscriptPresenters([]);
				tool.dispose();
			}
		});

		it("strips control sequences from omp's own summary on a plain compact row", () => {
			// Regression guard: a bash command's escape sequence reaching the terminal through the compact head.
			setTranscriptPresenters([block => (block.type === "toolCall" ? "compact" : undefined)]);
			const tool = new ToolExecutionComponent("bash", { command: "echo \x1b[?1049hboom\tx" }, {}, undefined, ui);
			try {
				tool.setArgsComplete("call-1");
				const drawn = tool.render(80).join("\n");
				expect(drawn).not.toContain("\x1b[?1049h");
				expect(drawn).not.toContain("\t");
				expect(Bun.stripANSI(drawn)).toContain("boom");
			} finally {
				setTranscriptPresenters([]);
				tool.dispose();
			}
		});

		it("keeps its head first in a squeezed allocation", () => {
			// Regression guard: a one-row allocation keeping the last presenter row instead of the head.
			const tool = compactCall(["detail", "tail"]);
			try {
				tool.setTranscriptAllocation(1, { tick: 0, now: 0 });
				const drawn = tool.render(80).map(row => Bun.stripANSI(row));
				expect(drawn).toHaveLength(1);
				expect(drawn[0]).toContain("JOB");
			} finally {
				setTranscriptPresenters([]);
				tool.dispose();
			}
		});
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

describe("background job completion rows", () => {
	it("show a job's minimizer filter and byte counts", () => {
		const minimized = { filter: "git", inputBytes: 28_213, outputBytes: 9_720, artifactId: "2" };
		const block = buildAsyncResultBlock(
			createCustomMessage(
				"async-result",
				"done",
				true,
				{ jobs: [{ jobId: "bg_1", type: "bash", durationMs: 1200, meta: { minimized } }] },
				"2026",
			),
		);
		expect(Bun.stripANSI(block.render(120).join("\n"))).toContain("Minimized: git 27.6KB → 9.5KB");
	});
});
