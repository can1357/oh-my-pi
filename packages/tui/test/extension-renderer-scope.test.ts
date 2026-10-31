import { beforeAll, describe, expect, it } from "bun:test";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import type {
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	MessageRenderer,
} from "@oh-my-pi/pi-tui/chat/extension-types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

/**
 * The custom message frame and the assistant message's thinking extensions as hosts of an
 * extension's components, and the assistant message as the caller of its text renderers. An
 * extension's renderer carries its `rendererScope`; the host runs every call into a component it
 * returned inside that scope, and once the scope has gone treats it as no renderer: the frame's
 * own card, the thinking block without the extension's rows, the block's own text.
 */

interface Scope {
	readonly live: boolean;
	run<T>(call: () => T): T;
}

function ownedScope() {
	let live = true;
	let depth = 0;
	const scope: Scope = {
		get live() {
			return live;
		},
		run<T>(call: () => T): T {
			if (!live) throw new Error("scope retired");
			depth++;
			try {
				return call();
			} finally {
				depth--;
			}
		},
	};
	return {
		scope,
		inside: () => depth > 0,
		retire: () => {
			live = false;
		},
	};
}

/** `renderer` as coding-agent hands it: carrying the scope its components run in. */
function scoped<F extends object>(renderer: F, scope: Scope): F & { rendererScope: Scope } {
	return Object.assign(renderer, { rendererScope: scope });
}

function rows(component: Component, width = 80): string {
	return component
		.render(width)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

/** A component that records each call into it, and whether it ran inside `owner`'s scope. */
function recordingComponent(label: string, calls: Array<[string, boolean]>, inside: () => boolean): Component {
	return {
		render() {
			calls.push([`${label}.render`, inside()]);
			return [`${label} line`];
		},
		invalidate() {
			calls.push([`${label}.invalidate`, inside()]);
		},
		dispose() {
			calls.push([`${label}.dispose`, inside()]);
		},
	};
}

describe("an extension's message renderer in the custom message frame", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const message = () => createCustomMessage("ext-note", "host-owned note body", true, undefined, "2026-01-01");

	it("runs each call into the returned component inside the renderer's scope, and keeps one component mounted once", () => {
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		const component = recordingComponent("note", calls, owner.inside);
		let rendered = 0;
		const renderer: MessageRenderer = scoped(() => (rendered++, component), owner.scope);
		const frame = new CustomMessageComponent(message(), renderer);
		expect(rows(frame)).toContain("note line");
		frame.invalidate();
		frame.setExpanded(true);
		expect(rows(frame)).toContain("note line");
		expect(rendered).toBe(3);
		expect(calls.filter(([where]) => where === "note.dispose")).toEqual([]);
		expect(calls.filter(([, inside]) => !inside)).toEqual([]);
	});

	it("once the scope has gone, draws the frame's own card and calls nothing the renderer returned", () => {
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		const renderer: MessageRenderer = scoped(
			() => (calls.push(["renderer", owner.inside()]), recordingComponent("note", calls, owner.inside)),
			owner.scope,
		);
		const frame = new CustomMessageComponent(message(), renderer);
		expect(rows(frame)).toContain("note line");

		calls.length = 0;
		owner.retire();
		const retired = rows(frame);
		frame.invalidate();
		const invalidated = rows(frame, 79);
		const native = JSON.stringify(frame.describe());
		frame.dispose();
		expect(calls).toEqual([]);
		for (const output of [retired, invalidated, native]) {
			expect(output).toContain("host-owned note body");
			expect(output).not.toContain("note line");
		}
	});

	it("leaves a host message renderer as it is: its component is mounted as itself", () => {
		const component = new Text("host note", 0, 0);
		const frame = new CustomMessageComponent(message(), () => component);
		expect(frame.children).toContain(component);
		expect(rows(frame)).toContain("host note");
	});
});

describe("an extension's assistant renderers", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function reply(blocks: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content: blocks,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
	}

	it("runs a thinking renderer's component inside its scope, and once the scope has gone draws the thought without it", () => {
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		const renderer: AssistantThinkingRenderer = scoped(
			() => (calls.push(["renderer", owner.inside()]), recordingComponent("thought-ext", calls, owner.inside)),
			owner.scope,
		);
		const assistant = new AssistantMessageComponent(
			reply([
				{ type: "thinking", thinking: "host-owned thought" },
				{ type: "text", text: "host-owned answer" },
			]),
			false,
			undefined,
			[renderer],
			undefined,
			false,
			undefined,
			true,
		);
		const live = rows(assistant);
		expect(live).toContain("thought-ext line");
		expect(calls.filter(([where, inside]) => where !== "renderer" && !inside)).toEqual([]);

		calls.length = 0;
		owner.retire();
		const retired = rows(assistant, 79);
		assistant.invalidate();
		const invalidated = rows(assistant, 78);
		expect(calls).toEqual([]);
		for (const output of [retired, invalidated]) {
			expect(output).toContain("host-owned thought");
			expect(output).toContain("host-owned answer");
			expect(output).not.toContain("thought-ext line");
		}
	});

	it("once a text renderer's scope has gone, draws the block's own text and asks it nothing", () => {
		const owner = ownedScope();
		let asked = 0;
		const renderer: AssistantTextRenderer = scoped(() => (asked++, "transformed by the extension"), owner.scope);
		const assistant = new AssistantMessageComponent(
			reply([{ type: "text", text: "host-owned answer" }]),
			false,
			undefined,
			[],
			undefined,
			true,
			undefined,
			false,
			{ renderers: [renderer], contentOffset: 0 },
		);
		expect(rows(assistant)).toContain("transformed by the extension");

		asked = 0;
		owner.retire();
		const retired = rows(assistant, 79);
		expect(asked).toBe(0);
		expect(retired).toContain("host-owned answer");
		expect(retired).not.toContain("transformed by the extension");
	});
});
