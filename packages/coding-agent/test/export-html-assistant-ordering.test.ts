import { afterEach, describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { type Document, Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { Marked } from "@oh-my-pi/pi-utils/marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
	if (originalScrollIntoView) {
		Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
	} else {
		Reflect.deleteProperty(Element.prototype, "scrollIntoView");
	}
});

interface AssistantBlock {
	type: "text" | "thinking" | "image" | "toolCall";
	text?: string;
	thinking?: string;
	mimeType?: string;
	data?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface RenderedSession {
	assistant: Element;
	document: Document;
	context: vm.Context;
	lastScrolledId: () => string | null;
}

function renderSession(entries: unknown[], leafId: string): RenderedSession {
	const { document, window } = parseHTML(templateHtml);
	let lastScrolledId: string | null = null;
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		value(this: Element) {
			lastScrolledId = this.id || null;
		},
		configurable: true,
	});
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(
		JSON.stringify({
			header: {
				type: "session",
				version: 3,
				id: "assistant-ordering-test",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			entries,
			leafId,
		}),
	).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: (callback: () => void, delay = 0) => {
			if (delay === 0) callback();
			return 0;
		},
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);

	const assistant = document.querySelector(".assistant-message");
	if (!assistant) throw new Error("Export viewer did not render the assistant message");
	return { assistant, document, context, lastScrolledId: () => lastScrolledId };
}

