import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

let harness: TspHarness | undefined;
afterEach(() => {
	setTranscriptActionHandler(undefined);
	harness?.stop();
	harness = undefined;
});

const USAGE: AssistantMessage["usage"] = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failed(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		usage: USAGE,
		timestamp: 1,
	};
}

/** A node's prop by name, whatever its kind. */
function prop(node: TspNode | undefined, name: string): unknown {
	const props = node?.p;
	for (const key in props) if (key === name) return props[key as keyof typeof props];
	return undefined;
}

function texts(node: TspNode | undefined): string {
	if (!node) return "";
	const own = prop(node, "text");
	const spans = prop(node, "spans");
	return (
		(typeof own === "string" ? own : "") +
		(Array.isArray(spans) ? (spans as { t: string }[]).map(s => s.t).join("") : "") +
		(node.c ?? []).map(texts).join("")
	);
}

describe("native transcript redesign", () => {
	it("draws a failed request as one frame: status chip, the message once, actions that run omp's commands", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const component = new AssistantMessageComponent(
			failed("500 upstream overloaded\nupstream overloaded (type=server_error)"),
		);
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();

		const frame = harness.find(node => node.k === "card" && node.p?.role === "omp.error");
		expect(frame?.p).toMatchObject({ tone: "error" });
		expect(harness.find(node => node.k === "badge" && node.p?.role === "omp.error.code")?.p).toMatchObject({
			text: "500",
		});
		const message = harness.find(node => node.p?.role === "omp.error.message");
		expect(texts(message)).toBe("upstream overloaded (type=server_error)");

		const retry = harness.find(node => node.p?.role === "omp.error.action" && texts(node).startsWith("Retry"));
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: retry!.id, act: "retry" });
		const copy = harness.find(node => node.p?.role === "omp.error.action" && texts(node).startsWith("Copy"));
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: copy!.id, act: "copy-error" });
		expect(actions).toEqual([{ act: "retry" }, { act: "copy", text: "upstream overloaded (type=server_error)" }]);
		expect(harness.errors).toEqual([]);
	});

	it("streams thinking under a live head, then settles to a collapsed 'Thought' line", async () => {
		const component = new AssistantMessageComponent();
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		const thinking = (text: string): AssistantMessage => ({
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "thinking", thinking: text }],
		});
		component.updateContent(thinking("Weighing it"), { transient: true });
		await harness.render();
		const live = harness.find(node => node.k === "section" && node.p?.role === "omp.thinking.live");
		expect(live).toBeDefined();
		expect(harness.find(node => node.k === "spinner" && node.p?.style === "starburst")).toBeDefined();
		expect(harness.find(node => node.k === "elapsed")).toBeDefined();
		expect(prop(live, "took")).toBeUndefined();

		component.updateContent(thinking("Weighing it carefully"));
		component.markTranscriptBlockFinalized();
		await harness.render();
		const done = harness.find(node => node.k === "section" && node.p?.role === "omp.thinking");
		expect(done?.p).toMatchObject({ collapsed: true });
		expect(texts(done)).toStartWith("Thought");
		expect(prop(done, "took")).toBeNumber();
		expect(harness.find(node => node.k === "spinner")).toBeUndefined();
		expect(harness.errors).toEqual([]);
	});

	it("shows hidden thinking only while it streams, and nothing once it settles", async () => {
		const component = new AssistantMessageComponent(undefined, true);
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		const message = (...content: AssistantMessage["content"]): AssistantMessage => ({
			...failed(""),
			stopReason: "stop",
			errorMessage: undefined,
			content,
		});
		component.updateContent(message({ type: "thinking", thinking: "Weighing it" }), { transient: true });
		await harness.render();
		expect(harness.find(node => node.k === "section" && node.p?.role === "omp.thinking.live")?.p).toMatchObject({
			collapsed: true,
		});

		component.updateContent(
			message({ type: "thinking", thinking: "Weighing it carefully" }, { type: "text", text: "Done." }),
		);
		component.markTranscriptBlockFinalized();
		await harness.render();
		expect(
			harness.find(node => node.k === "section" && String(node.p?.role).startsWith("omp.thinking")),
		).toBeUndefined();
		expect(harness.errors).toEqual([]);
	});

	it("gives a user message no head row, and routes its toolbar to omp's copy and rewind", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const user = new UserMessageComponent("Fix the build", { timestamp: Date.UTC(2026, 0, 1, 12, 30) });
		harness = await TspHarness.start();
		harness.tui.addChild(user);
		await harness.render();
		const frame = harness.find(node => node.k === "card" && node.p?.role === "omp.user");
		expect(prop(frame, "head")).toBeUndefined();
		const tool = (label: string) =>
			harness!.find(node => node.p?.role === "omp.user.tool" && prop(node, "text") === label)!;
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: tool("Copy").id, act: "copy-message" });
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: tool("Rewind").id, act: "rewind" });
		expect(actions).toEqual([{ act: "copy", text: "Fix the build" }, { act: "rewind" }]);
	});

	it("shows a status notice as a toast that re-shows when its text changes", async () => {
		const notice = new StatusNotice("Thinking blocks: hidden");
		harness = await TspHarness.start();
		harness.tui.addChild(notice);
		await harness.render();
		const toast = harness.find(node => node.k === "toast");
		expect(toast?.p).toMatchObject({ text: "Thinking blocks: hidden", ttl: 2400 });
		notice.setMessage("Thinking blocks: shown");
		harness.tui.requestRender();
		await harness.render();
		expect(harness.find(node => node.k === "toast")?.p).toMatchObject({ text: "Thinking blocks: shown" });
		expect(harness.find(node => node.k === "text" && node.p?.text === "Thinking blocks: hidden")).toBeUndefined();
	});
});
