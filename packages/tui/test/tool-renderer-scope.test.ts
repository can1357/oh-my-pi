import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { span } from "@oh-my-pi/pi-tui/native/describe";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { SafeToolRendererComponent } from "@oh-my-pi/pi-tui/tools/renderer-scope";

/**
 * The chat card as a host of a tool whose renderers are not the host's own (an extension tool,
 * whose code runs only inside its session's admission). The tool hands its `rendererScope`; the
 * card runs every call into a component the tool returned inside it, copies the lines it renders
 * there, and once the scope has gone treats the tool as having no renderer: the host's default card.
 */

interface Scope {
	readonly live: boolean;
	run<T>(call: () => T): T;
}

/** A scope whose owner the test retires. `inside()` says whether code runs inside it now. */
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

const ui = () => ({ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() });

const result = { content: [{ type: "text" as const, text: "host-owned output" }] };

/** A tool carrying `renderers` and, when given, the scope they belong to. */
function scopedTool(renderers: object, scope: Scope | undefined): AgentTool {
	// The renderers are the test's own shapes; a tool object is what the card is handed.
	const tool = {
		name: "scoped_tool",
		label: "Scoped Tool",
		description: "scoped",
		parameters: { type: "object", additionalProperties: true },
		execute: async () => result,
		rendererScope: scope,
		...renderers,
	} as unknown as AgentTool;
	return tool;
}

function card(tool: AgentTool): ToolExecutionComponent {
	const component = new ToolExecutionComponent("scoped_tool", { command: "safe" }, {}, tool, ui());
	component.setArgsComplete();
	component.updateResult(result, false);
	return component;
}

function rows(component: Component, width = 80): string {
	return component
		.render(width)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

describe("a scoped tool's components in the chat card", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("runs each call into a returned component inside the tool's scope, and reads its lines there", () => {
		const owner = ownedScope();
		const where: Array<[string, boolean]> = [];
		const component = (stage: string): Component => ({
			render() {
				where.push([`${stage}.render`, owner.inside()]);
				const lines = [`${stage} line`];
				// A line the host reads after `render` returns would run this outside the scope.
				Object.defineProperty(lines, 0, {
					enumerable: true,
					get() {
						where.push([`${stage}.line`, owner.inside()]);
						return `${stage} line`;
					},
				});
				return lines;
			},
			invalidate() {
				where.push([`${stage}.invalidate`, owner.inside()]);
			},
		});
		const tool = scopedTool(
			{ renderCall: () => component("call"), renderResult: () => component("result") },
			owner.scope,
		);
		const shown = card(tool);
		shown.invalidate();
		const output = rows(shown);
		expect(output).toContain("call line");
		expect(output).toContain("result line");
		expect(where.length).toBeGreaterThan(0);
		expect(where.filter(([, inside]) => !inside)).toEqual([]);
	});

	it("draws the host's fallback, not an error, for lines that are not strings", () => {
		const owner = ownedScope();
		const tool = scopedTool(
			{
				renderCall: () => new Text("call line", 0, 0),
				renderResult: (): Component => ({ render: () => [{ forged: true }] as never, invalidate() {} }),
			},
			owner.scope,
		);
		const output = rows(card(tool));
		expect(output).toContain("call line");
		expect(output).toContain("host-owned output");
		expect(output).not.toContain("forged");
		expect(output).not.toContain("Error");
	});

	it("once the scope has gone, draws the host's default card and calls nothing the tool returned", () => {
		const owner = ownedScope();
		const calls: string[] = [];
		const component = (stage: string): Component => ({
			render() {
				calls.push(`${stage}.render`);
				return [`${stage} line`];
			},
			invalidate() {
				calls.push(`${stage}.invalidate`);
			},
			dispose() {
				calls.push(`${stage}.dispose`);
			},
		});
		const renderers = {
			renderCall: () => (calls.push("renderCall"), component("call")),
			renderResult: () => (calls.push("renderResult"), component("result")),
		};
		const shown = card(scopedTool(renderers, owner.scope));
		expect(rows(shown)).toContain("result line");

		calls.length = 0;
		owner.retire();
		const retired = rows(shown);
		shown.invalidate();
		const invalidated = rows(shown, 79);
		shown.dispose();
		expect(calls).toEqual([]);
		for (const output of [retired, invalidated]) {
			expect(output).toContain("Scoped Tool");
			expect(output).toContain("host-owned output");
			expect(output).not.toContain("call line");
			expect(output).not.toContain("result line");
		}
	});

	it("once the scope has gone, the native card is the default view and asks no describe hook", () => {
		const owner = ownedScope();
		const asked: string[] = [];
		const describers = {
			renderCall: () => new Text("call line", 0, 0),
			describeCall: () => (asked.push("describeCall"), { head: [span("described call")] }),
			describeResult: () => (asked.push("describeResult"), { head: [span("described result")] }),
		};
		const shown = card(scopedTool(describers, owner.scope));
		expect(JSON.stringify(shown.describe())).toContain("described call");

		asked.length = 0;
		owner.retire();
		const retired = JSON.stringify(shown.describe());
		expect(asked).toEqual([]);
		expect(retired).not.toContain("described");
		expect(retired).toContain("host-owned output");
	});

	it("leaves a host tool as it is: its renderer gets the card's own arguments and its component draws", () => {
		const handed: unknown[] = [];
		const hostComponent: Component = {
			render: () => ["host line"],
			invalidate() {},
		};
		const tool = scopedTool(
			{
				renderCall: (args: unknown) => (handed.push(args), hostComponent),
				renderResult: () => new Text("host result", 0, 0),
			},
			undefined,
		);
		const args = { command: "safe" };
		const shown = new ToolExecutionComponent("scoped_tool", args, {}, tool, ui());
		expect(rows(shown)).toContain("host line");
		expect(handed[0]).toBe(args);
	});
});

describe("SafeToolRendererComponent", () => {
	it("hands a host component's lines through as they are", () => {
		const lines = ["host line"];
		const mounted = new SafeToolRendererComponent(
			"host_tool",
			"call",
			{ render: () => lines, invalidate() {} },
			() => undefined,
		);
		expect(mounted.render(80)).toBe(lines);
	});

	it("hands the host a copy of a scoped component's lines", () => {
		const lines = ["scoped line"];
		const owner = ownedScope();
		const mounted = new SafeToolRendererComponent(
			"scoped_tool",
			"call",
			{ render: () => lines, invalidate() {} },
			() => undefined,
			owner.scope,
		);
		const rendered = mounted.render(80);
		expect(rendered).toEqual(["scoped line"]);
		expect(rendered).not.toBe(lines);
	});

	it("calls a scoped component's methods on the component itself, so its private fields work", () => {
		class PrivateState implements Component {
			#lines = ["before"];
			render(): readonly string[] {
				return this.#lines;
			}
			invalidate(): void {
				this.#lines = ["after"];
			}
		}
		const owner = ownedScope();
		const mounted = new SafeToolRendererComponent(
			"scoped_tool",
			"call",
			new PrivateState(),
			() => undefined,
			owner.scope,
		);
		expect(mounted.render(80)).toEqual(["before"]);
		mounted.invalidate();
		expect(mounted.render(80)).toEqual(["after"]);
	});
});