function renderAssistant(
	content: AssistantBlock[],
	stopReason: "stop" | "aborted" | "error" = "stop",
	withToolResults = false,
	reverseToolResultChain = false,
): RenderedSession {
	const toolCalls = content.filter(
		(block): block is AssistantBlock & { id: string; name: string } => block.type === "toolCall",
	);
	const entries = [
		{
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content,
				stopReason,
				errorMessage: stopReason === "error" ? "provider failed" : undefined,
				timestamp: 1,
			},
		},
		...(withToolResults
			? toolCalls.map((block, index) => ({
					type: "message",
					id: `result-${block.id}`,
					parentId: reverseToolResultChain
						? index === toolCalls.length - 1
							? "assistant-1"
							: `result-${toolCalls[index + 1]!.id}`
						: index === 0
							? "assistant-1"
							: `result-${toolCalls[index - 1]!.id}`,
					timestamp: `2026-01-01T00:00:0${index + 2}.000Z`,
					message: {
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} result` }],
						isError: false,
						timestamp: index + 2,
					},
				}))
			: []),
	];
	const leafId = withToolResults ? `result-${toolCalls.at(reverseToolResultChain ? 0 : -1)?.id}` : "assistant-1";
	return renderSession(entries, leafId);
}

function toolName(element: Element, context: vm.Context): string {
	const key = element.getAttribute("data-key");
	if (!key) throw new Error("Rendered tool call is missing its data key");
	const payload = vm.runInContext(`globalThis.__OMP_TOOL_VIEW_DATA.get(${JSON.stringify(key)})`, context) as unknown;
	if (!payload || typeof payload !== "object" || !("name" in payload) || typeof payload.name !== "string") {
		throw new Error(`Rendered tool call ${key} is missing its name`);
	}
	return payload.name;
}

function renderedBlockOrder({ assistant, context }: RenderedSession): string[] {
	const order: string[] = [];
	for (const child of Array.from(assistant.children)) {
		if (child.classList.contains("assistant-text")) {
			order.push(child.textContent?.trim() ?? "");
		} else if (child.classList.contains("thinking-block")) {
			order.push(child.querySelector(".thinking-text")?.textContent?.trim() ?? "");
		} else if (child.classList.contains("message-images")) {
			order.push("image");
		} else if (child.tagName.toLowerCase() === "omp-tool-view") {
			order.push(toolName(child, context));
		} else if (child.classList.contains("error-text")) {
			order.push(child.textContent?.trim() ?? "");
		}
	}
	return order;
}

function renderedSidebarOrder({ document }: RenderedSession): string[] {
	return Array.from(document.querySelectorAll("#tree-container .tree-content")).map(
		node => node.textContent?.trim() ?? "",
	);
}

describe("HTML export assistant content ordering", () => {
	test("preserves interleaved text, tool calls, thinking, images, and the terminal stop reason", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "between-tools" },
				{
					type: "toolCall",
					id: "tool-2",
					name: "task",
					arguments: { agent: "ExploreCompletion", prompt: "Inspect completion handling" },
				},
				{ type: "thinking", thinking: "thinking-after-task" },
				{ type: "image", mimeType: "image/png", data: "aa" },
				{ type: "text", text: "final-answer" },
			],
			"aborted",
		);

		expect(renderedBlockOrder(rendered)).toEqual([
			"before-read",
			"read",
			"between-tools",
			"task",
			"thinking-after-task",
			"image",
			"final-answer",
			"Aborted",
		]);
	});

	test("keeps the text-tool-text-tool-text ordering invariant", () => {
		const rendered = renderAssistant([
			{ type: "text", text: "first" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
			{ type: "text", text: "middle" },
			{ type: "toolCall", id: "tool-2", name: "grep", arguments: { pattern: "needle" } },
			{ type: "text", text: "last" },
		]);

		expect(renderedBlockOrder(rendered)).toEqual(["first", "read", "middle", "grep", "last"]);
	});

	test("projects interleaved assistant blocks into pi-style sidebar timeline rows", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "between-tools" },
				{
					type: "toolCall",
					id: "tool-2",
					name: "task",
					arguments: { agent: "ExploreCompletion", prompt: "Inspect completion handling" },
				},
				{ type: "thinking", thinking: "thinking-after-task" },
				{ type: "image", mimeType: "image/png", data: "aa" },
				{ type: "text", text: "final-answer" },
			],
			"stop",
			true,
		);

		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-read",
			"[read: README.md]",
			"assistant: between-tools",
			'[task: {"agent":"ExploreCompletion","prompt":"I...]',
			"assistant: final-answer",
		]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("5 / 5 rows");

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		const expectedTargets = [
			"entry-assistant-1-block-0",
			"entry-assistant-1-block-1",
			"entry-assistant-1-block-2",
			"entry-assistant-1-block-3",
			"entry-assistant-1-block-6",
		];
		rows[2]!.click();
		expect(
			Array.from(rendered.document.querySelectorAll("#tree-container .tree-node")).map(row =>
				row.classList.contains("in-path"),
			),
		).toEqual([true, true, true, false, false]);
		for (let i = 0; i < rows.length; i++) {
			const currentRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
			currentRows[i]!.click();
			expect(rendered.lastScrolledId()).toBe(expectedTargets[i]);
		}
	});

	test("collapses projected sidebar assistant text the same way as other tree rows", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "first\nline" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
				{ type: "text", text: "after" },
			],
			"stop",
			true,
		);

		expect(renderedSidebarOrder(rendered)[0]).toBe("assistant: first line");
	});

	test("clicking a pi-style tool result row locates its assistant tool card", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
			],
			"stop",
			true,
		);

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		expect(rows).toHaveLength(2);
		rows[1]!.click();
		expect(rendered.lastScrolledId()).toBe("entry-assistant-1-block-1");
		expect(
			rendered.document.getElementById("entry-assistant-1-block-1")?.classList.contains("highlight"),
		).toBeFalse();
	});

	test("keeps a pending tool call in the projected sidebar without a tool result", () => {
		const rendered = renderAssistant([
			{ type: "text", text: "before-tool" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "pending.ts" } },
			{ type: "text", text: "after-tool" },
		]);

		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-tool",
			"[read: pending.ts]",
			"assistant: after-tool",
		]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("3 / 3 rows");

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		rows[1]!.click();
		expect(rendered.lastScrolledId()).toBe("entry-assistant-1-block-1");
	});

	test("hides projected tool calls when the No-tools filter is active", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "hidden.ts" } },
				{ type: "text", text: "after-tool" },
			],
			"stop",
			true,
		);

		const noToolsButton = rendered.document.querySelector('.filter-btn[data-filter="no-tools"]');
		if (!noToolsButton) throw new Error("Export template is missing the No-tools filter");
		noToolsButton.click();

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: before-tool", "assistant: after-tool"]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("2 / 3 rows");
	});

	test("uses projected timeline order when tool result ancestry is reversed", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
				{ type: "text", text: "after-read" },
				{ type: "toolCall", id: "tool-2", name: "hub", arguments: { op: "jobs" } },
				{ type: "text", text: "after-hub" },
			],
			"stop",
			true,
			true,
		);

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		rows[1]!.click();
		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-read",
			"[read: one.ts]",
			"assistant: after-read",
			'[hub: {"op":"jobs"}]',
			"assistant: after-hub",
		]);
		expect(
			Array.from(rendered.document.querySelectorAll("#tree-container .tree-node")).map(row =>
				row.classList.contains("in-path"),
			),
		).toEqual([true, true, false, false, false]);
	});

	test("rebuilds cached sidebar rows when navigation reprioritizes a sibling branch", () => {
		const rendered = renderSession(
			[
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "root" }],
						stopReason: "stop",
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "branch-a",
					parentId: "root",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: { role: "user", content: "branch-a", timestamp: 2 },
				},
				{
					type: "message",
					id: "branch-b",
					parentId: "root",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "user", content: "branch-b", timestamp: 3 },
				},
			],
			"branch-a",
		);

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: root", "user: branch-a", "user: branch-b"]);
		const initialRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		initialRows[2]!.click();

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: root", "user: branch-b", "user: branch-a"]);
		const updatedRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		expect(updatedRows.map(row => row.classList.contains("in-path"))).toEqual([true, true, false]);
	});
});
