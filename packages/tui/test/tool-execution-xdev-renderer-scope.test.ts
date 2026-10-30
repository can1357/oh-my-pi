import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { span } from "@oh-my-pi/pi-tui/native/describe";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { XdevMountedRenderer, XdevMountedState } from "@oh-my-pi/pi-tui/tools/xdev";

/**
 * The `write xd://<tool>` card as a second host of a dispatched tool's components. A tool whose
 * renderers are not the host's own (an extension tool) carries a `rendererScope`; the device card
 * runs every call into a component that tool returned inside it, and once it has gone treats the
 * tool as having no renderer: the device's default rendering, nothing the tool returned.
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

const ui = () => ({ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() });

const dispatchResult = {
	content: [{ type: "text" as const, text: "device output 42" }],
	details: {
		xdev: { tool: "probe", mode: "execute" as const, args: { command: "probe 42" }, inner: { output: "42" } },
	},
};

/** A device write whose host resolver answers `probe` with `mounted`. */
function deviceWrite(mounted: XdevMountedRenderer): ToolExecutionComponent {
	const xdev: XdevMountedState = {
		mountedNames: new Set(["probe"]),
		tools: new Map([["probe", mounted]]),
		resolve: name => (name === "probe" ? mounted : undefined),
	};
	// The write tool reaches the card as a tool object carrying its session's device state.
	const writeTool = { name: "write", label: "Write", session: { xdev } } as unknown as AgentTool;
	const card = new ToolExecutionComponent(
		"write",
		{ path: "xd://probe", content: JSON.stringify({ command: "probe 42" }) },
		{ useBuiltInRenderer: true },
		writeTool,
		ui(),
	);
	card.setExecutionStarted();
	return card;
}

function rows(component: Component, width = 80): string {
	return component
		.render(width)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

describe("a scoped tool's components in the write xd:// card", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("runs each call into a returned component inside the tool's scope", () => {
		const owner = ownedScope();
		const where: Array<[string, boolean]> = [];
		const component = (stage: string): Component => ({
			render() {
				where.push([`${stage}.render`, owner.inside()]);
				return [`${stage} line`];
			},
			invalidate() {
				where.push([`${stage}.invalidate`, owner.inside()]);
			},
		});
		const mounted = {
			label: "Probe",
			rendererScope: owner.scope,
			renderCall: () => component("call"),
			renderResult: () => component("result"),
		};
		const card = deviceWrite(mounted);
		expect(rows(card)).toContain("call line");
		card.updateResult(dispatchResult, false);
		card.invalidate();
		const output = rows(card);
		expect(output).toContain("call line");
		expect(output).toContain("result line");
		expect(where.length).toBeGreaterThan(0);
		expect(where.filter(([, inside]) => !inside)).toEqual([]);
	});

	it("once the scope has gone, draws the device's default rendering and calls nothing the tool returned", () => {
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
		const mounted = {
			label: "Probe",
			rendererScope: owner.scope,
			renderCall: () => (calls.push("renderCall"), component("call")),
			renderResult: () => (calls.push("renderResult"), component("result")),
		};
		const card = deviceWrite(mounted);
		card.updateResult(dispatchResult, false);
		expect(rows(card)).toContain("result line");

		calls.length = 0;
		owner.retire();
		const retired = rows(card);
		card.invalidate();
		const invalidated = rows(card, 79);
		card.dispose();
		expect(calls).toEqual([]);
		for (const output of [retired, invalidated]) {
			expect(output).toContain("device output 42");
			expect(output).not.toContain("call line");
			expect(output).not.toContain("result line");
			expect(output).not.toContain("retired");
		}
	});

	it("once the scope has gone, the native device view asks no describe hook", () => {
		const owner = ownedScope();
		const asked: string[] = [];
		const mounted = {
			label: "Probe",
			rendererScope: owner.scope,
			describeCall: () => (asked.push("describeCall"), { head: [span("described call")] }),
			describeResult: () => (asked.push("describeResult"), { head: [span("described result")] }),
		};
		const card = deviceWrite(mounted);
		card.updateResult(dispatchResult, false);
		expect(JSON.stringify(card.describe())).toContain("described result");

		asked.length = 0;
		owner.retire();
		card.invalidate();
		const retired = JSON.stringify(card.describe());
		expect(asked).toEqual([]);
		expect(retired).not.toContain("described");
		expect(retired).toContain("device output 42");
	});
});
